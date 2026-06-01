const path = require("path");
const fs = require("fs");
const kuzu = require("./../");

(async () => {
  // Open the existing on-disk database in read-only mode. The query below is
  // read-only, and demo_large has the Windows ReadOnly attribute set, so a
  // default read-write open would fail with "Access is denied" (Error 5).
  const bufferManagerSize = fs.statSync(path.join(__dirname, "./demo_large")).size;
  console.log("file size: ", Math.round(bufferManagerSize / (1024 * 1024)), "MB");
  const db = new kuzu.Database(path.join(__dirname, "./demo_large"), 0, undefined, true);
  const conn = new kuzu.Connection(db);
  
  // 统计节点数。
  const nodeResult = await conn.query(
    `MATCH (n) RETURN count(n) AS c`
  );
  const nodeCount = (await nodeResult.getAll())[0].c;
  nodeResult.close();

  // 统计关系数。
  const relResult = await conn.query(
    `MATCH ()-[r]->() RETURN count(r) AS c`
  );
  const relCount = (await relResult.getAll())[0].c;
  relResult.close();

  console.log("节点数:", nodeCount);
  console.log("关系数:", relCount);

  conn.close();
  db.close();

  process.exit(0);

})();
