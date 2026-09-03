/* 卡放哪儿、线怎么走。画布上没有坐标,坐标是算出来的。

   一个节点的列 = 从起点走到它最长要几步,所以分岔的两路各占一列,
   汇合的那张卡一定排在两路都走完之后,线不会往回拐。

   跳列的线要在它跨过的每一列上占一个位置——不占,它就从中间那张卡
   背后穿过去,出来时像凭空冒出来的一根。占了,那一列的真卡片自动被
   挤到别的行,线绕着走。 */

export const TILE = 176;
const GAP_X = 260;
const GAP_Y = 34;
export const PITCH = TILE + GAP_X;
const LANE = TILE + GAP_Y;

/* 一条链不摆在一条水平线上:每往右一列,高度按正弦错开一点,
   线才有流的样子,不是一根根横杠。幅度远小于分岔两路的间距,
   所以岔开的两路照样分得清。 */
const AMP = 48;
export const wave = (col) => Math.round(AMP * Math.sin(col * 0.9));

const keyOf = (e) => `${e.from}>${e.to}>${e.output ?? ""}`;

export function layout(nodes, edges) {
  const names = nodes.map((n) => n.name);
  const known = new Set(names);
  const live = edges.filter((e) => known.has(e.from) && known.has(e.to));

  /* 列:反复松弛,列 = 所有上游的列 + 1。有环也停得下来(最多走节点数遍)。 */
  const col = new Map(names.map((n) => [n, 0]));
  for (let pass = 0; pass < names.length; pass++) {
    let moved = false;
    for (const e of live) {
      const want = col.get(e.from) + 1;
      if (want > col.get(e.to)) { col.set(e.to, want); moved = true; }
    }
    if (!moved) break;
  }

  /* 跳列的线,在它跨过的每一列上放一个拐点,拐点跟真卡片一样占位置。 */
  const bends = new Map();
  const parents = new Map(names.map((n) => [n, []]));
  const members = [];
  for (const n of names) (members[col.get(n)] ??= []).push(n);

  for (const e of live) {
    const from = col.get(e.from), to = col.get(e.to);
    const chain = [];
    for (let c = from + 1; c < to; c++) {
      const id = `${keyOf(e)}@${c}`;
      chain.push(id);
      (members[c] ??= []).push(id);
      parents.set(id, [chain.length > 1 ? chain[chain.length - 2] : e.from]);
    }
    bends.set(keyOf(e), chain);
    parents.get(e.to).push(chain.length ? chain[chain.length - 1] : e.from);
  }

  /* 行:一列一列往右排,每样东西想待在它上游的高度上,想去同一格的往下让。 */
  const row = new Map();
  for (const column of members) {
    if (!column) continue;
    const want = column.map((id) => {
      const up = (parents.get(id) ?? []).filter((p) => row.has(p));
      return { id, at: up.length ? up.reduce((s, p) => s + row.get(p), 0) / up.length : 0 };
    });
    want.sort((a, b) => a.at - b.at || column.indexOf(a.id) - column.indexOf(b.id));
    let taken = -Infinity;
    for (const { id, at } of want) {
      const r = Math.max(at, taken + 1);
      row.set(id, r);
      taken = r;
    }
  }

  const colOf = (id) => (col.has(id) ? col.get(id) : Number(id.slice(id.lastIndexOf("@") + 1)));
  const topOf = (id) => row.get(id) * LANE + wave(colOf(id));

  const placed = nodes.map((n) => ({ node: n, x: col.get(n.name) * PITCH, y: topOf(n.name) }));
  const lift = Math.min(...placed.map((p) => p.y), ...[...bends.values()].flat().map(topOf));
  for (const p of placed) p.y -= lift;

  /* 拐点交给画线的人:一条线要经过哪几个点。 */
  const route = new Map();
  for (const [key, chain] of bends) {
    if (!chain.length) continue;
    route.set(key, chain.map((id) => ({ x: colOf(id) * PITCH + TILE / 2, y: topOf(id) - lift + TILE / 2 })));
  }
  return { placed, route };
}

/* 一串点连成一条线:横着出、横着进,控制点取横向距离的 0.52,和原型一致——
   两端各留一段真正水平的线,卡片挨得近的时候也不会拱起来。

   画布上只有这一种曲率:已经建好的线、等着的虚线、还没走到的那截轨道,
   全从这儿出。同一条链上出现两种曲率,眼睛立刻看出是两个东西拼的。 */
export function path(points) {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = (b.x - a.x) * 0.52;
    d += ` C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }
  return d;
}

/* 线:从上游右沿的中点到下游左沿的中点。经过拐点时同样是水平进、水平出。 */
export function wire(from, to, through = []) {
  const points = [
    { x: from.x + TILE, y: from.y + TILE / 2 },
    ...through,
    { x: to.x, y: to.y + TILE / 2 },
  ];
  const d = path(points);
  const head = points[0], next = points[1];
  const tail = points[points.length - 1];
  return { d, x0: head.x, y0: head.y, x1: tail.x, y1: tail.y, dx: (next.x - head.x) * 0.52, next };
}

/* 出口名(True / False)贴在线刚离开上游的那一段上。 */
export function wireLabelAt(w, t = 0.26) {
  const p = (a, b, c, d) => {
    const u = 1 - t;
    return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  };
  return {
    x: p(w.x0, w.x0 + w.dx, w.next.x - w.dx, w.next.x),
    y: p(w.y0, w.y0, w.next.y, w.next.y),
  };
}
