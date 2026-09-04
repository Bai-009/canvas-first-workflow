import { fullCard, miniCard } from "./card.mjs";
import { panel } from "./picker.mjs";
import { layout, wire, wireLabelAt, wave, TILE, PITCH } from "./layout.mjs";

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
  onFill, insets = () => ({ right: 0, bottom: 0 }) }) {
  const byType = new Map(table.map((d) => [d.type, d]));
  const nodes = new Map();
  const edges = new Map();
  /* box 是整幅东西的范围:已经落地的卡,加上那截还没走到的轨道。
     SVG 照它画,镜头也照它摆——人看的是整幅画,不是其中某一个点。 */
  let scale = 1, tx = 0, ty = 0, userMoved = false, box = { w: 1, h: 1 };
  /* 摆过一次镜头没有。第一次不能有过渡:画布空着的时候根本没摆过镜头,
     世界的 transform 是空的,一上过渡就成了「从左上角 1:1 的位置飘过来」——
     而那个位置从来没有存在过。 */
  let framed = false;
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
    '<p class="stop-why"></p><button class="stop-again" type="button">重走</button>';
  world.appendChild(stopEl);
  let onBreak = {};
  stopEl.querySelector(".stop-again").addEventListener("click", (e) => { e.stopPropagation(); onBreak.rerun?.(); });
  stopEl.addEventListener("click", () => onBreak.talk?.());
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
     往左拖能看回去。

     0.62 是列距 436 那会儿的数:那时十来个节点铺出去四千多像素宽,再缩就
     只剩缩略图了。列距收到 300 之后同样一条链只有两千八,0.45 上卡片还有
     79 像素、字看得清,而整条链一屏进得来。看全比看大要紧。 */
  const MIN_SCALE = 0.45;

  /* 跑着的时候,头站在画面横向的这个位置:左边是已经建好的,右边留一截给轨道。
     早先试过让头落在正中,右边空一大片——那是因为当时轨道还没画出来。 */
  const AHEAD = 0.64;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* 镜头两种状态,分得很开。

     跑着的时候不缩:卡片保持看得清的大小,镜头跟着下一格的落点走,越长越往右
     推,左边建好的拖回去还能看。整幅还塞得下的时候照样摆正中——不然一两张卡
     的时候会被推到边上。

     跑完了(pending 清掉)退回全景:框住整幅,缩放上限放开到 1,一路滑过去。
     有一张卡展开着的时候镜头归它,别的再动也不许抢。 */
  function fit() {
    if (opened) return;
    const { pad, w, h } = room();

    if (pending && !pending.broken) {
      scale = RUN_SCALE;
      const at = head();
      const wide = box.w * scale, tall = box.h * scale;
      tx = wide > w ? Math.min(pad, pad + w * AHEAD - at.x * scale) : pad + (w - wide) / 2;
      ty = tall > h ? clamp(pad + h / 2 - at.y * scale, pad + h - tall, pad) : pad + (h - tall) / 2;
      apply(framed);
      framed = box.w > 1;
      return;
    }

    scale = Math.max(MIN_SCALE, Math.min(1, w / box.w, h / box.h));
    const wide = box.w * scale, tall = box.h * scale;
    /* 全景也放不下就右端对齐:最后那几张在眼前,往左拖能看回去。 */
    tx = wide > w ? pad + w - wide : pad + (w - wide) / 2;
    ty = tall > h ? pad : pad + (h - tall) / 2;
    apply(framed);
    framed = box.w > 1;
  }

  const visible = () => last.placed.filter((p) => shown.has(p.node.name));

  function draw(canvas, { instant = false } = {}) {
    /* 刷新回来的那一下不重演:已经在画布上的东西直接就位。 */
    if (instant) {
      for (const n of canvas.nodes) shown.add(n.name);
      for (const e of canvas.edges) drawn.add(key(e));
    }
    const { placed } = layout(canvas.nodes, canvas.edges);
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
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          /* 卡上那一格是入口,不是卡身的一部分:点它是「定这一格」,
             不该顺手把卡收回去。 */
          const cell = e.target.closest("[data-key]");
          if (cell && el.classList.contains("open")) return openPicker(el, p.node, cell);
          toggle(p.node.name);
        });
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
      if (opened === p.node.name) remeasure(el);
    }

    for (const [k, e] of edges) if (!canvas.edges.some((x) => key(x) === k)) { e.g.remove(); edges.delete(k); }
    for (const e of canvas.edges) {
      const from = at.get(e.from), to = at.get(e.to);
      if (from && to) paint(e, wire(from, to));
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
    wires.setAttribute("width", paper.w);
    wires.setAttribute("height", paper.h);
  }

  /* 下一张卡会落在哪一格,头就在哪儿。已经落地的卡里最右一列往后接一格,
     一张都还没落就在原点——镜头会把它摆到正中。

     base 是这一格去掉起伏之后的高度。往后每一格的高度都从 base 加上那一列
     自己的起伏算出来,和真卡片用的是同一个函数:还没走到的那几步,
     踩的是真链路接着走的那几个点。 */
  function head() {
    const seen = visible();
    if (!seen.length) return { x: 0, y: TILE / 2 };
    const colOf = (p) => Math.round(p.x / PITCH);
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
      fade.setAttribute("x1", from);
      fade.setAttribute("x2", to);
      fade.setAttribute("y1", at.y);
      fade.setAttribute("y2", at.y);
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
      stopEl.querySelector(".stop-name").textContent = pending.title;
      stopEl.querySelector(".stop-why").textContent = pending.note ?? "";
      stopEl.querySelector(".stop-why").hidden = !pending.note;
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
  let filling = null;

  function openPicker(el, node, cell) {
    const def = byType.get(node.type);
    const slot = def?.slots.find((s) => s.key === cell.dataset.key);
    if (!slot || !picker) return;
    filling = { el, node, key: slot.key };
    const box = picker.querySelector(".panel");
    box.innerHTML = panel(def, slot, node);
    picker.hidden = false;
    /* 落在这张卡的中轴上,不是屏幕的中轴。
       卡的位置不去量:点开一张卡的时候镜头正把它送往取景框正中(见 aim),
       这会儿还在滑,量到的是半路上的那一帧,钉下去就是歪的。
       取景框正中是个定数,直接用它——镜头到位之后卡就在那儿。
       出不去屏幕:四边各留 20。 */
    const M = 20;
    const { pad, w: roomW, h: roomH } = room();
    const w = box.offsetWidth, h = box.offsetHeight;
    const grip = (v, hi) => Math.min(Math.max(v, M), Math.max(M, hi));
    box.style.left = `${grip(pad + roomW / 2 - w / 2, innerWidth - w - M)}px`;
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
  function fill(value) {
    if (!filling) return;
    if (value === "") return shutPicker();
    const { el, node, key } = filling;
    node.params = { ...node.params, [key]: value };
    node.blanks = (node.blanks ?? []).filter((b) => b !== key);
    shutPicker();
    const def = byType.get(node.type);
    el.firstChild.innerHTML = `${miniCard(def, node)}${fullCard(def, node, last.canvas.edges)}`;
    if (opened === node.name) remeasure(el);
    onFill?.({ node: node.name, key, value });
  }

  if (picker) {
    picker.addEventListener("click", (e) => {
      if (e.target === picker) return shutPicker();
      if (e.target.closest(".panel-close")) return shutPicker();
      const act = e.target.closest("[data-do]")?.dataset.do;
      if (act === "ok") return fill(picker.querySelector(".panel-field")?.value.trim() ?? "");
      /* 传文件和新建连接这两条,POC 到不了真的那一步:传文件当场落一个值,
         新建连接只能关掉——装成建好了才是骗人。 */
      if (act === "upload") return fill("刚上传的文件");
      if (act === "new") return shutPicker();
      const row = e.target.closest(".src-row[data-v]");
      if (row) return fill(row.dataset.v);
    });
    picker.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.matches("input.panel-field")) fill(e.target.value.trim());
    });
    addEventListener("keydown", (e) => { if (e.key === "Escape") shutPicker(); });
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

  /* 内容换了的那张卡如果正开着:重新量、重新定高,然后还得把 open 加回去——
     measure 量完是要摘掉 open 的(它得先撑开才量得出高度,量完不能留着),
     所以谁调 measure 谁负责把它加回来。 */
  const remeasure = (el) => { box0(el, measure(el)); el.classList.add("open"); };

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
  /* 盖在画布上的东西,点它外面的任何一处就收回去。这条挂在 document 上,不挂在
     viewport 上——挂 viewport 只管得着画布那一块,点顶栏、点输入框都收不掉,
     同样是「外面」,结果却不一样。
     谁在上头谁先收:选择器盖在展开的卡上,点画布的那一下只收选择器。 */
  addEventListener("click", (e) => {
    if (filling || e.target.closest(".picker")) return;
    if (!e.target.closest(".node")) shut(true);
  });
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
    /* 断口那张卡上能做的两件事:按「重走」,或者点一下卡身去跟这一步说话。 */
    onBreak(handlers) { onBreak = handlers; },
    /* 卡全落地了再报数。还在落的时候报「已生成 9 个」,画布上只有 4 张。 */
    onIdle(fn) {
      if (!playing && !queue.length) return void fn();
      idleWaiters.push(fn);
    },
  };
}
