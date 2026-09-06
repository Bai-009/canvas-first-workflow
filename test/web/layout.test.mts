import type { Edge } from '../../shared/contracts.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { layout, wire, heightAt, wireLabelAt, wave, TILE, PITCH } from "../../web/layout.mjs";
import type { Point, PlacedNode } from "../../web/layout.mjs";

/* 画布上没有坐标,坐标是算出来的。这几条守的是这份算法自己写在注释里的承诺:
   线只往右走、同一列的卡不叠、跨列的线不从中间那张卡身上压过去、两端拉平。
   这些是看图的人一眼就会发现不对、却没有任何断言拦得住的东西。 */

interface Named { name: string }
const build = (names: string[], edges: Edge[]) => ({
  placed: layout(names.map((name) => ({ name })), edges).placed, edges,
});
const at = (placed: PlacedNode<Named>[], name: string) => {
  const found = placed.find((p) => p.node.name === name);
  assert.ok(found, `布局里应当有 ${name}`);
  return found;
};
/* 一根线扫过某张卡的整个宽度时,占住的高度区间。 */
const band = (from: Point, to: Point, x: number) => {
  const w = wire(from, to), a = { x: w.x0, y: w.y0 }, b = { x: w.x1, y: w.y1 };
  const left = heightAt(a, b, x), right = heightAt(a, b, x + TILE);
  return { lo: Math.min(left, right), hi: Math.max(left, right) };
};

const 直链 = build(["a", "b", "c"], [{ from: "a", to: "b" }, { from: "b", to: "c" }]);
const 分岔汇合 = build(["a", "b", "c", "d"],
  [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" }]);
const 跨列长线 = build(["a", "b", "c", "d"],
  [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" }, { from: "a", to: "d" }]);
/* 这张图是压出来的:分岔加一条跳列的线,四个节点五条线。
   把最后那一遍「线扫过卡片就把卡挪开」去掉,它立刻变成 n1→n3 从 n2 身上压过去。
   前面几遍算占位看的是线在列正中间的高度,而线是斜着过去的,压到的是卡的左右沿。 */
const 分岔加跳线 = build(["n0", "n1", "n2", "n3"],
  [{ from: "n0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n1", to: "n3" },
   { from: "n2", to: "n3" }, { from: "n0", to: "n2" }]);
const 全部 = [直链, 分岔汇合, 跨列长线, 分岔加跳线];

test("线只往右走:一个节点的列是从起点走到它最长要几步", () => {
  for (const { placed, edges } of 全部) {
    for (const e of edges) assert.ok(at(placed, e.to).x > at(placed, e.from).x,
      `线 ${e.from}→${e.to} 必须往右走,否则画布上会看到往回拐的线`);
  }
  // 分岔的两路各占一列,汇合的那张排在两路都走完之后
  const { placed } = 分岔汇合;
  assert.equal(at(placed, "b").x, at(placed, "c").x);
  assert.ok(at(placed, "d").x > at(placed, "b").x);
});

test("同一列上的卡片不叠在一起", () => {
  for (const { placed } of 全部) {
    for (const one of placed) for (const other of placed) {
      if (one === other || one.x !== other.x) continue;
      assert.ok(Math.abs(one.y - other.y) >= TILE,
        `${one.node.name} 和 ${other.node.name} 同列,间距必须够一整张卡`);
    }
  }
});

test("跨列的线不从中间那张卡身上压过去", () => {
  for (const { placed, edges } of 全部) {
    for (const e of edges) {
      const from = at(placed, e.from), to = at(placed, e.to);
      for (const middle of placed) {
        if (middle.x <= from.x || middle.x >= to.x) continue;
        const { lo, hi } = band(from, to, middle.x);
        assert.ok(hi < middle.y || lo > middle.y + TILE,
          `线 ${e.from}→${e.to} 压在卡片 ${middle.node.name} 上:线 ${lo.toFixed(0)}~${hi.toFixed(0)},卡 ${middle.y.toFixed(0)}~${(middle.y + TILE).toFixed(0)}`);
      }
    }
  }
});

test("两端拉平,整张图不歪;最上面的卡贴着零", () => {
  for (const { placed } of 全部) {
    const columns = [...new Set(placed.map((p) => p.x))].sort((a, b) => a - b);
    const mean = (x: number) => {
      const inColumn = placed.filter((p) => p.x === x);
      return inColumn.reduce((sum, p) => sum + p.y, 0) / inColumn.length;
    };
    const first = columns[0], last = columns.at(-1);
    assert.ok(first !== undefined && last !== undefined);
    assert.ok(Math.abs(mean(last) - mean(first)) < 1,
      "首末两列的平均高度要齐平,否则整张图看着是斜的");
    assert.equal(Math.min(...placed.map((p) => p.y)), 0);
  }
});

test("一根线两头之间只有一条曲线,两端就落在给的那两个点上", () => {
  const from = { x: 0, y: 100 }, to = { x: 600, y: 400 };
  const w = wire(from, to);
  // 线从上游右沿的中点出,到下游左沿的中点进
  assert.deepEqual([w.x0, w.y0], [from.x + TILE, from.y + TILE / 2]);
  assert.deepEqual([w.x1, w.y1], [to.x, to.y + TILE / 2]);
  const a = { x: w.x0, y: w.y0 }, b = { x: w.x1, y: w.y1 };
  assert.ok(Math.abs(heightAt(a, b, a.x) - a.y) < 1e-6);
  assert.ok(Math.abs(heightAt(a, b, b.x) - b.y) < 1e-6);
  /* 横着出、横着进:线离开上游和进入下游的那一段几乎是平的,中间才拐。
     控制点一旦退化(取 0),整条线就成了一条斜着的直线——横向走一成、纵向也走一成,
     画布上看就是一根根斜杠,不是流。 */
  const 落差 = (比例: number) => (heightAt(a, b, a.x + (b.x - a.x) * 比例) - a.y) / (b.y - a.y);
  assert.ok(落差(0.1) < 0.05, "刚出上游就往下掉,线不是横着出去的");
  assert.ok(落差(0.9) > 0.95, "快到下游还在掉,线不是横着进去的");
  assert.ok(Math.abs(落差(0.5) - 0.5) < 1e-6, "中点应当正好在两端高度的正中间");
});

test("出口名贴在线刚离开上游的那一段上,跨得再远也不跑到画布中间", () => {
  const 长 = wire({ x: 0, y: 0 }, { x: PITCH * 4, y: 400 });
  assert.equal(wireLabelAt(长).x, 长.x0 + 80);
  // 短到 80 都放不下时改贴中点,不会越过终点
  const 短 = wire({ x: 0, y: 0 }, { x: PITCH, y: 0 });
  assert.equal(wireLabelAt(短).x, (短.x0 + 短.x1) / 2);
  assert.ok(wireLabelAt(短).x < 短.x1);
});

test("每往右一列高度错开一点,但错的幅度远小于分岔两路的间距", () => {
  assert.equal(wave(0), 0);
  const 最大 = Math.max(...Array.from({ length: 40 }, (_, i) => Math.abs(wave(i))));
  assert.ok(最大 > 0, "完全不错开,整条链就是一根横杠");
  assert.ok(最大 < TILE, "错开的幅度盖过一整张卡,岔开的两路就分不清了");
});
