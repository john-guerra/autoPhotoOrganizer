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
 *
 * ## The bar for `licence` (read this before adding a model)
 *
 * The settings panel shows this string at the moment the user decides whether
 * to spend ~90 MB on a download, which makes it a consent notice, not a label.
 * So it may only ever repeat what the model's own card DECLARES:
 *
 *  - Check the UPSTREAM repo, not the `Xenova/*` ONNX conversion. Those
 *    conversions declare no licence of their own, so the licence that governs
 *    the weights is the upstream model's.
 *  - "Declared" means the `license:` key in the card's YAML front-matter (the
 *    same value Hugging Face's API returns as `license`), or an explicit
 *    licence statement in the card body. Checked for both entries below on
 *    2026-07-25 against the API metadata AND the raw README.md.
 *  - **Unknown is a first-class answer.** If the card declares nothing, say so
 *    and link the card — never infer a licence from a related repo. The CLIP
 *    entry is exactly this case, and the tempting wrong answer is instructive:
 *    github.com/openai/CLIP (the CODE) is MIT, and the weights are a different
 *    artifact whose owner has stated nothing. Asserting "MIT" there would be
 *    telling the user a fact about someone else's IP that its owner never
 *    said — worse than an honest gap, because the user would rely on it.
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
    // DECLARED: google/siglip-base-patch16-224's card carries
    // `license: apache-2.0` in its YAML front-matter (verified 2026-07-25
    // against both the HF API's `license` field and the raw README.md). See
    // the bar for this field in the module doc above.
    licence: "Apache-2.0, declared by google/siglip-base-patch16-224",
    modelCardUrl: "https://huggingface.co/google/siglip-base-patch16-224",
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
    // NOT DECLARED, and this is not an oversight to be filled in with a
    // plausible guess: openai/clip-vit-base-patch32's card metadata has no
    // `license` key and no `license:*` tag (HF API returns `license = None`),
    // and its README front-matter is only `tags: [vision]` plus a widget
    // example — no licence statement anywhere in the body either (verified
    // 2026-07-25). An earlier revision of this file said "MIT" from the
    // github.com/openai/CLIP CODE repo; see the module doc above for why that
    // was wrong. The panel links the card so the user can check for
    // themselves.
    licence: "not stated on openai/clip-vit-base-patch32's model card",
    modelCardUrl: "https://huggingface.co/openai/clip-vit-base-patch32",
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
