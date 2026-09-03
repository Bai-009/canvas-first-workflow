import { fullCard, miniCard } from "./card.mjs";
import { layout, wire, wireLabelAt, TILE } from "./layout.mjs";

const SVG = "http://www.w3.org/2000/svg";

/* 画布这一头只做一件事:把画布数据摆到屏幕上,新长出来的卡带一下动静。
   它不认得任何一种具体节点——那些全在节点表里。 */
export function createCanvasView({ table, world, wires, viewport, insets = () => ({ right: 0, bottom: 0 }) }) {
  const byType = new Map(table.map((d) => [d.type, d]));
  const nodes = new Map();
  let scale = 1, tx = 0, ty = 0, userMoved = false, box = { w: 1, h: 1 };

  const apply = () => (world.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`);

  /* 把整张图放进「还空着的那块」:方案面板占了右边、输入条占了底下,
     镜头就不该把卡片摆到它们底下去。 */
  function fit() {
    const pad = 64;
    const { right, bottom } = insets();
    const w = innerWidth - right - pad * 2;
    const h = innerHeight - bottom - pad * 2;
    scale = Math.min(1, w / box.w, h / box.h);
    tx = pad + (w - box.w * scale) / 2;
    ty = pad + (h - box.h * scale) / 2;
    apply();
  }

  function draw(canvas) {
    const placed = layout(canvas.nodes, canvas.edges);
    const at = new Map(placed.map((p) => [p.node.name, p]));

    for (const [name, el] of nodes) if (!at.has(name)) { el.remove(); nodes.delete(name); }

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
      if (fresh) requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("born")));
    }

    wires.replaceChildren();
    for (const e of canvas.edges) {
      const from = at.get(e.from), to = at.get(e.to);
      if (!from || !to) continue;
      const w = wire(from, to);
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("class", "wire");
      path.setAttribute("d", w.d);
      wires.appendChild(path);
      const head = document.createElementNS(SVG, "path");
      head.setAttribute("class", "arrow");
      head.setAttribute("d", `M ${w.x1 - 9} ${w.y1 - 5} L ${w.x1} ${w.y1} L ${w.x1 - 9} ${w.y1 + 5} Z`);
      wires.appendChild(head);
      if (e.output) {
        const spot = wireLabelAt(w);
        const text = document.createElementNS(SVG, "text");
        text.setAttribute("class", "port-label");
        text.setAttribute("x", spot.x);
        text.setAttribute("y", spot.y - 8);
        text.setAttribute("text-anchor", "middle");
        text.textContent = e.output === "true" ? "True" : "False";
        wires.appendChild(text);
      }
    }

    box = placed.length
      ? { w: Math.max(...placed.map((p) => p.x)) + TILE, h: Math.max(...placed.map((p) => p.y)) + TILE }
      : { w: 1, h: 1 };
    wires.setAttribute("width", box.w);
    wires.setAttribute("height", box.h);
    if (!userMoved) fit();
  }

  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const next = Math.min(1.6, Math.max(0.2, scale * Math.exp(-e.deltaY / 420)));
    tx = e.clientX - (e.clientX - tx) * (next / scale);
    ty = e.clientY - (e.clientY - ty) * (next / scale);
    scale = next;
    userMoved = true;
    apply();
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
    apply();
  });
  viewport.addEventListener("pointerup", (e) => {
    if (drag?.moved) viewport.releasePointerCapture(e.pointerId);
    drag = null;
    viewport.classList.remove("grabbing");
  });
  viewport.addEventListener("click", (e) => {
    if (!e.target.closest(".node")) world.querySelectorAll(".node.open").forEach((n) => n.classList.remove("open"));
  });

  return { draw, fit, refit: () => { userMoved = false; fit(); } };
}
