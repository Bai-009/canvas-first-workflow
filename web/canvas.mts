import type { Canvas, CanvasNode, Edge, NodeDefinition } from '../shared/contracts.mjs';
import type { Edit } from '../shared/workflow.mjs';
import type { CanvasFlows, Flow } from './flow.mjs';
import type { Point, PlacedNode, Wire } from './layout.mjs';
import { errorMessage } from '../shared/errors.mjs';
import { element } from './dom.mjs';
interface ParameterRequest { node: string; key: string; value: unknown }
interface RevisionState { edits: Edit[]; busy: boolean; blockedReason: string }
interface Waiting { title: string; remaining?: number; broken?: boolean; note?: string }
interface BreakHandlers { rerun?: () => void; plan?: () => void }
interface Camera { tx: number; ty: number; scale: number; userMoved: boolean }
interface CanvasViewOptions {
  table: NodeDefinition[];
  world: HTMLElement;
  wires: SVGSVGElement;
  viewport: HTMLElement;
  stage: HTMLElement;
  picker: HTMLElement;
  onFill?: (request: ParameterRequest) => void | Promise<unknown>;
  onRevise?: (request: { node: CanvasNode; text: string }) => void | Promise<unknown>;
  onStopRevision?: () => void | Promise<unknown>;
  onZoom?: (scale: number) => void;
  nodeDraft?: (node: CanvasNode) => string;
  onNodeDraft?: (node: CanvasNode, text: string) => void;
  insets?: () => { left?: number; right?: number; bottom?: number };
}
interface EdgeElements { g: SVGGElement; port: SVGCircleElement; path: SVGPathElement; tip: SVGPathElement; text: SVGTextElement }
import { fullCard, miniCard } from "./card.mjs";
import { panel } from "./picker.mjs";
import { layout, wire, wireLabelAt, wave, TILE, PITCH } from "./layout.mjs";
import { edgeKey, flows, label } from "./flow.mjs";
import { createNodeConversation, editPresentation } from "./node-conversation.mjs";

const SVG = "http://www.w3.org/2000/svg";
const svg = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>) => {
  const el = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* 展开之后的卡有多宽。高度是内容自己写出来的,量出来才知道。 */
const OPEN_W = 540;

/* 一张卡出场分三拍:线先走到位,卡片落在线的尽头,然后停一口气再放下一张。
   三拍加起来一秒三,一步交回两个节点也是一张一张来。
   同时落地的两张卡分不出先后,人看不清哪张接哪张。 */
const LEAD = 460, LAND = 560, REST = 420;

/* 点开一张卡:镜头先过去,到位了再展开。
   先展开再挪镜头,展开的那一下人在看别处。 */
const FOCUS_LEAD = 300;

/* 还没走到的那几步:一个点一步,这是它们之间的距离。
   不用 PITCH——PITCH 是真卡片的列距,拿它排还没发生的步等于宣称它们会落在那儿,
   而落在哪要等卡片下来才知道。
   这条轨道不进镜头的取景框(见 resize):它有多长都不该把已经建好的那几张卡挤小。
   于是它可以一直往右伸,伸出画面之外——末端不是被切断,是淡掉。 */
const STEP_GAP = 176;
/* 头是个会呼吸的点,半径在 HEAD_R 和 HEAD_MAX 之间来回(headPulse)。线接到最小的那个
   半径上:大的时候线被压在点底下一点,小的时候正好碰上,任何一帧都不会露出缝。 */
const HEAD_R = 5;
const HEAD_MAX = 7;
const TRACK_TAIL = 620;

/* 画布这一头只做一件事:把画布数据摆到屏幕上,新长出来的卡带一下动静。
   它不认得任何一种具体节点——那些全在节点表里。 */
export function createCanvasView({ table, world, wires, viewport, stage, picker,
  onFill, onRevise, onStopRevision, onZoom = () => {}, nodeDraft = () => "", onNodeDraft = () => {}, insets = () => ({ right: 0, bottom: 0 }) }: CanvasViewOptions) {
  const byType = new Map(table.map((d) => [d.type, d]));
  const nodes = new Map<string, HTMLDivElement>();
  const edges = new Map<string, EdgeElements>();
  const conversations = new Map<string, ReturnType<typeof createNodeConversation<CanvasNode>>>();
  /* 遮罩直接改变内容透明度；只在还有内容可滚动的边缘出现。 */
  const updateScrollFade = (body: HTMLElement) => {
    const above = Math.max(0, body.scrollTop);
    const below = Math.max(0, body.scrollHeight - body.clientHeight - above);
    body.style.setProperty("--node-fade-top", `${Math.min(32, above)}px`);
    body.style.setProperty("--node-fade-bottom", `${below < 1 ? 0 : Math.min(32, below)}px`);
  };
  const fadeObserver = new ResizeObserver((entries) => {
    for (const { target } of entries) if (target instanceof HTMLElement) updateScrollFade(target);
  });
  const watchedFades = new WeakSet<HTMLElement>();
  const watchScrollFade = (body: HTMLElement | null) => {
    if (!body) return;
    if (!watchedFades.has(body)) {
      body.addEventListener("scroll", () => updateScrollFade(body), { passive: true });
      watchedFades.add(body);
    }
    fadeObserver.observe(body);
    updateScrollFade(body);
  };
  let revisionState: RevisionState = { edits: [], busy: false, blockedReason: "" };
  /* box 是整幅东西的范围:已经落地的卡,加上那截还没走到的轨道。
     SVG 照它画,镜头也照它摆——人看的是整幅画,不是其中某一个点。 */
  let scale = 1, tx = 0, ty = 0, userMoved = false, box = { w: 1, h: 1 };
  /* 摆过一次镜头没有。第一次不能有过渡:画布空着的时候根本没摆过镜头,
     世界的 transform 是空的,一上过渡就成了「从左上角 1:1 的位置飘过来」——
     而那个位置从来没有存在过。 */
  let framed = false;
  let last: { placed: PlacedNode<CanvasNode>[]; canvas: Canvas; flows?: CanvasFlows } = { placed: [], canvas: { nodes: [], edges: [], version: 0 } };
  /* 已经露过面的卡和已经走完的线。排队的那几张还挂在 queue 上,画布上是空位。 */
  const shown = new Set<string>();
  const drawn = new Set<string>();
  const queue: string[] = [];
  let playing = false;
  const idleWaiters: (() => void)[] = [];

  /* 线归一层,等待的轨道归另一层。轨道每次重画,线是留着的——
     线要自己走出来,重画一次就等于从头走一次。 */
  const gWires = svg("g", {});
  const gTrack = svg("g", {});
  /* 轨道的末端要淡掉,不能是一刀切。渐变按世界坐标铺,每次重画时定两头。 */
  const fade = svg("linearGradient", { id: "trackFade", gradientUnits: "userSpaceOnUse" });
  fade.append(
    svg("stop", { offset: "0", "stop-color": "#c3c9d3", "stop-opacity": "1" }),
    svg("stop", { offset: "0.42", "stop-color": "#c9cfd8", "stop-opacity": "0.7" }),
    svg("stop", { offset: "1", "stop-color": "#ced4dc", "stop-opacity": "0" }),
  );
  const defs = svg("defs", {});
  defs.appendChild(fade);
  wires.append(defs, gWires, gTrack);

  /* 等着的时候,进度长在链路自己的轨道上:左边是已经建好的真卡片,
     头上那个点是下一张卡出现的地方,右边几个淡点是还没走到的几步。
     一行字在点底下写当下这一步。除此之外画布上不加别的东西。 */
  const labelEl = document.createElement("div");
  labelEl.className = "track-label";
  labelEl.hidden = true;
  world.appendChild(labelEl);

  /* 停住的那一步就长在它本该出现的那一格上——画布上的东西都是卡片,停也是。
     摆在右上角等于让人在两个地方之间来回找:出事的地方在这儿,能做的事在那儿。 */
  const stopEl = document.createElement("div");
  stopEl.className = "stop";
  stopEl.hidden = true;
  stopEl.innerHTML =
    '<div class="stop-top"><i class="stop-mark"></i><h3 class="stop-name"></h3></div>' +
    '<p class="stop-why"></p>' +
    '<div class="stop-acts">' +
    '<button class="stop-plan" type="button">改方案</button><button class="stop-again" type="button">重走</button></div>';
  world.appendChild(stopEl);
  let onBreak: BreakHandlers = {};
  /* 收着的时候只有「重走」;点开看全了才给另外两个选择——改这一步、改方案。
     点卡身是点开,不是别的:它是一张卡,按卡的规矩办。 */
  const act = (sel: string, fn: () => void) => element(stopEl, sel).addEventListener("click", (e) => { e.stopPropagation(); fn(); });
  act(".stop-again", () => onBreak.rerun?.());
  act(".stop-plan", () => { shutBreak(); onBreak.plan?.(); });
  stopEl.addEventListener("click", (e) => { e.stopPropagation(); openBreak(); });
  let pending: Waiting | null = null, closeTrack = false;

  /* 自己挪的镜头是有过渡的:一跳一跳的镜头看不出东西是从哪儿长出来的。
     用户在拖、在滚的时候不能有过渡,那会变成拖不动。 */
  const apply = (glide = true) => {
    world.classList.toggle("gliding", glide);
    world.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
    onZoom(scale);
  };

  /* 正在长的时候镜头跟着头走,卡片保持看得清的大小;跑完了再退回来看全景。
     两种都躲开右边的需求框和底下的输入条。 */
  const RUN_SCALE = 0.78;

  function room() {
    const pad = 64;
    const { right = 0, bottom = 0, left = 0 } = insets();
    return { pad, left, w: Math.max(160, innerWidth - left - right - pad * 2), h: innerHeight - bottom - pad * 2 };
  }

  /* 画布本来就比窗口大。整条链塞不下的时候不再往小里缩——缩到看不清字,
     等于把画布变成一张缩略图。缩到底就停,右端对齐:刚长出来的那几张在眼前,
     往左拖能看回去。

     0.62 是列距 436 那会儿的数:那时十来个节点铺出去四千多像素宽,再缩就
     只剩缩略图了。列距收到 300 之后同样一条链只有两千八,0.45 上卡片还有
     79 像素、字看得清,而整条链一屏进得来。看全比看大要紧。 */
  const MIN_SCALE = 0.45;

  /* 跑着的时候,头站在画面横向的这个位置:左边是已经建好的,右边留一截给轨道。
     早先试过让头落在正中,右边空一大片——那是因为当时轨道还没画出来。 */
  const AHEAD = 0.64;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  /* 镜头两种状态,分得很开。

     跑着的时候不缩:卡片保持看得清的大小,镜头跟着下一格的落点走,越长越往右
     推,左边建好的拖回去还能看。整幅还塞得下的时候照样摆正中——不然一两张卡
     的时候会被推到边上。

     跑完了(pending 清掉)退回全景:框住整幅,缩放上限放开到 1,一路滑过去。
     有一张卡展开着的时候镜头归它,别的再动也不许抢。 */
  function fit() {
    if (opened) return;
    const { pad, left, w, h } = room();

    if (pending && !pending.broken) {
      scale = RUN_SCALE;
      const at = head();
      const wide = box.w * scale, tall = box.h * scale;
      tx = left + (wide > w ? Math.min(pad, pad + w * AHEAD - at.x * scale) : pad + (w - wide) / 2);
      ty = tall > h ? clamp(pad + h / 2 - at.y * scale, pad + h - tall, pad) : pad + (h - tall) / 2;
      apply(framed);
      framed = box.w > 1;
      return;
    }

    scale = Math.max(MIN_SCALE, Math.min(1, w / box.w, h / box.h));
    const wide = box.w * scale, tall = box.h * scale;
    /* 全景也放不下就右端对齐:最后那几张在眼前,往左拖能看回去。 */
    tx = left + (wide > w ? pad + w - wide : pad + (w - wide) / 2);
    ty = tall > h ? pad : pad + (h - tall) / 2;
    apply(framed);
    framed = box.w > 1;
  }

  const visible = () => last.placed.filter((p) => shown.has(p.node.name));

  function draw(canvas: Canvas, { instant = false } = {}) {
    /* 刷新回来的那一下不重演:已经在画布上的东西直接就位。 */
    if (instant) {
      for (const n of canvas.nodes) shown.add(n.name);
      for (const e of canvas.edges) drawn.add(key(e));
    }
    const { placed } = layout(canvas.nodes, canvas.edges);
    const at = new Map(placed.map((p) => [p.node.name, p]));
    /* 线上流的是什么,整张一起推:一根线上的东西取决于它上游整条路。 */
    const f = flows(table, canvas);
    last = { placed, canvas, flows: f };

    for (const [name, el] of nodes) if (!at.has(name)) {
      fadeObserver.unobserve(element(el, ".card-content"));
      el.remove(); nodes.delete(name); shown.delete(name);
    }

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
        element(el, ".card").appendChild(document.createElement("div")).className = "card-mini";
        const detail = element(el, ".card").appendChild(document.createElement("div"));
        detail.className = "card-detail";
        detail.inert = true;
        detail.appendChild(document.createElement("div")).className = "card-header";
        const body = detail.appendChild(document.createElement("div"));
        body.className = "card-content";
        body.appendChild(document.createElement("div")).className = "card-node-content";
        // 外壳收放时，滚动范围逐帧变化；等高度稳定后再显示滑块。
        // 跟随真实 transition 生命周期，快速反向收放或减少动态效果时也不会卡住。
        const card = element(el, ".card");
        const scrollChrome = (event: TransitionEvent) => {
          if (event.target === card && event.propertyName === "height") {
            card.classList.toggle("resizing", event.type === "transitionrun");
          }
        };
        card.addEventListener("transitionrun", scrollChrome);
        card.addEventListener("transitionend", scrollChrome);
        card.addEventListener("transitioncancel", scrollChrome);
        watchScrollFade(body);
        const conversation = conversations.get(p.node.name) ?? createNodeConversation({
          initialDraft: nodeDraft(p.node), onDraftChange: (value) => onNodeDraft(p.node, value),
          node: p.node, ...(onRevise ? { onSend: onRevise } : {}), ...(onStopRevision ? { onStop: onStopRevision } : {}),
          onResize: () => { if (el && opened === p.node.name) remeasure(el); },
        });
        conversations.set(p.node.name, conversation);
        body.appendChild(conversation.resultsEl);
        detail.appendChild(conversation.el);
        el.addEventListener("click", (e) => {
          if (!(e.target instanceof Element) || !el) return;
          e.stopPropagation();
          if (e.target.closest<HTMLElement>(".node-conversation")) return;
          if (e.target.closest<HTMLElement>("details")) {
            const cell = e.target.closest<HTMLElement>("[data-key]");
            if (!cell) return;
          }
          /* 卡上那一格是入口,不是卡身的一部分:点它是「定这一格」,
             不该顺手把卡收回去。 */
          const cell = e.target.closest<HTMLElement>("[data-key]");
          const current = last.canvas.nodes.find((n) => n.name === p.node.name);
          if (cell && el.classList.contains("open")) return openPicker(el, current, cell);
          toggle(p.node.name);
        });
        world.appendChild(el);
        nodes.set(p.node.name, el);
        if (!ready) queue.push(p.node.name);
      }
      el.style.setProperty("--node-color", def.color);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      paintNode(el, def, p.node);
      /* 换了内容的那张卡如果正开着,高度得跟着内容重新量。 */
      if (opened === p.node.name) remeasure(el);
    }

    for (const [k, e] of edges) if (!canvas.edges.some((x) => key(x) === k)) { e.g.remove(); edges.delete(k); }
    for (const e of canvas.edges) {
      const from = at.get(e.from), to = at.get(e.to);
      if (from && to) paint(e, wire(from, to), f.edges.get(key(e)));
    }

    track();
    resize();
    if (!userMoved) fit();
    /* 排队放卡要等这一遍画完:线得先在画布上,才走得起来。 */
    pump();
  }

  function paintNode(el: HTMLElement, def: NodeDefinition, node: CanvasNode) {
    const content = element(el, ".card-node-content");
    const expanded = new Set([...content.querySelectorAll<HTMLDetailsElement>("details[open][data-disclosure]")].map((detail) => detail.dataset.disclosure));
    content.innerHTML = `${miniCard(def, node)}${fullCard(def, node, last.canvas.edges, last.flows)}`;
    element(el, ".card-mini").replaceChildren(element(content, ".mini"));
    element(el, ".card-header").replaceChildren(element(content, ".full-top"));
    for (const detail of content.querySelectorAll<HTMLDetailsElement>("details[data-disclosure]")) {
      detail.open = expanded.has(detail.dataset.disclosure);
      detail.addEventListener("toggle", () => { if (opened === node.name) remeasure(el); });
    }
    for (const cell of el.querySelectorAll<HTMLButtonElement>("[data-key]")) {
      cell.disabled = Boolean(revisionState.busy);
      if (cell.disabled) cell.title = "等待当前工作流操作完成后配置";
    }
    refreshConversation(el, node);
    updateScrollFade(element(el, ".card-content"));
  }

  function refreshConversation(el: HTMLElement, node: CanvasNode) {
    const edits = revisionState.edits.filter((edit) => edit.target?.node === node.name && edit.target?.step === node.step);
    conversations.get(node.name)?.update({ ...revisionState, node, edits });
    updateScrollFade(element(el, ".card-content"));
    const badge = editPresentation(edits.at(-1)).badge;
    if (badge) {
      const evidence = element(el, ".mini-evi");
      evidence.textContent = badge;
      evidence.classList.add("revision-evi");
    }
  }

  /* ── 线 ───────────────────────────────────────────────
     一条线的四样:出发点上一个小圆点、一段贝塞尔、末端一个描边的箭头,
     和线刚离开上游那一段上的一行字——流的是什么(「Text · 按文件」);分岔的线前面
     再加出口名(「True · Text · 按文件」)。箭头停在卡片外一点五像素,不顶着卡沿。 */
  const key = edgeKey;
  const wording = (e: Edge, flow?: Flow) => [e.output && (e.output === "true" ? "True" : "False"), label(flow)].filter(Boolean).join(" · ");

  function paint(e: Edge, w: Wire, flow?: Flow) {
    const k = key(e);
    let it = edges.get(k);
    if (!it) {
      const g = svg("g", { class: "edge" });
      const port = svg("circle", { class: "port", r: 3.2 });
      const path = svg("path", { class: "wire" });
      const tip = svg("path", { class: "tip" });
      const text = svg("text", { class: "wire-label", "text-anchor": "middle" });
      g.append(port, path, tip, text);
      gWires.appendChild(g);
      it = { g, port, path, tip, text };
      edges.set(k, it);
    }
    it.path.setAttribute("d", w.d);
    it.port.setAttribute("cx", String(w.x0));
    it.port.setAttribute("cy", String(w.y0));
    it.tip.setAttribute("d", `M${w.x1 - 9},${w.y1 - 6} L${w.x1 - 1.5},${w.y1} L${w.x1 - 9},${w.y1 + 6}`);
    it.text.textContent = wording(e, flow);
    const spot = wireLabelAt(w);
    it.text.setAttribute("x", String(spot.x));
    it.text.setAttribute("y", String(spot.y - 8));
    /* 还没轮到的线是收着的:整条按自己的长度藏进虚线的空档里。 */
    const len = it.path.getTotalLength();
    it.path.style.strokeDasharray = String(len);
    it.path.style.strokeDashoffset = String(drawn.has(k) ? 0 : len);
    it.g.classList.toggle("held", !drawn.has(k));
  }

  /* 线自己走一遍。走的是这一格的入线,走完卡片才落下来。 */
  function light(k: string) {
    const it = edges.get(k);
    drawn.add(k);
    if (!it) return;
    /* 先把「收着」这一帧钉住再改:同一拍里设初值又设终值,浏览器看不见起点,
       线会直接整条出现。读一下几何就是钉住的办法。 */
    void it.path.getBoundingClientRect();
    it.path.style.transition = `stroke-dashoffset ${LEAD}ms cubic-bezier(.4,0,.2,1)`;
    it.path.style.strokeDashoffset = "0";
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
      if (name === undefined) break;
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

  /* 两个范围,分开算:
     box 是镜头的取景框——已经建好的那几张卡,加上下一格的落点。轨道不算在里头,
     它有多长都不该把这几张卡挤小。
     SVG 得比取景框大,不然轨道画到一半就没画布了。 */
  function resize() {
    const seen = visible();
    box = seen.length
      ? { w: Math.max(...seen.map((p) => p.x)) + TILE, h: Math.max(...seen.map((p) => p.y)) + TILE }
      : { w: 1, h: 1 };
    let paper = box;
    if (pending) {
      const at = head();
      const ahead = Math.max(0, (pending.remaining ?? 1) - 1);
      box = { w: Math.max(box.w, at.x + (pending.broken ? 320 : 40)), h: Math.max(box.h, at.y + 120) };
      paper = { w: Math.max(box.w, at.x + ahead * STEP_GAP + TRACK_TAIL), h: box.h };
    }
    wires.setAttribute("width", String(paper.w));
    wires.setAttribute("height", String(paper.h));
  }

  /* 下一张卡会落在哪一格,头就在哪儿。已经落地的卡里最右一列往后接一格,
     一张都还没落就在原点——镜头会把它摆到正中。

     base 是这一格去掉起伏之后的高度。往后每一格的高度都从 base 加上那一列
     自己的起伏算出来,和真卡片用的是同一个函数:还没走到的那几步,
     踩的是真链路接着走的那几个点。 */
  function head() {
    const seen = visible();
    if (!seen.length) return { x: 0, y: TILE / 2 };
    const colOf = (p: Point) => Math.round(p.x / PITCH);
    const col = Math.max(...seen.map(colOf)) + 1;
    const tail = seen.filter((p) => colOf(p) === col - 1);
    const base = tail.reduce((sum, p) => sum + p.y - wave(colOf(p)), 0) / (tail.length || 1) + TILE / 2;
    return { x: col * PITCH, y: base + wave(col) };
  }

  function track() {
    gTrack.replaceChildren();
    const broken = Boolean(pending?.broken);
    labelEl.hidden = !pending || broken;
    stopEl.hidden = !broken;
    if (!pending) return;
    const at = head();
    const ahead = Math.max(0, (pending.remaining ?? 1) - 1);

    /* 轨道是直的。起伏是真链路的事——卡片落在哪一行要等它落下来才知道,
       branch 一分,后面几步的位置全变。拿起伏去画还没发生的几步是在猜,
       猜出来的那道弯从一张卡都没有的时候就开始扭,难看在这里。 */
    const busy = new Set(last.canvas.edges.filter((e) => shown.has(e.to)).map((e) => e.from));
    for (const p of visible()) {
      if (busy.has(p.node.name)) continue;
      gTrack.appendChild(svg("line", {
        class: "wire waiting",
        x1: p.x + TILE, y1: p.y + TILE / 2, x2: at.x - HEAD_R, y2: at.y,
      }));
    }
    /* 还没走到的那几步:一条往右伸出去的线,一步一个点。线比点走得远得多,
       而且是淡出去的——链路到这儿并没有结束,只是还没长出来。 */
    if (ahead) {
      const from = at.x + HEAD_R, to = at.x + ahead * STEP_GAP + TRACK_TAIL;
      fade.setAttribute("x1", String(from));
      fade.setAttribute("x2", String(to));
      fade.setAttribute("y1", String(at.y));
      fade.setAttribute("y2", String(at.y));
      gTrack.appendChild(svg("line", { class: "track", x1: from, y1: at.y, x2: to, y2: at.y }));
      for (let i = 1; i <= ahead; i++) {
        const x = at.x + i * STEP_GAP;
        gTrack.appendChild(svg("circle", {
          class: "track-dot", cx: x, cy: at.y, r: 3.4,
          opacity: (1 - (i - 1) / Math.max(ahead, 1) * 0.72).toFixed(2),
        }));
      }
    }
    /* 断了就把那一格摆成一张卡:哪一步、为什么、以及能做什么,都在同一个地方。
       没断的时候还是一个脉动的点加一行字。 */
    if (broken) {
      stopEl.style.left = `${at.x}px`;
      stopEl.style.top = `${at.y}px`;
      element(stopEl, ".stop-name").textContent = pending.title;
      element(stopEl, ".stop-why").textContent = pending.note ?? "";
      element(stopEl, ".stop-why").hidden = !pending.note;
      return;
    }
    gTrack.appendChild(svg("circle", { class: "track-head", cx: at.x, cy: at.y, r: HEAD_MAX }));
    labelEl.textContent = pending.title;
    labelEl.style.left = `${at.x}px`;
    labelEl.style.top = `${at.y + 26}px`;
    labelEl.style.transform = `translate(-50%,0) scale(${1 / scale})`;
  }

  /* ── 那一格怎么定 ─────────────────────────────────────
     空位不是填空题,是入口。点它,画布往后退,选择器上台——跟需求框飞回中央
     是同一个动作,所以用的是同一套后退。

     V6 的规矩:上台的东西要从它来的地方长出来。把变形原点挪到你点的那一格上,
     面板就是从那个洞里撑开的,不是凭空淡进来的。 */
  let filling: { el: HTMLElement; node: CanvasNode; key: string } | null = null;

  function openPicker(el: HTMLElement, node: CanvasNode | undefined, cell: HTMLElement) {
    if (!node || revisionState.busy) return;
    const def = byType.get(node.type);
    const slot = def?.slots.find((s) => s.key === cell.dataset.key);
    if (!def || !slot || !picker) return;
    filling = { el, node, key: slot.key };
    const box = element(picker, ".panel");
    box.innerHTML = panel(def, slot, node);
    picker.hidden = false;
    /* 落在这张卡的中轴上,不是屏幕的中轴。
       卡的位置不去量:点开一张卡的时候镜头正把它送往取景框正中(见 aim),
       这会儿还在滑,量到的是半路上的那一帧,钉下去就是歪的。
       取景框正中是个定数,直接用它——镜头到位之后卡就在那儿。
       出不去屏幕:四边各留 20。 */
    const M = 20;
    const { pad, left, w: roomW, h: roomH } = room();
    const w = box.offsetWidth, h = box.offsetHeight;
    const grip = (v: number, hi: number) => Math.min(Math.max(v, M), Math.max(M, hi));
    box.style.left = `${grip(left + pad + roomW / 2 - w / 2, innerWidth - w - M)}px`;
    box.style.top = `${grip(pad + roomH / 2 - h / 2, innerHeight - h - M)}px`;
    /* 原点要在面板自己的坐标里量,所以得等它落好位置之后再量。 */
    const c = cell.getBoundingClientRect(), p = box.getBoundingClientRect();
    box.style.transformOrigin = `${c.left + c.width / 2 - p.left}px ${c.top + c.height / 2 - p.top}px`;
    picker.classList.add("on");
    stage?.classList.add("swap", "recede");
    box.focus();
  }

  function shutPicker() {
    if (!filling) return;
    filling = null;
    picker.classList.remove("on");
    stage?.classList.remove("recede");
    /* 等整段走完再收摊。早一步摘掉 swap,画布最后那一段就没了过渡——
       它会把剩下的路一帧跳完,看着就是「退到快好了忽然一顿」。
       620 是画布自己那条过渡的时长,多给 40ms 的余量。 */
    setTimeout(() => {
      if (filling) return;
      picker.hidden = true;
      stage?.classList.remove("swap");
    }, 660);
  }

  /* 定了:这一格从「待定」变成一个值,卡当场重画,小卡上的「待定 N 项」跟着少一项。 */
  let savingParameter = false;
  async function fill(value: unknown) {
    if (savingParameter) return;
    if (!filling) return;
    if (value === "") return shutPicker();
    const { el, key: slotKey, node: targetNode } = filling;
    const node = last.canvas.nodes.find((n) => n.name === targetNode.name);
    if (!node || revisionState.busy) return shutPicker();
    if (onFill) {
      savingParameter = true;
      const panel = element(picker, ".panel");
      try { await onFill({ node: node.name, key: slotKey, value }); shutPicker(); }
      catch (error) {
        let message = panel.querySelector(".panel-save-error");
        if (!message) { message = document.createElement("p"); message.className = "panel-save-error"; message.setAttribute("role", "alert"); panel.append(message); }
        message.textContent = errorMessage(error);
      } finally { savingParameter = false; }
      return;
    }
    node.params = { ...node.params, [slotKey]: value };
    node.blanks = (node.blanks ?? []).filter((b) => b !== slotKey);
    shutPicker();
    const def = byType.get(node.type);
    /* 定的那一格可能改了这个节点往下送什么(写代码的 Output Type):线上的字跟着重印。 */
    last.flows = flows(table, last.canvas);
    if (def) paintNode(el, def, node);
    for (const e of last.canvas.edges) edges.get(key(e))?.text.replaceChildren(wording(e, last.flows.edges.get(key(e))));
    if (opened === node.name) remeasure(el);
  }

  if (picker) {
    picker.addEventListener("click", (e) => {
      if (!(e.target instanceof Element)) return;
      if (e.target === picker) return shutPicker();
      if (e.target.closest<HTMLElement>(".panel-close")) return shutPicker();
      const act = e.target.closest<HTMLElement>("[data-do]")?.dataset.do;
      if (act === "ok") return fill(picker.querySelector<HTMLInputElement | HTMLTextAreaElement>(".panel-field")?.value.trim() ?? "");
      /* 传文件和新建连接这两条,POC 到不了真的那一步:传文件当场落一个值,
         新建连接只能关掉——装成建好了才是骗人。 */
      if (act === "upload") return fill("刚上传的文件");
      if (act === "new") return shutPicker();
      const row = e.target.closest<HTMLElement>(".src-row[data-v]");
      if (row) return fill(row.dataset.v);
    });
    picker.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.matches("input.panel-field")) fill(e.target.value.trim());
    });
    addEventListener("keydown", (e) => { if (e.key === "Escape") shutPicker(); });
  }

  /* ── 点开一张卡 ───────────────────────────────────────
     展开是「聚焦」的结果:镜头先带过去,别的卡退到背景里,这一张才撑开。
     卡片钉住上沿往下长,所以镜头瞄的是「上沿 + 展开高度的一半」。 */
  let opened: string | null = null, home: Camera | null = null, turn = 0;

  function measure(el: HTMLElement) {
    /* 用真实取景框留给卡的高度，给固定输入区留位置；不靠把整张卡缩小来塞进屏幕。 */
    el.style.setProperty("--node-room-height", `${Math.max(280, room().h + 32)}px`);
    /* 在不可见副本上量终点。对正在运动的卡禁用 transition 会直接取消展开，
       也不能为测量切换真实输入框的显示状态，否则会丢失焦点和中文组词。 */
    const probe = el.cloneNode(true);
    if (!(probe instanceof HTMLElement)) throw new Error("节点卡副本不是 HTML 元素");
    probe.className = "node measuring open";
    probe.inert = true;
    probe.setAttribute("aria-hidden", "true");
    probe.style.visibility = "hidden";
    for (const child of probe.querySelectorAll("[id]")) child.removeAttribute("id");
    const card = element(probe, ".card");
    card.style.height = "auto";
    world.appendChild(probe);
    try { return card.offsetHeight; }
    finally { probe.remove(); }
  }

  const box0 = (el: HTMLElement, h: number) => {
    element(el, ".card").style.height = `${h}px`;
    element(el, ".card").style.transform = `translate(-50%, calc(-50% + ${((h - TILE) / 2).toFixed(1)}px))`;
  };

  /* 外壳变高或变矮时镜头不动:正在读的那张卡就该待在原地,人打一行字画布跟着晃是在抢镜。
     只有它顶出画面才追一下——正在写的那句话不能跑到看不见的地方去。
     追的时候照人自己定的倍数来,不重设缩放。 */
  const remeasure = (el: HTMLElement) => {
    const h = measure(el);
    if (element(el, ".card").style.height === `${h}px`) return;
    box0(el, h); el.classList.add("open");
    const p = last.placed.find((placed) => nodes.get(placed.node.name) === el);
    if (!p) return;
    const { pad, h: roomHeight } = room();
    const outOfView = ty + p.y * scale < pad - 32 || ty + (p.y + h) * scale > pad + roomHeight + 32;
    if (outOfView) aim(p, h, userMoved);
  };

  /* keepScale:人自己缩放过之后,重新取景照人定的倍数来,只把卡片挪回阅读中心。 */
  function aim(p: Point, h: number, keepScale = false) {
    const { pad, left, w, h: room_h } = room();
    const s = keepScale ? scale : Math.min(1, (w - 32) / OPEN_W, (room_h + 32) / h);
    scale = s;
    tx = left + pad + w / 2 - (p.x + TILE / 2) * s;
    ty = pad + room_h / 2 - (p.y + h / 2) * s;
    apply();
  }

  async function toggle(name: string) {
    if (!shown.has(name)) return;
    if (opened === name) return void shut(true);
    if (breakOpen) shutBreak(false);
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
    element(el, ".card-detail").inert = false;
  }

  /* 断口卡点开:跟点开一张卡是同一个手势——镜头带过去,别的退到背景,这一张撑开。
     撑开之后原因不再截,三个选择都在。 */
  let breakOpen = false;

  function openBreak() {
    if (breakOpen || !pending?.broken) return;
    if (opened) shut(false);
    if (!home) home = { tx, ty, scale, userMoved };
    breakOpen = true;
    stopEl.classList.add("open");
    for (const e of nodes.values()) e.classList.add("dim");
    const at = head();
    const h = stopEl.offsetHeight, w = stopEl.offsetWidth;
    aim({ x: at.x + w / 2 - TILE / 2, y: at.y - h / 2 }, h);
  }

  function shutBreak(back = true) {
    if (!breakOpen) return false;
    breakOpen = false;
    stopEl.classList.remove("open");
    if (!opened) for (const e of nodes.values()) e.classList.remove("dim");
    if (back && home && !opened) { ({ tx, ty, scale, userMoved } = home); apply(); home = null; }
    return true;
  }

  function shut(back = true) {
    if (breakOpen) return shutBreak(back);
    if (!opened) return false;
    const el = nodes.get(opened);
    ++turn;
    opened = null;
    if (el) {
      el.classList.remove("open");
      element(el, ".card-detail").inert = true;
      element(el, ".card").style.height = "";
      element(el, ".card").style.transform = "";
    }
    for (const e of nodes.values()) e.classList.remove("dim");
    if (back && home) { ({ tx, ty, scale, userMoved } = home); apply(); home = null; }
    return true;
  }

  function zoomTo(value: number, x?: number, y?: number, glide = true) {
    const next = clamp(value, 0.2, 1.6);
    const r = room();
    x ??= r.left + r.pad + r.w / 2;
    y ??= r.pad + r.h / 2;
    tx = x - (x - tx) * (next / scale);
    ty = y - (y - ty) * (next / scale);
    scale = next;
    userMoved = true;
    apply(glide);
  }

  function fitAll() {
    ++turn; // 也取消镜头先行阶段尚未展开的节点。
    shut(false);
    home = null;
    const { pad, left, w, h } = room();
    scale = Math.min(1, w / box.w, Math.max(1, h) / box.h);
    tx = left + pad + (w - box.w * scale) / 2;
    ty = pad + (h - box.h * scale) / 2;
    userMoved = true;
    apply();
  }

  viewport.addEventListener("wheel", (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest<HTMLElement>(".node.open .card-content")) return;
    e.preventDefault();
    zoomTo(scale * Math.exp(-e.deltaY / 420), e.clientX, e.clientY, false);
  }, { passive: false });

  /* 按下先不抢指针,挪过 4 像素才算拖,否则那一下是点在卡片上。 */
  let drag: { x: number; y: number; from: [number, number]; moved: boolean } | null = null;
  viewport.addEventListener("pointerdown", (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest<HTMLElement>(".node")) return;
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
  /* 盖在画布上的东西,点它外面的任何一处就收回去。这条挂在 document 上,不挂在
     viewport 上——挂 viewport 只管得着画布那一块,点顶栏、点输入框都收不掉,
     同样是「外面」,结果却不一样。
     谁在上头谁先收:选择器盖在展开的卡上,点画布的那一下只收选择器。 */
  addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    if (filling || e.target.closest<HTMLElement>(".picker, .canvas-controls")) return;
    if (!e.target.closest<HTMLElement>(".node") && !e.target.closest<HTMLElement>(".stop")) shut(true);
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape") shut(true); });

  return {
    draw,
    revisions(info: Partial<RevisionState>) {
      revisionState = { ...revisionState, ...info };
      if (revisionState.busy) shutPicker();
      for (const node of last.canvas.nodes) {
        const el = nodes.get(node.name);
        if (!el) continue;
        refreshConversation(el, node);
        for (const cell of el.querySelectorAll<HTMLButtonElement>("[data-key]")) {
          cell.disabled = Boolean(revisionState.busy);
          cell.title = cell.disabled ? "等待当前工作流操作完成后配置" : "";
        }
        if (opened === node.name) remeasure(el);
      }
    },
    fit,
    zoomBy: (direction: number) => zoomTo(Math.round((scale + direction * 0.1) * 100) / 100),
    resetZoom: () => zoomTo(1),
    fitAll,
    refit: () => { userMoved = false; if (opened) { const el = nodes.get(opened); const p = last.placed.find((p) => p.node.name === opened); if (el && p) aim(p, measure(el)); } else fit(); },
    /* 正在做哪一步、后面还剩几步。传 null 就是做完了,轨道收掉——
       但队伍还没放完的话得等它放完,卡还在落,轨道先撤是空一块。 */
    waiting(info: Waiting | null) {
      if (info === null && (playing || queue.length)) { closeTrack = true; return; }
      closeTrack = false;
      if (!info?.broken) shutBreak(false);
      pending = info;
      draw(last.canvas);
    },
    /* 断口那张卡上能做的两件事:按「重走」,或者点一下卡身去跟这一步说话。 */
    onBreak(handlers: BreakHandlers) { onBreak = handlers; },
    /* 卡全落地了再报数。还在落的时候报「已生成 9 个」,画布上只有 4 张。 */
    onIdle(fn: () => void) {
      if (!playing && !queue.length) return void fn();
      idleWaiters.push(fn);
    },
  };
}
