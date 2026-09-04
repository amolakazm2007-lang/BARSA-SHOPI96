// RIFEEngine — real AI frame interpolation via Android Native ONNX / WebGPU / WASM.
import { NativeAiClient } from '../platform/NativeAiClient.js';
//
// RIFE exports use several input signatures. Two conventions are
// common across RIFE ONNX exports found in the wild:
//   (a) two separate inputs, each [1,3,H,W]  — used by most Python exports
//   (b) one concatenated input [1,6,H,W]     — frame0 and frame1 stacked
//       on the channel axis (seen in the TensorForger/RIFE-safetensors
//       reference implementation found during research)
// _loadSession() inspects the loaded model and selects the correct path.
//
// Also likely true of this and most RIFE ONNX exports: they implement a
// single fixed midpoint (t=0.5), not an arbitrary timestep input. So
// interpolate() below does NOT expose a timestep tensor at all — instead,
// ×4 interpolation is done by recursive midpoint splitting (interpolate
// A-B → M, then A-M → Q1 and M-B → Q3), which works with a midpoint-only
// model and is how several real RIFE integrations handle >2x anyway.

export const RIFE_MODEL_REGISTRY = {
  'rife-compatible': {
    source: 'local-import',
    sha256: null,
    format: 'onnx',
    label: 'RIFE compatible ONNX',
  },
  'rife-tensorstack': {
    source: 'audited-onnx-mirror',
    sourcePage: 'https://huggingface.co/TensorStack/RIFE',
    license: 'community ONNX export; verify source terms before redistribution',
    sha256: '76e4cef9ab42fa7dd4e8f6e4aba47462051e3faa969e4bca6479784fbab0ac6f',
    expectedSizeBytes: 21_458_882,
    format: 'onnx',
    label: 'RIFE 4.9 ONNX',
    downloadCandidates: [
      'https://huggingface.co/yuvraj108c/rife-onnx/resolve/main/rife49_ensemble_True_scale_1_sim.onnx?download=true',
      'https://huggingface.co/EmmaJohnson311/TensorRT-ONNX-collect/resolve/main/rife-onnx/rife49_ensemble_True_scale_1_sim.onnx?download=true',
    ],
  },
  'rife47-emmajohnson311': {
    source: 'audited-onnx-mirror',
    sourcePage: 'https://huggingface.co/yuvraj108c/rife-onnx',
    license: 'community ONNX export; verify source terms before redistribution',
    sha256: '0a3a52814d07d919b8336c6b66677baaeeec517bdd4ac4f6852d4bf2680ebb5a',
    expectedSizeBytes: 21_458_882,
    format: 'onnx',
    label: 'RIFE 4.7 ONNX',
    downloadCandidates: [
      'https://huggingface.co/yuvraj108c/rife-onnx/resolve/main/rife47_ensemble_True_scale_1_sim.onnx?download=true',
      'https://huggingface.co/EmmaJohnson311/TensorRT-ONNX-collect/resolve/main/rife-onnx/rife47_ensemble_True_scale_1_sim.onnx?download=true',
    ],
  },
};

/** Same fallback-chain mechanism as UpscaleEngine — see its comment for the full rationale. */
export const RIFE_FALLBACK_CHAIN = ['rife-compatible', 'rife-tensorstack', 'rife47-emmajohnson311'];

export class RIFEEngine {
  constructor(modelManager) {
    this.modelManager = modelManager;
    this.session = null;
    this.sessionModelId = null;
    this.ort = null;
    this.signature = null;
    this.preferGpu = true;
    this.nativeAi = new NativeAiClient();
    this.nativePrepared = new Set();
    this.lastExecutionProvider = null;
  }

  setExecutionPreference(preferGpu = true) {
    const next = preferGpu !== false;
    if (this.preferGpu !== next) {
      this.preferGpu = next;
      this.session?.release?.();
      this.session = null;
      this.sessionModelId = null;
      this.signature = null;
    }
  }

  async isAvailable(modelId = 'rife-tensorstack') {
    const config = RIFE_MODEL_REGISTRY[modelId];
    if (!config) return { available: false, reason: 'unknown_model' };
    const status = await this.modelManager.getStatus(modelId);
    if (!status.installed || !status.verified) return { available: false, reason: 'not_installed' };
    if (!status.testPassed) return { available: false, reason: 'not_tested' };
    return { available: true };
  }

  async installCatalogModel(modelId, onProgress = null) {
    const config = RIFE_MODEL_REGISTRY[modelId];
    if (!config?.remoteURL && !config?.downloadCandidates?.length) throw new Error('هذا نموذج RIFE عام ويحتاج استيراد ONNX يدوياً');
    await this.modelManager.installFromCandidates(modelId, { ...config, role: 'interpolation' }, onProgress);
    await this.runSelfTest(modelId);
    return this.modelManager.getStatus(modelId);
  }

  async ensureModel(modelId, onProgress, localFile = null) {
    const config = RIFE_MODEL_REGISTRY[modelId];
    if (!config) throw new Error(`Unknown RIFE model: ${modelId}`);
    const status = await this.modelManager.getStatus(modelId);
    if (!status.installed || !status.verified) {
      if (!localFile) {
        const error = new Error(`Import the licensed ONNX file for ${modelId} before enabling frame interpolation`);
        error.code = 'MODEL_REQUIRED';
        throw error;
      }
      await this.modelManager.importModel(modelId, localFile, { ...config, role: 'interpolation' }, onProgress);
    }
  }

  /** Same fallback-chain mechanism as UpscaleEngine.resolveWorkingModel — see its comment. */
  async resolveWorkingModel(onProgress) {
    const errors = [];
    for (const modelId of RIFE_FALLBACK_CHAIN) {
      const config = RIFE_MODEL_REGISTRY[modelId];
      if (!config) { errors.push(`${modelId}: unknown`); continue; }
      try {
        onProgress?.({ stage: 'trying', modelId });
        if (typeof this.modelManager.getStatus === 'function') {
          const status = await this.modelManager.getStatus(modelId);
          if (!status.installed || !status.verified) {
            if ((config.remoteURL || config.downloadCandidates?.length) && typeof this.modelManager.installFromCandidates === 'function') {
              await this.modelManager.installFromCandidates(modelId, { ...config, role: 'interpolation' }, (p) => onProgress?.({ stage: 'downloading', modelId, ...p }));
            } else {
              await this.ensureModel(modelId, (p) => onProgress?.({ stage: 'importing', modelId, ...p }));
            }
          }
        } else {
          // Keeps the engine testable with a minimal injected manager and
          // preserves the original ensureModel fallback contract.
          await this.ensureModel(modelId, (p) => onProgress?.({ stage: 'importing', modelId, ...p }));
        }
        onProgress?.({ stage: 'testing', modelId });
        await this.runSelfTest(modelId);
        return modelId;
      } catch (e) {
        console.warn(`RIFE model candidate "${modelId}" failed, trying next in chain:`, e.message);
        errors.push(`${modelId}: ${e.message}`);
        this.session?.release?.();
        this.session = null;
        this.sessionModelId = null;
      }
    }
    console.error('All RIFE model candidates failed:', errors.join(' | '));
    return null;
  }

  async _loadSession(modelId) {
    if (this.session && this.sessionModelId === modelId) return this.session;
    if (this.session) {
      this.session.release?.();
      this.session = null;
      this.signature = null;
    }
    if (!this.ort) {
      this.ort = await import('onnxruntime-web/webgpu');
      this.ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      this.ort.env.wasm.wasmPaths = new URL('./vendor/ort-wasm/', document.baseURI).href;
    }
    const buffer = await this.modelManager.loadModelBuffer(modelId);
    if (this.preferGpu) {
      try {
        this.session = await this.ort.InferenceSession.create(buffer, { executionProviders: ['webgpu'] });
        this.executionProvider = 'webgpu';
      } catch {
        this.session = await this.ort.InferenceSession.create(buffer, { executionProviders: ['wasm'] });
        this.executionProvider = 'wasm';
      }
    } else {
      this.session = await this.ort.InferenceSession.create(buffer, { executionProviders: ['wasm'] });
      this.executionProvider = 'wasm';
    }
    this.sessionModelId = modelId;
    this.signature = inspectRifeSignature(this.session);
    return this.session;
  }

  async runSelfTest(modelId = 'rife-tensorstack') {
    const session = await this._loadSession(modelId);
    const signature = this.signature || inspectRifeSignature(session);
    const w = signature.width || 64, h = signature.height || 64;
    const frame0 = new Float32Array(3 * h * w).fill(0.3);
    const frame1 = new Float32Array(3 * h * w).fill(0.7);
    const feeds = buildRifeFeeds(session, this.ort, signature, frame0, frame1, w, h, 0.5);
    const outputs = await session.run(feeds);
    const out = selectRifeOutput(session, outputs, 3 * h * w);
    if (!out) {
      const sizes = Object.values(outputs).map((tensor) => tensor?.data?.length || 0).join(', ');
      throw new Error(`RIFE self-test output size mismatch: got [${sizes}], expected ${3 * h * w}. Do not mark as ready.`);
    }
    await this.modelManager.markTestPassed(modelId, {
      executionProvider: this.executionProvider,
      signature: { ...signature, width: w, height: h, output: out.name },
    });
    return true;
  }

  /**
   * Generates the midpoint frame between frame0 and frame1. This export is
   * assumed to be a fixed-t=0.5 model (see file header) — there is no
   * timestep input wired here because guessing at one that doesn't exist
   * would silently produce garbage rather than fail loudly.
   */
  async interpolateMidpoint(modelId, frame0Chw, frame1Chw, width, height, timestep = 0.5) {
    const config = RIFE_MODEL_REGISTRY[modelId] || {};
    // Native Android RIFE is intentionally gated to <=1080p per call. A pair
    // of raw 4K float tensors exceeds 190 MB before ORT activations, which is
    // the opposite of stable mobile rendering. 4K keeps the WebGPU/WASM path
    // unless a future zero-copy native decoder surface is available.
    if (this.nativeAi.available && width * height <= 1920 * 1080 && !this.nativeAi.disabledModels.has(modelId)) {
      try {
        if (!this.nativePrepared.has(modelId)) {
          const status = await this.modelManager.getStatus(modelId).catch(() => ({}));
          const ready = await this.nativeAi.ensureModelLazy(modelId, {
            bytes: status?.size || config.expectedSizeBytes || 0, sha256: status?.sha256 || config.sha256 || '',
            load: () => this.modelManager.loadModelBuffer(modelId),
          });
          if (!ready) throw new Error('Android native RIFE model registration failed');
          this.nativePrepared.add(modelId);
        }
        const native = await this.nativeAi.inferRife(modelId, frame0Chw, frame1Chw, { width, height, timestep });
        this.executionProvider = `android-native:${native.provider}`;
        this.lastExecutionProvider = this.executionProvider;
        return { data:native.data, dims:[1,3,native.height,native.width] };
      } catch (error) {
        console.warn(`Native RIFE failed for ${modelId}; falling back to WebGPU/WASM:`, error?.message || error);
        this.nativeAi.disableModel(modelId);
      }
    }
    const session = await this._loadSession(modelId);
    const signature = this.signature || inspectRifeSignature(session);
    assertDynamicOrMatchingSize(signature, width, height);
    const feeds = buildRifeFeeds(session, this.ort, signature, frame0Chw, frame1Chw, width, height, timestep);
    const outputs = await session.run(feeds);
    const output = selectRifeOutput(session, outputs, 3 * width * height);
    if (!output) throw new Error(`RIFE returned no RGB frame matching ${width}x${height}`);
    this.lastExecutionProvider = this.executionProvider;
    return output.tensor;
  }

  /**
   * ×4 interpolation via recursive midpoint splitting — works with a
   * midpoint-only (t=0.5) model, which is the safest assumption for this
   * unverified export. Returns [quarter1, midpoint, quarter3] in order.
   */
  async interpolateX4(modelId, frame0Chw, frame1Chw, width, height) {
    const midData = await this.interpolateMidpoint(modelId, frame0Chw, frame1Chw, width, height);
    const mid = midData.data;
    // Run sequentially to avoid two simultaneous ONNX activation graphs on
    // mobile GPUs, which can otherwise double peak VRAM.
    const q1Data = await this.interpolateMidpoint(modelId, frame0Chw, mid, width, height);
    const q3Data = await this.interpolateMidpoint(modelId, mid, frame1Chw, width, height);
    return [q1Data.data, mid, q3Data.data];
  }

  async interpolateAt(modelId, frame0Chw, frame1Chw, width, height, t, depth = 3) {
    if (t <= 0.001) return frame0Chw;
    if (t >= 0.999) return frame1Chw;
    await this._loadSession(modelId);
    if (this.signature?.timestepInput) {
      return (await this.interpolateMidpoint(modelId, frame0Chw, frame1Chw, width, height, t)).data;
    }
    const midpointTensor = await this.interpolateMidpoint(modelId, frame0Chw, frame1Chw, width, height);
    const midpoint = midpointTensor.data;
    if (depth <= 0 || Math.abs(t - 0.5) < 0.04) return midpoint;
    if (t < 0.5) return this.interpolateAt(modelId, frame0Chw, midpoint, width, height, t * 2, depth - 1);
    return this.interpolateAt(modelId, midpoint, frame1Chw, width, height, (t - 0.5) * 2, depth - 1);
  }

  async warmup(modelId) {
    await this._loadSession(modelId);
    return { executionProvider: this.executionProvider, signature: this.signature };
  }

  /** Plan which interpolation calls are needed for a given conversion. */
  static planForConversion(fromFps, toFps) {
    const ratio = toFps / fromFps;
    if (Math.abs(ratio - 2) < 0.01) return { factor: 2, method: 'interpolateMidpoint' };
    if (Math.abs(ratio - 4) < 0.01) return { factor: 4, method: 'interpolateX4' };
    return { factor: null, method: null, note: 'Non-integer or unsupported ratio — fall back to Basic FPS boost (no AI) and label it as such.' };
  }

  destroy() {
    this.session?.release?.();
    this.session = null;
    this.sessionModelId = null;
    this.signature = null;
    this.nativePrepared.clear();
    this.lastExecutionProvider = null;
  }
}

/** Classifies common RIFE ONNX signatures, including timestep and scale inputs. */
export function inspectRifeSignature(session) {
  const inputs = (session.inputNames || []).map((name, index) => ({
    name,
    dimensions: inputDimensions(session, name, index),
  }));
  const imageInputs = inputs.filter((input) => {
    const channels = positiveDimension(input.dimensions[1]);
    return input.dimensions.length >= 4 && (channels === 3 || channels === 6);
  });
  let convention;
  if (imageInputs.some((input) => positiveDimension(input.dimensions[1]) === 6)) convention = 'concat';
  else if (imageInputs.filter((input) => positiveDimension(input.dimensions[1]) === 3).length >= 2) convention = 'dual';
  else if (inputs.length === 1) convention = 'concat';
  else {
    const namedFrames = inputs.filter((input) => /(img|image|frame|input)[_ -]?[01ab]?/i.test(input.name) && input.dimensions.length >= 4);
    if (namedFrames.length >= 2) convention = 'dual';
    else throw new Error('Unsupported RIFE signature: expected two RGB inputs or one six-channel input');
  }
  const frameInputs = convention === 'concat'
    ? [imageInputs.find((input) => positiveDimension(input.dimensions[1]) === 6) || inputs[0]]
    : imageInputs.filter((input) => positiveDimension(input.dimensions[1]) === 3).slice(0, 2);
  const auxiliary = inputs.filter((input) => !frameInputs.some((frame) => frame.name === input.name));
  const timestep = auxiliary.find((input) => /(time|timestep|ratio|t$)/i.test(input.name));
  const scale = auxiliary.find((input) => /scale/i.test(input.name));
  const unsupported = auxiliary.filter((input) => input !== timestep && input !== scale);
  if (unsupported.length) throw new Error(`Unsupported RIFE auxiliary inputs: ${unsupported.map((item) => item.name).join(', ')}`);
  const dimensions = frameInputs[0]?.dimensions || [];
  return {
    convention,
    frameInputs: frameInputs.map((input) => input.name),
    timestepInput: timestep?.name || null,
    scaleInput: scale?.name || null,
    width: positiveDimension(dimensions[3]),
    height: positiveDimension(dimensions[2]),
  };
}

export function buildRifeFeeds(session, ort, signature, frame0, frame1, width, height, timestep = 0.5) {
  const feeds = {};
  if (signature.convention === 'concat') {
    const concat = new Float32Array(6 * width * height);
    concat.set(frame0, 0); concat.set(frame1, 3 * width * height);
    feeds[signature.frameInputs[0]] = new ort.Tensor('float32', concat, [1, 6, height, width]);
  } else {
    feeds[signature.frameInputs[0]] = new ort.Tensor('float32', frame0, [1, 3, height, width]);
    feeds[signature.frameInputs[1]] = new ort.Tensor('float32', frame1, [1, 3, height, width]);
  }
  if (signature.timestepInput) feeds[signature.timestepInput] = makeScalarFeed(session, ort, signature.timestepInput, timestep);
  if (signature.scaleInput) feeds[signature.scaleInput] = makeScalarFeed(session, ort, signature.scaleInput, 1);
  return feeds;
}

function makeScalarFeed(session, ort, name, value) {
  const index = session.inputNames.indexOf(name);
  const dimensions = inputDimensions(session, name, index).map((dimension) => positiveDimension(dimension) || 1);
  const shape = dimensions.length ? dimensions : [];
  const count = Math.max(1, shape.reduce((total, dimension) => total * dimension, 1));
  return new ort.Tensor('float32', new Float32Array(count).fill(value), shape);
}

function selectRifeOutput(session, outputs, expectedLength) {
  for (const name of session.outputNames || Object.keys(outputs)) {
    const tensor = outputs[name];
    if (tensor?.data?.length === expectedLength) return { name, tensor };
  }
  return null;
}

function inputDimensions(session, name, index) {
  const metadata = session.inputMetadata;
  const item = Array.isArray(metadata) ? metadata[index] : metadata?.[name] || metadata?.[index];
  return item?.dimensions || item?.shape || [];
}

function positiveDimension(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function assertDynamicOrMatchingSize(signature, width, height) {
  if (signature.width && signature.width !== width) throw new Error(`RIFE model requires width ${signature.width}, received ${width}`);
  if (signature.height && signature.height !== height) throw new Error(`RIFE model requires height ${signature.height}, received ${height}`);
}
