#!/usr/bin/env node
// Dev launcher (issue #65). Resolves a free API port BEFORE starting anything,
// then runs the Express server + Vite (+ Electron with --electron) under
// `concurrently` with that port injected into both:
//   - PORT           → the Express dev server binds it (server/index.js)
//   - VITE_API_PORT  → Vite's dev proxy targets it (ui/vite.config.js)
//
// Vite's proxy targets the API by number, so the server can't just fall back on
// its own without desyncing the proxy — resolving the port here, up front, is
// what lets `npm run dev` survive a busy 4321 (e.g. a running packaged app or a
// second dev server) instead of dying with EADDRINUSE.
import { spawn } from "node:child_process";
import { findFreePort } from "../server/lib/findFreePort.js";

const withElectron = process.argv.includes("--electron");

// Honor an explicit PORT if the user set one; otherwise probe from 4321.
const apiPort = process.env.PORT
  ? Number(process.env.PORT)
  : await findFreePort(4321);

const env = {
  ...process.env,
  PORT: String(apiPort),
  VITE_API_PORT: String(apiPort),
};

const names = ["server", "ui"];
const colors = ["blue", "magenta"];
const commands = ["npm:dev:server", "npm:dev:ui"];

if (withElectron) {
  names.push("electron");
  colors.push("green");
  commands.push(
    `wait-on tcp:${apiPort} tcp:5173 && cross-env ELECTRON_DEV=1 electron .`
  );
}

console.log(`[dev] API server + Vite proxy on port ${apiPort}`);

// concurrently runs each command string in its own shell, so the electron
// command's `&&` works. We invoke concurrently via npx; shell:true on Windows
// where npx is a .cmd shim.
const child = spawn(
  "npx",
  ["concurrently", "-n", names.join(","), "-c", colors.join(","), ...commands],
  { stdio: "inherit", env, shell: process.platform === "win32" }
);

child.on("exit", (code) => process.exit(code ?? 0));
