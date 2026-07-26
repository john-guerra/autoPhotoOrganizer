/**
 * The vetted vision encoders, and everything the loader needs to drive each one.
 *
 * Deliberately a short allowlist rather than "any Hugging Face id". An arbitrary
 * id is an arbitrary download into the user's machine, and a model whose output
 * shape we have not checked writes plausible vectors of the wrong dimension —
 * which nothing downstream can detect.
 *
 * Both entries have vision-only int8 ONNX exports. The TEXT encoder is
 * deliberately not loaded here: #161 needs image vectors only, and skipping it
 * saves both the download and the resident RAM until #164 wants it.
 */
export const MODELS = [
  {
    id: "Xenova/siglip-base-patch16-224",
    label: "SigLIP base (better quality)",
    // SigLIP has no projection head — the pooled encoder output IS the
    // embedding. CLIP's is behind a projection, hence the differing key below.
    loader: "SiglipVisionModel",
    outputKey: "pooler_output",
    dim: 768,
    dtype: "int8",
    // Measured, not guessed: a real from_pretrained() download of the int8
    // ONNX export (vision_model_int8.onnx + config + preprocessor config)
    // came to 94,099,141 bytes on 2026-07-25 — confirmed against Hugging
    // Face's own reported file size for onnx/vision_model_int8.onnx
    // (94,098,316 bytes) plus a few KB of config JSON. Deliberately decimal
    // MB (bytes / 1e6 = 94.1, rounded), NOT MiB (bytes / 1048576 = 89.7) —
    // this is rendered in a later task's settings panel before the user
    // starts the download, and decimal MB is what the OS/browser will show
    // while it runs, so a user watching "94 MB" tick by against a panel
    // that said "90 MB" would think the panel was wrong.
    approxDownloadMB: 94,
    // The settings panel shows this BEFORE the enable toggle, because turning
    // embedding on is the moment the user consents to fetching this file —
    // "first use shows what is being fetched, how big, and its licence" (the
    // spec's own words). Named with the UPSTREAM repo the Xenova export was
    // converted from, since that repo is where the licence is actually
    // declared: google/siglip-base-patch16-224 is Apache-2.0.
    licence: "Apache-2.0 (upstream google/siglip-base-patch16-224)",
    note: "~4x the CPU cost of CLIP per photo, clearly better zero-shot accuracy",
  },
  {
    id: "Xenova/clip-vit-base-patch32",
    label: "CLIP ViT-B/32 (faster)",
    loader: "CLIPVisionModelWithProjection",
    outputKey: "image_embeds",
    dim: 512,
    dtype: "int8",
    // Measured the same way as SigLIP above: 88,653,921 bytes for the int8
    // vision_model_int8.onnx + config + preprocessor config, 2026-07-25 —
    // confirmed against Hugging Face's reported 88,648,877 bytes for
    // onnx/vision_model_int8.onnx plus a few KB of config JSON. Decimal MB
    // (bytes / 1e6 = 88.65, rounded), not MiB (84.5) — see the note on the
    // SigLIP entry above for why. The original 45 MB estimate undersold
    // this by roughly half — "faster to run" (fewer patches) is not the
    // same as "smaller to download"; CLIP and SigLIP's downloads are
    // actually close in size.
    approxDownloadMB: 89,
    // See the SigLIP entry above for why this is here and why it names the
    // upstream repo: openai/clip-vit-base-patch32 is MIT.
    licence: "MIT (upstream openai/clip-vit-base-patch32)",
    note: "49 patches instead of 196 — much cheaper, lower accuracy",
  },
];

export const DEFAULT_MODEL_ID = "Xenova/siglip-base-patch16-224";

/** @param {string} id @returns {typeof MODELS[number]} */
export function modelById(id) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown model: ${id}`);
  return m;
}
