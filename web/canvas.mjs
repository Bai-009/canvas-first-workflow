import { fullCard, miniCard } from "./card.mjs";
import { layout, wire, wireLabelAt, path, wave, TILE, PITCH } from "./layout.mjs";

const SVG = "http://www.w3.org/2000/svg";
const svg = (name, attrs) => {
  const el = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 展开之后的卡有多宽。高度是内容自己写出来的,量出来才知道。 */
const OPEN_W = 540;

/* 一张卡出场分三拍:线先走到位,卡片落在线的尽头,然后停一口气再放下一张。
   三拍加起来一秒三,一步交回两个节点也是一张一张来。
   同时落地的两张卡分不出先后,人看不清哪张接哪张。 */
const LEAD = 460, LAND = 560, REST = 420;

/* 点开一张卡:镜头先过去,到位了再展开。
   先展开再挪镜头,展开的那一下人在看别处。 */
const FOCUS_LEAD = 300;

/* 画布这一头只做一件事:把画布数据摆到屏幕上,新长出来的卡带一下动静。
   它不认得任何一种具体节点——那些全在节点表里。 */
export function createCanvasView({ table, world, wires, viewport, insets = () => ({ right: 0, bottom: 0 }) }) {
  const byType = new Map(table.map((d) => [d.type, d]));
  const nodes = new Map();
  const edges = new Map();
  /* box 是整张画布的范围,连还没走到的那截轨道一起——SVG 得画得下。
     built 只算已经落地的卡,镜头看的是它:为了把剩下几步全塞进画面
     而把卡片缩到看不清,是本末倒置。轨道跑出右边就跑出去。 */
  let scale = 1, tx = 0, ty = 0, userMoved = false, box = { w: 1, h: 1 }, built = { w: 1, h: 1 };
  let last = { placed: [], canvas: { nodes: [], edges: [] } };
  /* 已经露过面的卡和已经走完的线。排队的那几张还挂在 queue 上,画布上是空位。 */
  const shown = new Set();
  const drawn = new Set();
  const queue = [];
  let playing = false, idleWaiters = [];

  /* 线归一层,等待的轨道归另一层。轨道每次重画,线是留着的——
     线要自己走出来,重画一次就等于从头走一次。 */
  const gWires = svg("g", {});
  const gTrack = svg("g", {});
  wires.append(gWires, gTrack);

  /* 等着的时候,进度长在链路自己的轨道上:左边是已经建好的真卡片,
     头上那个点是下一张卡出现的地方,右边几个淡点是还没走到的几步。
     一行字在点底下写当下这一步。除此之外画布上不加别的东西。 */
  const labelEl = document.createElement("div");
  labelEl.className = "track-label";
  labelEl.hidden = true;
  world.appendChild(labelEl);
  let pending = null, closeTrack = false;

  /* 自己挪的镜头是有过渡的:一跳一跳的镜头看不出东西是从哪儿长出来的。
     用户在拖、在滚的时候不能有过渡,那会变成拖不动。 */
  const apply = (glide = true) => {
    world.classList.toggle("gliding", glide);
    world.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
  };

  /* 正在长的时候镜头跟着头走,卡片保持看得清的大小;跑完了再退回来看全景。
     两种都躲开右边的需求框和底下的输入条。 */
  const RUN_SCALE = 0.78;

  function room() {
    const pad = 64;
    const { right, bottom } = insets();
    return { pad, w: innerWidth - right - pad * 2, h: innerHeight - bottom - pad * 2 };
  }

  /* 画布本来就比窗口大。整条链塞不下的时候不再往小里缩——缩到看不清字,
     等于把画布变成一张缩略图。缩到底就停,右端对齐:刚长出来的那几张在眼前,
     往左拖能看回去。 */
  const MIN_SCALE = 0.62;

  /* 有一张卡展开着的时候,镜头归它。这时候别的东西再动也不许抢镜头。 */
  function fit() {
    if (opened) return;
    if (pending) return follow();
    const { pad, w, h } = room();
    scale = Math.max(MIN_SCALE, Math.min(1, w / box.w, h / box.h));
    const wide = box.w * scale;
    tx = wide > w ? pad + w - wide : pad + (w - wide) / 2;
    ty = pad + (h - box.h * scale) / 2;
    apply();
  }

  function follow() {
    const { pad, w, h } = room();
    const at = head();
    scale = Math.min(RUN_SCALE, w / built.w, 1);
    tx = pad + w / 2 - at.x * scale;
    ty = pad + h / 2 - at.y * scale;
    apply();
  }

  const visible = () => last.placed.filter((p) => shown.has(p.node.name));

  function draw(canvas, { instant = false } = {}) {
    /* 刷新回来的那一下不重演:已经在画布上的东西直接就位。 */
    if (instant) {
      for (const n of canvas.nodes) shown.add(n.name);
      for (const e of canvas.edges) drawn.add(key(e));
    }
    const { placed, route } = layout(canvas.nodes, canvas.edges);
    const at = new Map(placed.map((p) => [p.node.name, p]));
    last = { placed, canvas };

    for (const [name, el] of nodes) if (!at.has(name)) { el.remove(); nodes.delete(name); shown.delete(name); }

    for (const p of placed) {
      const def = byType.get(p.node.type);
      if (!def) continue;
      let el = nodes.get(p.node.name);
      if (!el) {
        /* 刷新回来的那一下不排队:这些卡早就在画布上了,再演一遍就是从头长一次。 */
        const ready = shown.has(p.node.name);
        el = document.createElement("div");
        el.className = ready ? "node" : "node born";
        el.appendChild(document.createElement("div")).className = "card";
        el.addEventListener("click", (e) => { e.stopPropagation(); toggle(p.node.name); });
        world.appendChild(el);
        nodes.set(p.node.name, el);
        if (!ready) queue.push(p.node.name);
      }
      el.style.setProperty("--c", def.color);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      const card = el.firstChild;
      card.innerHTML = `${miniCard(def, p.node)}${fullCard(def, p.node, canvas.edges)}`;
      /* 换了内容的那张卡如果正开着,高度得跟着内容重新量。 */
      if (opened === p.node.name) box0(el, measure(el));
    }

    for (const [k, e] of edges) if (!canvas.edges.some((x) => key(x) === k)) { e.g.remove(); edges.delete(k); }
    for (const e of canvas.edges) {
      const from = at.get(e.from), to = at.get(e.to);
      if (from && to) paint(e, wire(from, to, route.get(key(e)) ?? []));
    }

    track();
    resize();
    if (!userMoved) fit();
    /* 排队放卡要等这一遍画完:线得先在画布上,才走得起来。 */
    pump();
  }

  /* ── 线 ───────────────────────────────────────────────
     一条线的三样:出发点上一个小圆点、一段贝塞尔、末端一个描边的箭头。
     箭头停在卡片外一点五像素,不顶着卡沿。 */
  const key = (e) => `${e.from}>${e.to}>${e.output ?? ""}`;

  function paint(e, w) {
    const k = key(e);
    let it = edges.get(k);
    if (!it) {
      const g = svg("g", { class: "edge" });
      const port = svg("circle", { class: "port", r: 3.2 });
      const path = svg("path", { class: "wire" });
      const tip = svg("path", { class: "tip" });
      g.append(port, path, tip);
      let text = null;
      if (e.output) {
        text = svg("text", { class: "port-label", "text-anchor": "middle" });
        text.textContent = e.output === "true" ? "True" : "False";
        g.appendChild(text);
      }
      gWires.appendChild(g);
      it = { g, port, path, tip, text };
      edges.set(k, it);
    }
    it.path.setAttribute("d", w.d);
    it.port.setAttribute("cx", w.x0);
    it.port.setAttribute("cy", w.y0);
    it.tip.setAttribute("d", `M${w.x1 - 9},${w.y1 - 6} L${w.x1 - 1.5},${w.y1} L${w.x1 - 9},${w.y1 + 6}`);
    if (it.text) {
      const spot = wireLabelAt(w);
      it.text.setAttribute("x", spot.x);
      it.text.setAttribute("y", spot.y - 8);
    }
    /* 还没轮到的线是收着的:整条按自己的长度藏进虚线的空档里。 */
    const len = it.path.getTotalLength();
    it.path.style.strokeDasharray = len;
    it.path.style.strokeDashoffset = drawn.has(k) ? 0 : len;
    it.g.classList.toggle("held", !drawn.has(k));
  }

  /* 线自己走一遍。走的是这一格的入线,走完卡片才落下来。 */
  function light(k) {
    const it = edges.get(k);
    drawn.add(k);
    if (!it) return;
    /* 先把「收着」这一帧钉住再改:同一拍里设初值又设终值,浏览器看不见起点,
       线会直接整条出现。读一下几何就是钉住的办法。 */
    void it.path.getBoundingClientRect();
    it.path.style.transition = `stroke-dashoffset ${LEAD}ms cubic-bezier(.4,0,.2,1)`;
    it.path.style.strokeDashoffset = 0;
    /* 箭头等线走到了才出现:线还在半路,末端先冒出个箭头是不对的。 */
    setTimeout(() => it.g.classList.remove("held"), LEAD - 60);
  }

  /* ── 出场 ─────────────────────────────────────────────
     一张一张放。放完一张歇一口气再放下一张,队伍空了才算这一段过去了。 */
  async function pump() {
    if (playing || !queue.length) return;
    playing = true;
    while (queue.length) {
      const name = queue.shift();
      const el = nodes.get(name);
      if (!el) continue;
      const feed = last.canvas.edges.filter((e) => e.to === name && shown.has(e.from)).map(key);
      if (feed.length) {
        for (const k of feed) light(k);
        await wait(LEAD);
      }
      shown.add(name);
      el.classList.remove("born");
      /* 卡片落下来了,头才往前挪一格,镜头跟上。 */
      resize();
      track();
      if (!userMoved) fit();
      await wait(LAND + REST);
    }
    playing = false;
    if (closeTrack) { closeTrack = false; pending = null; track(); resize(); if (!userMoved) fit(); }
    for (const fn of idleWaiters.splice(0)) fn();
  }

  function resize() {
    const seen = visible();
    built = seen.length
      ? { w: Math.max(...seen.map((p) => p.x)) + TILE, h: Math.max(...seen.map((p) => p.y)) + TILE }
      : { w: 1, h: 1 };
    box = built;
    if (pending) {
      const at = head();
      const ahead = Math.max(0, (pending.remaining ?? 1) - 1);
      box = { w: Math.max(box.w, at.x + Math.max(1, ahead) * PITCH + 40), h: Math.max(box.h, at.y + 120) };
    }
    wires.setAttribute("width", box.w);
    wires.setAttribute("height", box.h);
  }

  /* 下一张卡会落在哪一格,头就在哪儿。已经落地的卡里最右一列往后接一格,
     一张都还没落就在原点——镜头会把它摆到正中。

     base 是这一格去掉起伏之后的高度。往后每一格的高度都从 base 加上那一列
     自己的起伏算出来,和真卡片用的是同一个函数:还没走到的那几步,
     踩的是真链路接着走的那几个点。 */
  function head() {
    const seen = visible();
    if (!seen.length) return { x: 0, y: TILE / 2, col: 0, base: TILE / 2 };
    const colOf = (p) => Math.round(p.x / PITCH);
    const col = Math.max(...seen.map(colOf)) + 1;
    const tail = seen.filter((p) => colOf(p) === col - 1);
    const base = tail.reduce((sum, p) => sum + p.y - wave(colOf(p)), 0) / (tail.length || 1) + TILE / 2;
    return { x: col * PITCH, y: base + wave(col), col, base };
  }

  function track() {
    gTrack.replaceChildren();
    labelEl.hidden = !pending;
    if (!pending) return;
    const at = head();
    const ahead = Math.max(0, (pending.remaining ?? 1) - 1);

    /* 已经落定的那几张卡先把线接到头上来:和真线同一条规矩画。 */
    const busy = new Set(last.canvas.edges.filter((e) => shown.has(e.to)).map((e) => e.from));
    for (const p of visible()) {
      if (busy.has(p.node.name)) continue;
      gTrack.appendChild(svg("path", {
        class: "wire waiting",
        d: path([{ x: p.x + TILE, y: p.y + TILE / 2 }, { x: at.x - 14, y: at.y }]),
      }));
    }
    /* 还没走到的那几步:一步一个点,点落在真链路接着走的位置上,
       线穿过这些点——所以它跟已经建好的那半截是同一条曲线,不是一根横杠。 */
    if (ahead) {
      const next = [];
      for (let i = 1; i <= ahead; i++) next.push({ x: at.x + i * PITCH, y: at.base + wave(at.col + i) });
      gTrack.appendChild(svg("path", { class: "track", d: path([{ x: at.x + 14, y: at.y }, ...next]) }));
      for (const q of next) gTrack.appendChild(svg("circle", { class: "track-dot", cx: q.x, cy: q.y, r: 3 }));
    }
    gTrack.appendChild(svg("circle", { class: pending.broken ? "track-break" : "track-head", cx: at.x, cy: at.y, r: 7 }));

    labelEl.textContent = pending.title;
    labelEl.style.left = `${at.x}px`;
    labelEl.style.top = `${at.y + 26}px`;
    labelEl.style.transform = `translate(-50%,0) scale(${1 / scale})`;
  }

  /* ── 点开一张卡 ───────────────────────────────────────
     展开是「聚焦」的结果:镜头先带过去,别的卡退到背景里,这一张才撑开。
     卡片钉住上沿往下长,所以镜头瞄的是「上沿 + 展开高度的一半」。 */
  let opened = null, home = null, turn = 0;

  function measure(el) {
    const card = el.firstChild;
    el.classList.add("measuring", "open");
    card.style.height = "auto";
    const h = card.offsetHeight;
    el.classList.remove("open");
    card.style.height = "";
    card.style.transform = "";
    void card.offsetHeight;
    el.classList.remove("measuring");
    return h;
  }

  const box0 = (el, h) => {
    el.firstChild.style.height = `${h}px`;
    el.firstChild.style.transform = `translate(-50%, calc(-50% + ${((h - TILE) / 2).toFixed(1)}px))`;
  };

  function aim(p, h) {
    const { pad, w, h: room_h } = room();
    const s = Math.min(1, (w - 32) / OPEN_W, (room_h - 32) / h);
    scale = s;
    tx = pad + w / 2 - (p.x + TILE / 2) * s;
    ty = pad + room_h / 2 - (p.y + h / 2) * s;
    apply();
  }

  async function toggle(name) {
    if (!shown.has(name)) return;
    if (opened === name) return void shut(true);
    const p = last.placed.find((q) => q.node.name === name);
    const el = nodes.get(name);
    if (!p || !el) return;
    if (!opened) home = { tx, ty, scale, userMoved };
    else shut(false);            /* 换一张看,镜头不回原位 */
    const tk = ++turn;

    const h = measure(el);
    aim(p, h);
    await wait(FOCUS_LEAD);
    if (tk !== turn) return;
    opened = name;
    for (const [n, e] of nodes) e.classList.toggle("dim", n !== name);
    el.classList.add("morph");
    box0(el, h);
    el.classList.add("open");
  }

  function shut(back = true) {
    if (!opened) return false;
    const el = nodes.get(opened);
    ++turn;
    opened = null;
    if (el) {
      el.classList.remove("open");
      el.firstChild.style.height = "";
      el.firstChild.style.transform = "";
    }
    for (const e of nodes.values()) e.classList.remove("dim");
    if (back && home) { ({ tx, ty, scale, userMoved } = home); apply(); home = null; }
    return true;
  }

  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const next = Math.min(1.6, Math.max(0.2, scale * Math.exp(-e.deltaY / 420)));
    tx = e.clientX - (e.clientX - tx) * (next / scale);
    ty = e.clientY - (e.clientY - ty) * (next / scale);
    scale = next;
    userMoved = true;
    apply(false);
  }, { passive: false });

  /* 按下先不抢指针,挪过 4 像素才算拖,否则那一下是点在卡片上。 */
  let drag = null;
  viewport.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".node")) return;
    drag = { x: e.clientX - tx, y: e.clientY - ty, from: [e.clientX, e.clientY], moved: false };
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.from[0], e.clientY - drag.from[1]) < 4) return;
      drag.moved = true;
      userMoved = true;
      viewport.classList.add("grabbing");
      viewport.setPointerCapture(e.pointerId);
    }
    tx = e.clientX - drag.x;
    ty = e.clientY - drag.y;
    apply(false);
  });
  viewport.addEventListener("pointerup", (e) => {
    if (drag?.moved) viewport.releasePointerCapture(e.pointerId);
    drag = null;
    viewport.classList.remove("grabbing");
  });
  viewport.addEventListener("click", (e) => { if (!e.target.closest(".node")) shut(true); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") shut(true); });

  return {
    draw,
    fit,
    refit: () => { userMoved = false; fit(); },
    /* 正在做哪一步、后面还剩几步。传 null 就是做完了,轨道收掉——
       但队伍还没放完的话得等它放完,卡还在落,轨道先撤是空一块。 */
    waiting(info) {
      if (info === null && (playing || queue.length)) { closeTrack = true; return; }
      closeTrack = false;
      pending = info;
      draw(last.canvas);
    },
    /* 卡全落地了再报数。还在落的时候报「已生成 9 个」,画布上只有 4 张。 */
    onIdle(fn) {
      if (!playing && !queue.length) return void fn();
      idleWaiters.push(fn);
    },
  };
}
