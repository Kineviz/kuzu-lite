"use strict";
/*
 * Toolchain doctor for the Windows kuzujs.node build.
 *
 * Verifies that the MSVC toolchain needed to compile for a given target
 * architecture (x64 or arm64) is actually installed, and — when something is
 * missing — prints the exact `vs_installer` command to add it.
 *
 * The arm64 case is the interesting one: producing a Windows ARM64 .node from
 * an x64 host is a CROSS build, which needs the "MSVC ... ARM64/ARM64EC build
 * tools" component (cross compiler bin/Hostx64/arm64/cl.exe + lib/arm64 CRT).
 * That component is separate from the default x64 toolset and is frequently
 * absent, so we fail fast with actionable guidance instead of deep inside cmake.
 *
 * Usage:   node check-toolchain.js [x64|arm64]      (default: x64)
 * Exit:    0 = toolchain present, 1 = missing pieces, 2 = bad usage / no VS.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function normArch(a) {
  if (!a) return "x64";
  a = a.toLowerCase();
  if (a === "amd64" || a === "x86_64") return "x64";
  if (a === "aarch64") return "arm64";
  return a;
}

const target = normArch(process.argv[2]);
if (target !== "x64" && target !== "arm64") {
  console.error('[doctor] Unknown target arch "' + process.argv[2] + '". Use x64 or arm64.');
  process.exit(2);
}
const hostArch = normArch(process.env.PROCESSOR_ARCHITECTURE || process.arch);

// --- locate the VS installation via vswhere (no hardcoded path) ---------------
function findVsInstall() {
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const vswhere = path.join(pf86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!fs.existsSync(vswhere)) return null;
  try {
    const out = execFileSync(
      vswhere,
      ["-latest", "-prerelease", "-property", "installationPath"],
      { encoding: "utf8" }
    ).trim();
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

function latestMsvcDir(vsInstall) {
  const base = path.join(vsInstall, "VC", "Tools", "MSVC");
  if (!fs.existsSync(base)) return null;
  const versions = fs.readdirSync(base).filter((d) => /^\d+\./.test(d)).sort();
  if (!versions.length) return null;
  return path.join(base, versions[versions.length - 1]);
}

// The vcvars batch that sets up the right host->target environment.
function vcvarsFor(host, tgt) {
  if (tgt === "x64") return host === "arm64" ? "vcvarsarm64_amd64.bat" : "vcvars64.bat";
  // tgt === arm64
  return host === "arm64" ? "vcvarsarm64.bat" : "vcvarsamd64_arm64.bat";
}

// Cross-compiler folder under bin (Host<host>/<target>).
function clHostTargetDir(msvcDir, host, tgt) {
  const hostFolder = host === "arm64" ? "HostArm64" : "Hostx64";
  return path.join(msvcDir, "bin", hostFolder, tgt);
}

const vsInstall = findVsInstall();
if (!vsInstall) {
  console.error("[doctor] No Visual Studio installation found (vswhere returned nothing).");
  console.error("[doctor] Install VS 2022/2026 with the C++ desktop workload first.");
  process.exit(2);
}
const msvcDir = latestMsvcDir(vsInstall);
console.log("[doctor] VS install   : " + vsInstall);
console.log("[doctor] MSVC toolset  : " + (msvcDir || "(none)"));
console.log("[doctor] Host arch     : " + hostArch);
console.log("[doctor] Target arch   : " + target);

const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  console.log("  " + (ok ? "[ OK ]" : "[FAIL]") + " " + label + (detail ? " — " + detail : ""));
}

// 1) vcvars batch
const vcvarsName = vcvarsFor(hostArch, target);
const vcvarsPath = path.join(vsInstall, "VC", "Auxiliary", "Build", vcvarsName);
check("vcvars script (" + vcvarsName + ")", fs.existsSync(vcvarsPath), vcvarsPath);

// 2) cross compiler cl.exe
let clOk = false, clDir = "(no MSVC dir)";
if (msvcDir) {
  clDir = clHostTargetDir(msvcDir, hostArch, target);
  clOk = fs.existsSync(path.join(clDir, "cl.exe"));
}
check("compiler (cl.exe targeting " + target + ")", clOk, clDir);

// 3) target CRT import libs (the real tell for a cross toolset)
let crtOk = false, crtDir = "(no MSVC dir)";
if (msvcDir) {
  crtDir = path.join(msvcDir, "lib", target);
  // libcmt/msvcrt/vcruntime are the core static/dynamic CRT import libs; the
  // bare arm64 folder ships asan libs even without the cross toolset, so we
  // must look for an actual CRT lib, not just the directory.
  crtOk =
    fs.existsSync(crtDir) &&
    ["libcmt.lib", "msvcrt.lib", "vcruntime.lib", "libvcruntime.lib"].some((f) =>
      fs.existsSync(path.join(crtDir, f))
    );
}
check("CRT import libs (lib/" + target + ")", crtOk, crtDir);

// 4) delayimp.lib (needed for the /DELAYLOAD:node.exe Electron fix)
let delayOk = false;
if (msvcDir) {
  delayOk = fs.existsSync(path.join(msvcDir, "lib", target, "delayimp.lib"));
}
check("delayimp.lib (Electron delay-load fix)", delayOk, msvcDir ? path.join(msvcDir, "lib", target, "delayimp.lib") : "");

// 5) Windows SDK libs for the target (ucrt/um) — usually present.
function sdkHasArch(tgt) {
  const roots = [
    "C:\\Program Files (x86)\\Windows Kits\\10\\Lib",
    "C:\\Program Files\\Windows Kits\\10\\Lib",
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const ver of fs.readdirSync(root)) {
      if (fs.existsSync(path.join(root, ver, "um", tgt, "kernel32.lib"))) return true;
    }
  }
  return false;
}
check("Windows SDK libs (um/" + target + ")", sdkHasArch(target));

const allOk = checks.every((c) => c.ok);
console.log("");
if (allOk) {
  console.log("[doctor] RESULT: toolchain for " + target + " is READY.");
  process.exit(0);
}

console.log("[doctor] RESULT: toolchain for " + target + " is INCOMPLETE.");
if (target === "arm64" && hostArch !== "arm64") {
  const comp = "Microsoft.VisualStudio.Component.VC.Tools.ARM64";
  console.log("");
  console.log("[doctor] To add the ARM64 cross build tools, run (elevated):");
  console.log("");
  console.log('  "%ProgramFiles(x86)%\\Microsoft Visual Studio\\Installer\\vs_installer.exe" ^');
  console.log('     modify --installPath "' + vsInstall + '" ^');
  console.log("     --add " + comp + " --quiet --norestart");
  console.log("");
  console.log("[doctor] (Or: VS Installer GUI -> Modify -> Individual components ->");
  console.log('[doctor]  search "ARM64" -> check "MSVC ... ARM64/ARM64EC build tools".)');
}
process.exit(1);
