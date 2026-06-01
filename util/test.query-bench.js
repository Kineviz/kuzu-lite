const path = require("path");
const fs = require("fs");
const { fork } = require("child_process");
const kuzu = require("./../");

// Benchmark 3 comparable queries against the on-disk demo_large database,
// measuring wall-clock time and process memory (RSS) for each.
//
// Two modes:
//   node --expose-gc util/test.query-bench.js            # shared process
//   node --expose-gc util/test.query-bench.js --isolated # one process / query
//
// Kùzu's buffer pool RETAINS pages across queries within a single process, so
// in shared mode the later queries inherit the earlier queries' high RSS
// baseline (their per-query "delta" is still correct, but their absolute "peak"
// is not their own). --isolated runs each query in a fresh `fork`ed process so
// every query gets a clean baseline and an honest peak RSS — the fair
// apples-to-apples memory comparison.
//
// RSS is sampled with process.memoryUsage().rss, which includes Kùzu's native
// buffer-pool allocations (not just the V8 heap), so the heavy scan query shows
// its real >1GB footprint.

const DB_PATH = path.join(__dirname, "./demo_large");

const QUERIES = [
  {
    name: "Q1 node-only scan",
    cypher: "MATCH (n) RETURN * LIMIT 2000",
  },
  {
    name: "Q2 full rel scan (heavy)",
    cypher: "MATCH (n)-[r]->(m) RETURN * LIMIT 2000",
  },
    {
    name: "Q3 rel scan, id-filtered",
    cypher:
      "MATCH (n)-[r]->(m) WHERE ID(n) > internal_id(1, 1)  RETURN * LIMIT 2000",
  },
  {
    name: "Q4 rel scan, id-filtered",
    cypher:
      "MATCH (n)-[r]->(m) WHERE NOT ID(n)  IN [internal_id(3, 0),internal_id(3, 1)] RETURN * LIMIT 2000",
  },
];

const MB = 1024 * 1024;
const toMB = (bytes) => Math.round((bytes / MB) * 10) / 10;

function maybeGc() {
  if (global.gc) {
    global.gc();
  }
}

// Run one query while polling RSS so we capture the peak during execution,
// not just the value at the moment the call returns.
async function runOne(conn, { name, cypher }) {
  maybeGc();

  const memBefore = process.memoryUsage();
  let peakRss = memBefore.rss;

  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }, 25);
  // Don't let the sampler keep the event loop alive.
  if (typeof sampler.unref === "function") sampler.unref();

  const t0 = process.hrtime.bigint();
  const queryResult = await conn.query(cypher);
  const tQuery = process.hrtime.bigint();

  const numTuples = queryResult.getNumTuples();
  const rows = await queryResult.getAll();
  const tFetch = process.hrtime.bigint();

  clearInterval(sampler);

  const memAfter = process.memoryUsage();
  peakRss = Math.max(peakRss, memAfter.rss);

  queryResult.close();

  const queryMs = Number(tQuery - t0) / 1e6;
  const fetchMs = Number(tFetch - tQuery) / 1e6;

  return {
    name,
    cypher,
    numTuples,
    rowsReturned: rows.length,
    queryMs,
    fetchMs,
    totalMs: queryMs + fetchMs,
    rssBeforeMB: toMB(memBefore.rss),
    rssPeakMB: toMB(peakRss),
    rssAfterMB: toMB(memAfter.rss),
    rssDeltaMB: toMB(memAfter.rss - memBefore.rss),
    heapDeltaMB: toMB(memAfter.heapUsed - memBefore.heapUsed),
  };
}

function openDb() {
  // Read-only open: demo_large has the Windows ReadOnly attribute, so a
  // default read-write open would fail with "Access is denied" (Error 5).
  return new kuzu.Database(DB_PATH, 0, undefined, true);
}

function printResult(r) {
  console.log(`=== ${r.name} ===`);
  console.log(`  cypher        : ${r.cypher}`);
  console.log(`  result tuples : ${r.numTuples} (returned ${r.rowsReturned})`);
  console.log(
    `  time          : query ${r.queryMs.toFixed(1)} ms + fetch ${r.fetchMs.toFixed(1)} ms = ${r.totalMs.toFixed(1)} ms`
  );
  console.log(
    `  RSS           : before ${r.rssBeforeMB} MB -> peak ${r.rssPeakMB} MB -> after ${r.rssAfterMB} MB (delta ${r.rssDeltaMB} MB)`
  );
  console.log(`  heap delta    : ${r.heapDeltaMB} MB`);
  console.log("");
}

function printSummary(results) {
  console.log("=== summary ===");
  console.table(
    results.map((r) => ({
      query: r.name,
      tuples: r.numTuples,
      "query ms": Math.round(r.queryMs),
      "fetch ms": Math.round(r.fetchMs),
      "total ms": Math.round(r.totalMs),
      "peak RSS MB": r.rssPeakMB,
      "RSS delta MB": r.rssDeltaMB,
    }))
  );
}

// Child-process worker: run exactly one query (selected by index) and emit the
// result as JSON on stdout. Used by --isolated mode.
async function runAsWorker(index) {
  const db = openDb();
  const conn = new kuzu.Connection(db);
  const r = await runOne(conn, QUERIES[index]);
  conn.close();
  db.close();
  console.log("RESULT_JSON:" + JSON.stringify(r));
  process.exit(0);
}

// Driver: fork one fresh process per query so each gets a clean memory baseline.
function runIsolated() {
  return new Promise((resolve) => {
    const results = [];
    const next = (i) => {
      if (i >= QUERIES.length) {
        resolve(results);
        return;
      }
      const child = fork(__filename, ["--worker", String(i)], {
        execArgv: global.gc ? ["--expose-gc"] : [],
        stdio: ["inherit", "pipe", "inherit", "ipc"],
      });
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d.toString();
      });
      child.on("exit", () => {
        const line = buf.split(/\r?\n/).find((l) => l.startsWith("RESULT_JSON:"));
        if (line) {
          const r = JSON.parse(line.slice("RESULT_JSON:".length));
          results.push(r);
          printResult(r);
        } else {
          console.error("worker produced no result for query", i);
        }
        next(i + 1);
      });
    };
    next(0);
  });
}

async function runShared() {
  const db = openDb();
  const conn = new kuzu.Connection(db);
  const results = [];
  for (const q of QUERIES) {
    const r = await runOne(conn, q);
    results.push(r);
    printResult(r);
  }
  conn.close();
  db.close();
  return results;
}

(async () => {
  // Worker entry point (forked child).
  const workerIdx = process.argv.indexOf("--worker");
  if (workerIdx !== -1) {
    await runAsWorker(Number(process.argv[workerIdx + 1]));
    return;
  }

  const isolated = process.argv.includes("--isolated");
  const fileSize = fs.statSync(DB_PATH).size;
  console.log("KuzuDB version :", kuzu.VERSION);
  console.log("DB file        :", DB_PATH);
  console.log("DB file size   :", toMB(fileSize), "MB");
  console.log("mode           :", isolated ? "isolated (process per query)" : "shared (one process)");
  if (!global.gc) {
    console.log(
      "(tip: run with `node --expose-gc util/test.query-bench.js` for cleaner memory deltas)"
    );
  }
  console.log("");

  const results = isolated ? await runIsolated() : await runShared();
  printSummary(results);
  process.exit(0);
})();
