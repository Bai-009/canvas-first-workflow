import assert from "node:assert/strict";
import test from "node:test";

import { checkAgainstNodeTable } from "../../src/nodes/check-nodes.mjs";

const node = (type, params = {}, blanks = [], name = "A") => ({ name, step: "s1", type, params, blanks });
const reasons = (nodes, edges = [], canvas = []) => checkAgainstNodeTable(nodes, edges, canvas).join("\n");

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
  assert.equal(reasons([sink], [{ from: "不认识的老节点", to: "B" }], [{ name: "不认识的老节点", type: "n8n-nodes-base.set", params: {}, blanks: [] }]), "");
});
