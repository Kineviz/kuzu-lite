@echo off
REM ============================================================================
REM  Build an Electron-compatible (and Node-compatible) Windows x64 kuzujs.node.
REM
REM  Prereqs:
REM    - Visual Studio 2022/2026 with "Desktop development with C++"
REM      (provides cl.exe, cmake, ninja). Edit VCVARS below if your path differs.
REM    - Node.js 22.x installed.
REM    - From repo root:  yarn add kuzu   (populates node_modules/kuzu/kuzu-source)
REM    - cd node_modules/kuzu/kuzu-source/tools/nodejs_api && npm install --include=dev
REM
REM  Usage (from repo root):  util\electron-build\build-win-electron.bat
REM ============================================================================
setlocal
set VCVARS=D:\visualStudio\apps\VC\Auxiliary\Build\vcvars64.bat
set ROOT=e:\projects\kuzu-lite
set KUZU_SRC=%ROOT%\node_modules\kuzu\kuzu-source

if not exist "%VCVARS%" (
  echo [ERROR] vcvars64.bat not found at %VCVARS%
  echo         Edit VCVARS in this script to point at your VS install.
  exit /b 1
)

echo ===== PATCH CMakeLists (delay-load) =====
node "%ROOT%\util\electron-build\patch-cmakelists.js"
if errorlevel 1 ( echo [ERROR] patch failed & exit /b 1 )

call "%VCVARS%" >nul 2>&1
cd /d "%KUZU_SRC%"
set CMAKE_BUILD_PARALLEL_LEVEL=12

echo ===== CONFIGURE =====
cmake -B build/release -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DBUILD_NODEJS=TRUE ^
  -DBUILD_SHELL=FALSE ^
  -DBUILD_TESTS=FALSE ^
  -DBUILD_BENCHMARK=FALSE ^
  -DBUILD_EXAMPLES=FALSE ^
  -DBUILD_SINGLE_FILE_HEADER=FALSE ^
  .
if errorlevel 1 ( echo [ERROR] configure failed & exit /b 1 )

echo ===== BUILD (target kuzujs) =====
cmake --build build/release --config Release --target kuzujs
if errorlevel 1 ( echo [ERROR] build failed & exit /b 1 )

set OUT=%KUZU_SRC%\tools\nodejs_api\build\kuzujs.node
if not exist "%OUT%" ( echo [ERROR] output not found: %OUT% & exit /b 1 )

echo ===== INSTALL into repo =====
copy /y "%OUT%" "%ROOT%\kuzujs.node" >nul
copy /y "%OUT%" "%ROOT%\prebuilt\kuzujs-win32-x64.node" >nul
echo Copied to %ROOT%\kuzujs.node and prebuilt\kuzujs-win32-x64.node

echo ===== DONE =====
endlocal
