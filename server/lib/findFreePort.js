import net from "node:net";

/**
 * Resolve whether a TCP port can be bound on `host` right now.
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/**
 * Find the first free TCP port at or above `preferred` (probing sequentially).
 *
 * Unlike `listenOnOpenPort`'s "fall back to an OS-assigned port" (which picks a
 * random high port), this returns a concrete, predictable number the dev
 * launcher can hand to BOTH the Express server (`PORT`) and Vite's proxy
 * (`VITE_API_PORT`) — the by-number proxy needs to know the port up front, so
 * the server can only move if something resolves the port before either starts.
 *
 * @param {number} [preferred] first port to try (default 4321).
 * @param {{host?: string, attempts?: number}} [opts]
 * @returns {Promise<number>} a free port in `[preferred, preferred + attempts)`.
 * @throws {Error} if every candidate in that range is taken.
 */
export async function findFreePort(
  preferred = 4321,
  { host = "127.0.0.1", attempts = 50 } = {}
) {
  for (let port = preferred; port < preferred + attempts; port++) {
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(
    `no free port in [${preferred}, ${preferred + attempts}) on ${host}`
  );
}
