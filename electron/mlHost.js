/**
 * The WebGPU ML host, running in a hidden renderer.
 *
 * This file is a BROWSER context, not Node: no fs, no require, no ipcRenderer
 * (nodeIntegration is off for this window — see createMlWindow in main.js).
 * It receives JPEG bytes and returns vectors. Diagnostics go to the renderer
 * console, which read_console_messages can read during verification.
 *
 * Bare specifier imports below resolve via the import map in mlHost.html, not
 * node_modules resolution (this is a plain browser module loader) — see that
 * file's comment for why.
 */
import {
  AutoProcessor,
  RawImage,
  SiglipVisionModel,
  CLIPVisionModelWithProjection,
  env,
} from "@huggingface/transformers";

const LOADERS = { SiglipVisionModel, CLIPVisionModelWithProjection };

let loaded = null;

/** Forward a transformers.js progress_callback frame to the main process, if
 * the preload bridge is present. Optional and swallowed on failure — a
 * progress relay is a nice-to-have for the JobsPanel (Task 10), never a
 * reason inference itself should fail. `window.mlBridge` comes from
 * electron/mlHostPreload.cjs; it is absent in any context that loads this
 * file without that preload (there is none in production, but defensive
 * either way — a missing progress channel must degrade quietly, not throw). */
function reportProgress(modelId, frame) {
  try {
    window.mlBridge?.reportProgress?.({ type: "progress", modelId, ...frame });
  } catch {
    // Never let a progress frame's transport break inference.
  }
}

async function ensureModel(spec) {
  if (loaded?.id === spec.id) return loaded;
  env.allowLocalModels = false;
  const progress_callback = (frame) => reportProgress(spec.id, frame);
  const model = await LOADERS[spec.loader].from_pretrained(spec.id, {
    dtype: spec.dtype,
    device: "webgpu",
    progress_callback,
  });
  const processor = await AutoProcessor.from_pretrained(spec.id, {
    progress_callback,
  });
  loaded = { id: spec.id, model, processor, outputKey: spec.outputKey };
  return loaded;
}

window.mlHost = {
  async available() {
    if (!navigator.gpu) return false;
    try {
      return Boolean(await navigator.gpu.requestAdapter());
    } catch {
      return false;
    }
  },

  async configure({ spec }) {
    await ensureModel(spec);
    return { ok: true };
  },

  async embed({ spec, images }) {
    const { model, processor, outputKey } = await ensureModel(spec);
    const raw = await Promise.all(
      images.map((bytes) => RawImage.fromBlob(new Blob([bytes])))
    );
    const out = await model(await processor(raw));
    const tensor = out[outputKey];
    const [n, dim] = tensor.dims;
    const vectors = [];
    for (let i = 0; i < n; i++) {
      vectors.push(Array.from(tensor.data.slice(i * dim, (i + 1) * dim)));
    }
    return { vectors, dim };
  },
};
