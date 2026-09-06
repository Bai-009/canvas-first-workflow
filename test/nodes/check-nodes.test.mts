import type { CanvasNode, Edge } from "../../shared/contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { checkAgainstNodeTable, checkFlow } from "../../src/nodes/check-nodes.mjs";

const node = (type: string, params: Record<string, unknown> = {}, blanks: string[] = [], name = "A"): CanvasNode => ({ name, step: "s1", type, params, blanks });
const reasons = (nodes: CanvasNode[], edges: Edge[] = [], canvas: CanvasNode[] = []) => checkAgainstNodeTable(nodes, edges, canvas).join("\n");

test("对得上节点表的交回:一个字不退", () => {
  const nodes = [
    node("schedule", {}, [], "每天定时"),
    node("readFile", { pattern: "*.pdf" }, ["folder"], "读取合同 PDF"),
    node("llm", { model: "DeepSeek V4 Pro", prompt: "抽字段" }, ["outputSchema"], "抽取"),
    node("condition", { condition: 'input.text != ""' }, [], "有文字层?"),
    node("writeDatabase", { mode: "Insert" }, ["connection", "table"], "写库"),
  ];
  const edges = [
    { from: "每天定时", to: "读取合同 PDF" },
    { from: "有文字层?", to: "抽取", output: "true" },
    { from: "有文字层?", to: "写库", output: "false" },
  ];
  assert.deepEqual(checkAgainstNodeTable(nodes, edges), []);
});

test("类型不在表里:退,并列出有哪些", () => {
  assert.match(reasons([node("n8n-nodes-base.postgres")]), /类型 n8n-nodes-base.postgres 不在节点表里,有:.*llm/);
});

test("格子不存在、空位不是它的格:退", () => {
  assert.match(reasons([node("llm", { prompt: "p", temperature: 0.2 }, ["outputSchema"])]), /没有 temperature 这一格/);
  assert.match(reasons([node("llm", { prompt: "p" }, ["outputSchema", "apiKey"])]), /空位 apiKey 不是它的格/);
});

test("要填的格没填也没留空:退;有默认值的不算;留空了不算", () => {
  assert.match(reasons([node("llm", { prompt: "p" })]), /outputSchema 没填也没留空/);
  assert.equal(reasons([node("llm", { prompt: "p" }, ["outputSchema"])]), "");
  assert.equal(reasons([node("splitText")]), "");
  assert.match(reasons([node("readFile", { pattern: "*.pdf" })]), /folder 没填也没留空/);
});

test("挑一个的值不在能挑的里面、填个数的不是数:退", () => {
  assert.match(reasons([node("llm", { model: "deepseek-chat", prompt: "p" }, ["outputSchema"])]), /model 只能是:DeepSeek V4 Pro/);
  assert.match(reasons([node("splitText", { chunkSize: "500" })]), /chunkSize 要填个数/);
});

test("多出口节点的线要写出口,单出口的不许写;线的源头在画布上也查", () => {
  const cond = node("condition", { condition: "input.x" }, [], "分岔");
  const sink = node("code", { code: "// a" }, [], "B");
  assert.match(reasons([cond, sink], [{ from: "分岔", to: "B" }]), /要写出口,分岔 有:true、false/);
  assert.match(reasons([cond, sink], [{ from: "B", to: "分岔", output: "true" }]), /写了出口 true,B 只有一个出口/);
  assert.equal(reasons([cond, sink], [{ from: "分岔", to: "B", output: "false" }]), "");
  const onCanvas = [node("condition", { condition: "input.x" }, [], "画布上的分岔")];
  assert.match(reasons([sink], [{ from: "画布上的分岔", to: "B" }], onCanvas), /要写出口/);
  assert.equal(reasons([sink], [{ from: "不认识的老节点", to: "B" }], [{ name: "不认识的老节点", step: "s1", type: "n8n-nodes-base.set", params: {}, blanks: [] }]), "");
});

/* 第三样:接得上。查的是整条上游一路加进来的全部,不是紧挨着那一个。 */
test("接得上:要的东西在线上就放行;不在就退,并说线上只有什么;没线进来也退", () => {
  const n = (name: string, type: string, params: Record<string, unknown> = {}) => ({ name, step: "s1", type, params, blanks: [] });
  const canvas = (nodes: CanvasNode[], edges: Edge[]) => ({ nodes, edges });
  const 读 = n("读", "readFile"), 识 = n("识", "ocr"), 抽 = n("抽", "llm", { prompt: "p" }), 库 = n("库", "writeVectorStore");
  assert.deepEqual(checkFlow([识, 抽], canvas([读, 识, 抽], [{ from: "读", to: "识" }, { from: "识", to: "抽" }])), []);
  assert.deepEqual(checkFlow([库], canvas([读, 库], [{ from: "读", to: "库" }])), ["节点 库 要 Vector,接进来的线上只有 File"]);
  assert.deepEqual(checkFlow([识], canvas([读, 识], [])), ["节点 识 要 File,没有一根线进来"]);
  /* 分岔原样带过去:false 路上的 OCR 照样拿得到文件 */
  const 岔 = n("岔", "condition", { condition: "x" });
  assert.deepEqual(checkFlow([识], canvas([读, 岔, 识], [{ from: "读", to: "岔" }, { from: "岔", to: "识", output: "false" }])), []);
  /* 上游有一张没申报出口的写代码卡:不知道加了什么,不拦 */
  const 算 = n("算", "code", { code: "//" });
  assert.deepEqual(checkFlow([抽], canvas([读, 算, 抽], [{ from: "读", to: "算" }, { from: "算", to: "抽" }])), []);
  算.params.outputKind = "File";
  assert.deepEqual(checkFlow([抽], canvas([读, 算, 抽], [{ from: "读", to: "算" }, { from: "算", to: "抽" }])), ["节点 抽 要 Text,接进来的线上只有 File"]);
  /* 什么都不要的(写代码、分岔)不查 */
  assert.deepEqual(checkFlow([算, 岔], canvas([算, 岔], [])), []);
});
