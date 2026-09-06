import type { Edge } from '../shared/contracts.mjs';
export interface Point { x: number; y: number }
export interface PlacedNode<N> extends Point { node: N }
export interface Wire { d: string; x0: number; y0: number; x1: number; y1: number }
type Rows = Map<string, number>;
type Neighbors = Map<string, string[]>;
// 这些表由本次布局的节点和占位统一建立；缺项代表布局内部不变量被破坏。
function required<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`布局缺少内部位置：${String(key)}`);
  return value;
}
/* 卡放哪儿、线怎么走。画布上没有坐标,坐标是算出来的。

   一个节点的列 = 从起点走到它最长要几步,所以分岔的两路各占一列,
   汇合的那张卡一定排在两路都走完之后,线不会往回拐。

   跳列的线要在它跨过的每一列上占一个位置——不占,它就从中间那张卡背后
   穿过去。占的是这根线自己真正经过的高度,不是它上游的高度:占位本来就是
   给线让路的,那就照着线让。同一列上让路的是卡片,不是线——反过来的话,
   本来在线上边的卡会被压到线下边去,线就得穿过它。 */

export const TILE = 176;

/* 列距。原来是 436,那个数是被展开态倒推出来的:卡片点开变 540 宽,每边外扩
   182,间隙够宽它就不压邻居。但十来个节点铺出去就是四千多像素宽,镜头被逼到
   很远,卡片小得像模型图,而竖着还空着一大半——长线于是只能在那点高度里落,
   同一条曲线摊在四千像素上就是一条平线,弧不是画法不对,是它没地方落。

   收到 300:画布窄了三分之一,镜头拉回来,卡片看得清,长线也有坡了。
   代价是间隙 124 < 182,点开的卡会盖住旁边那张(邻居这时是暗的)。 */
const GAP_X = 124;
const GAP_Y = 34;
export const PITCH = TILE + GAP_X;
const LANE = TILE + GAP_Y;

/* 一条链不摆在一条水平线上:每往右一列,高度按正弦错开一点,
   线才有流的样子,不是一根根横杠。幅度远小于分岔两路的间距,
   所以岔开的两路照样分得清。 */
const AMP = 48;
export const wave = (col: number) => Math.round(AMP * Math.sin(col * 0.9));

/* 一根线两头之间只有一条曲线,不切段。横着出、横着进,控制点取横距的 0.52。
   切了段,每个接缝上线都要先压平再拐,跨三列就压平三次、起拐三次,长线就成了
   几段拼的——一根线上出现好几个弧,眼睛立刻看出不是一笔画的。

   画布上只有这一种线:已经建好的、等着的虚线、还没走到的那截轨道,全从这儿出。 */
const SHOULDER = 0.52;
const cub = (a: number, b: number, c: number, d: number, t: number) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };

export function path(a: Point, b: Point) {
  const s = (b.x - a.x) * SHOULDER;
  return `M ${a.x} ${a.y} C ${a.x + s} ${a.y}, ${b.x - s} ${b.y}, ${b.x} ${b.y}`;
}

/* 这根线走到某个横坐标上有多高。x 一路向右,二分就够。 */
export function heightAt(a: Point, b: Point, x: number) {
  const s = (b.x - a.x) * SHOULDER;
  let lo = 0, hi = 1;
  for (let i = 0; i < 26; i++) {
    const t = (lo + hi) / 2;
    if (cub(a.x, a.x + s, b.x - s, b.x, t) < x) lo = t; else hi = t;
  }
  return cub(a.y, a.y, b.y, b.y, (lo + hi) / 2);
}

export function layout<N extends { name: string }>(nodes: readonly N[], edges: readonly Edge[]) {
  const names = nodes.map((n) => n.name);
  const known = new Set(names);
  const live = edges.filter((e) => known.has(e.from) && known.has(e.to));

  /* 列:反复松弛,列 = 所有上游的列 + 1。有环也停得下来(最多走节点数遍)。 */
  const col = new Map(names.map((n) => [n, 0]));
  for (let pass = 0; pass < names.length; pass++) {
    let moved = false;
    for (const e of live) {
      const want = required(col, e.from) + 1;
      if (want > required(col, e.to)) { col.set(e.to, want); moved = true; }
    }
    if (!moved) break;
  }

  const members: string[][] = [];
  const owner = new Map<string, Edge>();                                  // 占位 → 它是哪根线的
  const parents: Neighbors = new Map(names.map((n) => [n, []]));
  const ups: Neighbors = new Map(), downs: Neighbors = new Map();
  const join = (a: string, b: string) => {
    const above = ups.get(b) ?? []; above.push(a); ups.set(b, above);
    const below = downs.get(a) ?? []; below.push(b); downs.set(a, below);
  };
  for (const n of names) (members[required(col, n)] ??= []).push(n);
  for (const e of live) {
    let prev = e.from;
    for (let c = required(col, e.from) + 1; c < required(col, e.to); c++) {
      const id = `${e.from}>${e.to}>${e.output ?? ""}@${c}`;
      (members[c] ??= []).push(id);
      owner.set(id, e);
      join(prev, id);
      prev = id;
    }
    join(prev, e.to);
    /* 下游想待的高度看的是真正的上游那张卡,不是这根线路上的占位——占位是
       跟着线算出来的,让它当爹,这根线会顺着自己把自己一路往下拽。 */
    required(parents, e.to).push(e.from);
  }
  const colOf = (id: string) => (col.has(id) ? required(col, id) : Number(id.slice(id.lastIndexOf("@") + 1)));
  const mean = (of: Neighbors, id: string, row: Rows) => {
    const seen = (of.get(id) ?? []).filter((p) => row.has(p));
    return seen.length ? seen.reduce((s, p) => s + required(row, p), 0) / seen.length : 0;
  };

  /* 这根线在这一列上真正经过的高度,换算成行。 */
  const onLine = (id: string, row: Rows) => {
    const e = required(owner, id), c = colOf(id);
    const a = { x: required(col, e.from) * PITCH + TILE, y: required(row, e.from) * LANE + wave(required(col, e.from)) + TILE / 2 };
    const b = { x: required(col, e.to) * PITCH, y: required(row, e.to) * LANE + wave(required(col, e.to)) + TILE / 2 };
    return (heightAt(a, b, c * PITCH + TILE / 2) - TILE / 2 - wave(c)) / LANE;
  };
  const nearestFree = (at: number, held: number[]) => {
    const free = (r: number) => held.every((h) => Math.abs(h - r) >= 1);
    if (free(at)) return at;
    for (let d = 0.05; d <= 12; d += 0.05) {
      if (free(at - d)) return at - d;
      if (free(at + d)) return at + d;
    }
    return Math.max(...held) + 1;
  };

  /* 一列一列往右排。第一遍还不知道线要从哪儿过,占位先跟着上游;
     之后每一遍,占位待在线真正经过的高度上,卡片往最近的空位让。 */
  function pack(prev: Rows | null) {
    const row: Rows = new Map();
    for (const column of members) {
      if (!column) continue;
      const want = column.map((id) => {
        const line = owner.has(id);
        if (line && prev) return { id, at: onLine(id, prev), line };
        return { id, at: mean(line ? ups : parents, id, row), line };
      });
      want.sort((a, b) => a.at - b.at || column.indexOf(a.id) - column.indexOf(b.id));
      if (!prev) {
        let taken = -Infinity;
        for (const { id, at } of want) { const r = Math.max(at, taken + 1); row.set(id, r); taken = r; }
        continue;
      }
      const held: number[] = [];
      for (const w of want) if (w.line) { row.set(w.id, w.at); held.push(w.at); }
      for (const w of want) {
        if (w.line) continue;
        const r = nearestFree(w.at, held);
        row.set(w.id, r); held.push(r);
      }
    }
    return row;
  }

  /* 一列里谁上谁下。只从左往右扫一遍,下游的高低管不到上游,线就要交叉。
     来回扫几遍:往右看上游的平均高度,往左看下游的平均高度。 */
  function sweep(row: Rows, back: boolean) {
    const out = new Map(row);
    const cols = members.map((_, i) => i).filter((i) => members[i]);
    for (const c of back ? cols.slice().reverse() : cols) {
      const want = (members[c] ?? []).map((id) => {
        const near = ((back ? downs : ups).get(id) ?? []).filter((n) => out.has(n));
        return { id, at: near.length ? near.reduce((s, n) => s + required(out, n), 0) / near.length : required(row, id) };
      });
      want.sort((a, b) => a.at - b.at || required(row, a.id) - required(row, b.id));
      let taken = -Infinity;
      for (const { id, at } of want) { const r = Math.max(at, taken + 1); out.set(id, r); taken = r; }
    }
    return out;
  }

  let row = pack(null);
  for (let i = 0; i < 3; i++) row = sweep(sweep(row, true), false);
  /* 卡片一让,线就变;线一变,该让的地方也变。来回几遍就停住了。 */
  for (let i = 0; i < 12; i++) row = pack(row);

  /* 两端拉平。中间怎么起伏是好看,两端不在一条线上是「这张图整个是斜的」——
     那不是风格,是看着不稳。歪来自两处:行本身爬上去了(分支被长线的走廊顶开),
     和 wave 在头尾两列取值不同。所以拉的是最终高度,不是只调 wave。

     做法是整体剪一刀:每一列按它离起点多远,匀一点回来,第一列不动、最后一列
     补满。列内谁上谁下一点没变,所以不会摆出新的叠卡;列与列之间隔着 300,
     本来就碰不到。剩下的只有线扫过卡片的高度变了——那正是下面收尾那一遍的活。

     头尾这两列不会被别的线跨过去:一根线只占它两头之间的列,第一列左边没有
     上游,最后一列右边没有下游。所以拉平之后没人再动得了它们。 */
  const flat = members.length - 1;
  if (flat > 0) {
    const yAt = (id: string) => required(row, id) * LANE + wave(colOf(id));
    const avg = (ids: string[]) => ids.reduce((sum, id) => sum + yAt(id), 0) / ids.length;
    const tilt = avg(members[flat] ?? []) - avg(members[0] ?? []);
    if (tilt) for (const id of row.keys()) row.set(id, required(row, id) - (tilt * colOf(id)) / flat / LANE);
  }

  /* 收尾。前面几遍算占位,看的是线在那一列正中间有多高;可线是斜着过去的,
     压到卡片的往往是卡的左沿或右沿。这一遍改用真正画出来的那根线:它扫过
     这张卡的整个宽度时占住哪一段,那一段里有卡就把卡挪开。只挪被压的那张。

     没清干净:随机造两千张合法的图压过,这一遍把压卡从约一成七降到约一分二,
     剩下的是分岔再加跨列长线的那种图。只是难看,不丢东西,现在不追。
     test/web/layout.test.mts 里那张四节点五条线的图,守的就是这一遍别被删掉。 */
  const MARGIN = 10;
  for (let round = 0; round < 8; round++) {
    const y = (n: string) => required(row, n) * LANE + wave(required(col, n));
    const bands = [];
    for (const e of live) {
      const a = { x: required(col, e.from) * PITCH + TILE, y: y(e.from) + TILE / 2 };
      const b = { x: required(col, e.to) * PITCH, y: y(e.to) + TILE / 2 };
      for (let c = required(col, e.from) + 1; c < required(col, e.to); c++) {
        const l = heightAt(a, b, c * PITCH), r = heightAt(a, b, c * PITCH + TILE);
        bands.push({ c, lo: Math.min(l, r), hi: Math.max(l, r) });
      }
    }
    let moved = false;
    for (const n of names) {
      const c = required(col, n);
      const over = bands.filter((b) => b.c === c);
      const near = names.filter((m) => m !== n && required(col, m) === c).map(y);
      const ok = (t: number) => over.every((b) => b.hi < t - MARGIN || b.lo > t + TILE + MARGIN)
        && near.every((o) => Math.abs(o - t) >= TILE + GAP_Y);
      const now = y(n);
      if (ok(now)) continue;
      let go: number | null = null;
      for (let d = 6; d <= 1200 && go === null; d += 6) {
        if (ok(now - d)) go = now - d;
        else if (ok(now + d)) go = now + d;
      }
      if (go === null) continue;
      row.set(n, (go - wave(c)) / LANE);
      moved = true;
    }
    if (!moved) break;
  }

  const top = (id: string) => required(row, id) * LANE + wave(colOf(id));
  const placed = nodes.map((n) => ({ node: n, x: required(col, n.name) * PITCH, y: top(n.name) }));
  const lift = Math.min(...placed.map((p) => p.y));
  for (const p of placed) p.y -= lift;
  return { placed };
}

/* 线:从上游右沿的中点到下游左沿的中点。 */
export function wire(from: Point, to: Point): Wire {
  const a = { x: from.x + TILE, y: from.y + TILE / 2 };
  const b = { x: to.x, y: to.y + TILE / 2 };
  return { d: path(a, b), x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

/* 出口名(True / False)贴在线刚离开上游的那一段上。跨得再远也贴在起点旁边,
   不跟着线跑到画布中间去。 */
const LABEL_X = 80;
export function wireLabelAt(w: Wire) {
  const a = { x: w.x0, y: w.y0 }, b = { x: w.x1, y: w.y1 };
  const x = Math.min(w.x0 + LABEL_X, (w.x0 + w.x1) / 2);
  return { x, y: heightAt(a, b, x) };
}
