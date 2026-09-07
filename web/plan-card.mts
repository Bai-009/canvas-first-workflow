import type { ChatLine } from '../shared/http.mjs';
import type { PlanProposal } from '../shared/contracts.mjs';
import type { PlanDraft } from '../shared/plan.mjs';
import { element } from './dom.mjs';
interface PlanView { task?: string; speech?: string; chat?: ChatLine[]; plan?: PlanProposal | null }
interface PlanCardOptions { card: HTMLElement; stage: HTMLElement; leftInset?: () => number }
interface CardBounds { left: number; top: number; width: number; height: number }
/* Plan 卡片：首次生成先收窄再飞走；右上角与中央的往返则沿用原型最终版，
   位置、尺寸与正文在同一拍形变。两种动作不能共用先塌后飞的编排。 */

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const MINI = { w: 320, right: 24, top: 68, pad: "13px 15px 12px" };
const OPEN = { w: 600, pad: "22px 24px 18px" };
const SWAP = 620;

/* 卡上三块的行怎么印。序号从 1 数起;s1、u3 这种带字母的编号是模型认身份用的,
   留在 data-ref 上等以后指着说用,不上墙——等宽字母夹在中文里看着像调试信息。
   还在写的时候一行可能缺格,所以每格都当可能没有来印。 */
interface StepLike { ref?: unknown; title?: unknown }
interface ReadLike { ref?: unknown; quote?: unknown; reading?: unknown }
interface AskLike { ref?: unknown; question?: unknown; reason?: unknown; affects?: unknown }
const cell = (v: unknown) => esc(v ?? "");
const stepRow = (s: StepLike, i: number) =>
  `<div class="plan-row" data-ref="${cell(s.ref)}"><span class="n">${i + 1}</span><b>${cell(s.title)}</b></div>`;
const readRow = (u: ReadLike, i: number) =>
  `<tr data-ref="${cell(u.ref)}"><td class="n">${i + 1}</td><td class="q"><q>${cell(u.quote)}</q></td><td>${cell(u.reading)}</td></tr>`;
/* 每条待确认标着它影响的第几步。步还没到齐时找不到,就先不标。 */
const askRow = (q: AskLike, steps: StepLike[]) => {
  const first = Array.isArray(q.affects) ? q.affects[0] : undefined;
  const n = steps.findIndex((s) => s.ref === first) + 1;
  return `<div class="plan-row plan-ask" data-ref="${cell(q.ref)}"><span class="q">?</span><div>` +
    `<p>${cell(q.question)}${n ? `<em>第 ${n} 步</em>` : ""}</p><span>${cell(q.reason)}</span></div></div>`;
};

export function createPlanCard({ card, stage, leftInset = () => 0 }: PlanCardOptions) {
  const content = document.createElement("div");
  content.className = "plan-content";
  content.append(...card.childNodes);
  card.append(content);
  const $ = (sel: string) => element(content, sel);
  const body = $(".plan-body");
  const say = $(".plan-say");
  const dot = $(".plan-dot");
  const go = $(".plan-go");
  const close = $(".plan-close");
  let mini = false;
  let moving = false;
  /* 边写边看的时候,记着每一块已经露了几条,只补新的那几条。 */
  let shown = { says: 0, understanding: 0, steps: 0, asks: 0 };
  /* 这一条从头到尾说过的话。谁说的看形不看名:自己说的是一块浅底,
     Plan Agent 说的就是正文——画面上不出现「你」「它」这种称呼。 */
  let thread: ChatLine[] = [];

  const chatBox = () => $(".plan-thread");
  /* 写的时候跟着看:正在落字的在最底下。滚的是整张卡的正文。 */
  const followChat = () => { if (!mini) body.scrollTop = body.scrollHeight; };
  const turnHtml = (t: ChatLine) => (t.who === "user"
    ? `<div class="plan-turn me"><span>${esc(t.text)}</span></div>`
    : `<div class="plan-turn plan-says">${rich(t.text)}</div>`);

  /* 第一句自己说的话不进线程:它已经写在上面的「需求」栏里了。
     同一段话在同一张卡上出现两次,读的人要比对一遍才知道是同一句。 */
  const inThread = () => (thread[0]?.who === "user" ? thread.slice(1) : thread);

  function paintChat() {
    const box = chatBox();
    const turns = inThread();
    box.innerHTML = turns.map(turnHtml).join("");
    box.hidden = turns.length === 0;
  }

  /* 正在写的那一条单独更新,前面说过的话不跟着重画。 */
  function paintLive(text: string) {
    const box = chatBox();
    let el = box.querySelector(".plan-turn.live");
    if (!el) {
      el = document.createElement("div");
      el.className = "plan-turn plan-says live";
      box.appendChild(el);
    }
    el.innerHTML = rich(text);
    box.hidden = false;
    followChat();
  }

  /* 段名带个数:没读正文先知道这份方案有多大。 */
  const count = (sec: string, label: string) => { element($(sec), ".plan-h").textContent = label; };

  /* 正文滚到边上,字淡出去而不是被硬切;只在那一边真有东西被遮住时才淡。 */
  const fade = () => {
    const above = body.scrollTop, below = body.scrollHeight - body.clientHeight - above;
    body.style.setProperty("--plan-fade-top", `${Math.min(14, above)}px`);
    body.style.setProperty("--plan-fade-bottom", `${below < 1 ? 0 : Math.min(18, below)}px`);
  };
  body.addEventListener("scroll", fade);

  const place = () => {
    if (moving) return;
    if (mini) {
      card.style.left = `${Math.max(leftInset() + 16, innerWidth - MINI.right - MINI.w)}px`;
      card.style.top = `${MINI.top}px`;
      card.style.width = `${Math.min(MINI.w, innerWidth - leftInset() - 32)}px`;
    } else {
      card.style.width = `${Math.min(OPEN.w, innerWidth - leftInset() - 48)}px`;
      card.style.left = `${leftInset() + (innerWidth - leftInset() - card.offsetWidth) / 2}px`;
      card.style.top = `${centerTop(card.offsetHeight)}px`;
    }
    fade();
  };

  const centerTop = (height: number) => {
    const top = 68;
    const bottom = Math.max(128, innerHeight - (document.querySelector(".bar")?.getBoundingClientRect().top ?? innerHeight) + 24);
    return Math.max(24, Math.round(top + (innerHeight - bottom - top - height) / 2));
  };
  const pin = ({ left, top, width, height }: CardBounds) => Object.assign(card.style, {
    left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
  });

  /* 在不可见副本上量终态，不把正在显示的卡片先变大再变回去。
     正文也用真实像素：拿一个很大的 max-height 做动画会让正文晚半拍。
     副本按目标状态挂 mini / open,该藏的段样式自己藏,量出来的就是那一态的高。 */
  function measure(compact: boolean) {
    const probe = card.cloneNode(true);
    if (!(probe instanceof HTMLElement)) throw new Error("方案卡副本不是 HTML 元素");
    probe.removeAttribute("id");
    for (const el of probe.querySelectorAll("[id]")) el.removeAttribute("id");
    probe.hidden = false; probe.inert = true;
    probe.setAttribute("aria-hidden", "true");
    probe.classList.remove("morph");
    probe.classList.toggle("mini", compact); probe.classList.toggle("open", !compact);
    const width = Math.min(compact ? MINI.w : OPEN.w, innerWidth - leftInset() - (compact ? 32 : 48));
    Object.assign(probe.style, { visibility: "hidden", pointerEvents: "none", left: "-10000px", top: "0px",
      width: `${width}px`, height: "auto", transform: "none", transition: "none", padding: compact ? MINI.pad : OPEN.pad });
    const pb = element(probe, ".plan-body");
    Object.assign(pb.style, { maxHeight: "", transition: "none" });
    element(probe, ".plan-close").hidden = compact;
    element(probe, ".plan-go").hidden = true;
    document.body.append(probe);
    const height = probe.getBoundingClientRect().height, bodyHeight = pb.getBoundingClientRect().height;
    const contentWidth = element(probe, ".plan-content").getBoundingClientRect().width;
    probe.remove();
    return { width, height, bodyHeight, contentWidth,
      left: compact ? Math.max(leftInset() + 16, innerWidth - MINI.right - width) : Math.round(leftInset() + (innerWidth - leftInset() - width) / 2),
      top: compact ? MINI.top : centerTop(height) };
  }

  /* 外壳连续形变，文字只在起点和终点排版。
     原排版保留为短暂的视觉副本，淡出后移除；真实内容始终承接更新和交互。 */
  function transitionText(target: { contentWidth: number }, duration: number) {
    const copy = content.cloneNode(true);
    if (!(copy instanceof HTMLElement)) throw new Error("方案正文副本不是 HTML 元素");
    copy.classList.add("plan-motion-copy");
    copy.inert = true;
    copy.setAttribute("aria-hidden", "true");
    for (const el of copy.querySelectorAll("[id]")) el.removeAttribute("id");
    const padding = getComputedStyle(card);
    Object.assign(copy.style, { left: padding.paddingLeft, top: padding.paddingTop,
      width: `${content.getBoundingClientRect().width}px` });
    // 祖先从 open 变成 mini 时，副本的正文和页脚仍保持出发时的样子。
    for (const selector of [".plan-body", ".plan-foot"]) {
      const source = $(selector), frozen = element(copy, selector), style = getComputedStyle(source);
      for (const property of ["height", "maxHeight", "marginTop", "paddingTop", "opacity"] as const)
        frozen.style[property] = style[property];
    }
    card.append(copy);
    element(copy, ".plan-body").scrollTop = body.scrollTop;
    content.style.width = `${target.contentWidth}px`;
    const outgoing = copy.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: duration * .22, easing: "ease-out", fill: "both",
    });
    const incoming = content.animate([
      { opacity: 0, offset: 0 }, { opacity: 0, offset: .28 },
      { opacity: 1, offset: .78 }, { opacity: 1, offset: 1 },
    ], { duration, easing: "ease", fill: "both" });
    return () => {
      copy.remove(); outgoing.cancel(); incoming.cancel();
      content.style.width = "";
    };
  }

  async function settle() {
    // 先触发布局，等待实际动画完成；不在“差不多到位”时直接补写终点。
    void card.offsetHeight;
    await Promise.all(card.getAnimations({ subtree: true }).filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map((animation) => animation.finished.catch(() => {})));
  }

  /* 收起来的时候先回到顶上:需求在正文里,滚到半路收起来它就不在。
     副本留着滚到哪儿的样子淡出去,真身回到顶上淡进来,这一下就是那个交叉淡。 */
  async function swap(compact: boolean) {
    if (moving || mini === compact) return;
    moving = true;
    const target = measure(compact);
    pin(card.getBoundingClientRect());
    body.style.transition = "none";
    body.style.maxHeight = `${body.getBoundingClientRect().height}px`;
    void card.offsetHeight;
    body.style.transition = "";
    card.style.setProperty("--mo", `${SWAP}ms`);
    const finishText = transitionText(target, SWAP);
    if (compact) body.scrollTop = 0;
    card.classList.add("morph");
    stage.classList.add("swap");
    void card.offsetHeight;
    stage.classList.toggle("recede", !compact);
    mini = compact;
    card.classList.toggle("mini", compact); card.classList.toggle("open", !compact);
    card.style.padding = compact ? MINI.pad : OPEN.pad;
    body.style.maxHeight = `${target.bodyHeight}px`;
    go.hidden = true; close.hidden = compact;
    pin(target);
    await settle();
    finishText();
    card.classList.remove("morph");
    card.style.height = "auto";
    body.style.maxHeight = "";
    if (compact) stage.classList.remove("swap");
    moving = false;
    fade();
  }

  /* 一条一条落下来,不是一块一块闪出来。 */
  async function drop(nodes: HTMLElement[], gap = 90) {
    for (const el of nodes) {
      el.classList.add("drop");
      el.hidden = false;
      if (!mini) place();
      await wait(gap);
    }
  }

  const setSay = (text: string, done = false) => {
    say.textContent = text;
    dot.classList.toggle("done", done);
  };

  /* 卡上的内容照方案填,返回这一轮要落下来的几块。 */
  function fill({ task, speech, chat, plan }: PlanView) {
    /* 需求写的是方案里的 goal,不是用户敲进来的第一句。第一句可能是「你好」,
       真正的需求是聊出来的——goal 就是模型把这一轮聊下来的东西收成的一句话。
       方案还没出来之前,先摆着用户自己的话;那不当标题排,goal 才当标题。 */
    const want = plan?.goal || task;
    if (want) $(".plan-text").textContent = want;
    $(".plan-text").classList.toggle("goal", Boolean(plan?.goal));
    const secs: HTMLElement[] = [];
    for (const sec of content.querySelectorAll<HTMLElement>(".plan-sec")) sec.hidden = true;
    shown = { says: 0, understanding: 0, steps: 0, asks: 0 };
    /* 服务端交回来的 chat 已经把这一轮的回话接在末尾了,所以不再单独补 speech。
       只有还没接上的时候(刷新回来正好卡在中间)才拿 speech 当最后一条。 */
    if (chat) thread = [...chat];
    if (speech && thread.at(-1)?.who !== "agent") thread = [...thread, { who: "agent", text: speech }];
    /* 对话在需求底下、方案上头:它先说话再交方案,卡上的顺序跟它交上来的一样。 */
    paintChat();
    if (inThread().length) {
      chatBox().hidden = true;
      secs.push(chatBox());
    }
    if (plan) {
      $(".plan-route").innerHTML = plan.steps.map(stepRow).join("");
      count(".sec-route", `路线 · ${plan.steps.length} 步`);
      secs.push($(".sec-route"));
      if (plan.openQuestions.length) {
        $(".plan-asks").innerHTML = plan.openQuestions.map((q) => askRow(q, plan.steps)).join("");
        count(".sec-asks", `待确认 · ${plan.openQuestions.length} 项`);
        secs.push($(".sec-asks"));
      }
      $(".plan-table tbody").innerHTML = plan.understanding.map(readRow).join("");
      count(".sec-understanding", `理解 · ${plan.understanding.length} 条`);
      secs.push($(".sec-understanding"));
    }
    return secs;
  }

  return {
    get isMini() { return mini; },

    /* 你按下发送的那一刻卡片就在,里头是你那句话。
       最长的那一段是「什么都还没有」的那一段,那正是最需要有形态的地方。 */
    async ask(text: string) {
      card.hidden = false;
      card.classList.add("open");
      /* 第一句之后需求就归 goal 管了,这里只在还没有方案的时候顶上。 */
      if (!thread.length) $(".plan-text").textContent = text;
      for (const sec of content.querySelectorAll<HTMLElement>(".plan-sec")) sec.hidden = true;
      for (const sel of [".plan-table tbody", ".plan-route", ".plan-asks"]) $(sel).innerHTML = "";
      shown = { says: 0, understanding: 0, steps: 0, asks: 0 };
      /* 按下发送这句话就上墙。模型要想三十秒,不能让它先消失三十秒。 */
      thread = [...thread, { who: "user", text }];
      paintChat();
      /* 刚说的这句是从下面的框飞上来的,得落一下,不能凭空出现。
         用卡片其他段落同一个落法,一张卡上不出现第二种动。 */
      chatBox().lastElementChild?.classList.add("drop");
      followChat();
      go.hidden = true;
      close.hidden = true;
      setSay("正在理解需求");
      place();
    },

    /* 交回来了:说明、路线、待确认、理解,一条一条落。 */
    async show(state: PlanView) {
      const streamed = shown.says + shown.understanding + shown.steps + shown.asks > 0;
      const secs = fill(state);
      /* 已经一条条看着长出来了,最后收尾就不再重演一遍。 */
      if (streamed) for (const sec of secs) sec.hidden = false;
      else await drop(secs);
      /* 这里必须自己取出来:页面上有个 id 是 plan 的元素,浏览器会把它变成同名全局变量,
         少写一行 const 就会读到那个 div,状态和「开始生成」全哑掉。 */
      const { plan } = state;
      const open = plan?.openQuestions.length ?? 0;
      setSay(plan ? `${plan.steps.length} 步 · ${open ? `${open} 项待确认` : "待确认已清"}` : "未出方案", true);
      /* 收在右上角的时候不再冒出「开始生成」:那是中央这张卡上的动作。 */
      if (plan && !mini) {
        go.hidden = false;
        go.classList.add("drop");
      }
      /* 刚看着它一个字一个字写完,别把人甩回顶上。刷新回来的那一下不一样:
         没人在看写字,该先看见方案。streamed 正好分得开这两种。 */
      if (!mini) {
        if (!streamed) body.scrollTop = 0;
        place();
      }
    },

    /* 模型还在写的时候:一条一条补上去,已经露过的不重画。
       写好的先站住,后面的接着长——这才是人读东西的样子。 */
    draft({ speech, plan, phase }: PlanDraft) {
      if (mini) return;
      /* 等的时候只报一件事,报到底:先是在想,动笔之后是在写。
         想的内容不上界面——那是内心独白,而且是断的。 */
      if (!plan?.steps.length) setSay(phase === "writing" ? "正在生成方案" : "正在理解需求");
      if (speech && speech.length !== shown.says) {
        paintLive(speech);
        shown.says = speech.length;
      }
      if (!plan) return place();
      const grow = <T,>(sel: string, rows: T[], key: keyof typeof shown, render: (row: T, index: number) => string) => {
        if (rows.length <= shown[key]) return;
        const box = $(sel);
        const before = box.children.length;
        rows.slice(shown[key]).forEach((row, i) => box.insertAdjacentHTML("beforeend", render(row, shown[key] + i)));
        for (const el of [...box.children].slice(before)) el.classList?.add("drop");
        shown[key] = rows.length;
        const section = box.closest<HTMLElement>(".plan-sec");
        if (section) section.hidden = false;
      };
      grow(".plan-route", plan.steps, "steps", stepRow);
      if (plan.steps.length) count(".sec-route", `路线 · ${plan.steps.length} 步`);
      grow(".plan-asks", plan.openQuestions, "asks", (q) => askRow(q, plan.steps));
      if (plan.openQuestions.length) count(".sec-asks", `待确认 · ${plan.openQuestions.length} 项`);
      grow(".plan-table tbody", plan.understanding, "understanding", readRow);
      if (plan.understanding.length) count(".sec-understanding", `理解 · ${plan.understanding.length} 条`);
      place();
    },

    /* 刷新页面回来的那一下不重演:已经搭过了就直接是右上角那张。 */
    restore(state: PlanView, status: string) {
      for (const section of fill(state)) section.hidden = false;
      card.hidden = false;
      card.classList.remove("open");
      mini = true;
      card.classList.add("mini");
      card.style.padding = MINI.pad;
      card.style.height = "auto";
      go.hidden = true;
      close.hidden = true;
      place();
      setSay(status, true);
    },

    /* 首次生成：先在中央收成小卡，停一拍，再沿原型曲线飞到右上角。 */
    async toMini(status: string) {
      if (mini || moving) return;
      moving = true;
      go.hidden = true; close.hidden = true;
      const target = measure(true);
      pin(card.getBoundingClientRect());
      body.style.transition = "none";
      body.style.maxHeight = `${body.getBoundingClientRect().height}px`;
      void card.offsetHeight;
      body.style.transition = "";
      card.style.setProperty("--mo", "420ms");
      const finishText = transitionText(target, 420);
      body.scrollTop = 0;
      card.classList.add("morph");
      void card.offsetHeight;
      card.classList.remove("open"); card.classList.add("mini");
      card.style.padding = MINI.pad;
      body.style.maxHeight = `${target.bodyHeight}px`;
      pin({ ...target, left: leftInset() + (innerWidth - leftInset() - target.width) / 2, top: centerTop(target.height) });
      await settle();
      finishText();
      card.classList.remove("morph");
      body.style.maxHeight = "";
      await wait(40);
      const from = card.getBoundingClientRect();
      const dx = target.left - from.left, dy = target.top - from.top;
      const frames = Array.from({ length: 41 }, (_, k) => {
        const t = k / 40, m = 1 - t;
        return { offset: t, transform: `translate(${2*m*t*dx*.30+t*t*dx}px, ${2*m*t*dy*.94+t*t*dy}px)` };
      });
      const flight = card.animate(frames, { duration: 780 * 1.05, fill: "both", easing: "cubic-bezier(.4,0,.2,1)" });
      stage.classList.remove("recede");
      await flight.finished.catch(() => {});
      pin(target); flight.cancel();
      mini = true;
      card.style.height = "auto";
      stage.classList.remove("swap");
      setSay(status, true);
      moving = false;
    },

    toCenter() { return swap(false); },
    back() { return swap(true); },

    status(text: string) { if (mini) setSay(text, true); },
    reflow() { if (!moving) place(); },
    onGo: (fn: (event: MouseEvent) => void) => go.addEventListener("click", fn),
    onClose: (fn: (event: MouseEvent) => void) => close.addEventListener("click", fn),
  };
}

/* 说明是一段一段的,**重点**加粗,「- 」开头的排成一条条。 */
export function rich(text: unknown) {
  return String(text).split(/\n{2,}/).map((block) => {
    const lines = block.split("\n");
    const bold = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    if (lines.every((l) => l.trimStart().startsWith("- "))) {
      return `<ul class="says">${lines.map((l) => `<li>${bold(l.trimStart().slice(2))}</li>`).join("")}</ul>`;
    }
    return `<p>${lines.map(bold).join("<br>")}</p>`;
  }).join("");
}
