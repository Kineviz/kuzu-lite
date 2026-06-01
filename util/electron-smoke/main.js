"use strict";

// Electron main-process smoke test for the kuzu-lite N-API addon.
// Loads the prebuilt kuzujs.node under the Electron runtime (no BrowserWindow)
// and runs a real in-memory query to prove ABI compatibility.

const path = require("path");
const fs = require("fs");
const { app } = require("electron");

const logPath = path.join(__dirname, "smoke.log");
fs.writeFileSync(logPath, "");
function step(msg) {
  const line = msg + "\n";
  fs.appendFileSync(logPath, line); // synchronous → survives a native crash
  process.stdout.write(line);
}

// Headless: we never create a window, so disable GPU to avoid display deps.
app.disableHardwareAcceleration();

async function run() {
  step("ELECTRON_VERSION=" + process.versions.electron);
  step("NODE_VERSION=" + process.versions.node);
  step("NAPI_MODULES=" + process.versions.napi);
  step("ARCH=" + process.arch);

  step("STEP: requiring kuzu_native directly");
  const native = require(path.join(__dirname, "..", "..", "kuzu_native.js"));
  step("STEP: kuzu_native loaded; keys=" + Object.keys(native).join(","));

  step("STEP: calling NodeDatabase.getVersion()");
  const ver = native.NodeDatabase.getVersion();
  step("KUZU_VERSION=" + ver);

  step("STEP: requiring index.js");
  const kuzu = require(path.join(__dirname, "..", "..", "index.js"));
  step("STEP: index.js loaded");

  step("STEP: creating in-memory Database");
  const db = new kuzu.Database(":memory:");
  const conn = new kuzu.Connection(db);

  step("STEP: running DDL + inserts");
  await conn.query("CREATE NODE TABLE Person(name STRING, age INT64, PRIMARY KEY(name))");
  await conn.query("CREATE (:Person {name: 'Alice', age: 30})");
  await conn.query("CREATE (:Person {name: 'Bob', age: 42})");

  step("STEP: running MATCH query");
  const res = await conn.query("MATCH (p:Person) RETURN p.name AS name, p.age AS age ORDER BY p.age");
  const rows = await res.getAll();
  step("QUERY_ROWS=" + JSON.stringify(rows));

  await conn.close();
  await db.close();

  step("SMOKE_OK");
}

app.whenReady().then(run).then(
  () => app.exit(0),
  (err) => {
    step("SMOKE_FAIL: " + (err && err.stack ? err.stack : String(err)));
    app.exit(1);
  }
);
