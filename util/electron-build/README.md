# Electron-compatible Windows build (`kuzujs.node`)

## TL;DR

The default `prebuilt/kuzujs-win32-x64.node` shipped by upstream kuzu **crashes when
loaded inside Electron** (the process dies on `process.dlopen`). The binary in this
repo's `prebuilt/` has been rebuilt with a one-line delay-load fix so the **same file
works in both Node.js and Electron**. Targets verified: **Electron 39.8.10 (Node 22.22),
plain Node 22.22, win x64**.

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
util\electron-build\build-win-electron.bat
```

The script patches the CMakeLists, runs the full static build (`cmake -G Ninja`,
`--target kuzujs`), and copies the result to both `kuzujs.node` and
`prebuilt\kuzujs-win32-x64.node`.

Toolchain used for the committed binary: **VS 2026, MSVC 14.50.35717, cmake+ninja from
VS, Node 22.22.0**. (Edit `VCVARS` in the `.bat` if your VS path differs.) A full build
is ~1000 compile steps; expect a few minutes on a 12-core box.

## Verify

```bat
:: Node 22
node util\electron-smoke\node-smoke.js                       :: -> NODE_SMOKE_OK

:: Electron (install electron@39 first: npm i --no-save electron@^39)
set ELECTRON_RUN_AS_NODE=
node_modules\.bin\electron util\electron-smoke\main.js       :: -> SMOKE_OK

:: Inspect PE import tables (node.exe must be a DELAY import)
node util\electron-smoke\pe-imports.js prebuilt\kuzujs-win32-x64.node
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
