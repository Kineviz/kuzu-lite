"use strict";

// 低内存导入测试：验证在受限 buffer pool（默认 100MB）下，通过「手动逐表 COPY +
// 串行 + 每表 CHECKPOINT + 低 checkpointThreshold」让导入成功（IMPORT DATABASE
// 在 100MB 下会因 buffer pool 占满无法释放而 OOM）。
//
// 复用 test.export-import.js 留下的导出产物（util/export-import-bench/export_<fmt>/）。
// 先跑一次 test.export-import.js 生成产物，再运行本脚本。
//
// 可调环境变量：
//   FMT                  导入源格式 parquet|csv（默认 parquet）
//   KUZU_BUFFER_POOL_MB  buffer pool 上限 MB（默认 100）
//   MAX_THREADS          COPY 并行线程数，越小越省内存（默认 1 串行）
//   CHECKPOINT_EACH      每表后是否 CHECKPOINT（默认 true）
//   CKPT_THRESHOLD_MB    自动 checkpoint 的 WAL 阈值 MB（默认 16）
//
// 注：COPY 的并行度通过线程数控制（不用 COPY 的 parallel 选项——parquet 不接受该
// 选项）。脚本会从 copy.cypher 中剥离 parallel 选项，再用 setMaxNumThreadForExec 限制。
//
// 示例：KUZU_BUFFER_POOL_MB=100 node util/test.import-lowmem.js

const path = require("path");
const fs = require("fs");
const kuzu = require("./../");

const UTIL_DIR = __dirname;
const WORK_DIR = path.join(UTIL_DIR, "export-import-bench");

const FMT = process.env.FMT || "parquet";
const EXPORT_DIR = path.join(WORK_DIR, `export_${FMT}`);
const IMPORT_DB = path.join(WORK_DIR, `lowmem_import_${FMT}.db`);

const BUFFER_POOL_MB = Number(process.env.KUZU_BUFFER_POOL_MB) || 100;
const BUFFER_POOL_BYTES = Math.floor(BUFFER_POOL_MB * 1024 * 1024);
const MAX_THREADS = Number(process.env.MAX_THREADS) || 1; // 默认 1（串行，最省内存）
const CHECKPOINT_EACH = process.env.CHECKPOINT_EACH !== "false"; // 默认 true
const CKPT_THRESHOLD_MB = Number(process.env.CKPT_THRESHOLD_MB) || 16;
const CKPT_THRESHOLD_BYTES = Math.floor(CKPT_THRESHOLD_MB * 1024 * 1024);
// 大关系表分块导入：每个 COPY 只灌入 CHUNK_LINES 行，避免单条 COPY 缓冲全部边来
// 构建 CSR 而撑爆 buffer pool。0 = 不分块。仅对 CSV 生效（parquet 不便按行切分）。
const CHUNK_LINES = Number(process.env.CHUNK_LINES) || 0;

// ---------- 小工具 ----------
const toCypherPath = (p) => p.replace(/\\/g, "/");
const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1) + " MB";
const sec = (ms) => (ms / 1000).toFixed(2) + " s";

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function closeResult(res) {
  if (Array.isArray(res)) res.forEach((r) => r.close());
  else res.close();
}

// 流式按行切分 CSV 为多个 chunk 文件（不把整文件读进内存，避免污染内存测量）。
// 返回各 chunk 的绝对路径。
function splitCsvByLines(srcAbs, linesPerChunk, outDir) {
  const readline = require("readline");
  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const chunks = [];
    let idx = 0;
    let lineCount = 0;
    let ws = null;
    const openChunk = () => {
      const p = path.join(outDir, `chunk_${idx}.csv`);
      chunks.push(p);
      ws = fs.createWriteStream(p);
      idx += 1;
      lineCount = 0;
    };
    const rl = readline.createInterface({
      input: fs.createReadStream(srcAbs),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      if (line === "") return;
      if (!ws || lineCount >= linesPerChunk) {
        if (ws) ws.end();
        openChunk();
      }
      ws.write(line + "\n");
      lineCount += 1;
    });
    rl.on("close", () => {
      if (ws) ws.end(() => resolve(chunks));
      else resolve(chunks);
    });
    rl.on("error", reject);
  });
}

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

async function measure(fn) {
  const stop = startMemSampler();
  const start = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const { peakRss, peakHeap } = stop();
  return { ms, peakRss, peakHeap, result };
}

async function collectCounts(conn) {
  const tablesRes = await conn.query("CALL show_tables() RETURN name, type ORDER BY name;");
  const tables = await tablesRes.getAll();
  closeResult(tablesRes);
  const counts = {};
  for (const t of tables) {
    let cypher;
    if (t.type === "NODE") cypher = `MATCH (n:\`${t.name}\`) RETURN count(n) AS c;`;
    else if (t.type === "REL") cypher = `MATCH ()-[r:\`${t.name}\`]->() RETURN count(r) AS c;`;
    else continue;
    const res = await conn.query(cypher);
    const rows = await res.getAll();
    closeResult(res);
    counts[t.name] = Number(rows[0].c);
  }
  return counts;
}

// 把 copy.cypher 拆成单条语句，并：① 把相对文件路径改成绝对路径；
// ② 剥离 parallel 选项（parquet 不接受该选项；并行度统一用线程数控制）。
function buildCopyStatements(copySql, dirAbs) {
  return copySql
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("//"))
    .map((s) => s.replace(/;\s*$/, ""))
    .map((s) => {
      // 只替换文件路径 FROM "xxx"（大写 FROM + 双引号），不动 rel 的 from='Table'
      s = s.replace(/FROM "([^"]+)"/, (_m, f) => `FROM "${dirAbs}/${f}"`);
      // 去掉 parallel=true/false（含其后可能的逗号），再清理空括号 / 前导逗号
      s = s.replace(/parallel\s*=\s*(?:true|false)\s*,?\s*/i, "");
      s = s.replace(/\(\s*\)/, "");
      s = s.replace(/\(\s*,\s*/, "(");
      return s.trim();
    });
}

// ---------- 主流程 ----------
(async () => {
  if (!fs.existsSync(EXPORT_DIR)) {
    console.error(`Export dir not found: ${EXPORT_DIR}`);
    console.error("先运行: node util/test.export-import.js 生成导出产物。");
    process.exit(1);
  }
  rmrf(IMPORT_DB);
  rmrf(IMPORT_DB + ".wal");

  const schemaStmts = fs
    .readFileSync(path.join(EXPORT_DIR, "schema.cypher"), "utf8")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const copyStmts = buildCopyStatements(
    fs.readFileSync(path.join(EXPORT_DIR, "copy.cypher"), "utf8"),
    toCypherPath(EXPORT_DIR)
  );

  console.log("=".repeat(60));
  console.log("Low-memory manual import");
  console.log("  version    :", kuzu.VERSION, "| storage:", kuzu.STORAGE_VERSION);
  console.log("  source     :", EXPORT_DIR, `(${FMT})`);
  console.log("  bufferPool :", BUFFER_POOL_MB, "MB");
  console.log("  maxThreads :", MAX_THREADS);
  console.log("  checkpoint :", CHECKPOINT_EACH ? "after each table/chunk" : "off", `| threshold ${CKPT_THRESHOLD_MB} MB`);
  console.log("  chunkLines :", CHUNK_LINES > 0 ? `${CHUNK_LINES} (csv rel tables)` : "off");
  console.log("=".repeat(60));

  // 受限 buffer pool + autoCheckpoint=true + 低 checkpointThreshold 打开新库。
  const impDb = new kuzu.Database(
    IMPORT_DB,
    BUFFER_POOL_BYTES,
    true, // enableCompression
    false, // readOnly
    0, // maxDBSize（自动）
    true, // autoCheckpoint
    CKPT_THRESHOLD_BYTES
  );
  const conn = new kuzu.Connection(impDb);
  conn.setMaxNumThreadForExec(MAX_THREADS); // 限制 COPY 并行度以省内存

  // 1) 建表
  for (const stmt of schemaStmts) {
    await conn.query(stmt + ";").then(closeResult);
  }
  console.log(`[schema] created ${schemaStmts.length} tables`);

  // 1.5) 预处理：把每条 COPY 展开成实际要执行的语句（大关系表 CSV 按行分块）。
  // 分块在测量前完成（流式切分），使 COPY 阶段的内存测量只反映 Kuzu 的开销。
  const TMP_CHUNK_DIR = path.join(WORK_DIR, `_chunks_${FMT}`);
  rmrf(TMP_CHUNK_DIR);
  const plan = [];
  for (const stmt of copyStmts) {
    const tableName = (stmt.match(/COPY `([^`]+)`/) || [])[1] || "?";
    const isRel = /\bfrom\s*=/.test(stmt); // rel COPY 带 from='..', to='..'
    const fileMatch = stmt.match(/FROM "([^"]+)"/);
    if (CHUNK_LINES > 0 && isRel && FMT === "csv" && fileMatch) {
      const chunks = await splitCsvByLines(
        fileMatch[1],
        CHUNK_LINES,
        path.join(TMP_CHUNK_DIR, tableName)
      );
      plan.push({
        table: tableName,
        statements: chunks.map((c) => stmt.replace(fileMatch[1], toCypherPath(c))),
      });
    } else {
      plan.push({ table: tableName, statements: [stmt] });
    }
  }

  // 2) 逐表 COPY（串行 + 每表/每块 CHECKPOINT），分别计时与采峰值内存。
  const perTable = [];
  const overall = await measure(async () => {
    for (const item of plan) {
      const r = await measure(async () => {
        for (const s of item.statements) {
          await conn.query(s + ";").then(closeResult);
          if (CHECKPOINT_EACH) await conn.query("CHECKPOINT;").then(closeResult);
        }
      });
      perTable.push({
        table: item.table,
        chunks: item.statements.length,
        "load(s)": +(r.ms / 1000).toFixed(2),
        "peakRSS(MB)": +(r.peakRss / (1024 * 1024)).toFixed(1),
      });
      console.log(
        `  [copy] ${item.table.padEnd(10)} x${String(item.statements.length).padStart(3)} ${sec(r.ms).padStart(8)} | peak RSS ${mb(r.peakRss)}`
      );
    }
  });
  rmrf(TMP_CHUNK_DIR); // 清理分块临时文件（中间产物，非导入产物）

  // 3) 校验行数
  const counts = await collectCounts(conn);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  console.log("\n--- per-table load ---");
  console.table(perTable);
  console.log("--- imported row counts ---");
  console.table(counts);
  console.log(
    `[done] import OK | total ${total} rows | wall ${sec(overall.ms)} | overall peak RSS ${mb(overall.peakRss)}`
  );

  conn.close();
  impDb.close();
  process.exit(0);
})().catch((err) => {
  console.error("Low-memory import FAILED:", err);
  process.exit(1);
});
