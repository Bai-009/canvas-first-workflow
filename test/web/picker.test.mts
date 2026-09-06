import test from "node:test";
import assert from "node:assert/strict";
import { panel } from "../../web/picker.mjs";
import { icon, ICONS } from "../../web/icons.mjs";
import { nodeTable, findNodeDefinition } from "../../src/nodes/node-table.mjs";
import { present } from "../helpers/fixtures.mjs";

/* 空位不是填空题,是入口:一个没定的参数怎么补上,看它是什么东西。
   这几条守的是面板给出的那几种入口没被换掉,以及编的东西必须标明是编的。 */

const def = (type: string) => present(findNodeDefinition(type));
const slotOf = (type: string, key: string) =>
  present(def(type).slots.find((s) => s.key === key));

test("编出来的清单必须自己说自己是编的", () => {
  // 接数据源、接连接两种面板都用了编的清单,面上就得有那行字。CLAUDE.md:手写的东西必须标明是手写的。
  const 数据源 = panel(def("readFile"), slotOf("readFile", "folder"),
    { name: "读取文件", type: "readFile", params: {}, blanks: ["folder"] });
  assert.match(数据源, /这几条是编的/);
  assert.match(数据源, /POC 不接真实平台/);

  const 连接 = panel(def("writeVectorStore"), slotOf("writeVectorStore", "connection"),
    { name: "写入向量库", type: "writeVectorStore", params: {}, blanks: ["connection"] });
  assert.match(连接, /这几条是编的/);
});

test("挑一个的选项来自节点表,不是编的;现在用的那一项标出来", () => {
  const slot = slotOf("code", "language");
  const options = slot.options ?? [];
  assert.ok(options.length > 1, "这一格应当是从节点表拿多个选项的");
  const 现在用 = present(options[0]);
  const html = panel(def("code"), slot,
    { name: "自己写一段", type: "code", params: { [slot.key]: 现在用 }, blanks: [] });
  for (const o of options) assert.ok(html.includes(o), `选项 ${o} 应当出现在面板上`);
  assert.match(html, /现在用的/);
  // 编的清单没混进来
  assert.doesNotMatch(html, /这几条是编的/);
});

test("留空的格不预填默认值,填过的格把填的印出来", () => {
  const slot = slotOf("splitText", "chunkSize");
  const 留空 = panel(def("splitText"), slot,
    { name: "切块", type: "splitText", params: {}, blanks: ["chunkSize"] });
  assert.match(留空, /value=""/, "留空的格要空着等人写,不能拿默认值冒充已经定了");
  const 填过 = panel(def("splitText"), slot,
    { name: "切块", type: "splitText", params: { chunkSize: 800 }, blanks: [] });
  assert.match(填过, /value="800"/);
  assert.match(填过, /type="number"/, "数字格要给数字输入");
});

test("节点名和格名里的尖括号不会原样进 HTML", () => {
  const html = panel(def("readFile"), slotOf("readFile", "folder"),
    { name: '<img src=x onerror="boom">', type: "readFile", params: {}, blanks: ["folder"] });
  assert.doesNotMatch(html, /<img/, "节点名必须转义后再印");
  assert.match(html, /&lt;img/);
});

test("不认识的节点类型照样画得出图标,加节点不给图标也不会开天窗", () => {
  const 兜底 = icon("这个类型不存在");
  assert.match(兜底, /^<svg /);
  assert.notEqual(兜底, icon("readFile"));
  // 节点表里的每一种类型都得画得出来
  for (const d of nodeTable()) {
    assert.match(icon(d.type), /^<svg /, `${d.type} 应当画得出图标`);
    assert.ok(icon(d.type).length > 40, `${d.type} 的图标不能是空壳`);
  }
  assert.ok(Object.keys(ICONS).length > 0);
});
