"use strict";
// Minimal PE import-directory parser: lists normal imports and delay imports.
const fs = require("fs");
const file = process.argv[2];
const buf = fs.readFileSync(file);

const peOff = buf.readUInt32LE(0x3c);
if (buf.toString("ascii", peOff, peOff + 4) !== "PE\0\0") throw new Error("not PE");
const coffOff = peOff + 4;
const numSections = buf.readUInt16LE(coffOff + 2);
const optSize = buf.readUInt16LE(coffOff + 16);
const optOff = coffOff + 20;
const magic = buf.readUInt16LE(optOff);
const pe32plus = magic === 0x20b;
// Data directory offset: PE32 -> optOff+96, PE32+ -> optOff+112
const ddOff = optOff + (pe32plus ? 112 : 96);
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

console.log("PE32+ =", pe32plus, "| magic =0x" + magic.toString(16));

console.log("\n=== NORMAL IMPORTS (IMAGE_DIRECTORY_ENTRY_IMPORT) ===");
if (importRva) {
  let o = rva2off(importRva);
  while (true) {
    const nameRva = buf.readUInt32LE(o + 12);
    const firstThunk = buf.readUInt32LE(o + 16);
    if (nameRva === 0 && firstThunk === 0) break;
    const dll = cstr(rva2off(nameRva));
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
    console.log("DLL:", dll, "(attrs=0x" + attrs.toString(16) + ")");
    o += 32;
  }
} else console.log("(none) - no delay-import directory");
