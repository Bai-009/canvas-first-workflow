import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkNodeDefinition, findNodeDefinition, loadNodeTable } from "../../src/nodes/node-table.mjs";

test("nodes/ 里每个文件都合契约,type 不重", () => {
  const table = loadNodeTable();
  assert.ok(table.length >= 1);
  assert.equal(new Set(table.map((n) => n.type)).size, table.length);
});

test("LLM:卡类型 LLM;三格 Model 挑一个、Output Schema 上传、Prompt 正文;进出形态都写了", () => {
  const llm = findNodeDefinition("llm");
  assert.equal(llm.kind, "LLM");
  assert.deepEqual(llm.slots.map((s) => s.label), ["Model", "Output Schema", "Prompt"]);
  assert.deepEqual(llm.slots.map((s) => s.kind), ["pick", "upload", "body"]);
  assert.equal(llm.slots[0].default, "DeepSeek V4 Pro");
  assert.ok(llm.input && llm.output);
  assert.equal(findNodeDefinition("没有这种"), null);
});

test("契约:格子只有八种;挑一个必须给 options;默认值得在 options 里;key 不许重;不许自己加字段", () => {
  const base = { type: "x", kind: "X", summary: "s", slots: [], input: "a", output: "b" };
  const slot = (extra) => ({ ...base, slots: [{ key: "a", label: "A", ...extra }] });
  assert.deepEqual(checkNodeDefinition(base), []);
  assert.match(checkNodeDefinition(slot({ kind: "magic" })).join("\n"), /取值不在允许范围内/);
  assert.match(checkNodeDefinition(slot({ kind: "pick" })).join("\n"), /是挑一个,却没给 options/);
  assert.match(checkNodeDefinition(slot({ kind: "pick", options: ["x"], default: "y" })).join("\n"), /不在 options 里/);
  assert.match(checkNodeDefinition(slot({ kind: "text", options: ["x"] })).join("\n"), /不该有 options/);
  assert.match(checkNodeDefinition({ ...base, slots: [{ key: "a", label: "A", kind: "text" }, { key: "a", label: "B", kind: "text" }] }).join("\n"), /重复/);
  assert.match(checkNodeDefinition({ ...base, extra: 1 }).join("\n"), /没有的字段/);
});

test("表里有一个坏文件,整张表不上桌", () => {
  const dir = mkdtempSync(join(tmpdir(), "nodes-"));
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ type: "bad" }));
  assert.throws(() => loadNodeTable(dir), /bad\.json 不合节点定义的契约/);
});
