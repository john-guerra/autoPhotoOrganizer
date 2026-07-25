/**
 * The ML child process.
 *
 * JSON-lines over stdio, one request at a time. Deliberately tiny in this
 * slice: it loads onnxruntime-node and reports what it found. Model loading,
 * an idle unload timer, and real inference arrive with #161.
 *
 * Nothing here may write to stdout except a reply line — stdout IS the
 * protocol. Diagnostics go to stderr.
 */
let ort = null;
let loadError = null;
try {
  ort = (await import("onnxruntime-node")).default;
} catch (e) {
  loadError = e;
}

process.stdin.setEncoding("utf8");
let buf = "";

process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim()) handle(line);
  }
});

/** @param {string} line */
function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // unparseable input is the parent's bug; stay alive
  }
  try {
    if (req.op === "health") {
      if (loadError) {
        return reply({
          id: req.id,
          error: `onnxruntime-node: ${loadError.message}`,
        });
      }
      return reply({
        id: req.id,
        ok: true,
        ort: ort.env?.versions?.node ?? "unknown",
        providers: ort.listSupportedBackends?.().map((b) => b.name) ?? ["cpu"],
        pid: process.pid,
      });
    }
    reply({ id: req.id, error: `unknown op: ${req.op}` });
  } catch (e) {
    reply({ id: req.id, error: String(e?.message ?? e) });
  }
}

/** @param {object} obj */
function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
