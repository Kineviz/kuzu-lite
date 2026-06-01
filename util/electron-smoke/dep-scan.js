"use strict";
// Cross-format native-module dependency scanner.
// Detects PE / ELF / Mach-O and prints the hard library dependencies, so we can
// confirm that non-Windows .node files have NO hard dependency on a `node`
// executable (which is what makes them already Electron-compatible).
const fs = require("fs");

function scan(file) {
  const buf = fs.readFileSync(file);
  const m = buf.readUInt32BE(0);
  if (buf[0] === 0x7f && buf.toString("ascii", 1, 4) === "ELF") return elf(buf);
  if (m === 0xfeedfacf || m === 0xfeedface) return macho(buf, false);
  if (m === 0xcffaedfe || m === 0xcefaedfe) return macho(buf, true); // LE magic
  if (buf.toString("ascii", 0, 2) === "MZ") return { fmt: "PE", note: "use pe-imports.js" };
  return { fmt: "unknown magic 0x" + m.toString(16) };
}

function elf(buf) {
  const is64 = buf[4] === 2;
  const le = buf[5] === 1;
  const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const r64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const machineNames = { 0x3e: "x86-64", 0xb7: "aarch64", 0x28: "arm" };
  const e_machine = r16(18);
  const e_shoff = is64 ? r64(0x28) : r32(0x20);
  const e_shentsize = r16(is64 ? 0x3a : 0x2e);
  const e_shnum = r16(is64 ? 0x3c : 0x30);
  const e_shstrndx = r16(is64 ? 0x3e : 0x32);
  const sh = (i) => {
    const o = e_shoff + i * e_shentsize;
    return {
      name: r32(o),
      type: r32(o + 4),
      offset: is64 ? r64(o + 24) : r32(o + 16),
      size: is64 ? r64(o + 32) : r32(o + 20),
      link: r32(o + (is64 ? 40 : 24)),
      entsize: is64 ? r64(o + 56) : r32(o + 36),
    };
  };
  // find .dynamic (type 6) and its linked strtab
  let dyn = null;
  for (let i = 0; i < e_shnum; i++) {
    const s = sh(i);
    if (s.type === 6) { dyn = s; break; }
  }
  const needed = [];
  let soname = null;
  if (dyn) {
    const str = sh(dyn.link);
    const cstr = (off) => {
      let e = str.offset + off;
      let s = e;
      while (s < buf.length && buf[s] !== 0) s++;
      return buf.toString("utf8", e, s);
    };
    const step = is64 ? 16 : 8;
    for (let o = dyn.offset; o < dyn.offset + dyn.size; o += step) {
      const tag = is64 ? r64(o) : r32(o);
      const val = is64 ? r64(o + 8) : r32(o + 4);
      if (tag === 0) break;
      if (tag === 1) needed.push(cstr(val)); // DT_NEEDED
      if (tag === 14) soname = cstr(val); // DT_SONAME
    }
  }
  const hasNapi = buf.includes(Buffer.from("napi_create_string_utf8"));
  return {
    fmt: "ELF" + (is64 ? "64" : "32"),
    arch: machineNames[e_machine] || "0x" + e_machine.toString(16),
    soname,
    needed,
    hardNodeDep: needed.some((n) => /(^|\W)node(\W|$)|node\.exe/i.test(n)),
    napiSymbolsPresent: hasNapi,
  };
}

function macho(buf, swap) {
  // assume LE host; thin Mach-O 64-bit
  const r32 = (o) => buf.readUInt32LE(o);
  const cpu = r32(4);
  const ncmds = r32(16);
  const archNames = { 0x01000007: "x86-64", 0x0100000c: "arm64" };
  let o = 32; // mach_header_64 size
  const dylibs = [];
  for (let i = 0; i < ncmds; i++) {
    const cmd = r32(o);
    const cmdsize = r32(o + 4);
    if (cmd === 0x0c || cmd === 0x0d) {
      // LC_LOAD_DYLIB / LC_LOAD_WEAK_DYLIB
      const nameOff = r32(o + 8);
      let s = o + nameOff;
      let e = s;
      while (e < o + cmdsize && buf[e] !== 0) e++;
      dylibs.push(buf.toString("utf8", s, e));
    }
    o += cmdsize;
  }
  const flags = r32(24);
  const hasNapi = buf.includes(Buffer.from("napi_create_string_utf8"));
  return {
    fmt: "Mach-O64",
    arch: archNames[cpu] || "0x" + cpu.toString(16),
    twoLevel: !!(flags & 0x80),
    undefinedDynamicLookup: !!(flags & 0x200000), // MH_NLIST_OUTOFSYNC? no — use note below
    dylibs,
    hardNodeDep: dylibs.some((n) => /(^|\/)node(\W|$)|node\.exe/i.test(n)),
    napiSymbolsPresent: hasNapi,
  };
}

for (const f of process.argv.slice(2)) {
  console.log("==== " + f + " ====");
  try { console.log(JSON.stringify(scan(f), null, 2)); }
  catch (e) { console.log("ERROR: " + e.message); }
}
