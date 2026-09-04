const DB_NAME = 'video-toolkit-pro-models';
const STORE_NAME = 'models';
const MODEL_DIRECTORY = 'models';

/**
 * Stores ONNX models in OPFS and their verified metadata in IndexedDB.
 * Models may be imported from a local file or installed from a same-origin
 * bundled asset. No remote service is required by this class.
 */
export class ModelManager {
  constructor() {
    this.db = null;
    this.root = null;
  }

  async _openDB() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db;
  }

  async _modelDirectory() {
    if (!this.root) {
      if (!navigator.storage?.getDirectory) throw new Error('OPFS is unavailable; AI model storage cannot be initialized');
      this.root = await navigator.storage.getDirectory();
    }
    return this.root.getDirectoryHandle(MODEL_DIRECTORY, { create: true });
  }

  async getStatus(modelId) {
    const meta = await this.getMetadata(modelId);
    if (!meta) return { installed: false, verified: false, testPassed: false };
    let installed = false;
    try {
      const directory = await this._modelDirectory();
      const file = await (await directory.getFileHandle(meta.fileName)).getFile();
      installed = file.size === meta.sizeBytes;
    } catch {
      installed = false;
    }
    return { ...meta, installed, verified: installed && meta.verified === true, testPassed: meta.testPassed === true };
  }

  async getMetadata(modelId) {
    const db = await this._openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(modelId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Imports a user-selected ONNX file, streams it into OPFS, and verifies
   * its digest before it becomes visible to inference engines.
   */
  async importModel(modelId, file, config = {}, onProgress = null) {
    if (!(file instanceof Blob)) throw new TypeError('Model import requires a File or Blob');
    if (!file.size) throw new Error('The selected model file is empty');
    return this._importStream(modelId, file.stream(), file.size, file.name || `${sanitize(modelId)}.onnx`, config, onProgress);
  }

  async _importStream(modelId, stream, totalBytes, originalName, config = {}, onProgress = null) {
    const directory = await this._modelDirectory();
    const fileName = `${sanitize(modelId)}.onnx`;
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    const reader = stream.getReader();
    const digest = new StreamingSHA256();
    let written = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        await writable.write(value);
        digest.update(value);
        written += value.byteLength;
        onProgress?.({ received: written, total: totalBytes, pct: totalBytes ? written / totalBytes : 0 });
      }
      await writable.close();
    } catch (error) {
      await writable.abort(error).catch(() => {});
      await directory.removeEntry(fileName).catch(() => {});
      throw error;
    }

    const sha256 = digest.hex();
    if (config.sha256 && sha256 !== config.sha256.toLowerCase()) {
      await directory.removeEntry(fileName).catch(() => {});
      throw new Error(`Model digest mismatch for ${modelId}`);
    }
    if (config.expectedSizeBytes && Math.abs(written - config.expectedSizeBytes) > Math.max(1024, config.expectedSizeBytes * 0.02)) {
      await directory.removeEntry(fileName).catch(() => {});
      throw new Error(`Unexpected model size for ${modelId}: ${written} bytes`);
    }

    const metadata = {
      id: modelId,
      fileName,
      originalName: originalName || fileName,
      sizeBytes: written,
      sha256,
      verified: true,
      testPassed: false,
      verificationClass: config.sha256 ? 'catalog-hash' : 'custom-runtime-required',
      knownHash: Boolean(config.sha256),
      format: config.format || 'onnx',
      role: config.role || null,
      version: config.version || null,
      purpose: config.purpose || config.role || null,
      sourceKind: config.source || (config.sourceURL ? 'url' : 'manual-import'),
      sourceURL: config.sourceURL || null,
      sourcePage: config.sourcePage || null,
      license: config.license || null,
      importedAt: Date.now(),
    };
    await this._putMetadata(metadata);
    return metadata;
  }

  /** Installs a same-origin bundled model using the same verification path. */
  async installBundled(modelId, relativeURL, config = {}, onProgress = null) {
    const response = await fetch(relativeURL, { credentials: 'same-origin', cache: 'no-cache' });
    if (!response.ok) throw new Error(`Bundled model could not be loaded: HTTP ${response.status}`);
    return this.importModel(modelId, await response.blob(), config, onProgress);
  }

  /**
   * Downloads a catalog model from an audited HTTPS host, reports network
   * progress, then passes it through the exact same digest and OPFS import
   * path as a local model. Arbitrary URLs are intentionally rejected.
   */
  async installFromURL(modelId, remoteURL, config = {}, onProgress = null) {
    const url = new URL(remoteURL, location.href);
    const allowedHosts = new Set(['github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com', 'huggingface.co']);
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) throw new Error('Model source is not in the audited HTTPS catalog');
    await this._ensureDownloadCapacity(config.expectedSizeBytes || 0);
    const response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'follow' });
    if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || config.expectedSizeBytes || 0;
    const reader = response.body?.getReader();
    if (!reader) return this.importModel(modelId, await response.blob(), { ...config, sourceURL: url.href }, onProgress);
    if (total >= 32 * 1024 * 1024) {
      // Large AI models are written to OPFS and hashed incrementally. This
      // avoids holding a second complete model copy in Android RAM.
      const stream = new ReadableStream({
        async pull(controller) {
          const { value, done } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel(reason) { return reader.cancel(reason); },
      });
      return this._importStream(
        modelId,
        stream,
        total,
        `${sanitize(modelId)}.onnx`,
        { ...config, sourceURL: url.href },
        (progress) => onProgress?.({ stage: 'download', ...progress }),
      );
    }
    const chunks = [];
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress?.({ stage: 'download', received, total, pct: total ? received / total : 0 });
    }
    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    const file = typeof File === 'function' ? new File([blob], `${sanitize(modelId)}.onnx`, { type: blob.type }) : blob;
    return this.importModel(modelId, file, { ...config, sourceURL: url.href }, (progress) => onProgress?.({ stage: 'verify', ...progress }));
  }

  /**
   * Tries trusted catalog mirrors in order. Every candidate still goes
   * through the same OPFS streaming + SHA/size verification path. A bad
   * partial download is removed before trying the next mirror.
   */
  async installFromCandidates(modelId, config = {}, onProgress = null) {
    const raw = config.downloadCandidates?.length ? config.downloadCandidates : (config.remoteURL ? [config.remoteURL] : []);
    if (!raw.length) throw new Error(`No automatic download source is configured for ${modelId}`);
    const errors = [];
    for (let index = 0; index < raw.length; index++) {
      const candidate = typeof raw[index] === 'string' ? { url: raw[index] } : raw[index];
      if (!candidate?.url) continue;
      try {
        onProgress?.({ stage: 'source', candidate: index + 1, candidateCount: raw.length, url: candidate.url });
        const merged = { ...config, ...candidate, sourceURL: candidate.url };
        delete merged.downloadCandidates;
        delete merged.url;
        return await this.installFromURL(modelId, candidate.url, merged, (progress) => onProgress?.({ candidate: index + 1, candidateCount: raw.length, ...progress }));
      } catch (error) {
        errors.push(`source ${index + 1}: ${error?.message || error}`);
        await this.deleteModel(modelId).catch(() => {});
      }
    }
    throw new Error(`All automatic model sources failed for ${modelId}: ${errors.join(' | ')}`);
  }

  async markTestPassed(modelId, details = {}) {
    const metadata = await this.getMetadata(modelId);
    if (!metadata?.verified) throw new Error(`Cannot activate unverified model ${modelId}`);
    await this._putMetadata({
      ...metadata,
      testPassed: true,
      testedAt: Date.now(),
      lastSuccessfulTest: Date.now(),
      executionProvider: details.executionProvider || metadata.executionProvider || null,
      signature: details.signature || details,
      testDetails: details,
      health: 'ready',
      readinessLabel: metadata.knownHash ? 'READY' : 'CUSTOM · RUNTIME VERIFIED',
    });
  }

  async markTestFailed(modelId, error) {
    const metadata = await this.getMetadata(modelId);
    if (!metadata) return;
    await this._putMetadata({
      ...metadata,
      testPassed: false,
      testedAt: Date.now(),
      health: 'failed',
      lastTestError: String(error?.message || error || 'Unknown inference failure').slice(0, 1000),
      readinessLabel: 'FAILED',
    });
  }

  /** Re-hashes the OPFS file without creating a second full model copy. */
  async verifyStoredModel(modelId, config = {}, onProgress = null) {
    const metadata = await this.getMetadata(modelId);
    if (!metadata) throw new Error(`Model ${modelId} is not registered`);
    const file = await this.openModelFile(modelId);
    const reader = file.stream().getReader();
    const digest = new StreamingSHA256();
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      digest.update(value);
      received += value.byteLength;
      onProgress?.({ received, total: file.size, pct: file.size ? received / file.size : 0 });
    }
    const sha256 = digest.hex();
    const expectedHash = (config.sha256 || metadata.knownHash && metadata.sha256 || '').toLowerCase();
    const validSize = file.size === metadata.sizeBytes && (!config.expectedSizeBytes || Math.abs(file.size - config.expectedSizeBytes) <= Math.max(1024, config.expectedSizeBytes * .02));
    const validHash = !expectedHash || sha256 === expectedHash;
    const verified = validSize && validHash;
    await this._putMetadata({ ...metadata, sha256, verified, health: verified ? (metadata.testPassed ? 'ready' : 'needs-test') : 'failed', lastVerifiedAt: Date.now(), lastVerificationError: verified ? null : (!validSize ? 'size-mismatch' : 'hash-mismatch') });
    if (!verified) throw new Error(`Stored model ${modelId} failed ${validSize ? 'SHA-256' : 'file-size'} verification`);
    return this.getStatus(modelId);
  }

  async loadModelBuffer(modelId) {
    const status = await this.getStatus(modelId);
    if (!status.installed || !status.verified) throw new Error(`Model ${modelId} is not installed or verified`);
    const directory = await this._modelDirectory();
    const file = await (await directory.getFileHandle(status.fileName)).getFile();
    return file.arrayBuffer();
  }

  async openModelFile(modelId) {
    const status = await this.getStatus(modelId);
    if (!status.installed) throw new Error(`Model ${modelId} is not installed`);
    const directory = await this._modelDirectory();
    return (await directory.getFileHandle(status.fileName)).getFile();
  }

  async listModels() {
    const db = await this._openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async importFromUserURL(modelId, remoteURL, config = {}, onProgress = null) {
    const url = new URL(remoteURL);
    if (url.protocol !== 'https:') throw new Error('Manual model URLs must use HTTPS');
    let response;
    try {
      response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'follow' });
    } catch (error) {
      const wrapped = new Error('The model host blocked browser download (CORS). Open the source, download manually, then use Import File.');
      wrapped.cause = error;
      throw wrapped;
    }
    if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    if (!response.body) return this.importModel(modelId, await response.blob(), { ...config, source: 'manual-url', sourceURL: url.href }, onProgress);
    return this._importStream(modelId, response.body, total, `${sanitize(modelId)}.onnx`, { ...config, source: 'manual-url', sourceURL: url.href }, onProgress);
  }

  async deleteModel(modelId) {
    const metadata = await this.getMetadata(modelId);
    if (metadata) {
      const directory = await this._modelDirectory();
      await directory.removeEntry(metadata.fileName).catch(() => {});
    }
    const db = await this._openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(modelId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async _ensureDownloadCapacity(expectedSizeBytes = 0) {
    if (!(expectedSizeBytes > 0) || !navigator.storage?.estimate) return;
    const estimate = await navigator.storage.estimate().catch(() => null);
    if (!estimate?.quota || estimate.usage == null) return;
    const free = Math.max(0, estimate.quota - estimate.usage);
    const reserve = Math.max(64 * 1024 * 1024, Math.ceil(expectedSizeBytes * 0.12));
    const required = expectedSizeBytes + reserve;
    if (free < required) {
      const error = new Error(`Not enough browser storage for this model. Required about ${formatMB(required)} MB, free ${formatMB(free)} MB.`);
      error.code = 'MODEL_STORAGE_LOW';
      error.requiredBytes = required;
      error.freeBytes = free;
      throw error;
    }
  }

  async getStorageUsage() {
    const estimate = await navigator.storage?.estimate?.();
    return { usageBytes: estimate?.usage ?? null, quotaBytes: estimate?.quota ?? null };
  }

  async _putMetadata(metadata) {
    const db = await this._openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(metadata);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}

function sanitize(value) {
  return value.replace(/[^a-z0-9_-]/gi, '-').replace(/-+/g, '-').slice(0, 80);
}

export async function sha256Hex(input) {
  const bytes = input instanceof ArrayBuffer ? input : input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Incremental SHA-256 used for large model files without whole-file buffering. */
export class StreamingSHA256 {
  constructor() {
    this.state = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesHashed = 0;
    this.finished = false;
  }

  update(input) {
    if (this.finished) throw new Error('SHA-256 digest has already been finalized');
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.bytesHashed += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.length) {
      const take = Math.min(64 - this.bufferLength, bytes.length - offset);
      this.buffer.set(bytes.subarray(offset, offset + take), this.bufferLength);
      this.bufferLength += take;
      offset += take;
      if (this.bufferLength === 64) {
        this._transform(this.buffer);
        this.bufferLength = 0;
      }
    }
    return this;
  }

  digest() {
    if (!this.finished) {
      const bitLength = BigInt(this.bytesHashed) * 8n;
      this.buffer[this.bufferLength++] = 0x80;
      if (this.bufferLength > 56) {
        this.buffer.fill(0, this.bufferLength);
        this._transform(this.buffer);
        this.bufferLength = 0;
      }
      this.buffer.fill(0, this.bufferLength, 56);
      for (let index = 0; index < 8; index++) {
        this.buffer[63 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
      }
      this._transform(this.buffer);
      this.finished = true;
    }
    const result = new Uint8Array(32);
    const view = new DataView(result.buffer);
    for (let index = 0; index < 8; index++) view.setUint32(index * 4, this.state[index], false);
    return result;
  }

  hex() {
    return [...this.digest()].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  _transform(chunk) {
    const words = new Uint32Array(64);
    const view = new DataView(chunk.buffer, chunk.byteOffset, 64);
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15], b = words[index - 2];
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index++) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0; this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0; this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0; this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0; this.state[7] = (this.state[7] + h) >>> 0;
  }
}

function rotateRight(value, shift) {
  return (value >>> shift) | (value << (32 - shift));
}

const SHA256_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);

function formatMB(bytes) { return Math.max(0, bytes / (1024 * 1024)).toFixed(0); }
