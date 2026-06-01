"use strict";
/*
 * Idempotently patches the kuzu Node.js addon CMakeLists so the produced
 * kuzujs.node DELAY-loads `node.exe` on Windows. Without this, the N-API
 * symbols are hard-imported from node.exe and the addon crashes on load
 * inside Electron (electron.exe). Delay-loading lets the bundled
 * win_delay_load_hook resolve the imports from whichever host process loads
 * the addon (node.exe OR electron.exe) — one binary works in both.
 *
 * Run automatically by build-win-electron.bat; safe to run repeatedly.
 */
const fs = require("fs");
const path = require("path");

const cmakePath = path.join(
  __dirname,
  "..",
  "..",
  "node_modules",
  "kuzu",
  "kuzu-source",
  "tools",
  "nodejs_api",
  "CMakeLists.txt"
);

if (!fs.existsSync(cmakePath)) {
  console.error("[patch] CMakeLists not found:", cmakePath);
  console.error("[patch] Run `yarn add kuzu` / `npm install` first.");
  process.exit(1);
}

const MARKER = "/DELAYLOAD:node.exe";
let src = fs.readFileSync(cmakePath, "utf8");

if (src.includes(MARKER)) {
  console.log("[patch] Delay-load block already present — nothing to do.");
  process.exit(0);
}

const anchor = "target_link_libraries(kuzujs PRIVATE kuzu ${CMAKE_JS_LIB})";
if (!src.includes(anchor)) {
  console.error("[patch] Anchor line not found; CMakeLists layout changed:");
  console.error("        " + anchor);
  process.exit(1);
}

const block = [
  "# [kuzu-lite] Make the addon loadable inside Electron (electron.exe) as well",
  "# as Node (node.exe) by delay-loading node.exe so the win_delay_load_hook",
  "# (from ${CMAKE_JS_SRC}) can resolve the N-API symbols from the host process.",
  "if(WIN32)",
  "  target_link_options(kuzujs PRIVATE /DELAYLOAD:node.exe)",
  "  target_link_libraries(kuzujs PRIVATE delayimp)",
  "endif()",
  anchor,
].join("\n");

src = src.replace(anchor, block);
fs.writeFileSync(cmakePath, src);
console.log("[patch] Added Windows delay-load block to", cmakePath);
