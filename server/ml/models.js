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
    // came to 94,099,141 bytes (89.7 MB) on 2026-07-25. Rendered in a later
    // task's settings panel before the user starts the download — a wrong
    // number there is a metered-connection surprise, not a cosmetic bug.
    approxDownloadMB: 90,
    note: "~4x the CPU cost of CLIP per photo, clearly better zero-shot accuracy",
  },
  {
    id: "Xenova/clip-vit-base-patch32",
    label: "CLIP ViT-B/32 (faster)",
    loader: "CLIPVisionModelWithProjection",
    outputKey: "image_embeds",
    dim: 512,
    dtype: "int8",
    // Measured the same way as SigLIP above: 88,653,921 bytes (84.5 MB) for
    // the int8 vision_model_int8.onnx + config + preprocessor config,
    // 2026-07-25. The old 45 MB estimate undersold this by roughly half —
    // "faster to run" (fewer patches) is not the same as "smaller to
    // download"; CLIP and SigLIP's downloads are actually close in size.
    approxDownloadMB: 85,
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
