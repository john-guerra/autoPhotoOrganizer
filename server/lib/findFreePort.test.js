import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { findFreePort, isPortFree } from "./findFreePort.js";

/** Bind a port and return the server so a test can free it afterward. */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

describe("findFreePort", () => {
  let held = [];
  afterEach(async () => {
    await Promise.all(held.map((s) => new Promise((r) => s.close(r))));
    held = [];
  });

  it("returns the preferred port when it is free", async () => {
    // A high port unlikely to be taken by anything else on the machine.
    expect(await findFreePort(48211)).toBe(48211);
  });

  it("skips a busy port and returns the next free one", async () => {
    held.push(await occupy(48221));
    expect(await findFreePort(48221)).toBe(48222);
  });

  it("skips a run of busy ports", async () => {
    held.push(await occupy(48231));
    held.push(await occupy(48232));
    expect(await findFreePort(48231)).toBe(48233);
  });

  it("throws when every candidate in range is taken", async () => {
    held.push(await occupy(48241));
    await expect(findFreePort(48241, { attempts: 1 })).rejects.toThrow(
      /no free port/
    );
  });

  it("isPortFree reflects a bound port", async () => {
    expect(await isPortFree(48251)).toBe(true);
    held.push(await occupy(48251));
    expect(await isPortFree(48251)).toBe(false);
  });
});
