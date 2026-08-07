import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  cpSync,
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

describe("better-sqlite3 opens from inside a WORKER in an asar (#282 step 4)", () => {
  /**
   * The one link the whole writer migration rests on, and the one nothing
   * tested.
   *
   * Three separate things were already verified and none of them is this:
   * the ML worker is a SPAWNED `ELECTRON_RUN_AS_NODE` child (a plain Node
   * process, #203); the projection worker probe above is a `worker_threads`
   * isolate but pure JS; and better-sqlite3 itself is only ever loaded on the
   * MAIN thread. Step 4 needs all three at once — a native addon, resolved
   * from inside an asar, from a worker isolate — and the asar redirect to
   * `app.asar.unpacked` is a runtime patch Electron installs, so "it works on
   * the main thread" is not evidence it works in a fresh isolate.
   *
   * `require("better-sqlite3")` is NOT the check: it only loads the JS
   * wrapper. The native binding is not touched until `new Database()`, and
   * reading "it loads fine" as "the ABI is right" already cost a wrong
   * diagnosis once (docs/AGENT-NOTES.md, 2026-07-28). So this OPENS a database
   * and runs a statement.
   */
  const binary = electronBinary();
  // Everything better-sqlite3 REQUIRES at runtime, because these are copied
  // into the miniature asar and a missing one produces "Cannot find module" —
  // a probe failure that looks exactly like the thing being tested and is not.
  //
  // As of better-sqlite3 13 that list is EMPTY. 12.x resolved its binary
  // through `bindings` (which pulls `file-uri-to-path`); 13 moved to the N-API
  // and loads `prebuilds/<platform>-<arch>.node` directly, so both packages
  // are gone from node_modules entirely. They were left in this array for one
  // release and the effect was the failure mode this repo keeps meeting:
  // `haveAll` went false, the probe SKIPPED, and the skip is indistinguishable
  // from a pass unless you read the count. `node-addon-api` is headers for
  // `binding.gyp`, not a runtime require.
  const NEEDED = ["better-sqlite3"];
  const srcOf = (name) =>
    new URL(`../../node_modules/${name}`, import.meta.url).pathname;
  const haveAll = NEEDED.every((n) => existsSync(srcOf(n)));

  if (!binary) {
    console.warn(
      "[asarPackaging] SKIPPED the better-sqlite3-in-a-worker probe — the " +
        "Electron binary is not installed."
    );
  }
  if (binary && !haveAll) {
    console.warn(
      "[asarPackaging] SKIPPED the better-sqlite3-in-a-worker probe — one of " +
        `${NEEDED.join(", ")} is missing from node_modules (run \`npm ci\`).`
    );
  }

  const live = binary && haveAll ? it : it.skip;

  live(
    "runs a statement on a real connection opened in the worker",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "autogallery-asar-db-"));
      try {
        const app = join(root, "app");
        const dir = join(app, "server", "workers");
        mkdirSync(dir, { recursive: true });
        mkdirSync(join(app, "node_modules"), { recursive: true });
        for (const name of NEEDED) {
          cpSync(srcOf(name), join(app, "node_modules", name), {
            recursive: true,
          });
        }
        writeFileSync(
          join(app, "package.json"),
          JSON.stringify({ name: "probe", version: "1.0.0", type: "module" })
        );

        // An ESM worker reaching a CommonJS native module, which is exactly
        // how `server/db/connection.js` reaches it today.
        writeFileSync(
          join(dir, "worker.js"),
          [
            'import { parentPort } from "node:worker_threads";',
            "let out;",
            "try {",
            '  const { default: Database } = await import("better-sqlite3");',
            '  const db = new Database(":memory:");',
            '  db.prepare("CREATE TABLE t (a INTEGER)").run();',
            '  db.prepare("INSERT INTO t (a) VALUES (?)").run(41);',
            '  const row = db.prepare("SELECT a + 1 AS a FROM t").get();',
            "  out = { ok: true, a: row.a };",
            "} catch (e) {",
            "  out = { ok: false, message: String(e && e.message ? e.message : e) };",
            "}",
            "parentPort.postMessage(out);",
            "",
          ].join("\n")
        );
        writeFileSync(
          join(dir, "parent.js"),
          [
            'import { Worker } from "node:worker_threads";',
            'const w = new Worker(new URL("./worker.js", import.meta.url));',
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
        // `unpack` is the whole point: a .node file CANNOT be loaded from
        // inside an archive however it was built, so the real build leaves it
        // in app.asar.unpacked and Electron redirects. This reproduces that
        // arrangement rather than assuming it.
        await asar.createPackageWithOptions(app, archive, {
          unpack: "*.node",
        });
        expect(existsSync(`${archive}.unpacked`)).toBe(true);

        const { code, stdout, stderr } = await run(binary, [
          join(archive, "server", "workers", "parent.js"),
        ]);

        expect(code, `electron exited ${code}\n${stderr}`).toBe(0);
        const got = JSON.parse(stdout);

        // TWO failure modes, and only one of them is this probe's business.
        //
        // The ABI is a property of the local INSTALL, not of the packaging:
        // `npm ci` builds better-sqlite3 for Node's NODE_MODULE_VERSION, and
        // Electron's is different. A packaged build runs `rebuild:electron`
        // first, so it ships the right one — but this test tree must not,
        // because that rebuild is a ONE-WAY SWITCH that leaves every other
        // test in the repo unable to open a database (docs/AGENT-NOTES.md).
        //
        // So an ABI mismatch skips LOUDLY. What it does NOT do is hide the
        // link under test: reaching dlopen at all means the worker isolate
        // resolved a bare CJS import from inside the archive AND followed the
        // app.asar.unpacked redirect to a real file on disk. That is the part
        // step 4 depends on, and it is asserted below either way.
        const abiMismatch =
          !got.ok && /NODE_MODULE_VERSION/.test(got.message ?? "");
        if (abiMismatch) {
          console.warn(
            "[asarPackaging] better-sqlite3 loaded from app.asar.unpacked in a " +
              "worker, but this checkout is built for Node's ABI, not " +
              "Electron's — so the OPEN half is unverified here. Run it " +
              "against a packaged build, or `npm run rebuild:electron` then " +
              "`npm run rebuild:node`. Resolution half: PASSED."
          );
          // The redirect: the module was found OUTSIDE the archive.
          expect(got.message).toMatch(/app\.asar\.unpacked/);
          expect(got.message).not.toMatch(/Cannot find module/);
          return;
        }
        expect(got, JSON.stringify(got)).toEqual({ ok: true, a: 42 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000
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
