@echo off
REM ============================================================================
REM  Build an Electron-compatible (and Node-compatible) Windows kuzujs.node,
REM  for x64 or arm64. The delay-load fix (/DELAYLOAD:node.exe) makes ONE binary
REM  load under both node.exe and electron.exe.
REM
REM  Usage (from repo root):
REM    util\electron-build\build-win-electron.bat                :: x64 (default)
REM    util\electron-build\build-win-electron.bat x64
REM    util\electron-build\build-win-electron.bat arm64          :: cross from x64 host
REM    util\electron-build\build-win-electron.bat install-tools arm64
REM                                                  :: only install the toolchain
REM
REM  If the toolchain for the target arch is missing, the script tries to install
REM  it via vs_installer (needs an ELEVATED prompt). Set NO_INSTALL_TOOLS=1 to
REM  disable that and fail with guidance instead.
REM
REM  Prereqs:
REM    - Visual Studio 2022/2026 with "Desktop development with C++".
REM    - Node.js 22.x.
REM    - From repo root:  yarn add kuzu     (populates node_modules/kuzu/kuzu-source)
REM    - cd node_modules\kuzu\kuzu-source\tools\nodejs_api && npm install --include=dev
REM
REM  VS is located via vswhere; override by setting VSINSTALL before calling.
REM ============================================================================
setlocal EnableDelayedExpansion

REM ---- mode + target arch ----------------------------------------------------
set "MODE=build"
if /I "%~1"=="install-tools" (
  set "MODE=install"
  set "ARCH=%~2"
) else (
  set "ARCH=%~1"
)
if "%ARCH%"=="" set "ARCH=x64"
if /I "%ARCH%"=="amd64" set "ARCH=x64"
if /I "%ARCH%"=="x64" ( set "ARCH=x64" ) else if /I "%ARCH%"=="arm64" ( set "ARCH=arm64" ) else (
  echo [ERROR] Unknown arch "%ARCH%". Use x64 or arm64.
  exit /b 2
)

REM ---- repo root (this script lives in util\electron-build) -------------------
set "ROOT=%~dp0..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "KUZU_SRC=%ROOT%\node_modules\kuzu\kuzu-source"

REM ---- host arch -------------------------------------------------------------
set "HOSTARCH=x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "HOSTARCH=arm64"

echo ===== MODE=%MODE%  TARGET=%ARCH%  HOST=%HOSTARCH%  ROOT=%ROOT% =====

REM ---- locate Visual Studio (vswhere) unless VSINSTALL preset ----------------
if not defined VSINSTALL (
  set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
  if not exist "!VSWHERE!" (
    echo [ERROR] vswhere not found: !VSWHERE!
    exit /b 1
  )
  for /f "usebackq delims=" %%i in (`"!VSWHERE!" -latest -prerelease -property installationPath`) do set "VSINSTALL=%%i"
)
if not defined VSINSTALL (
  echo [ERROR] Could not locate a Visual Studio installation.
  exit /b 1
)
echo [info] VS install: %VSINSTALL%

REM ---- pick the right vcvars (host -> target) --------------------------------
if /I "%ARCH%"=="x64" (
  if /I "%HOSTARCH%"=="arm64" ( set "VCVARS_NAME=vcvarsarm64_amd64.bat" ) else ( set "VCVARS_NAME=vcvars64.bat" )
) else (
  if /I "%HOSTARCH%"=="arm64" ( set "VCVARS_NAME=vcvarsarm64.bat" ) else ( set "VCVARS_NAME=vcvarsamd64_arm64.bat" )
)
set "VCVARS=%VSINSTALL%\VC\Auxiliary\Build\%VCVARS_NAME%"

REM ---- toolchain preflight; auto-install when incomplete ---------------------
echo ===== TOOLCHAIN CHECK (%ARCH%) =====
node "%ROOT%\util\electron-build\check-toolchain.js" %ARCH%
if errorlevel 1 (
  call :install_tools
  if errorlevel 1 exit /b 1
)
if not exist "%VCVARS%" (
  echo [ERROR] vcvars not found: %VCVARS%
  exit /b 1
)

REM ---- install-only mode: stop here -----------------------------------------
if /I "%MODE%"=="install" (
  echo ===== TOOLCHAIN READY for %ARCH% - install-only mode, not building =====
  endlocal
  exit /b 0
)

REM ---- patch CMakeLists (idempotent delay-load block) ------------------------
echo ===== PATCH CMakeLists (delay-load) =====
node "%ROOT%\util\electron-build\patch-cmakelists.js"
if errorlevel 1 ( echo [ERROR] patch failed & exit /b 1 )

REM ---- enter the build environment ------------------------------------------
echo ===== VCVARS: %VCVARS_NAME% =====
call "%VCVARS%" >nul 2>&1
if errorlevel 1 ( echo [ERROR] vcvars failed & exit /b 1 )
cd /d "%KUZU_SRC%"
if not defined CMAKE_BUILD_PARALLEL_LEVEL set "CMAKE_BUILD_PARALLEL_LEVEL=12"

set "BUILD_DIR=build\release-%ARCH%"

REM ---- cross-compile flags for arm64 from a non-arm64 host -------------------
set "CROSS_FLAGS="
if /I "%ARCH%"=="arm64" if /I not "%HOSTARCH%"=="arm64" (
  set "CROSS_FLAGS=-DCMAKE_SYSTEM_NAME=Windows -DCMAKE_SYSTEM_PROCESSOR=ARM64"
)

echo ===== CONFIGURE (%BUILD_DIR%) =====
REM Static CRT (/MT) so the produced kuzujs.node has NO runtime dependency on the
REM VC++ redistributable (VCRUNTIME140.dll / MSVCP140.dll). Without this the addon
REM fails to load on a clean machine that lacks the redist with
REM ERR_DLOPEN_FAILED "The specified module could not be found" (Win error 126) -
REM which is exactly what bites a fresh Windows-on-ARM box. Honoured because kuzu's
REM cmake_minimum_required(3.15) makes policy CMP0091 NEW.
cmake -B "%BUILD_DIR%" -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded ^
  -DBUILD_NODEJS=TRUE ^
  -DBUILD_SHELL=FALSE ^
  -DBUILD_TESTS=FALSE ^
  -DBUILD_BENCHMARK=FALSE ^
  -DBUILD_EXAMPLES=FALSE ^
  -DBUILD_SINGLE_FILE_HEADER=FALSE ^
  %CROSS_FLAGS% ^
  .
if errorlevel 1 ( echo [ERROR] configure failed & exit /b 1 )

echo ===== BUILD (target kuzujs) =====
cmake --build "%BUILD_DIR%" --config Release --target kuzujs
if errorlevel 1 ( echo [ERROR] build failed & exit /b 1 )

set "OUT=%KUZU_SRC%\tools\nodejs_api\build\kuzujs.node"
if not exist "%OUT%" ( echo [ERROR] output not found: %OUT% & exit /b 1 )

REM ---- install into repo prebuilt/ ------------------------------------------
echo ===== INSTALL into repo =====
copy /y "%OUT%" "%ROOT%\prebuilt\kuzujs-win32-%ARCH%.node" >nul
echo Copied to %ROOT%\prebuilt\kuzujs-win32-%ARCH%.node
REM Only refresh the root runnable kuzujs.node when we built for THIS host arch;
REM an arm64 binary can't load on an x64 host (and vice-versa).
if /I "%ARCH%"=="%HOSTARCH%" (
  copy /y "%OUT%" "%ROOT%\kuzujs.node" >nul
  echo Copied to %ROOT%\kuzujs.node  ^(matches host arch^)
) else (
  echo Skipped root kuzujs.node ^(target %ARCH% != host %HOSTARCH%^)
)

REM ---- verify the produced PE (machine + node.exe delay import) --------------
echo ===== VERIFY PE =====
node "%ROOT%\util\electron-smoke\pe-imports.js" "%ROOT%\prebuilt\kuzujs-win32-%ARCH%.node"
if errorlevel 1 ( echo [ERROR] PE verify failed ^(node.exe not delay-imported?^) & exit /b 1 )

echo ===== DONE (%ARCH%) =====
endlocal
exit /b 0

REM ============================================================================
REM  :install_tools  - ensure the MSVC cross toolset for %ARCH% is installed.
REM  Returns 0 on success, 1 on failure. arm64-from-x64 only; other gaps mean
REM  the base C++ workload is missing and must be installed manually.
REM ============================================================================
:install_tools
echo [warn] Toolchain for %ARCH% is incomplete.
if /I not "%ARCH%"=="arm64" (
  echo [ERROR] Auto-install only handles the arm64 cross tools.
  echo         Install the "Desktop development with C++" workload via VS Installer.
  exit /b 1
)
if /I "%HOSTARCH%"=="arm64" (
  echo [ERROR] On an arm64 host the base toolset already targets arm64;
  echo         install the "Desktop development with C++" workload via VS Installer.
  exit /b 1
)
if "%NO_INSTALL_TOOLS%"=="1" (
  echo [info] NO_INSTALL_TOOLS=1 - skipping auto-install of the ARM64 tools.
  exit /b 1
)
net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Installing VS components requires an ELEVATED Administrator prompt.
  echo         Re-run from an admin terminal, or install manually with vs_installer:
  echo           modify --installPath "%VSINSTALL%" --add Microsoft.VisualStudio.Component.VC.Tools.ARM64
  exit /b 1
)
set "VS_INSTALLER=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vs_installer.exe"
if not exist "%VS_INSTALLER%" (
  echo [ERROR] vs_installer not found: %VS_INSTALLER%
  exit /b 1
)
echo ===== INSTALLING "MSVC ARM64/ARM64EC build tools" (several minutes, ~1-2 GB) =====
REM NOTE: this vs_installer build does NOT support --wait; passing it fails with
REM exit 87 and installs nothing. Launch without it, then poll for the toolset.
"%VS_INSTALLER%" modify --installPath "%VSINSTALL%" --add Microsoft.VisualStudio.Component.VC.Tools.ARM64 --quiet --norestart
set "RC=%errorlevel%"
echo [info] vs_installer launch exit code: %RC%
if not "%RC%"=="0" if not "%RC%"=="3010" (
  echo [ERROR] vs_installer returned %RC% - e.g. 87 = bad args, 1 = failure. Aborting.
  exit /b 1
)
echo [info] Waiting for the ARM64 toolchain to appear (polling, up to ~15 min)...
set /a _tries=0
:wait_tools
node "%ROOT%\util\electron-build\check-toolchain.js" %ARCH% >nul 2>&1
if not errorlevel 1 goto tools_ready
set /a _tries+=1
if %_tries% GEQ 60 (
  echo [ERROR] Toolchain still absent after polling. The install may have failed or is
  echo         still downloading - check the VS Installer UI, then re-run this script.
  exit /b 1
)
ping -n 16 127.0.0.1 >nul
goto wait_tools
:tools_ready
echo [info] ARM64 toolchain is now present.
exit /b 0
