import { present } from "../helpers/fixtures.mjs";
import type { CanvasFlows, FlowEdge } from "../../shared/flow.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { nodeTable } from "../../src/nodes/node-table.mjs";
import { adds, edgeKey, flows, label } from "../../web/flow.mjs";

const table = nodeTable();
const node = (name: string, type: string, params: Record<string, unknown> = {}) => ({ name, step: "s", type, params, blanks: [] });
const edge = (from: string, to: string, output?: string) => (output ? { from, to, output } : { from, to });
const at = (f: CanvasFlows, e: FlowEdge | undefined) => present(f.edges.get(edgeKey(present(e))));

test("一条直链:读文件 → OCR → LLM → 写库,每根线上流的是什么", () => {
  const canvas = {
    nodes: [node("读", "readFile"), node("识", "ocr"), node("抽", "llm"), node("写", "writeDatabase")],
    edges: [edge("读", "识"), edge("识", "抽"), edge("抽", "写")],
  };
  const f = flows(table, canvas);
  assert.deepEqual(at(f, canvas.edges[0]), { head: "File", carries: ["File"], per: "文件" });
  assert.deepEqual(at(f, canvas.edges[1]), { head: "Text", carries: ["File", "Text"], per: "文件" });
  assert.deepEqual(at(f, canvas.edges[2]), { head: "JSON", carries: ["File", "Text", "JSON"], per: "文件" });
  assert.equal(label(at(f, canvas.edges[2])), "JSON · 按文件");
  assert.equal(label(f.out.get("写")), "Result · 按文件");
});

test("单位跟着改单位的节点走:切块之后按块,向量化不改单位", () => {
  const canvas = {
    nodes: [node("读", "readFile"), node("解", "parseDocument"), node("切", "splitText"), node("向", "embedText"), node("库", "writeVectorStore")],
    edges: [edge("读", "解"), edge("解", "切"), edge("切", "向"), edge("向", "库")],
  };
  const f = flows(table, canvas);
  assert.equal(label(at(f, canvas.edges[1])), "Text · 按文件");
  assert.equal(label(at(f, canvas.edges[2])), "Text · 按块");
  assert.equal(label(at(f, canvas.edges[3])), "Vector · 按块");
  /* 带原文:向量化之后原文还在流里 */
  assert.deepEqual(at(f, canvas.edges[3]).carries, ["File", "Text", "Vector"]);
});

test("触发接在起点前面:那根线上流的是 Event 按次,读文件之后换成按文件", () => {
  const canvas = { nodes: [node("定", "schedule"), node("读", "readFile"), node("识", "ocr")], edges: [edge("定", "读"), edge("读", "识")] };
  const f = flows(table, canvas);
  assert.equal(label(at(f, canvas.edges[0])), "Event · 按次");
  assert.deepEqual(at(f, canvas.edges[1]), { head: "File", carries: ["Event", "File"], per: "文件" });
});

test("分岔原样带过去:两个出口上流的一样;false 路上接 OCR 照样拿得到文件", () => {
  const canvas = {
    nodes: [node("读", "readFile"), node("解", "parseDocument"), node("岔", "condition"), node("识", "ocr"), node("切", "splitText")],
    edges: [edge("读", "解"), edge("解", "岔"), edge("岔", "切", "true"), edge("岔", "识", "false")],
  };
  const f = flows(table, canvas);
  assert.deepEqual(at(f, canvas.edges[2]), at(f, canvas.edges[3]));
  assert.equal(label(at(f, canvas.edges[3])), "Text · 按文件");
  assert.ok(at(f, canvas.edges[3]).carries.includes("File"));
});

test("汇合:带着的合起来;单位不同就都留着,印的时候一起印", () => {
  const canvas = {
    nodes: [node("读", "readFile"), node("解", "parseDocument"), node("切", "splitText"), node("合", "code")],
    edges: [edge("解", "合"), edge("切", "合"), edge("读", "解"), edge("解", "切")],
  };
  const f = flows(table, canvas);
  const into = present(f.out.get("合"));
  assert.deepEqual(into.carries, ["File", "Text"]);
  assert.deepEqual(into.per, ["文件", "块"]);
  assert.equal(label(into), "Text · 按文件 / 按块");
});

test("写代码:出去的看它自己申报的;没申报就不知道它加了什么——线上印的是上游带下来的,并且标上不知道", () => {
  const canvas = { nodes: [node("读", "readFile"), node("算", "code", { code: "//" }), node("写", "writeDatabase")], edges: [edge("读", "算"), edge("算", "写")] };
  let f = flows(table, canvas);
  assert.equal(adds(table.find((d) => d.type === "code"), canvas.nodes[1]), null);
  assert.equal(label(at(f, canvas.edges[1])), "File · 按文件");
  assert.equal(at(f, canvas.edges[1]).unknown, true);
  assert.equal(at(f, canvas.edges[0]).unknown, undefined);
  present(canvas.nodes[1]).params.outputKind = "JSON";
  f = flows(table, canvas);
  assert.equal(label(at(f, canvas.edges[1])), "JSON · 按文件");
  assert.deepEqual(at(f, canvas.edges[1]).carries, ["File", "JSON"]);
  assert.equal(at(f, canvas.edges[1]).unknown, undefined);
});

test("不在表里的类型也是不知道,而且往下传", () => {
  const canvas = { nodes: [node("老", "n8n-nodes-base.set"), node("识", "ocr")], edges: [edge("老", "识")] };
  const f = flows(table, canvas);
  assert.equal(at(f, canvas.edges[0]).unknown, true);
  assert.equal(present(f.out.get("识")).unknown, true);
});

test("有环也停得下来,接了不存在的节点的线不算", () => {
  const canvas = {
    nodes: [node("a", "ocr"), node("b", "llm")],
    edges: [edge("a", "b"), edge("b", "a"), edge("b", "鬼")],
  };
  const f = flows(table, canvas);
  assert.equal(f.edges.size, 2);
  assert.equal(label(f.out.get("b")), "JSON");
});

test("空画布、不认识的类型:不炸", () => {
  assert.equal(flows(table, { nodes: [], edges: [] }).edges.size, 0);
  const f = flows(table, { nodes: [node("x", "n8n-nodes-base.code")], edges: [] });
  assert.equal(label(f.out.get("x")), "");
});
