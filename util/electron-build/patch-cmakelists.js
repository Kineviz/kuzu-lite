"use strict";
/*
 * Idempotently patches the kuzu CMake build (which lives in the un-committed
 * node_modules/kuzu/kuzu-source tree, so the patches are re-applied at build
 * time) with two kuzu-lite fixes:
 *
 *   1) Addon delay-load (Electron): make the produced kuzujs.node DELAY-load
 *      node.exe on Windows so the bundled win_delay_load_hook can resolve the
 *      N-API symbols from whichever host process loads it (node.exe OR
 *      electron.exe). Without this the addon hard-imports node.exe and crashes
 *      on load inside Electron.
 *
 *   2) Target-arch macro (ARM64 cross build): the root CMakeLists hard-codes
 *      -D_AMD64_ for every MSVC build. When cross-compiling for ARM64 that
 *      makes <winnt.h> take the AMD64 branch and reference x64-only intrinsics,
 *      failing with C3861 (ReadAcquire8/WriteRelease8/... not found). Pick the
 *      arch define from CMAKE_SYSTEM_PROCESSOR instead.
 *
 * Run automatically by build-win-electron.bat; safe to run repeatedly.
 */
const fs = require("fs");
const path = require("path");

const KUZU_ROOT = path.join(
  __dirname,
  "..",
  "..",
  "node_modules",
  "kuzu",
  "kuzu-source"
);

/**
 * Apply one idempotent patch. Skips if `marker` is already present; aborts if
 * `anchor` is missing (so a changed upstream layout fails loudly).
 */
function patchFile(file, marker, anchor, replacement, label) {
  if (!fs.existsSync(file)) {
    console.error("[patch] " + label + ": file not found: " + file);
    console.error("[patch] Run `yarn add kuzu` / `npm install` first.");
    process.exit(1);
  }
  let src = fs.readFileSync(file, "utf8");
  if (src.includes(marker)) {
    console.log("[patch] " + label + ": already present - nothing to do.");
    return;
  }
  if (!src.includes(anchor)) {
    console.error("[patch] " + label + ": anchor not found; layout changed:");
    console.error("        " + anchor);
    process.exit(1);
  }
  src = src.replace(anchor, replacement);
  fs.writeFileSync(file, src);
  console.log("[patch] " + label + ": applied to " + file);
}

// --- 1) Addon delay-load (Electron compatibility) ----------------------------
const addonAnchor = "target_link_libraries(kuzujs PRIVATE kuzu ${CMAKE_JS_LIB})";
patchFile(
  path.join(KUZU_ROOT, "tools", "nodejs_api", "CMakeLists.txt"),
  "/DELAYLOAD:node.exe",
  addonAnchor,
  [
    "# [kuzu-lite] Make the addon loadable inside Electron (electron.exe) as well",
    "# as Node (node.exe) by delay-loading node.exe so the win_delay_load_hook",
    "# (from ${CMAKE_JS_SRC}) can resolve the N-API symbols from the host process.",
    "if(WIN32)",
    "  target_link_options(kuzujs PRIVATE /DELAYLOAD:node.exe)",
    "  target_link_libraries(kuzujs PRIVATE delayimp)",
    "endif()",
    addonAnchor,
  ].join("\n"),
  "addon delay-load (Electron)"
);

// --- 2) Target-arch macro (ARM64 cross build) --------------------------------
patchFile(
  path.join(KUZU_ROOT, "CMakeLists.txt"),
  "[kuzu-lite] arch macro",
  "    add_compile_definitions(_AMD64_)",
  [
    "    # [kuzu-lite] arch macro: choose the <winnt.h> architecture define from",
    "    # the TARGET processor instead of hard-coding _AMD64_. Hard-coding it",
    "    # breaks ARM64 cross builds (winnt.h then uses x64-only intrinsics ->",
    "    # C3861 ReadAcquire8/WriteRelease8/...).",
    '    if(CMAKE_SYSTEM_PROCESSOR MATCHES "[Aa][Rr][Mm]64|[Aa][Aa][Rr][Cc][Hh]64")',
    "        add_compile_definitions(_ARM64_)",
    "    else()",
    "        add_compile_definitions(_AMD64_)",
    "    endif()",
  ].join("\n"),
  "root arch macro (ARM64 cross)"
);

// --- 2b) cmake-js target arch: map CMAKE_SYSTEM_PROCESSOR -> cmake-js --arch --
// cmake-js's `print-cmakejs-lib` resolves node.lib for the HOST arch unless told
// otherwise via the --arch CLI flag (it ignores npm_config_arch). Without this,
// an ARM64 cross build links the addon against the x64 node.lib and fails with
// LNK1112 (machine type conflict). Define a CMAKEJS_TARGET_ARCH var here...
patchFile(
  path.join(KUZU_ROOT, "tools", "nodejs_api", "CMakeLists.txt"),
  "CMAKEJS_TARGET_ARCH",
  "add_definitions(-DNAPI_VERSION=6)",
  [
    "add_definitions(-DNAPI_VERSION=6)",
    "",
    "# [kuzu-lite] Map the CMake target processor to a cmake-js --arch value so",
    "# the addon links against win-<arch>/node.lib. cmake-js defaults to the host",
    "# arch and ignores npm_config_arch, so an ARM64 cross build would otherwise",
    "# pick up the x64 node.lib and fail to link (LNK1112).",
    'if(CMAKE_SYSTEM_PROCESSOR MATCHES "[Aa][Rr][Mm]64|[Aa][Aa][Rr][Cc][Hh]64")',
    "  set(CMAKEJS_TARGET_ARCH arm64)",
    "else()",
    "  set(CMAKEJS_TARGET_ARCH x64)",
    "endif()",
  ].join("\n"),
  "cmake-js target arch var"
);

// ...and pass it to the lib resolver (the include/src outputs are arch-neutral).
patchFile(
  path.join(KUZU_ROOT, "tools", "nodejs_api", "CMakeLists.txt"),
  "print-cmakejs-lib --arch",
  "  COMMAND ${NPX_CMD} cmake-js print-cmakejs-lib",
  "  COMMAND ${NPX_CMD} cmake-js print-cmakejs-lib --arch ${CMAKEJS_TARGET_ARCH}",
  "cmake-js lib --arch"
);

// --- 3) PCG endianness detection (ARM64) -------------------------------------
// third_party/pcg only recognises x86/x64 as little-endian and #errors out on
// ARM64 ("Unable to determine target endianness"). ARM/ARM64 on Windows and
// Linux are little-endian; add them to the little-endian branch.
patchFile(
  path.join(KUZU_ROOT, "third_party", "pcg", "pcg_uint128.hpp"),
  "|| _M_ARM64 || _M_ARM || __aarch64__ || __arm__",
  "    #elif __x86_64 || __x86_64__ || _M_X64 || __i386 || __i386__ || _M_IX86",
  [
    "    #elif __x86_64 || __x86_64__ || _M_X64 || __i386 || __i386__ || _M_IX86 \\",
    "          || _M_ARM64 || _M_ARM || __aarch64__ || __arm__",
  ].join("\n"),
  "pcg little-endian (ARM64)"
);
