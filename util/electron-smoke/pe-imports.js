"use strict";
// Minimal PE import-directory parser: prints the target machine architecture,
// lists normal vs delay imports, and gives a PASS/FAIL verdict on whether
// node.exe is a DELAY import (the Electron-compat requirement).
const fs = require("fs");
const file = process.argv[2];
if (!file) {
  console.error("usage: node pe-imports.js <file.node>");
  process.exit(2);
}
const buf = fs.readFileSync(file);

const peOff = buf.readUInt32LE(0x3c);
if (buf.toString("ascii", peOff, peOff + 4) !== "PE\0\0") throw new Error("not PE");
const coffOff = peOff + 4;
const MACHINE = { 0x8664: "x64 (AMD64)", 0xaa64: "arm64 (AA64)", 0x14c: "x86 (I386)", 0x1c0: "arm" };
const machine = buf.readUInt16LE(coffOff + 0);
const machineName = MACHINE[machine] || "0x" + machine.toString(16);
const numSections = buf.readUInt16LE(coffOff + 2);
const optSize = buf.readUInt16LE(coffOff + 16);
const optOff = coffOff + 20;
const magic = buf.readUInt16LE(optOff);
const pe32plus = magic === 0x20b;
// Data directory offset: PE32 -> optOff+96, PE32+ -> optOff+112
const ddOff = optOff + (pe32plus ? 112 : 96);
const exportRva = buf.readUInt32LE(ddOff + 0 * 8);
const importRva = buf.readUInt32LE(ddOff + 1 * 8);
const delayRva = buf.readUInt32LE(ddOff + 13 * 8);

// Section headers (to map RVA -> file offset)
const secOff = optOff + optSize;
const sections = [];
for (let i = 0; i < numSections; i++) {
  const o = secOff + i * 40;
  sections.push({
    name: buf.toString("ascii", o, o + 8).replace(/\0+$/, ""),
    vaddr: buf.readUInt32LE(o + 12),
    vsize: buf.readUInt32LE(o + 8),
    praw: buf.readUInt32LE(o + 20),
    rawsize: buf.readUInt32LE(o + 16),
  });
}
function rva2off(rva) {
  for (const s of sections) {
    if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawsize)) {
      return s.praw + (rva - s.vaddr);
    }
  }
  return null;
}
function cstr(off) {
  let e = off;
  while (e < buf.length && buf[e] !== 0) e++;
  return buf.toString("ascii", off, e);
}

console.log("FILE   =", file);
console.log("MACHINE=", machineName, "| PE32+ =", pe32plus, "| magic =0x" + magic.toString(16));

const isNode = (dll) => /^node\.exe$/i.test(dll);
const normal = [];
const delay = [];

console.log("\n=== NORMAL IMPORTS (IMAGE_DIRECTORY_ENTRY_IMPORT) ===");
if (importRva) {
  let o = rva2off(importRva);
  while (true) {
    const nameRva = buf.readUInt32LE(o + 12);
    const firstThunk = buf.readUInt32LE(o + 16);
    if (nameRva === 0 && firstThunk === 0) break;
    const dll = cstr(rva2off(nameRva));
    normal.push(dll);
    console.log("DLL:", dll);
    o += 20;
  }
} else console.log("(none)");

console.log("\n=== DELAY IMPORTS (IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT) ===");
if (delayRva) {
  let o = rva2off(delayRva);
  while (true) {
    const attrs = buf.readUInt32LE(o + 0);
    const nameRva = buf.readUInt32LE(o + 4);
    if (nameRva === 0) break;
    const dll = cstr(rva2off(nameRva));
    delay.push(dll);
    console.log("DLL:", dll, "(attrs=0x" + attrs.toString(16) + ")");
    o += 32;
  }
} else console.log("(none) - no delay-import directory");

// --- exports: confirm the N-API entry point is actually exported -------------
const exportNames = [];
if (exportRva) {
  const eo = rva2off(exportRva);
  const nNames = buf.readUInt32LE(eo + 24);
  const namesRva = buf.readUInt32LE(eo + 32);
  let no = rva2off(namesRva);
  for (let i = 0; i < nNames; i++) {
    exportNames.push(cstr(rva2off(buf.readUInt32LE(no))));
    no += 4;
  }
}
const NAPI_ENTRY = "napi_register_module_v1";
const hasNapiEntry = exportNames.includes(NAPI_ENTRY);
console.log("\n=== EXPORTS (" + exportNames.length + " total) ===");
console.log(NAPI_ENTRY + ": " + (hasNapiEntry ? "present" : "MISSING"));

// --- redist dependency: a self-contained .node must not import the VC++ -------
// runtime (VCRUNTIME140*/MSVCP140*), or it fails with ERR_DLOPEN_FAILED on a
// clean machine without the redistributable (Windows error 126).
const redistDlls = normal.filter((d) => /^(vcruntime140|msvcp140|concrt140)/i.test(d));
const selfContained = redistDlls.length === 0;

// --- verdict: node.exe must be a DELAY import for Electron compatibility ------
const nodeNormal = normal.some(isNode);
const nodeDelay = delay.some(isNode);
console.log("\n=== VERDICT ===");
console.log(
  (hasNapiEntry ? "PASS" : "FAIL") +
    ": N-API entry point " + NAPI_ENTRY + (hasNapiEntry ? " is exported." : " is MISSING.")
);
console.log(
  (selfContained ? "PASS" : "WARN") +
    ": VC++ runtime dependency " +
    (selfContained
      ? "none (static CRT) -> loads without the redistributable."
      : "[" + redistDlls.join(", ") + "] -> target needs the VC++ redist, or rebuild with static CRT.")
);
if (nodeNormal) {
  console.log("FAIL: node.exe is a NORMAL import -> will crash inside electron.exe.");
  process.exit(1);
} else if (nodeDelay) {
  console.log("PASS: node.exe is a DELAY import -> loads in both node.exe and electron.exe.");
} else {
  console.log("PASS: no node.exe import at all -> N-API symbols resolved from host at load.");
}
if (!hasNapiEntry) process.exit(1);
