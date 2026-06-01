"use strict";

// 大数据导出/导入往返测试。
// 参考 test.large.js，复用现有的 demo_large（只读打开），分别用 CSV 与
// Parquet 两种格式做 EXPORT DATABASE -> IMPORT DATABASE 往返，记录每个阶段的
// 耗时、峰值内存（RSS / V8 堆）、产物大小，并逐表校验行数是否一致。
//
// 运行：node util/test.export-import.js
// 产物保留在 util/export-import-bench/ 下，不自动清理。

const path = require("path");
const fs = require("fs");
const kuzu = require("./../");

const UTIL_DIR = __dirname;
const SOURCE_DB = path.join(UTIL_DIR, "demo_large");
const WORK_DIR = path.join(UTIL_DIR, "export-import-bench");
const FORMATS = ["csv", "parquet"];

// Kuzu buffer pool 上限（MB）。源库与导入库都用它打开，以观察受限内存下能否
// 正常导出/导入。默认 0 = 自动（不限制）；设环境变量 KUZU_BUFFER_POOL_MB 来限制，
// 例如 KUZU_BUFFER_POOL_MB=100 node util/test.export-import.js
const BUFFER_POOL_MB = Number(process.env.KUZU_BUFFER_POOL_MB) || 0;
const BUFFER_POOL_BYTES = Math.floor(BUFFER_POOL_MB * 1024 * 1024); // 0 表示自动

// ---------- 小工具 ----------

// Kuzu 的 cypher 字符串路径在 Windows 上需用正斜杠，避免反斜杠转义问题。
const toCypherPath = (p) => p.replace(/\\/g, "/");

const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1) + " MB";
const sec = (ms) => (ms / 1000).toFixed(2) + " s";

function rmrf(p) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

// 递归统计目录下所有文件的总字节数。
function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

// query() 可能返回单个 QueryResult，也可能是数组（多语句）。统一关闭。
function closeResult(res) {
  if (Array.isArray(res)) res.forEach((r) => r.close());
  else res.close();
}

// 内存采样器：阶段开始后每 50ms 采一次进程内存，记录峰值。
// RSS 覆盖 Kuzu 原生插件分配的内存；heapUsed 只反映 V8 堆，仅作参考。
function startMemSampler() {
  let peakRss = process.memoryUsage().rss;
  let peakHeap = process.memoryUsage().heapUsed;
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    if (m.rss > peakRss) peakRss = m.rss;
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
  }, 50);
  if (timer.unref) timer.unref();
  return () => {
    clearInterval(timer);
    return { peakRss, peakHeap };
  };
}

// 测量一个异步阶段的耗时与峰值内存。
async function measure(fn) {
  const stop = startMemSampler();
  const start = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const { peakRss, peakHeap } = stop();
  return { ms, peakRss, peakHeap, result };
}

// 统计每张 NODE / REL 表的行数。
async function collectCounts(conn) {
  const tablesRes = await conn.query("CALL show_tables() RETURN name, type ORDER BY name;");
  const tables = await tablesRes.getAll();
  closeResult(tablesRes);

  const counts = {};
  for (const t of tables) {
    let cypher;
    if (t.type === "NODE") {
      cypher = `MATCH (n:\`${t.name}\`) RETURN count(n) AS c;`;
    } else if (t.type === "REL") {
      cypher = `MATCH ()-[r:\`${t.name}\`]->() RETURN count(r) AS c;`;
    } else {
      continue; // 跳过 REL_GROUP 等其它类型
    }
    const res = await conn.query(cypher);
    const rows = await res.getAll();
    closeResult(res);
    counts[t.name] = Number(rows[0].c); // count() 返回 BigInt，转 Number 便于比对
  }
  return counts;
}

// 逐表比对基准行数与导入后行数。
function compareCounts(base, imported) {
  const labels = [...new Set([...Object.keys(base), ...Object.keys(imported)])].sort();
  const rows = [];
  let allMatch = true;
  for (const label of labels) {
    const b = base[label] ?? 0;
    const i = imported[label] ?? 0;
    const ok = b === i;
    if (!ok) allMatch = false;
    rows.push({ table: label, base: b, imported: i, match: ok ? "✅" : "❌" });
  }
  return { rows, allMatch };
}

// ---------- 主流程 ----------

(async () => {
  if (!fs.existsSync(SOURCE_DB)) {
    console.error(`Source database not found: ${SOURCE_DB}`);
    process.exit(1);
  }
  fs.mkdirSync(WORK_DIR, { recursive: true });

  console.log("=".repeat(60));
  console.log("Kuzu export/import benchmark");
  console.log("  version:", kuzu.VERSION, "| storage:", kuzu.STORAGE_VERSION);
  console.log("  source :", SOURCE_DB, `(${mb(fs.statSync(SOURCE_DB).size)})`);
  console.log("  work   :", WORK_DIR);
  console.log("  bufferPool:", BUFFER_POOL_MB ? BUFFER_POOL_MB + " MB" : "auto (unlimited)");
  console.log("=".repeat(60));

  // 只读打开源库（demo_large 带 Windows 只读属性），buffer pool 限制为 BUFFER_POOL_BYTES。
  const srcDb = new kuzu.Database(SOURCE_DB, BUFFER_POOL_BYTES, undefined, true);
  const srcConn = new kuzu.Connection(srcDb);

  console.log("\n[baseline] counting rows in source DB ...");
  const baseCounts = await collectCounts(srcConn);
  const totalRows = Object.values(baseCounts).reduce((a, b) => a + b, 0);
  console.table(baseCounts);
  console.log(`[baseline] total ${totalRows} rows across ${Object.keys(baseCounts).length} tables`);

  const summary = [];

  for (const fmt of FORMATS) {
    console.log("\n" + "-".repeat(60));
    console.log(`Format: ${fmt.toUpperCase()}`);
    console.log("-".repeat(60));

    const exportDir = path.join(WORK_DIR, `export_${fmt}`);
    const importDbPath = path.join(WORK_DIR, `import_${fmt}.db`);

    // 清理上一次的产物（EXPORT 要求目标目录不存在/为空）。
    rmrf(exportDir);
    rmrf(importDbPath);
    rmrf(importDbPath + ".wal");

    // --- EXPORT（在只读源连接上执行） ---
    console.log(`[export] EXPORT DATABASE -> ${exportDir}`);
    const exp = await measure(() =>
      srcConn
        .query(`EXPORT DATABASE '${toCypherPath(exportDir)}' (format="${fmt}");`)
        .then(closeResult)
    );
    const exportBytes = dirSize(exportDir);
    console.log(
      `[export] done in ${sec(exp.ms)} | peak RSS ${mb(exp.peakRss)} | artifact ${mb(exportBytes)}`
    );

    // --- IMPORT（导入到全新可写空库） ---
    console.log(`[import] IMPORT DATABASE -> fresh ${importDbPath}`);
    const impDb = new kuzu.Database(importDbPath, BUFFER_POOL_BYTES);
    const impConn = new kuzu.Connection(impDb);
    const imp = await measure(() =>
      impConn.query(`IMPORT DATABASE '${toCypherPath(exportDir)}';`).then(closeResult)
    );
    console.log(`[import] done in ${sec(imp.ms)} | peak RSS ${mb(imp.peakRss)}`);

    // --- VERIFY（逐表行数校验） ---
    console.log("[verify] counting rows in imported DB ...");
    const importedCounts = await collectCounts(impConn);
    const cmp = compareCounts(baseCounts, importedCounts);
    console.table(cmp.rows);
    console.log(`[verify] row-count match: ${cmp.allMatch ? "PASS ✅" : "FAIL ❌"}`);

    impConn.close();
    impDb.close();

    summary.push({
      format: fmt,
      "export(s)": +(exp.ms / 1000).toFixed(2),
      "import(s)": +(imp.ms / 1000).toFixed(2),
      "artifact(MB)": +(exportBytes / (1024 * 1024)).toFixed(1),
      "export peakRSS(MB)": +(exp.peakRss / (1024 * 1024)).toFixed(1),
      "import peakRSS(MB)": +(imp.peakRss / (1024 * 1024)).toFixed(1),
      verify: cmp.allMatch ? "PASS" : "FAIL",
    });
  }

  srcConn.close();
  srcDb.close();

  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY (CSV vs Parquet)");
  console.log("=".repeat(60));
  console.table(summary);
  console.log(`Artifacts kept at: ${WORK_DIR}`);

  process.exit(0);
})().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
