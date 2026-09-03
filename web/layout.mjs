/* 卡放哪儿。画布上没有坐标,坐标是算出来的:
   一个节点的列 = 从起点走到它最长要几步,所以分岔的两路各占一列,
   汇合的那张卡一定排在两路都走完之后,线不会往回拐。
   同一列里的上下顺序跟着上游走,让线尽量平。 */

export const TILE = 176;
const GAP_X = 260;
const GAP_Y = 34;
/* 一条链不摆在一条水平线上:每往右一列,高度按正弦错开一点,
   线才有流的样子,不是一根根横杠。幅度远小于分岔两路的间距,
   所以岔开的两路照样分得清。 */
const AMP = 48;
const wave = (col) => Math.round(AMP * Math.sin(col * 0.9));

export function layout(nodes, edges) {
  const names = nodes.map((n) => n.name);
  const parents = new Map(names.map((n) => [n, []]));
  for (const e of edges) if (parents.has(e.to)) parents.get(e.to).push(e.from);

  /* 列:反复松弛,列 = 所有上游的列 + 1。有环也停得下来(最多走节点数遍)。 */
  const col = new Map(names.map((n) => [n, 0]));
  for (let pass = 0; pass < names.length; pass++) {
    let moved = false;
    for (const n of names) {
      const up = parents.get(n);
      if (!up.length) continue;
      const want = Math.max(...up.map((p) => col.get(p) ?? 0)) + 1;
      if (want > col.get(n)) { col.set(n, want); moved = true; }
    }
    if (!moved) break;
  }

  /* 行:一列一列往右排,每张卡想待在它上游的高度上,想去同一格的往下让。 */
  const columns = [];
  for (const n of names) (columns[col.get(n)] ??= []).push(n);
  const row = new Map();
  for (const column of columns) {
    const want = column.map((n) => {
      const up = parents.get(n).filter((p) => row.has(p));
      return { n, at: up.length ? up.reduce((s, p) => s + row.get(p), 0) / up.length : 0 };
    });
    want.sort((a, b) => a.at - b.at || column.indexOf(a.n) - column.indexOf(b.n));
    let taken = -Infinity;
    for (const { n, at } of want) {
      const r = Math.max(at, taken + 1);
      row.set(n, r);
      taken = r;
    }
  }

  const placed = nodes.map((n) => ({
    node: n,
    x: col.get(n.name) * (TILE + GAP_X),
    y: row.get(n.name) * (TILE + GAP_Y) + wave(col.get(n.name)),
  }));
  const top = Math.min(...placed.map((p) => p.y));
  for (const p of placed) p.y -= top;
  return placed;
}

/* 线:从上游右沿的中点到下游左沿的中点,横着出、横着进,中间一段贝塞尔。
   控制点取横向距离的 0.52,和原型一致——两端各留一段真正水平的线,
   卡片挨得近的时候也不会拱起来。 */
export const PITCH = TILE + GAP_X;

export function wire(from, to) {
  const x0 = from.x + TILE, y0 = from.y + TILE / 2;
  const x1 = to.x, y1 = to.y + TILE / 2;
  const dx = (x1 - x0) * 0.52;
  return { d: `M ${x0} ${y0} C ${x0 + dx} ${y0}, ${x1 - dx} ${y1}, ${x1} ${y1}`, x0, y0, x1, y1, dx };
}

/* 出口名(True / False)贴在线刚离开上游的那一段上。 */
export function wireLabelAt(w, t = 0.26) {
  const p = (a, b, c, d) => {
    const u = 1 - t;
    return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  };
  return { x: p(w.x0, w.x0 + w.dx, w.x1 - w.dx, w.x1), y: p(w.y0, w.y0, w.y1, w.y1) };
}
