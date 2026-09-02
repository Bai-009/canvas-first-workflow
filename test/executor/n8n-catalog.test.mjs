import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog, searchNodes, describeNode, summarize, catalogTools } from "../../src/executor/n8n-catalog.mjs";

const rankOf = (query, type) => searchNodes(query).findIndex((n) => n.type === type);

test("目录来自真镜像,节点数和来源写在里面", () => {
  const catalog = loadCatalog();
  assert.equal(catalog.count, catalog.nodes.length);
  assert.ok(catalog.nodes.length > 500);
  assert.match(catalog.source, /n8n 2\./);
});

test("场景里的几个查询,该找的节点排在前面", () => {
  assert.equal(rankOf("run every day on a schedule", "n8n-nodes-base.scheduleTrigger"), 0);
  assert.equal(rankOf("extract text from pdf file", "n8n-nodes-base.extractFromFile"), 0);
  assert.equal(rankOf("insert rows into postgres table", "n8n-nodes-base.postgres"), 0);
  assert.equal(rankOf("deepseek chat model", "@n8n/n8n-nodes-langchain.lmChatDeepSeek"), 0);
  assert.ok(rankOf("read files from disk folder", "n8n-nodes-base.readWriteFile") <= 2);
  assert.ok(rankOf("extract structured fields from text with llm", "@n8n/n8n-nodes-langchain.informationExtractor") <= 2);
  assert.ok(rankOf("filter items by condition", "n8n-nodes-base.filter") <= 2);
});

test("搜索只回名字和一句话,最多几个;没词就空", () => {
  const hits = searchNodes("postgres");
  assert.ok(hits.length <= 6);
  assert.deepEqual(Object.keys(hits[0]), ["type", "displayName", "description", "kind"]);
  assert.deepEqual(searchNodes("the of"), []);
});

test("分操作的节点先给菜单,不给全部参数;选了操作才给那种操作的参数", () => {
  const menu = describeNode("n8n-nodes-base.postgres");
  assert.ok(menu.operations.some((o) => o.value === "insert"));
  assert.ok(menu.properties.every((p) => !p.displayOptions?.show?.operation));
  const insert = describeNode("n8n-nodes-base.postgres", { operation: "insert" });
  assert.equal(insert.operations, undefined);
  const names = insert.properties.map((p) => p.name);
  assert.ok(names.includes("schema") && names.includes("table") && names.includes("columns"));
  assert.ok(!names.includes("query"), "执行 SQL 那种操作的参数不该出现");
  const all = loadCatalog().nodes.find((n) => n.name === "postgres").properties.length;
  assert.ok(insert.properties.length < all / 2, `插入操作的参数 ${insert.properties.length} 应远少于全部 ${all}`);
  assert.deepEqual(insert.properties.find((p) => p.name === "operation").options.map((o) => o.value), ["insert"]);
});

test("不分操作的节点直接给参数;提示类假参数不在里面", () => {
  const d = describeNode("n8n-nodes-base.scheduleTrigger");
  assert.equal(d.operations, undefined);
  assert.ok(d.properties.some((p) => p.name === "rule"));
  assert.ok(d.properties.every((p) => !["notice", "hidden", "callout"].includes(p.type)));
  assert.deepEqual(d.inputs, []);
});

test("点错名字报错并给相近的;选了不存在的操作也报错", () => {
  assert.throws(() => describeNode("n8n-nodes-base.postgress"), /目录里没有.*像的有/);
  assert.throws(() => describeNode("n8n-nodes-base.postgres", { operation: "fly" }), /没有 fly 这种操作/);
});

test("常驻行从目录里生成,不手写", () => {
  const lines = summarize(["n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.postgres"]);
  assert.match(lines[0], /^Schedule Trigger \(n8n-nodes-base\.scheduleTrigger\): /);
  assert.equal(lines.length, 2);
});

test("两个工具的定义是 OpenAI 兼容的函数工具", () => {
  assert.deepEqual(catalogTools.map((t) => t.function.name), ["search_nodes", "describe_node"]);
  for (const t of catalogTools) assert.equal(t.function.parameters.additionalProperties, false);
});
