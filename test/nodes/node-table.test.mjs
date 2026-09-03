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
  assert.equal(llm.input, "Text");
  assert.equal(llm.output, "JSON · Output Schema");
  assert.equal(findNodeDefinition("没有这种"), null);
});

test("读文件:卡类型 File;两格 Folder 接数据源、Pattern 真打字;是起点,没有 input", () => {
  const node = findNodeDefinition("readFile");
  assert.equal(node.kind, "File");
  assert.deepEqual(node.slots.map((s) => [s.label, s.kind]), [["Folder", "source"], ["Pattern", "text"]]);
  assert.equal(node.input, undefined);
  assert.equal(node.output, "File");
});

test("OCR:卡类型 OCR;只有 Engine 一格,凭证是平台的事;File 进 Text 出", () => {
  const node = findNodeDefinition("ocr");
  assert.equal(node.kind, "OCR");
  assert.deepEqual(node.slots.map((s) => [s.label, s.kind]), [["Engine", "pick"]]);
  assert.equal(node.input, "File");
  assert.equal(node.output, "Text");
});

test("解析文档:卡类型 Parser;没有格子;File 进 Text 出", () => {
  const node = findNodeDefinition("parseDocument");
  assert.equal(node.kind, "Parser");
  assert.deepEqual(node.slots, []);
  assert.equal(node.input, "File");
  assert.equal(node.output, "Text");
});

test("切块:卡类型 Splitter;两格都是填个数,带默认值;Text 进,一块一条出", () => {
  const node = findNodeDefinition("splitText");
  assert.equal(node.kind, "Splitter");
  assert.deepEqual(node.slots.map((s) => [s.label, s.kind, s.default]), [["Chunk Size", "number", 500], ["Overlap", "number", 50]]);
  assert.equal(node.input, "Text");
  assert.equal(node.output, "Text · 一块一条");
});

test("向量化:卡类型 Embedding;一格 Model 挑一个,印产品名;Text 进,Vector 带原文出", () => {
  const node = findNodeDefinition("embedText");
  assert.equal(node.kind, "Embedding");
  assert.deepEqual(node.slots.map((s) => [s.label, s.kind, s.default]), [["Model", "pick", "BGE-M3"]]);
  assert.equal(node.input, "Text");
  assert.equal(node.output, "Vector · 带原文");
});

test("写向量库:卡类型 Vector Store;Connection 接连接、Collection 接数据源,都是用户的;Vector 进,Result 出", () => {
  const node = findNodeDefinition("writeVectorStore");
  assert.equal(node.kind, "Vector Store");
  assert.deepEqual(node.slots.map((s) => [s.label, s.kind, s.empty]), [["Connection", "credential", "选连接"], ["Collection", "source", "选集合"]]);
  assert.equal(node.input, "Vector");
  assert.equal(node.output, "Result");
});

test("定时触发:卡类型 Trigger;一格 Schedule 真打字,带默认值;起点,没有 input;Event 出", () => {
  const node = findNodeDefinition("schedule");
  assert.equal(node.kind, "Trigger");
  assert.deepEqual(node.slots.map((s) => [s.label, s.kind, s.default]), [["Schedule", "text", "每天 00:00"]]);
  assert.equal(node.input, undefined);
  assert.equal(node.output, "Event");
});

test("写数据库:Connection、Table 是用户的,Mode、Mapping 挑一个带默认值;JSON 进,Result 出", () => {
  const node = findNodeDefinition("writeDatabase");
  assert.equal(node.kind, "Database");
  assert.deepEqual(node.slots.map((s) => [s.label, s.kind]), [["Connection", "credential"], ["Table", "source"], ["Mode", "pick"], ["Mapping", "pick"]]);
  assert.equal(node.input, "JSON");
  assert.equal(node.output, "Result");
});

test("条件分岔:一格条件 AI 写;两个出口 true / false;数据原样带过去", () => {
  const node = findNodeDefinition("condition");
  assert.equal(node.kind, "Condition");
  assert.deepEqual(node.slots.map((s) => [s.label, s.kind]), [["Condition", "conditions"]]);
  assert.deepEqual(node.ports, ["true", "false"]);
});

test("写代码:Language 挑一个,Code 正文 AI 写;进出都是 Any", () => {
  const node = findNodeDefinition("code");
  assert.equal(node.kind, "Code");
  assert.deepEqual(node.slots.map((s) => [s.label, s.kind]), [["Language", "pick"], ["Code", "body"]]);
  assert.equal(node.input, "Any");
  assert.equal(node.output, "Any");
});

test("节点表收口:十一张,每张都有卡类型", () => {
  const table = loadNodeTable();
  assert.deepEqual(table.map((n) => n.type).sort(), ["code", "condition", "embedText", "llm", "ocr", "parseDocument", "readFile", "schedule", "splitText", "writeDatabase", "writeVectorStore"]);
  assert.ok(table.every((n) => n.kind));
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
  assert.match(checkNodeDefinition({ ...base, ports: ["true"] }).join("\n"), /ports/);
});

test("表里有一个坏文件,整张表不上桌", () => {
  const dir = mkdtempSync(join(tmpdir(), "nodes-"));
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ type: "bad" }));
  assert.throws(() => loadNodeTable(dir), /bad\.json 不合节点定义的契约/);
});
