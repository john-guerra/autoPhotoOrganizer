/**
 * Ad-hoc code signature for the macOS build (electron-builder `afterPack` hook).
 *
 * We have no Apple Developer ID, so the app cannot be *authenticated* — Gatekeeper
 * still can't vouch for who built it, and a first launch needs right-click → Open.
 * An ad-hoc signature (`codesign --sign -`) is the next best thing, and it is not
 * cosmetic:
 *
 *   - On Apple Silicon a binary with NO signature at all is killed by the kernel.
 *     Electron/electron-builder papers over this inconsistently; doing it here
 *     makes it explicit and verifiable (`codesign -dv` reports `Signature=adhoc`).
 *   - It seals the bundle: the signature covers every byte, so macOS detects any
 *     tampering after the fact. What it can't do is prove the bytes came from John.
 *   - It stops the "damaged and can't be opened" dialog that an unsigned or
 *     partially-signed bundle triggers once quarantined.
 *
 * If a real Developer ID ever lands in CI (CSC_LINK / CSC_NAME), this hook stands
 * down and lets electron-builder do the authenticated signing instead — an ad-hoc
 * signature applied afterwards would destroy it.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log(
      "[adhoc-sign] a real signing identity is configured — skipping"
    );
    return;
  }

  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  // --deep is the blunt instrument, but it is the right one here: there is no
  // identity to scope, and every nested helper/framework needs the same ad-hoc
  // seal or the bundle fails validation as a whole.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], {
    stdio: "inherit",
  });

  // Fail the build rather than ship something that only *looks* signed. Both of
  // these write to stderr, so let them inherit: the result belongs in the build
  // log, and a bad signature throws.
  console.log(`[adhoc-sign] ${app}`);
  execFileSync("codesign", ["-dv", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", app], {
    stdio: "inherit",
  });
};
