/**
 * Fetching the face weights, and refusing to trust them blindly (#166).
 *
 * These do not come from InsightFace's own release — their zips are 416 MB for
 * the same four graphs that are 207 MB individually — so they come from a
 * third-party mirror. A mirror is a supply-chain question, and the answer is
 * not "the URL looks right": every file is checked against a SHA-256 recorded
 * in faceModels.js from a real download, and a mismatch deletes the file and
 * throws rather than loading it.
 *
 * That check is the whole point of this module. A silently-substituted
 * recognizer does not crash — it produces 512 confident floats per face, and
 * the only symptom is that clustering stops corresponding to people, months
 * later, with no error anywhere.
 *
 * `fetchImpl` and the filesystem calls are injected so this is testable
 * without the network and without 191 MB on disk. So is the FILE LIST, and
 * that one is not a convenience: the registry's digests are of 191 MB of real
 * weights, and no test can fabricate bytes that hash to them. Without an
 * override, the only reachable assertions would be the rejection paths — the
 * successful download, which is the path that matters, would be untestable.
 */
import { createHash } from "node:crypto";
import { faceModelById, faceModelFiles } from "./faceModels.js";

/**
 * Is this pack already present and verified?
 *
 * Verifies the DIGEST, not merely that a file exists. A truncated download —
 * the overwhelmingly common failure, from a dropped connection — leaves a file
 * of the right name and the wrong length, and ONNX will happily fail to parse
 * it with an error that reads like a corrupt model rather than a partial one.
 *
 * @param {string} modelId
 * @param {{readFile: (path: string) => Promise<Uint8Array>, pathFor: (file: string) => string}} io
 * @returns {Promise<{ready: boolean, missing: string[], corrupt: string[]}>}
 */
export async function checkFaceModel(modelId, io, { files } = {}) {
  const missing = [];
  const corrupt = [];
  for (const f of files ?? faceModelFiles(modelId)) {
    let bytes;
    try {
      bytes = await io.readFile(io.pathFor(f.file));
    } catch {
      missing.push(f.name);
      continue;
    }
    if (bytes.length !== f.bytes || sha256(bytes) !== f.sha256) {
      corrupt.push(f.name);
    }
  }
  return { ready: !missing.length && !corrupt.length, missing, corrupt };
}

/**
 * Download whatever this pack is missing, verifying each file before it counts.
 *
 * @param {string} modelId
 * @param {object} io
 * @param {(url: string) => Promise<{ok: boolean, status: number, arrayBuffer: () => Promise<ArrayBuffer>}>} io.fetchImpl
 * @param {(path: string, bytes: Uint8Array) => Promise<void>} io.writeFile
 * @param {(path: string) => Promise<Uint8Array>} io.readFile
 * @param {(path: string) => Promise<void>} io.unlink
 * @param {(file: string) => string} io.pathFor
 * @param {object} [opts]
 * @param {(p: {file: string, done: number, total: number, phase: string}) => void} [opts.onProgress]
 * @param {Array<object>} [opts.files] override the registry's file list — tests
 *   only, since no fixture can hash to the real weights' digests
 * @returns {Promise<{downloaded: string[], skipped: string[], bytes: number}>}
 */
export async function downloadFaceModel(
  modelId,
  io,
  { onProgress = () => {}, files: override } = {}
) {
  const model = faceModelById(modelId);
  const files = override ?? faceModelFiles(modelId);
  const total = files.reduce((n, f) => n + f.bytes, 0);
  const downloaded = [];
  const skipped = [];
  let done = 0;

  for (const f of files) {
    // Already here and intact? Never re-download 174 MB to prove it.
    const have = await verifiedLocal(f, io);
    if (have) {
      skipped.push(f.name);
      done += f.bytes;
      onProgress({ file: f.name, done, total, phase: "cached" });
      continue;
    }

    onProgress({ file: f.name, done, total, phase: "downloading" });
    const res = await io.fetchImpl(f.url);
    if (!res.ok) {
      // Specific, not generic: the user needs to know WHICH file and WHY, per
      // CLAUDE.md's rule that a failure the user can trigger must say what
      // happened and what to do next.
      throw new Error(
        `Couldn't download the ${f.name} for ${model.label} — the server answered ${res.status}. ` +
          `Check your connection and try again; nothing was changed.`
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());

    if (bytes.length !== f.bytes) {
      throw new Error(
        `The ${f.name} for ${model.label} arrived incomplete ` +
          `(${bytes.length.toLocaleString()} of ${f.bytes.toLocaleString()} bytes). ` +
          `Nothing was saved; try again.`
      );
    }
    const digest = sha256(bytes);
    if (digest !== f.sha256) {
      throw new Error(
        `The ${f.name} for ${model.label} does not match its expected checksum. ` +
          `This means the file served is not the one this app was built against, ` +
          `so it was discarded rather than used. Nothing was changed.`
      );
    }

    await io.writeFile(io.pathFor(f.file), bytes);
    downloaded.push(f.name);
    done += f.bytes;
    onProgress({ file: f.name, done, total, phase: "verified" });
  }

  return { downloaded, skipped, bytes: total };
}

/** True only if the file is present AND matches its digest. A corrupt file is
 *  deleted here, so the next call re-downloads instead of failing forever on
 *  bytes nobody will ever repair. */
async function verifiedLocal(f, io) {
  let bytes;
  try {
    bytes = await io.readFile(io.pathFor(f.file));
  } catch {
    return false;
  }
  if (bytes.length === f.bytes && sha256(bytes) === f.sha256) return true;
  await io.unlink(io.pathFor(f.file)).catch(() => {});
  return false;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
