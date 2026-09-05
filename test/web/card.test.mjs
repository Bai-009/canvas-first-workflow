import test from "node:test";
import assert from "node:assert/strict";
import { fullCard, miniCard } from "../../web/card.mjs";
import { layout, wire, TILE } from "../../web/layout.mjs";
import { findNodeDefinition } from "../../src/nodes/node-table.mjs";

/* 卡是照节点表画的:格叫什么、留空印什么、进出是什么类型,全从表里来。
   这几条守的是「加一个节点,画卡的地方一行不用改」。 */

const def = (type) => findNodeDefinition(type);

test("留空的格印成可点的空位,空位上的字是节点表给的", () => {
  const html = fullCard(def("writeVectorStore"),
    { name: "写入向量库", type: "writeVectorStore", params: {}, blanks: ["connection", "collection"] }, []);
  assert.match(html, /选连接/);
  assert.match(html, /选集合/);
  assert.equal((html.match(/class="slot"/g) ?? []).length, 2);
});

test("填了的印填的,没填也没留空的印节点表里的默认值", () => {
  const html = fullCard(def("splitText"),
    { name: "切块", type: "splitText", params: { chunkSize: 800 }, blanks: [] }, []);
  assert.match(html, /Chunk Size[\s\S]*800/);
  assert.match(html, /Overlap[\s\S]*50/);
});

test("AI 起草的 Output Schema 印成字段清单,不印那份 JSON", () => {
  const html = fullCard(def("llm"), {
    name: "抽取", type: "llm", blanks: [],
    params: { prompt: "抽", outputSchema: { type: "object", properties: { 金额: {}, 抬头: {} } } },
  }, []);
  assert.match(html, /Output Schema[\s\S]*金额、抬头/);
  assert.doesNotMatch(html, /object Object/);
});

test("正文那种格自己占一块,不挤在一行里", () => {
  const html = fullCard(def("llm"),
    { name: "抽取", type: "llm", params: { prompt: "抽出甲方乙方" }, blanks: ["outputSchema"] }, []);
  assert.match(html, /<details class="node-block"[^>]*>[\s\S]*<button [^>]*class="prompt"[^>]*>抽出甲方乙方/);
});

test("分岔节点按出口印去哪儿;单出口的只印类型", () => {
  const edges = [
    { from: "有文字层？", to: "解析", output: "true" },
    { from: "有文字层？", to: "OCR", output: "false" },
  ];
  const html = fullCard(def("condition"),
    { name: "有文字层？", type: "condition", params: { condition: "input.text != \"\"" }, blanks: [] }, edges);
  assert.match(html, /True → <span class="name">解析<\/span>/);
  assert.match(html, /False → <span class="name">OCR<\/span>/);
});

test("起点没有进,印一横;有上游就印上游的名字", () => {
  const start = fullCard(def("schedule"), { name: "每天", type: "schedule", params: {}, blanks: [] }, []);
  assert.match(start, /<b>Input<\/b><span>—<\/span>/);
  const next = fullCard(def("parseDocument"),
    { name: "解析", type: "parseDocument", params: {}, blanks: [] }, [{ from: "读文件", to: "解析" }]);
  assert.match(next, /<span class="name">读文件<\/span> · File/);
});

test("收起来的小卡报还差几处", () => {
  const pending = miniCard(def("readFile"), { name: "读入手册", type: "readFile", params: {}, blanks: ["folder"] });
  assert.match(pending, /待定 1 项/);
  const settled = miniCard(def("parseDocument"), { name: "解析", type: "parseDocument", params: {}, blanks: [] });
  assert.match(settled, /✓/);
});

test("卡上的名字全是转义过的,画布上的字进不了标签", () => {
  const html = fullCard(def("code"),
    { name: "<script>x</script>", type: "code", params: { code: "a < b" }, blanks: [] }, []);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /a &lt; b/);
});

test("跳列的线不从中间那一列的卡片上压过去", () => {
  const nodes = ["岔", "OCR", "抽取"].map((name) => ({ name }));
  const edges = [
    { from: "岔", to: "OCR", output: "false" },
    { from: "岔", to: "抽取", output: "true" },
    { from: "OCR", to: "抽取" },
  ];
  const at = new Map(layout(nodes, edges).placed.map((p) => [p.node.name, p]));
  const w = wire(at.get("岔"), at.get("抽取"));
  const ocr = at.get("OCR");
  /* 沿着真正画出来的那根线走一遍,看它有没有落进 OCR 那张卡里。 */
  const cub = (a, b, c, d, t) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
  const s = (w.x1 - w.x0) * 0.52;
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    const x = cub(w.x0, w.x0 + s, w.x1 - s, w.x1, t);
    const y = cub(w.y0, w.y0, w.y1, w.y1, t);
    assert.ok(!(x > ocr.x && x < ocr.x + TILE && y > ocr.y && y < ocr.y + TILE),
      `线在 (${Math.round(x)}, ${Math.round(y)}) 压到了 OCR`);
  }
});

/* 一张图不管长成什么样,进来的地方和出去的地方都在一条水平线上。
   中间怎么起伏不管——起伏是好看,两端不平是「整张图是斜的」。 */
test("头一列和末一列落在同一条水平线上", () => {
  const N = (name) => ({ name });
  const E = (from, to) => ({ from, to });
  const 图 = {
    "一条直链": [["a", "b", "c", "d", "e"].map(N),
      [E("a", "b"), E("b", "c"), E("c", "d"), E("d", "e")]],
    "分岔再汇合": [["读", "岔", "A", "B", "合"].map(N),
      [E("读", "岔"), E("岔", "A"), E("岔", "B"), E("A", "合"), E("B", "合")]],
    "跨了三列的跳线": [["a", "b", "c", "d", "e"].map(N),
      [E("a", "b"), E("b", "c"), E("c", "d"), E("d", "e"), E("a", "d")]],
    "两个起点两个终点": [["a1", "a2", "m", "z1", "z2"].map(N),
      [E("a1", "m"), E("a2", "m"), E("m", "z1"), E("m", "z2")]],
    "谁也不连谁": [["a", "b", "c"].map(N), []],
  };
  for (const [名, [nodes, edges]] of Object.entries(图)) {
    const placed = layout(nodes, edges).placed;
    const 末列 = Math.max(...placed.map((p) => p.x));
    const 高 = (x) => { const 这列 = placed.filter((p) => p.x === x).map((p) => p.y);
      return 这列.reduce((s, y) => s + y, 0) / 这列.length; };
    assert.ok(Math.abs(高(末列) - 高(0)) < 0.5,
      `${名}:头 ${Math.round(高(0))},末 ${Math.round(高(末列))}`);
  }
});

test("分岔两路各占一列,汇合的卡排在两路都走完之后", () => {
  const nodes = ["读", "岔", "A", "B", "合"].map((name) => ({ name }));
  const edges = [
    { from: "读", to: "岔" }, { from: "岔", to: "A" }, { from: "岔", to: "B" },
    { from: "A", to: "合" }, { from: "B", to: "合" },
  ];
  const at = new Map(layout(nodes, edges).placed.map((p) => [p.node.name, p]));
  assert.ok(at.get("A").x === at.get("B").x, "两路同列");
  assert.ok(at.get("合").x > at.get("A").x, "汇合在后");
  assert.ok(at.get("A").y !== at.get("B").y, "两路不重叠");
});
