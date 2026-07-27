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
 *
 * ## Why `nearDupeThreshold` is per-model and not one constant (#162)
 *
 * Measured on real photographs (darwin/arm64, 2026-07-26 — the fixture set
 * behind `embeddingSimilarity.test.js`):
 *
 *   relation                          SigLIP    CLIP
 *   burst pair (same moment)          0.9608   0.9657
 *   same scene, re-framed             0.9326   0.8854
 *   two DIFFERENT outdoor scenes      0.6071   0.6771
 *   vs. an unrelated subject          0.50-0.56  0.41-0.52
 *
 * Two facts in that table decide the design. First, the two models disagree by
 * ~0.05 on the case that matters most (the re-framed pair), so a single global
 * constant would be correct for at most one of them — hence a field here,
 * beside `dim`, rather than a shared export.
 *
 * Second, "unrelated" is not one number. Two photographs that merely share a
 * genre score 0.61-0.68, far above the 0.41-0.56 of wholly different subjects.
 * That is the model being RIGHT, and it means a cutoff tuned by eye on
 * obviously-different photos will merge distinct shots on a library that is
 * mostly one genre — which is what a travel archive is. The near-dupe sweep
 * intersects this threshold with a time window for exactly that reason.
 *
 * Chosen deliberately conservative, just under the re-framed pair rather than
 * midway to the noise band: a missed duplicate is invisible to the user, while
 * a false merge HIDES a photo behind a stack cover. Those costs are not
 * symmetric.
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
    // #164. The TEXT tower of the same model, downloaded only when a text
    // query is first made. It shares the image tower's vector space, so a
    // caption's vector can be cosined directly against vectors already
    // computed for #161 — which is what makes open-vocabulary tagging cost
    // no per-photo inference at all.
    //
    // VERIFIED, not assumed (2026-07-26, against the real 16,797-photo
    // library): "a photo of a dog" returned a golden retriever, "a photo of
    // a city street" a San Francisco street, "a photo of a beach" the pier
    // at Santa Monica. The shared space is a claim about SigLIP's
    // architecture — get_image_features is the vision pooler_output and
    // get_text_features the text pooler_output, with no projection on either
    // side — and a claim like that is worth ten minutes to confirm rather
    // than discover wrong later.
    text: {
      loader: "SiglipTextModel",
      outputKey: "pooler_output",
      // SigLIP was trained with every caption padded to a fixed 64 tokens,
      // and its ONNX export has that length baked in. Tokenizing with the
      // default dynamic padding does not error — it silently returns a
      // DIFFERENT vector, which is the failure mode this whole file exists
      // to prevent.
      tokenize: { padding: "max_length", max_length: 64, truncation: true },
    },
    // Sits below the measured re-framed pair (0.9326) and far above the
    // shared-genre band (0.61). See the module doc for the full table.
    nearDupeThreshold: 0.93,
    // Measured on darwin/arm64 at batch 16 (#161). Used ONLY to estimate how
    // long a sweep will take before the user commits to it (#215) — an
    // order-of-magnitude honesty aid, not a promise. Real machines vary by a
    // lot; the panel says "about" and rounds hard.
    approxMsPerPhoto: 38,
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
    // #164. Note this pairs WithProjection against WithProjection: CLIP's
    // joint space is behind a projection head on BOTH towers, so pairing
    // `image_embeds` with a bare CLIPTextModel's `pooler_output` would
    // compare a projected vector against an unprojected one — same width,
    // plausible numbers, meaningless cosine. SigLIP above is the opposite
    // case (no projection on either side), which is exactly why this is a
    // per-model field and not one shared constant.
    text: {
      loader: "CLIPTextModelWithProjection",
      outputKey: "text_embeds",
      // CLIP's export takes dynamic-length input; it needs no fixed pad.
      tokenize: { padding: true, truncation: true },
    },
    // Lower than SigLIP's, and not by preference: CLIP scored the same
    // re-framed pair at 0.8854 where SigLIP gave 0.9326. Using SigLIP's 0.93
    // here would silently miss every re-framed duplicate under this model —
    // which is how a shared constant fails, invisibly.
    nearDupeThreshold: 0.88,
    // 49 patches instead of 196 — roughly a third of SigLIP's cost per photo,
    // measured the same way (batch 4, darwin/arm64).
    approxMsPerPhoto: 13,
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
