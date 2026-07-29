import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pkg from "../../package.json" with { type: "json" };

/**
 * CAN THE ML WORKER EVEN START IN THE SHIPPED APP?
 *
 * `OnnxMLService.#ensureChild` spawns `process.execPath <workerPath>` with
 * ELECTRON_RUN_AS_NODE=1. In a packaged build `<workerPath>` is
 * `.../app.asar/server/ml/worker/index.js` — an **ESM** module living inside an
 * archive, importing siblings by relative path and `@huggingface/transformers`
 * by bare specifier, which in turn loads `onnxruntime-node`, whose native
 * binary must be UNPACKED because a `.node` file cannot be dlopen'd from
 * inside an asar.
 *
 * Not one link of that chain is exercised by `npm run dev` (plain Node, plain
 * directories) or by `npm run build` (which is only `vite build ui`). It is the
 * shape of #67 exactly: a packaging assumption that holds in development and
 * fails only in the artifact users install. #203 was filed to answer it.
 *
 * THE ANSWER IS THAT IT WORKS — and that is precisely why this test exists.
 * A verified assumption with no test is a fact with an expiry date: the next
 * Electron major, or an `asarUnpack` edit, or a dependency that stops deduping,
 * silently un-verifies it, and the symptom would reach a user as a job error
 * they can only respond to by retrying something that can never succeed.
 *
 * TWO TIERS, deliberately:
 *
 *   1. Config assertions — pure, instant, always run. They pin the parts of
 *      `build.files`/`asarUnpack` the chain depends on. This tier catches the
 *      likeliest regression (someone edits the packaging config) without
 *      needing a binary.
 *   2. A live Electron probe — packs a miniature app.asar mirroring the real
 *      layout and actually runs an ESM entry from inside it. This tier catches
 *      what config assertions never could: the loader itself changing
 *      behaviour under a new Electron.
 *
 * The probe spawns a child, which the suite's standing rule reserves for
 * gated tests. It is allowed here because it violates neither reason for that
 * rule: it downloads nothing and finishes in well under a second. It skips —
 * LOUDLY — when the Electron binary is absent, the same way
 * `embeddingSimilarity.test.js` does, because a silent skip on a release gate
 * is indistinguishable from a pass.
 */

const require = createRequire(import.meta.url);

/** The `electron` package's main export is the path to the binary, not a
 *  module — resolving it can throw on a platform with no download. */
function electronBinary() {
  try {
    const p = require("electron");
    return typeof p === "string" && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

describe("packaged-build assumptions the ML worker depends on", () => {
  const files = pkg.build.files;
  const unpack = pkg.build.asarUnpack;

  it("packs the worker entry and the package.json it is parsed against", () => {
    // `server/**/*` is the load-bearing one: without it there is no worker
    // inside the archive to spawn at all.
    //
    // The root `package.json` is packed too, and its `"type": "module"` is
    // what tells Node to parse the worker — a `.js` file full of `import`
    // statements — as ESM. Measured caveat, because the obvious assumption is
    // wrong: dropping the flag does NOT break the worker. Electron 43 carries
    // Node 24, whose unflagged module-syntax detection reparses the file as
    // ESM anyway, emitting MODULE_TYPELESS_PACKAGE_JSON and paying a parse
    // twice. So this assertion guards a warning and a startup cost, not a
    // crash — worth keeping, not worth mistaking for the thing that makes
    // packaging work.
    expect(files).toContain("server/**/*");
    expect(files).toContain("package.json");
    expect(pkg.type).toBe("module");
  });

  it("unpacks the native runtime, which cannot be dlopen'd from an archive", () => {
    expect(unpack).toContain("node_modules/onnxruntime-node/**");
  });

  it("keeps onnxruntime-node deduped to the top level, where that glob matches", () => {
    // `node_modules/onnxruntime-node/**` is anchored: it does NOT match a
    // nested `node_modules/@huggingface/transformers/node_modules/
    // onnxruntime-node/`. Today npm dedupes the two requests (the root pins
    // 1.27.0, transformers asks for 1.24.3) to one top-level copy, so the glob
    // hits. Should a future version bump make those ranges disjoint, npm would
    // nest a second copy, the pattern would silently stop covering the one
    // actually loaded, and the `.node` binary would ship sealed inside the
    // asar. Nothing else in the build would complain.
    const nested = join(
      "node_modules",
      "@huggingface",
      "transformers",
      "node_modules",
      "onnxruntime-node"
    );
    expect(existsSync(join(process.cwd(), nested))).toBe(false);
    expect(
      existsSync(join(process.cwd(), "node_modules", "onnxruntime-node"))
    ).toBe(true);
  });
});

describe("ESM actually resolves from inside an asar under ELECTRON_RUN_AS_NODE", () => {
  const binary = electronBinary();

  if (!binary) {
    console.warn(
      "[asarPackaging] SKIPPED the live probe — the Electron binary is not " +
        "installed. The config assertions above still ran."
    );
  }

  const live = binary ? it : it.skip;

  live(
    "runs an ESM worker entry, its relative and bare imports, and an unpacked dep",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "autogallery-asar-"));
      try {
        // Mirrors the real packaged layout: an ESM entry at the same depth as
        // the worker, a sibling it imports relatively, a bare dependency packed
        // INSIDE the archive (as most are), and one UNPACKED dependency reached
        // by bare ESM import — the shape `onnxruntime-node` is loaded in.
        const app = join(root, "app");
        const w = join(app, "server", "ml", "worker");
        mkdirSync(w, { recursive: true });
        mkdirSync(join(app, "node_modules", "packed"), { recursive: true });
        mkdirSync(join(app, "node_modules", "unpacked"), { recursive: true });

        const esmPkg = (name) =>
          JSON.stringify({
            name,
            version: "1.0.0",
            type: "module",
            main: "index.js",
          });

        writeFileSync(
          join(app, "package.json"),
          JSON.stringify({ name: "probe", version: "1.0.0", type: "module" })
        );
        writeFileSync(
          join(app, "node_modules", "packed", "package.json"),
          esmPkg("packed")
        );
        writeFileSync(
          join(app, "node_modules", "packed", "index.js"),
          'export const packed = "packed-ok";\n'
        );
        writeFileSync(
          join(app, "node_modules", "unpacked", "package.json"),
          esmPkg("unpacked")
        );
        writeFileSync(
          join(app, "node_modules", "unpacked", "index.js"),
          'export const unpacked = "unpacked-ok";\n'
        );
        writeFileSync(
          join(w, "sibling.js"),
          'export const rel = "relative-ok";\n'
        );
        writeFileSync(
          join(w, "index.js"),
          [
            'import { rel } from "./sibling.js";',
            'import { packed } from "packed";',
            'import { unpacked } from "unpacked";',
            "process.stdout.write(JSON.stringify({ rel, packed, unpacked }));",
            "",
          ].join("\n")
        );

        const archive = join(root, "app.asar");
        const asar = await import("@electron/asar");
        await asar.createPackageWithOptions(app, archive, {
          unpackDir: "node_modules/unpacked",
        });

        const { code, stdout, stderr } = await run(binary, [
          join(archive, "server", "ml", "worker", "index.js"),
        ]);

        // stderr is in the failure message because the interesting failure here
        // is a MODULE_NOT_FOUND stack, and a bare "expected 1 to be 0" would
        // send the next reader straight back here to re-instrument it.
        expect(code, `electron exited ${code}\n${stderr}`).toBe(0);
        expect(JSON.parse(stdout)).toEqual({
          rel: "relative-ok",
          packed: "packed-ok",
          unpacked: "unpacked-ok",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000
  );
});

/**
 * The projection worker (#232) is a DIFFERENT asar path from the ML worker,
 * and the difference is not cosmetic.
 *
 * The ML worker is a spawned `ELECTRON_RUN_AS_NODE` child — a plain Node
 * process, verified above. The projection worker is a `worker_threads` Worker
 * created INSIDE the process, and in a packaged build the Express server runs
 * inside Electron's main process. So the open question is whether Electron's
 * asar interception is installed in a fresh worker isolate's module loader,
 * such that an ESM worker entry at `/…/app.asar/server/projection/worker.js`
 * resolves — along with its relative and bare imports.
 *
 * This is the exact shape of #67 and #203: it holds in dev (plain directories,
 * plain Node) and would fail only in the artifact. If it ever goes red, the
 * fix is one line — add `"server/projection/**"` to `build.asarUnpack` — and
 * the Tier-A assertion below starts pinning it. #203's own conclusion was that
 * adding that entry PRE-EMPTIVELY would have been dead weight, so it is not
 * there.
 */
describe("worker_threads resolves from inside an asar (#232)", () => {
  const binary = electronBinary();

  if (!binary) {
    console.warn(
      "[asarPackaging] SKIPPED the worker_threads probe — the Electron " +
        "binary is not installed."
    );
  }

  const live = binary ? it : it.skip;

  live(
    "starts an ESM worker from the archive and lets it resolve its imports",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "autogallery-asar-wt-"));
      try {
        const app = join(root, "app");
        const proj = join(app, "server", "projection");
        mkdirSync(proj, { recursive: true });
        mkdirSync(join(app, "node_modules", "packed"), { recursive: true });

        writeFileSync(
          join(app, "package.json"),
          JSON.stringify({ name: "probe", version: "1.0.0", type: "module" })
        );
        writeFileSync(
          join(app, "node_modules", "packed", "package.json"),
          JSON.stringify({
            name: "packed",
            version: "1.0.0",
            type: "module",
            main: "index.js",
          })
        );
        writeFileSync(
          join(app, "node_modules", "packed", "index.js"),
          'export const packed = "packed-ok";\n'
        );

        // The worker: a relative import, a bare import, and a message back —
        // the same three links runProjection depends on.
        writeFileSync(
          join(proj, "seeded.js"),
          'export const rel = "relative-ok";\n'
        );
        writeFileSync(
          join(proj, "worker.js"),
          [
            'import { parentPort, workerData } from "node:worker_threads";',
            'import { rel } from "./seeded.js";',
            'import { packed } from "packed";',
            "parentPort.postMessage({ rel, packed, got: workerData.n });",
            "",
          ].join("\n")
        );

        // The parent: creates the Worker by URL relative to ITSELF, exactly as
        // runProjection.js does with `new URL("./worker.js", import.meta.url)`.
        writeFileSync(
          join(proj, "parent.js"),
          [
            'import { Worker } from "node:worker_threads";',
            'const w = new Worker(new URL("./worker.js", import.meta.url), {',
            "  workerData: { n: 7 },",
            "  resourceLimits: { maxOldGenerationSizeMb: 512 },",
            "});",
            'w.on("message", (m) => {',
            "  process.stdout.write(JSON.stringify(m));",
            "  w.terminate();",
            "});",
            'w.on("error", (e) => {',
            "  process.stderr.write(String(e && e.stack ? e.stack : e));",
            "  process.exit(3);",
            "});",
            "",
          ].join("\n")
        );

        const archive = join(root, "app.asar");
        const asar = await import("@electron/asar");
        await asar.createPackageWithOptions(app, archive, {});

        const { code, stdout, stderr } = await run(binary, [
          join(archive, "server", "projection", "parent.js"),
        ]);

        expect(code, `electron exited ${code}\n${stderr}`).toBe(0);
        expect(JSON.parse(stdout)).toEqual({
          rel: "relative-ok",
          packed: "packed-ok",
          got: 7,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000
  );
});

/** @returns {Promise<{code: number|null, stdout: string, stderr: string}>} */
function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
