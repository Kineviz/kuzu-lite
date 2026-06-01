"use strict";
const path = require("path");
const k = require(path.join(__dirname, "..", "..", "index.js"));
(async () => {
  console.log("NODE_VERSION=" + process.version);
  console.log("KUZU_VERSION=" + k.VERSION);
  const db = new k.Database(":memory:");
  const c = new k.Connection(db);
  await c.query("CREATE NODE TABLE P(name STRING, age INT64, PRIMARY KEY(name))");
  await c.query("CREATE (:P {name:'Alice', age:30})");
  await c.query("CREATE (:P {name:'Bob', age:42})");
  const r = await c.query("MATCH (p:P) RETURN p.name AS name, p.age AS age ORDER BY p.age");
  console.log("ROWS=" + JSON.stringify(await r.getAll()));
  await c.close();
  await db.close();
  console.log("NODE_SMOKE_OK");
})().catch((e) => { console.error("NODE_FAIL", e); process.exit(1); });
