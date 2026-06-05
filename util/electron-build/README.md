# Electron-compatible Windows build (`kuzujs.node`)

## TL;DR

The default `prebuilt/kuzujs-win32-x64.node` shipped by upstream kuzu **crashes when
loaded inside Electron** (the process dies on `process.dlopen`). The binary in this
repo's `prebuilt/` has been rebuilt with a one-line delay-load fix so the **same file
works in both Node.js and Electron**. Targets verified: **Electron 39.8.10 (Node 22.22),
plain Node 22.22, win x64**. The build script (`build-win-electron.bat`) also produces a
**win arm64** binary by cross-compiling from an x64 host — `prebuilt/kuzujs-win32-arm64.node`
is built and statically verified (PE machine = arm64, `node.exe` delay import, N-API entry
exported); see [ARM64](#arm64-windows-on-arm) below for the toolchain component and the
upstream fixes it needs. Runtime smoke-testing of the arm64 binary requires real
Windows-on-ARM hardware (an x64 host cannot load it).

## Root cause

The addon is a pure **N-API (Node-API v6)** module — N-API is ABI-stable across Node and
Electron, so in principle one binary should run on both. On Windows, however, the addon
must resolve the `napi_*` symbols from the host executable. kuzu's CMake build links them
as a **normal (hard) import from `node.exe`**:

```
NORMAL IMPORTS: node.exe, KERNEL32.dll, ...   <-- hard dependency on node.exe
DELAY IMPORTS : (none)
```

Inside `electron.exe` there is no `node.exe` to satisfy that import, so the Windows loader
fails and the process segfaults the moment the `.node` is loaded.

This affects upstream kuzu too — the official npm `kuzu@0.11.3` win32-x64 prebuilt is
byte-identical and has the same defect. It is **not** a kuzu-lite regression.

## The fix

kuzu's addon CMake already compiles in cmake-js's `win_delay_load_hook.cc` (via
`${CMAKE_JS_SRC}`) but never enables delay-loading, so the hook is inert. Adding the
linker flag activates it:

```cmake
if(WIN32)
  target_link_options(kuzujs PRIVATE /DELAYLOAD:node.exe)
  target_link_libraries(kuzujs PRIVATE delayimp)
endif()
```

After rebuilding, `node.exe` moves to the **delay-import** table. At first call the
`win_delay_load_hook` resolves the N-API symbols from `GetModuleHandle(NULL)` — i.e.
whatever process is hosting the addon (`node.exe` **or** `electron.exe`). One binary,
both runtimes.

```
NORMAL IMPORTS: KERNEL32.dll, MSVCP140.dll, ...   (no node.exe)
DELAY IMPORTS : node.exe (attrs=0x1)              <-- resolved from host at runtime
```

`patch-cmakelists.js` applies this block idempotently to
`node_modules/kuzu/kuzu-source/tools/nodejs_api/CMakeLists.txt` (that tree is not
committed, so the patch is reapplied at build time).

## Rebuild from scratch

```bat
:: from repo root
yarn add kuzu                       :: populate node_modules/kuzu/kuzu-source
cd node_modules\kuzu\kuzu-source\tools\nodejs_api
npm install --include=dev           :: cmake-js + node-addon-api
cd ..\..\..\..\..
util\electron-build\build-win-electron.bat            :: x64 (default)
util\electron-build\build-win-electron.bat arm64      :: arm64 (cross from x64 host)
```

The script auto-locates Visual Studio via `vswhere` (override with the `VSINSTALL`
env var), runs a **toolchain preflight** (`check-toolchain.js`), patches the
CMakeLists, runs the full static build (`cmake -G Ninja`, `--target kuzujs`), copies
the result to `prebuilt\kuzujs-win32-<arch>.node`, and finally re-parses the produced
PE to assert `node.exe` is a delay import. The root `kuzujs.node` is refreshed only
when the target arch matches the host (an arm64 binary can't load on an x64 host).

Toolchain used for the committed x64 binary: **VS 2026, MSVC 14.50.35717, cmake+ninja
from VS, Node 22.22.0**. A full build is ~1000 compile steps; expect a few minutes on a
12-core box.

### ARM64 (Windows on ARM)

`kuzujs-win32-arm64.node` is produced by **cross-compiling from an x64 host**, which
needs the separate **"MSVC … ARM64/ARM64EC build tools"** VS component (the default x64
toolset cannot target ARM64). Check first:

```bat
node util\electron-build\check-toolchain.js arm64
```

If it reports `INCOMPLETE`, it prints the exact `vs_installer … --add
Microsoft.VisualStudio.Component.VC.Tools.ARM64` command to add the component (or use
the VS Installer GUI → Individual components → search "ARM64"). The Windows SDK already
ships ARM64 libs, so only the MSVC cross toolset is missing on a typical x64 dev box.

**Auto-install.** `build-win-electron.bat` will install that component for you when the
preflight finds it missing — it runs `vs_installer modify … --add … --quiet --norestart
--wait`, then re-checks and continues. This needs an **elevated (Administrator)** prompt
(the script verifies via `net session`). To install without building, or to install
ahead of time:

```bat
util\electron-build\build-win-electron.bat install-tools arm64
```

Set `NO_INSTALL_TOOLS=1` to disable auto-install and just fail with guidance instead.

The build script passes `-DCMAKE_SYSTEM_NAME=Windows -DCMAKE_SYSTEM_PROCESSOR=ARM64`
for the cross configure and uses `vcvarsamd64_arm64.bat`.

**Upstream ARM64 fixes** (applied idempotently by `patch-cmakelists.js`, since the
kuzu source tree under `node_modules` is not committed; harmless for x64 builds):

1. **`_AMD64_` hard-coded** in the root `CMakeLists.txt` → `<winnt.h>` takes the x64
   branch and references x64-only intrinsics, failing with `C3861` (`ReadAcquire8`,
   `WriteRelease8`, …). Fixed by choosing `_ARM64_` vs `_AMD64_` from
   `CMAKE_SYSTEM_PROCESSOR`.
2. **PCG endianness** (`third_party/pcg/pcg_uint128.hpp`) only recognises x86/x64 as
   little-endian and `#error`s on ARM64 (`C1189`). Fixed by adding ARM/ARM64 to the
   little-endian branch.
3. **cmake-js node.lib arch**: `cmake-js print-cmakejs-lib` resolves `node.lib` for the
   *host* arch and ignores `npm_config_arch`, so the addon would link against the x64
   `node.lib` and fail with `LNK1112`. Fixed by passing `--arch <target>` (mapped from
   `CMAKE_SYSTEM_PROCESSOR`) to the resolver so it picks `win-arm64/node.lib`.

The first two match the known fixes from the ladybug ARM64 port. A clean cross build is
~1070 steps. **Runtime** verification still needs real Windows-on-ARM hardware (or an
arm64 VM) — an x64 host can build the binary but cannot load it. The static checks
(`pe-imports.js`: machine arch, `node.exe` delay import, exported N-API entry point) all
pass for the produced binary.

### Static CRT — no VC++ redistributable required

The first arm64 build loaded fine on a dev box but failed on a clean Windows-on-ARM
machine with `ERR_DLOPEN_FAILED: The specified module could not be found` (Windows error
126). Root cause: the addon **dynamically linked the MSVC runtime** (`VCRUNTIME140.dll`,
`MSVCP140.dll`), which is part of the VC++ redistributable — present on dev machines but
**not on a fresh ARM64 device**. (The x64 prebuilt has the same latent dependency; it
just usually finds a redist already installed.)

Fix: `build-win-electron.bat` configures with `-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`
(**static CRT, `/MT`**), so the produced `.node` is self-contained. After the fix the only
normal imports left are `KERNEL32.dll` and `WS2_32.dll` (both core OS); the VC++ runtime
is gone. `pe-imports.js` asserts this — its verdict prints `PASS: VC++ runtime dependency
none (static CRT)`. This works because `cmake_minimum_required(3.15)` makes CMake policy
`CMP0091` NEW, so the runtime library is selected via this variable rather than hard-coded
`/MD` flags. Diagnose a load failure on the target with `diagnose.js` (prints host vs
binary arch and the exact dlopen error + Windows code).

## Verify

```bat
:: Node 22
node util\electron-smoke\node-smoke.js                       :: -> NODE_SMOKE_OK

:: Electron (install electron@39 first: npm i --no-save electron@^39)
set ELECTRON_RUN_AS_NODE=
node_modules\.bin\electron util\electron-smoke\main.js       :: -> SMOKE_OK

:: Inspect PE import tables — prints machine arch + PASS/FAIL verdict for the
:: N-API entry, node.exe delay import, and VC++ runtime (static-CRT) dependency
node util\electron-smoke\pe-imports.js prebuilt\kuzujs-win32-x64.node
node util\electron-smoke\pe-imports.js prebuilt\kuzujs-win32-arm64.node

:: Diagnose a load failure ON THE TARGET machine (host vs binary arch, exact
:: dlopen error + Windows error code). Run under both node and electron.
node util\electron-smoke\diagnose.js
```

## Other platforms are already Electron-compatible (no rebuild needed)

The delay-load problem is **Windows-only**. On Linux/macOS the N-API symbols are
resolved at load time from the host process via the dynamic linker, so the same
`.node` works under both `node` and `electron`:

- **Linux / Alpine (ELF):** napi symbols are undefined globals resolved from the
  host; `kuzu_native.js` already loads with `RTLD_LAZY | RTLD_GLOBAL`. There is no
  ELF equivalent of a hard `node.exe` import.
- **macOS (Mach-O):** the addon is linked with `-undefined dynamic_lookup`
  (see the `if(APPLE)` block in the addon CMakeLists), so napi symbols are looked
  up dynamically from the host at load.

Verified with `util/electron-smoke/dep-scan.js`, which prints each binary's hard
library dependencies. None of the non-Windows prebuilts depend on `node` — only on
standard system libraries:

| prebuilt | format | hard `node` dep | needs delay-load fix |
|---|---|---|---|
| `kuzujs-win32-x64.node` (was) | PE | **yes** (`node.exe`, normal import) | **yes — fixed here** |
| `kuzujs-linux-x64.node` | ELF64 x86-64 | no | no |
| `kuzujs-linux-arm64.node` | ELF64 aarch64 | no | no |
| `kuzujs-alpine-amd64.node` | ELF64 musl x86-64 | no | no |
| `kuzujs-alpine-arm64.node` | ELF64 musl aarch64 | no | no |
| `kuzujs-darwin-x64.node` | Mach-O x86-64 | no | no |
| `kuzujs-darwin-arm64.node` | Mach-O arm64 | no | no |

```bat
node util\electron-smoke\dep-scan.js prebuilt\kuzujs-linux-x64.node prebuilt\kuzujs-darwin-arm64.node
```

## Known issue (pre-existing, unrelated to this fix)

On Windows + Node 22 the process exits with an access violation (`0xC0000005`) **during
teardown**, after all queries have completed correctly and `close()` has returned. This
reproduces identically with the **original upstream binary**, so it is a pre-existing
kuzu shutdown issue, not caused by the delay-load change. It does not affect query
results or normal long-lived app usage; investigate separately if a clean process exit
is required.
