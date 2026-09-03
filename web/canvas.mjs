import { fullCard, miniCard } from "./card.mjs";
import { layout, wire, wireLabelAt, TILE, PITCH } from "./layout.mjs";

const SVG = "http://www.w3.org/2000/svg";

/* 画布这一头只做一件事:把画布数据摆到屏幕上,新长出来的卡带一下动静。
   它不认得任何一种具体节点——那些全在节点表里。 */
export function createCanvasView({ table, world, wires, viewport, insets = () => ({ right: 0, bottom: 0 }) }) {
  const byType = new Map(table.map((d) => [d.type, d]));
  const nodes = new Map();
  let scale = 1, tx = 0, ty = 0, userMoved = false, box = { w: 1, h: 1 };
  let last = { placed: [], canvas: { nodes: [], edges: [] } };
  /* 已经露过面的卡和线。一步交回好几个节点时,它们一个接一个出场,
     不一次全拍上去——一次拍上去人看不清哪张是哪张。 */
  const seenNodes = new Set();
  const seenEdges = new Set();
  const BEAT = 240;

  /* 等着的时候,进度长在链路自己的轨道上:左边是已经建好的真卡片,
     头上那个点是下一张卡出现的地方,右边几个淡点是还没走到的几步。
     一行字在点底下写当下这一步。除此之外画布上不加别的东西。 */
  const labelEl = document.createElement("div");
  labelEl.className = "track-label";
  labelEl.hidden = true;
  world.appendChild(labelEl);
  let pending = null;

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

  function fit() {
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
    scale = Math.min(RUN_SCALE, w / box.w, 1);
    tx = pad + w / 2 - at.x * scale;
    ty = pad + h / 2 - at.y * scale;
    apply();
  }

  function draw(canvas, { instant = false } = {}) {
    /* 刷新回来的那一下不重演:已经在画布上的东西直接就位。 */
    if (instant) {
      for (const n of canvas.nodes) seenNodes.add(n.name);
      for (const e of canvas.edges) seenEdges.add(`${e.from}>${e.to}>${e.output ?? ""}`);
    }
    const placed = layout(canvas.nodes, canvas.edges);
    const at = new Map(placed.map((p) => [p.node.name, p]));

    for (const [name, el] of nodes) if (!at.has(name)) { el.remove(); nodes.delete(name); }

    let beat = 0;
    for (const p of placed) {
      const def = byType.get(p.node.type);
      if (!def) continue;
      let el = nodes.get(p.node.name);
      const fresh = !el;
      if (fresh) {
        el = document.createElement("div");
        el.className = "node born";
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const open = el.classList.contains("open");
          world.querySelectorAll(".node.open").forEach((n) => n.classList.remove("open"));
          if (!open) el.classList.add("open");
        });
        world.appendChild(el);
        nodes.set(p.node.name, el);
      }
      el.style.setProperty("--c", def.color);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      el.innerHTML = `<div class="card">${miniCard(def, p.node)}${fullCard(def, p.node, canvas.edges)}</div>`;
      if (fresh) {
        const wait = beat++ * BEAT;
        seenNodes.add(p.node.name);
        setTimeout(() => requestAnimationFrame(() => el.classList.remove("born")), wait + 20);
      }
    }

    wires.replaceChildren();
    /* 一条线的三样:出发点上一个小圆点、一段贝塞尔、末端一个描边的箭头。
       箭头停在卡片外一点五像素,不顶着卡沿。 */
    for (const e of canvas.edges) {
      const from = at.get(e.from), to = at.get(e.to);
      if (!from || !to) continue;
      const w = wire(from, to);
      const key = `${e.from}>${e.to}>${e.output ?? ""}`;
      const g = document.createElementNS(SVG, "g");
      g.setAttribute("class", "edge");
      g.appendChild(svg("circle", { class: "port", cx: w.x0, cy: w.y0, r: 3.2 }));
      g.appendChild(svg("path", { class: "wire", d: w.d }));
      g.appendChild(svg("path", {
        class: "tip",
        d: `M${w.x1 - 9},${w.y1 - 6} L${w.x1 - 1.5},${w.y1} L${w.x1 - 9},${w.y1 + 6}`,
      }));
      if (e.output) {
        const spot = wireLabelAt(w);
        const text = svg("text", { class: "port-label", x: spot.x, y: spot.y - 8, "text-anchor": "middle" });
        text.textContent = e.output === "true" ? "True" : "False";
        g.appendChild(text);
      }
      /* 线跟着它接住的那张卡一起出场,不抢在卡片前面。 */
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        g.classList.add("fresh");
        setTimeout(() => g.classList.remove("fresh"), Math.max(0, beat - 1) * BEAT + 60);
      }
      wires.appendChild(g);
    }

    last = { placed, canvas };
    drawPending();

    box = placed.length
      ? { w: Math.max(...placed.map((p) => p.x)) + TILE, h: Math.max(...placed.map((p) => p.y)) + TILE }
      : { w: 1, h: 1 };
    if (pending) {
      const at = head();
      const ahead = Math.max(0, (pending.remaining ?? 1) - 1);
      box = {
        w: Math.max(box.w, at.x + Math.max(1, ahead) * PITCH + 40),
        h: Math.max(box.h, at.y + 80),
      };
    }
    wires.setAttribute("width", box.w);
    wires.setAttribute("height", box.h);
    if (!userMoved) fit();
  }

  /* 下一张卡会落在哪一列,标记就站在哪儿:已经有卡就接在最右边那一列后面,
     一张都还没有就站在原点,镜头会把它放到正中。 */
  /* 下一张卡会落在哪一格,头就在哪儿。已经有卡就接在最右一列后面,
     一张都还没有就在原点——镜头会把它摆到正中。 */
  function head() {
    const { placed } = last;
    if (!placed.length) return { x: 0, y: TILE / 2 };
    const x = Math.max(...placed.map((p) => p.x)) + PITCH;
    const tail = placed.filter((p) => p.x + PITCH >= x);
    return { x, y: tail.reduce((sum, p) => sum + p.y, 0) / (tail.length || 1) + TILE / 2 };
  }

  const svg = (name, attrs) => {
    const el = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  function drawPending() {
    labelEl.hidden = !pending;
    if (!pending) return;
    const at = head();
    const ahead = Math.max(0, (pending.remaining ?? 1) - 1);
    const end = at.x + Math.max(1, ahead) * PITCH;

    /* 已经落定的那几张卡先把线接到头上来。 */
    const busy = new Set(last.canvas.edges.map((e) => e.from));
    for (const p of last.placed) {
      if (busy.has(p.node.name)) continue;
      const x0 = p.x + TILE, y0 = p.y + TILE / 2;
      const dx = Math.max(40, (at.x - 14 - x0) / 2);
      wires.appendChild(svg("path", {
        class: "wire waiting",
        d: `M ${x0} ${y0} C ${x0 + dx} ${y0}, ${at.x - 14 - dx} ${at.y}, ${at.x - 14} ${at.y}`,
      }));
    }
    /* 还没走到的那几步:一条淡线,一步一个点。 */
    if (ahead) {
      wires.appendChild(svg("line", { class: "track", x1: at.x + 14, y1: at.y, x2: end, y2: at.y }));
      for (let i = 1; i <= ahead; i++) {
        wires.appendChild(svg("circle", { class: "track-dot", cx: at.x + i * PITCH, cy: at.y, r: 3 }));
      }
    }
    wires.appendChild(svg("circle", { class: pending.broken ? "track-break" : "track-head", cx: at.x, cy: at.y, r: 7 }));

    labelEl.textContent = pending.title;
    labelEl.style.left = `${at.x}px`;
    labelEl.style.top = `${at.y + 26}px`;
    labelEl.style.transform = `translate(-50%,0) scale(${1 / scale})`;
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
  viewport.addEventListener("click", (e) => {
    if (!e.target.closest(".node")) world.querySelectorAll(".node.open").forEach((n) => n.classList.remove("open"));
  });

  return {
    draw,
    fit,
    refit: () => { userMoved = false; fit(); },
    /* 正在做哪一步、后面还剩几步。传 null 就是做完了,轨道收掉。 */
    waiting(info) {
      pending = info;
      draw(last.canvas);
    },
  };
}
