"use strict";
/*
 * Runtime load diagnostic for kuzujs.node — run this ON THE TARGET MACHINE
 * (the Windows-on-ARM box) to pinpoint a `process.dlopen` failure. Run it both
 * ways and paste BOTH outputs:
 *
 *   1) plain Node (arm64):     node util\electron-smoke\diagnose.js
 *   2) Electron (arm64):       set ELECTRON_RUN_AS_NODE=
 *                              node_modules\.bin\electron util\electron-smoke\diagnose.js
 *
 * It prints the host arch, the binary arch (to catch an arch mismatch), and the
 * EXACT dlopen error message + Windows error code, which discriminates the
 * likely root causes:
 *   - error 193 / "not a valid Win32 application"  -> arch mismatch
 *   - error 126/127 / "module could not be found"  -> missing dependent DLL
 *                                                      (usually the ARM64 VC++ runtime)
 */
const fs = require("fs");
const path = require("path");

function peMachine(file) {
  try {
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(0x200);
    fs.readSync(fd, b, 0, 0x200, 0);
    fs.closeSync(fd);
    const pe = b.readUInt32LE(0x3c);
    const m = b.readUInt16LE(pe + 4);
    return { 0x8664: "x64", 0xaa64: "arm64", 0x14c: "x86", 0x1c0: "arm" }[m] || "0x" + m.toString(16);
  } catch (e) {
    return "??(" + e.message + ")";
  }
}

const root = path.join(__dirname, "..", "..");
const arch = process.arch;
console.log("HOST    : platform=" + process.platform + " arch=" + arch);
console.log(
  "VERSIONS: node=" + process.versions.node +
    " electron=" + (process.versions.electron || "-") +
    " napi=" + process.versions.napi
);

for (const f of [
  path.join(root, "kuzujs.node"),
  path.join(root, "prebuilt", "kuzujs-win32-" + arch + ".node"),
]) {
  console.log("\nFILE    : " + f);
  if (!fs.existsSync(f)) {
    console.log("  exists : NO");
    continue;
  }
  const bm = peMachine(f);
  console.log(
    "  binary arch: " + bm + (bm === arch ? "  (matches host)" : "  *** MISMATCH vs host " + arch + " ***")
  );
}

console.log("\n=== LOAD TEST (require index.js) ===");
let failed = false;
try {
  const k = require(path.join(root, "index.js"));
  console.log("LOAD_OK; KUZU_VERSION=" + k.VERSION);
} catch (e) {
  failed = true;
  const blob = String(e.message) + " " + String(e.code);
  console.log("LOAD_FAIL");
  console.log("  message: " + e.message);
  console.log("  code   : " + (e.code || "(none)"));
  console.log("  errno  : " + (e.errno != null ? e.errno : "(none)"));
  if (/not a valid Win32 application|\b193\b/.test(blob)) {
    console.log("  HINT   : ARCH MISMATCH — the .node arch != the process arch.");
    console.log("           Are you running the x64 (emulated) Electron on ARM64? Use the arm64 Electron build.");
  } else if (/specified module could not be found|cannot find|\b12[67]\b/.test(blob)) {
    console.log("  HINT   : a dependent DLL is missing — most likely the ARM64 VC++ runtime");
    console.log("           (VCRUNTIME140.dll / MSVCP140.dll). Install the ARM64 VC++ Redistributable");
    console.log("           (vc_redist.arm64.exe), or rebuild kuzujs with a static CRT.");
  } else {
    console.log("  HINT   : unrecognised error — paste this whole output back.");
  }
}

// Don't leave a windowless Electron process hanging.
if (process.versions.electron) {
  try {
    const el = require("electron");
    if (el && typeof el === "object" && el.app) {
      const done = () => el.app.exit(failed ? 1 : 0);
      el.app.isReady() ? done() : el.app.whenReady().then(done);
    }
  } catch (_) {
    /* running as ELECTRON_RUN_AS_NODE — nothing to exit */
  }
}
if (failed) process.exitCode = 1;
