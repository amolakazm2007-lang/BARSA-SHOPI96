import { processTiled } from './TileProcessor.js';
import { NativeAiClient } from '../platform/NativeAiClient.js';

// UpscaleEngine — real ONNX Runtime Web integration for AI upscaling
// (Real-ESRGAN / Real-CUGAN style models), with Tile Processing + Overlap
// so a 4K frame is never held whole (plus its intermediate copies) in RAM.
//
export const MODEL_REGISTRY = {
  'onnx-model-zoo-sr-x3': {
    source: 'bundled-audited',
    bundledURL: './models/super-resolution-10.onnx',
    sourcePage: 'https://github.com/onnx/models/tree/main/validated/vision/super_resolution/sub_pixel_cnn_2016',
    license: 'Apache-2.0',
    sha256: '85f36ff88cc504a24af5e0602148bc56a8aa09a58eca8c0da2756f3e8186035e',
    expectedSizeBytes: 240_078,
    format: 'onnx',
    scale: 3,
    channels: 1,
    colorModel: 'ycbcr-luma',
    tileSize: 224,
    overlap: 12,
    label: 'ONNX Model Zoo Mobile ×3',
    recommendedFor: 'mobile',
  },
  'real-esrgan-compatible-x4': {
    source: 'local-import',
    sha256: null,
    format: 'onnx',
    scale: 4,
    tileSize: 256,
    overlap: 16,
    label: 'Real-ESRGAN compatible ×4',
  },
  'real-esrgan-x4plus': {
    source: 'audited-onnx-mirror',
    sourcePage: 'https://github.com/xinntao/Real-ESRGAN',
    mirrorPage: 'https://huggingface.co/notaneimu/onnx-image-models/blob/main/RealESRGAN_x4plus.onnx',
    license: 'BSD-3-Clause (upstream Real-ESRGAN)',
    sha256: 'cd0ec097469c94c903e6f74d4f43f545683250ec0a54bc0c2ab1ff4c6364d8da',
    expectedSizeBytes: 67_167_471,
    format: 'onnx',
    scale: 4,
    tileSize: 128,
    overlap: 12,
    label: 'Real-ESRGAN ×4',
    downloadCandidates: [
      'https://huggingface.co/notaneimu/onnx-image-models/resolve/main/RealESRGAN_x4plus.onnx?download=true',
    ],
  },
  'real-esrgan-x8-facefusion': {
    source: 'local-import',
    sha256: 'ac8b19b572cff261e609d1e80f33df45cd46db1d3f65526f94da70fb7da06a39',
    expectedSizeBytes: 69_600_000,
    format: 'onnx',
    scale: 8,
    tileSize: 256,
    overlap: 12,
  },
  'real-cugan-x2-fp16': {
    source: 'local-import',
    sha256: null,
    format: 'onnx',
    scale: 2,
    tileSize: 256,
    overlap: 12,
  },
};

/**
 * Ordered fallback chain for the "AI Upscale" feature — tried in order
 * until one downloads, verifies, and passes a real self-test inference.
 * This is what "search for alternatives if the model doesn't work and
 * swap to them automatically" actually means as real, testable code: a
 * resolver that tries each candidate and moves on when one fails, rather
 * than a single hardcoded model with no recourse.
 */
export const UPSCALE_FALLBACK_CHAIN = ['onnx-model-zoo-sr-x3', 'real-esrgan-x4plus', 'real-esrgan-compatible-x4', 'real-esrgan-x8-facefusion'];

export class UpscaleEngine {
  constructor(modelManager) {
    this.modelManager = modelManager;
    this.session = null;
    this.sessionModelId = null;
    this.ort = null;
    this.nativeAi = new NativeAiClient();
    this.nativeModelRegistration = new Map();
    this.lastExecutionProvider = null;
  }

  async isAvailable(modelId) {
    const config = MODEL_REGISTRY[modelId];
    if (!config) return { available: false, reason: 'unknown_model' };
    const status = await this.modelManager.getStatus(modelId);
    if (!status.installed || !status.verified) return { available: false, reason: 'not_installed' };
    if (!status.testPassed) return { available: false, reason: 'not_tested' };
    return { available: true };
  }

  async ensureModel(modelId, onProgress, localFile = null) {
    const config = MODEL_REGISTRY[modelId];
    if (!config) throw new Error(`Unknown upscale model: ${modelId}`);
    const status = await this.modelManager.getStatus(modelId);
    if (!status.installed || !status.verified) {
      if (!localFile) {
        const error = new Error(`Import the licensed ONNX file for ${modelId} before enabling AI upscaling`);
        error.code = 'MODEL_REQUIRED';
        throw error;
      }
      await this.modelManager.importModel(modelId, localFile, { ...config, role: 'upscale' }, onProgress);
    }
  }

  /** Downloads an audited catalog model, verifies it, and runs inference. */
  async installCatalogModel(modelId, onProgress = null) {
    const config = MODEL_REGISTRY[modelId];
    if (!config?.bundledURL && !config?.remoteURL && !config?.downloadCandidates?.length) throw new Error('هذا الملف غير متوفر للتنزيل التلقائي؛ استخدم استيراد ONNX');
    if (config.bundledURL) await this.modelManager.installBundled(modelId, config.bundledURL, { ...config, role: 'upscale' }, onProgress);
    else await this.modelManager.installFromCandidates(modelId, { ...config, role: 'upscale' }, onProgress);
    await this.runSelfTest(modelId);
    return this.modelManager.getStatus(modelId);
  }

  /**
   * Walks UPSCALE_FALLBACK_CHAIN in order: downloads, verifies, and
   * self-tests each candidate until one actually succeeds, returning that
   * model's id. If a candidate's download or hash check fails, or its
   * self-test inference fails, it moves on to the next one automatically
   * rather than giving up outright. Returns null only if every candidate
   * in the chain failed — at that point there is genuinely no working
   * model, and the caller must fall back to non-AI processing.
   *
   * This is the concrete mechanism behind "if a model doesn't work, find
   * another one with similar power and swap to it automatically" — real,
   * runnable code, not a promise. It can only be exercised end-to-end with
   * a live network connection; see UpscaleEngine.fallback.test.mjs for a
   * mocked test proving the SWITCHING LOGIC itself is correct.
   */
  async resolveWorkingModel(onProgress) {
    const errors = [];
    for (const modelId of UPSCALE_FALLBACK_CHAIN) {
      const config = MODEL_REGISTRY[modelId];
      if (!config) { errors.push(`${modelId}: unknown`); continue; }
      try {
        onProgress?.({ stage: 'trying', modelId });
        const status = await this.modelManager.getStatus(modelId);
        if (!status.installed || !status.verified) {
          if (config.bundledURL) await this.modelManager.installBundled(modelId, config.bundledURL, { ...config, role: 'upscale' }, (p) => onProgress?.({ stage: 'installing', modelId, ...p }));
          else if (config.remoteURL || config.downloadCandidates?.length) {
            if (typeof this.modelManager.installFromCandidates === 'function') await this.modelManager.installFromCandidates(modelId, { ...config, role: 'upscale' }, (p) => onProgress?.({ stage: 'downloading', modelId, ...p }));
            else if (config.remoteURL && typeof this.modelManager.installFromURL === 'function') await this.modelManager.installFromURL(modelId, config.remoteURL, { ...config, role: 'upscale' }, (p) => onProgress?.({ stage: 'downloading', modelId, ...p }));
            else await this.ensureModel(modelId, (p) => onProgress?.({ stage: 'importing', modelId, ...p }));
          }
          else await this.ensureModel(modelId, (p) => onProgress?.({ stage: 'importing', modelId, ...p }));
        }
        onProgress?.({ stage: 'testing', modelId });
        await this.runSelfTest(modelId);
        return modelId; // first candidate that fully succeeds
      } catch (e) {
        console.warn(`Upscale model candidate "${modelId}" failed, trying next in chain:`, e.message);
        errors.push(`${modelId}: ${e.message}`);
        this.session?.release?.();
        this.session = null; // don't carry a half-initialized session into the next candidate
        this.sessionModelId = null;
      }
    }
    console.error('All upscale model candidates failed:', errors.join(' | '));
    return null;
  }

  async _loadSession(modelId) {
    if (this.session && this.sessionModelId === modelId) return this.session;
    if (this.session) {
      this.session.release?.();
      this.session = null;
    }
    if (!this.ort) {
      this.ort = await import('onnxruntime-web/webgpu');
      this.ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      this.ort.env.wasm.wasmPaths = new URL('./vendor/ort-wasm/', document.baseURI).href;
    }
    const buffer = await this.modelManager.loadModelBuffer(modelId);
    // WebGPU EP first, WASM EP fallback — matches EngineManager's priority.
    try {
      this.session = await this.ort.InferenceSession.create(buffer, { executionProviders: ['webgpu'] });
      this.executionProvider = 'webgpu';
    } catch (e) {
      this.session = await this.ort.InferenceSession.create(buffer, { executionProviders: ['wasm'] });
      this.executionProvider = 'wasm';
    }
    this.sessionModelId = modelId;
    return this.session;
  }

  /**
   * Run one real test inference on a small synthetic tile. Only after this
   * succeeds should the caller mark the model as "tested" (ModelManager
   * .markTestPassed) — matching the spec's rule that an AI feature isn't
   * "ready" until it has actually run inference successfully.
   *
   * IMPORTANT: Qualcomm AI Hub exports (like real-esrgan-x4plus above) are
   * frequently compiled for a FIXED input resolution rather than dynamic
   * H/W, because they're optimized for mobile NPU deployment. This method
   * reads the model's actual declared input shape first and uses that,
   * instead of assuming an arbitrary 64x64 will be accepted — an assumption
   * that would fail this exact model in practice.
   */
  async runSelfTest(modelId) {
    const config = MODEL_REGISTRY[modelId];
    const session = await this._loadSession(modelId);
    const inputName = session.inputNames[0];
    // onnxruntime-web exposes static dims via session.inputMetadata in
    // recent versions; fall back to a conservative 64x64 guess if the
    // model declares dynamic dims (-1) and metadata isn't available.
    let [n, c, h, w] = [1, config.channels || 3, config.tileSize || 64, config.tileSize || 64];
    try {
      const dims = session.inputMetadata?.[0]?.dimensions;
      if (dims && dims.length === 4 && dims[2] > 0 && dims[3] > 0) {
        [n, c, h, w] = [1, dims[1], dims[2], dims[3]];
      }
    } catch { /* metadata not available in this ORT build — use the 64x64 fallback */ }

    const testTile = new Float32Array(c * h * w).fill(0.5);
    const tensor = new this.ort.Tensor('float32', testTile, [n, c, h, w]);
    const outputs = await session.run({ [inputName]: tensor });
    const outName = session.outputNames[0];
    const outTensor = outputs[outName];
    const expectedLen = c * (h * config.scale) * (w * config.scale);
    if (outTensor.data.length !== expectedLen) {
      throw new Error(`Self-test output shape mismatch: got ${outTensor.data.length}, expected ${expectedLen} (input was ${w}x${h}, scale ${config.scale}). Do not mark this model as ready — check whether the actual scale factor or channel layout differs from what's assumed here.`);
    }
    await this.modelManager.markTestPassed(modelId, {
      executionProvider: this.executionProvider,
      signature: { input: inputName, inputShape: [n, c, h, w], output: outName, outputLength: outTensor.data.length, scale: config.scale },
    });
    return true;
  }

  async warmup(modelId) {
    const session = await this._loadSession(modelId);
    return {
      executionProvider: this.executionProvider,
      inputNames: [...session.inputNames],
      outputNames: [...session.outputNames],
    };
  }

  /** Runs one tile through the currently selected ONNX session. */
  async upscaleTile(modelId, input, width, height, { signal = null, preferNative = true } = {}) {
    const config = MODEL_REGISTRY[modelId];
    if (!config) throw new Error(`Unknown upscale model: ${modelId}`);
    const channels = config.channels || 3;
    const expected = channels * width * height;
    if (input.length !== expected) throw new Error(`Upscale tile input has ${input.length} values; expected ${expected}`);

    // Android v6.5 path: register the verified ONNX model once, then send only
    // raw Float32 tile tensors through the localhost binary API. Any failure
    // disables native inference for this model for the current session and
    // transparently falls back to WebGPU/WASM below.
    if (preferNative && this.nativeAi.available && !this.nativeAi.disabledModels.has(modelId)) {
      try {
        let pending = this.nativeModelRegistration.get(modelId);
        if (!pending) {
          pending = Promise.all([this.modelManager.loadModelBuffer(modelId), this.modelManager.getStatus(modelId)]).then(([buffer, status]) => this.nativeAi.ensureModel(modelId, buffer, { sha256: status?.sha256 || config.sha256 || '' }));
          this.nativeModelRegistration.set(modelId, pending);
        }
        await pending;
        const nativeOutput = await this.nativeAi.infer(modelId, input, { channels, width, height, scale: config.scale, signal });
        this.lastExecutionProvider = `android-native:${nativeOutput.provider}`;
        return nativeOutput;
      } catch (error) {
        console.warn(`Native AI tile failed for ${modelId}; falling back to WebGPU/WASM:`, error?.message || error);
        this.nativeAi.disableModel(modelId);
        this.nativeModelRegistration.delete(modelId);
      }
    }

    const session = await this._loadSession(modelId);
    const dimensions = session.inputMetadata?.[0]?.dimensions || [];
    const runHeight = Number(dimensions[2]) > 0 ? Number(dimensions[2]) : height;
    const runWidth = Number(dimensions[3]) > 0 ? Number(dimensions[3]) : width;
    if (width > runWidth || height > runHeight) throw new Error(`Tile ${width}x${height} exceeds fixed model input ${runWidth}x${runHeight}`);
    const prepared = runWidth === width && runHeight === height ? input : padCHWEdge(input, channels, width, height, runWidth, runHeight);
    const tensor = new this.ort.Tensor('float32', prepared, [1, channels, runHeight, runWidth]);
    const outputs = await session.run({ [session.inputNames[0]]: tensor });
    const output = outputs[session.outputNames[0]];
    const expectedOutput = channels * runWidth * config.scale * runHeight * config.scale;
    if (!output?.data || output.data.length !== expectedOutput) throw new Error(`Upscale output shape is incompatible: ${output?.data?.length || 0} values, expected ${expectedOutput}`);
    this.lastExecutionProvider = this.executionProvider;
    if (runWidth === width && runHeight === height) return output;
    return { ...output, data: cropCHW(output.data, channels, runWidth * config.scale, width * config.scale, height * config.scale) };
  }

  /**
   * Upscales one full frame using tile processing, so memory stays bounded
   * regardless of source resolution — this is the integration piece that
   * was previously missing (the model could load and self-test, but was
   * never actually applied to real video frames). Converts each tile to
   * the CHW float32 tensor layout the ONNX model expects, runs it through
   * upscaleTile(), converts the result back to RGBA, and lets
   * TileProcessor handle the overlap-blended reassembly (verified
   * separately — see TileProcessor.js header — to have zero seam
   * artifacts from the blending math itself).
   *
   * @param {CanvasRenderingContext2D} srcCtx - source frame already drawn onto some canvas
   * @param {CanvasRenderingContext2D} destCtx - destination context, sized width*scale x height*scale
   * @param {{tileSize:number, overlap:number, concurrency?:number}} tileConfig
   */
  async upscaleFrame(modelId, srcCtx, width, height, destCtx, tileConfig) {
    const config = MODEL_REGISTRY[modelId];
    const { scale } = config;
    const { tileSize, overlap, concurrency = 1, signal = null, onProgress = null } = tileConfig;
    const effectiveTileSize = Math.min(tileSize, config.tileSize || tileSize);

    const result = await processTiled({
      srcCtx, destCtx, width, height, scale, tileSize: effectiveTileSize, overlap: Math.min(overlap, effectiveTileSize - 1), concurrency, signal, onProgress,
      runInference: async (tileImageData) => {
        if (config.colorModel === 'ycbcr-luma') {
          const luma = imageDataToLumaFloat32(tileImageData);
          const outTensor = await this.upscaleTile(modelId, luma, tileImageData.width, tileImageData.height, { signal });
          return lumaToUpscaledImageData(outTensor.data, tileImageData, scale);
        }
        const chw = imageDataToChwFloat32(tileImageData);
        const outTensor = await this.upscaleTile(modelId, chw, tileImageData.width, tileImageData.height, { signal });
        return chwFloat32ToImageData(outTensor.data, tileImageData.width * scale, tileImageData.height * scale);
      },
    });
    result.compose(destCtx);
    result.release();
  }

  destroy() {
    this.session?.release?.();
    this.session = null;
    this.sessionModelId = null;
    this.nativeModelRegistration.clear();
  }
}

/** RGBA ImageData (0..255 ints) -> CHW float32 (0..1), the standard ONNX vision-model input layout. */
export function imageDataToChwFloat32(imageData) {
  const { width, height, data } = imageData;
  const chw = new Float32Array(3 * width * height);
  const plane = width * height;
  for (let i = 0; i < plane; i++) {
    chw[i] = data[i * 4] / 255;               // R
    chw[plane + i] = data[i * 4 + 1] / 255;   // G
    chw[2 * plane + i] = data[i * 4 + 2] / 255; // B
  }
  return chw;
}

/** CHW float32 (0..1) model output -> RGBA ImageData (0..255 ints) for canvas compositing. */
export function chwFloat32ToImageData(chw, width, height) {
  const plane = width * height;
  const data = new Uint8ClampedArray(4 * plane);
  for (let i = 0; i < plane; i++) {
    data[i * 4] = Math.round(chw[i] * 255);
    data[i * 4 + 1] = Math.round(chw[plane + i] * 255);
    data[i * 4 + 2] = Math.round(chw[2 * plane + i] * 255);
    data[i * 4 + 3] = 255;
  }
  return new ImageData(data, width, height);
}

/** RGBA -> normalized Y channel used by the ONNX Model Zoo mobile SR model. */
export function imageDataToLumaFloat32(imageData) {
  const { width, height, data } = imageData;
  const output = new Float32Array(width * height);
  for (let i = 0; i < output.length; i++) output[i] = (data[i * 4] * .299 + data[i * 4 + 1] * .587 + data[i * 4 + 2] * .114) / 255;
  return output;
}

/** Recombines model-upscaled Y with bilinearly scaled Cb/Cr color planes. */
export function lumaToUpscaledImageData(luma, source, scale) {
  const width = source.width * scale, height = source.height * scale;
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = (x + .5) / scale - .5, sy = (y + .5) / scale - .5;
    const [r0, g0, b0] = sampleRGBBilinear(source, sx, sy);
    const cb = -.168736 * r0 - .331264 * g0 + .5 * b0 + .5;
    const cr = .5 * r0 - .418688 * g0 - .081312 * b0 + .5;
    const yy = Math.max(0, Math.min(1, luma[y * width + x]));
    const index = (y * width + x) * 4;
    output[index] = clampByte((yy + 1.402 * (cr - .5)) * 255);
    output[index + 1] = clampByte((yy - .344136 * (cb - .5) - .714136 * (cr - .5)) * 255);
    output[index + 2] = clampByte((yy + 1.772 * (cb - .5)) * 255);
    output[index + 3] = 255;
  }
  return new ImageData(output, width, height);
}

function sampleRGBBilinear(image, x, y) {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x))), y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1), tx = Math.max(0, Math.min(1, x - x0)), ty = Math.max(0, Math.min(1, y - y0));
  const read = (px, py, channel) => image.data[(py * image.width + px) * 4 + channel] / 255;
  const mix = (a, b, t) => a + (b - a) * t;
  return [0, 1, 2].map((channel) => mix(mix(read(x0, y0, channel), read(x1, y0, channel), tx), mix(read(x0, y1, channel), read(x1, y1, channel), tx), ty));
}

function clampByte(value) { return Math.max(0, Math.min(255, Math.round(value))); }

function padCHWEdge(input, channels, width, height, targetWidth, targetHeight) {
  const output = new Float32Array(channels * targetWidth * targetHeight), sourcePlane = width * height, targetPlane = targetWidth * targetHeight;
  for (let channel = 0; channel < channels; channel++) for (let y = 0; y < targetHeight; y++) for (let x = 0; x < targetWidth; x++) {
    output[channel * targetPlane + y * targetWidth + x] = input[channel * sourcePlane + Math.min(y, height - 1) * width + Math.min(x, width - 1)];
  }
  return output;
}

function cropCHW(input, channels, sourceWidth, width, height) {
  const sourcePlane = input.length / channels, sourceHeight = sourcePlane / sourceWidth, output = new Float32Array(channels * width * height), outputPlane = width * height;
  if (!Number.isInteger(sourceHeight)) throw new Error('Invalid fixed-model output geometry');
  for (let channel = 0; channel < channels; channel++) for (let y = 0; y < height; y++) {
    output.set(input.subarray(channel * sourcePlane + y * sourceWidth, channel * sourcePlane + y * sourceWidth + width), channel * outputPlane + y * width);
  }
  return output;
}
