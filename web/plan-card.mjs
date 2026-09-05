/* Plan 卡片：首次生成先收窄再飞走；右上角与中央的往返则沿用原型最终版，
   位置、尺寸与正文在同一拍形变。两种动作不能共用先塌后飞的编排。 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const MINI = { w: 320, right: 24, top: 68, pad: "13px 15px 12px" };
const OPEN = { w: 560, pad: "18px 20px 16px" };
const SWAP = 620;

export function createPlanCard({ card, stage, onStart, leftInset = () => 0 }) {
  const content = document.createElement("div");
  content.className = "plan-content";
  content.append(...card.childNodes);
  card.append(content);
  const $ = (sel) => content.querySelector(sel);
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
  let thread = [];

  const chatBox = () => $(".plan-chat");
  /* 写的时候跟着看,写完了回到方案:正在落字的是最后那一条,在卡片最底下;
     一轮说完,该读的是理解和路线,卡片回到顶上。 */
  const followChat = () => { if (!mini) $(".plan-body").scrollTop = $(".plan-body").scrollHeight; };
  const turnHtml = (t) => (t.who === "user"
    ? `<div class="plan-turn me"><span>${esc(t.text)}</span></div>`
    : `<div class="plan-turn plan-says">${rich(t.text)}</div>`);

  /* 第一句自己说的话不进线程:它已经写在上面的「需求」栏里了。
     同一段话在同一张卡上出现两次,读的人要比对一遍才知道是同一句。 */
  const inThread = () => (thread[0]?.who === "user" ? thread.slice(1) : thread);

  /* 整条重画。滚到底那件事归 followChat 管:滚的是整张卡的正文,线程自己不滚。 */
  function paintChat() {
    const box = chatBox();
    const turns = inThread();
    box.innerHTML = turns.map(turnHtml).join("");
    $(".sec-chat").hidden = turns.length === 0;
  }

  /* 正在写的那一条单独更新,前面说过的话不跟着重画。 */
  function paintLive(text) {
    const box = chatBox();
    let el = box.querySelector(".plan-turn.live");
    if (!el) {
      el = document.createElement("div");
      el.className = "plan-turn plan-says live";
      box.appendChild(el);
    }
    el.innerHTML = rich(text);
    $(".sec-chat").hidden = false;
    followChat();
  }

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
  };

  const centerTop = (height) => {
    const top = 68;
    const bottom = Math.max(128, innerHeight - (document.querySelector(".bar")?.getBoundingClientRect().top ?? innerHeight) + 24);
    return Math.max(24, Math.round(top + (innerHeight - bottom - top - height) / 2));
  };
  const pin = ({ left, top, width, height }) => Object.assign(card.style, {
    left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
  });

  /* 在不可见副本上量终态，不把正在显示的卡片先变大再变回去。
     正文也用真实像素：拿一个很大的 max-height 做动画会让正文晚半拍。 */
  function measure(compact) {
    const probe = card.cloneNode(true);
    probe.removeAttribute("id");
    for (const el of probe.querySelectorAll("[id]")) el.removeAttribute("id");
    probe.hidden = false; probe.inert = true;
    probe.setAttribute("aria-hidden", "true");
    probe.classList.remove("morph");
    probe.classList.toggle("mini", compact); probe.classList.toggle("open", !compact);
    const width = Math.min(compact ? MINI.w : OPEN.w, innerWidth - leftInset() - (compact ? 32 : 48));
    Object.assign(probe.style, { visibility: "hidden", pointerEvents: "none", left: "-10000px", top: "0px",
      width: `${width}px`, height: "auto", transform: "none", transition: "none", padding: compact ? MINI.pad : OPEN.pad });
    const pb = probe.querySelector(".plan-body");
    Object.assign(pb.style, { maxHeight: compact ? "0px" : "", marginTop: compact ? "0px" : "12px", opacity: compact ? "0" : "1", transition: "none" });
    probe.querySelector(".plan-close").hidden = compact;
    probe.querySelector(".plan-go").hidden = true;
    document.body.append(probe);
    const height = probe.getBoundingClientRect().height, bodyHeight = pb.getBoundingClientRect().height;
    const contentWidth = probe.querySelector(".plan-content").getBoundingClientRect().width;
    probe.remove();
    return { width, height, bodyHeight, contentWidth,
      left: compact ? Math.max(leftInset() + 16, innerWidth - MINI.right - width) : Math.round(leftInset() + (innerWidth - leftInset() - width) / 2),
      top: compact ? MINI.top : centerTop(height) };
  }

  /* 外壳连续形变，文字只在起点和终点排版。
     原排版保留为短暂的视觉副本，淡出后移除；真实内容始终承接更新和交互。 */
  function transitionText(target, duration) {
    const copy = content.cloneNode(true);
    copy.classList.add("plan-motion-copy");
    copy.inert = true;
    copy.setAttribute("aria-hidden", "true");
    for (const el of copy.querySelectorAll("[id]")) el.removeAttribute("id");
    const padding = getComputedStyle(card);
    Object.assign(copy.style, { left: padding.paddingLeft, top: padding.paddingTop,
      width: `${content.getBoundingClientRect().width}px` });
    // 祖先从 open 变成 mini 时，副本的正文和页脚仍保持出发时的样子。
    for (const selector of [".plan-body", ".plan-foot"]) {
      const source = $(selector), frozen = copy.querySelector(selector), style = getComputedStyle(source);
      for (const property of ["height", "maxHeight", "marginTop", "paddingTop", "opacity"])
        frozen.style[property] = style[property];
    }
    card.append(copy);
    copy.querySelector(".plan-body").scrollTop = body.scrollTop;
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
    await Promise.all(card.getAnimations({ subtree: true }).filter((animation) => Number.isFinite(animation.effect.getComputedTiming().endTime)).map((animation) => animation.finished.catch(() => {})));
  }

  async function swap(compact) {
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
    card.classList.add("morph");
    stage.classList.add("swap");
    void card.offsetHeight;
    stage.classList.toggle("recede", !compact);
    mini = compact;
    card.classList.toggle("mini", compact); card.classList.toggle("open", !compact);
    card.style.padding = compact ? MINI.pad : OPEN.pad;
    body.style.maxHeight = `${target.bodyHeight}px`;
    body.style.opacity = compact ? "0" : "1";
    body.style.marginTop = compact ? "0px" : "12px";
    go.hidden = true; close.hidden = compact;
    pin(target);
    await settle();
    finishText();
    card.classList.remove("morph");
    card.style.height = "auto";
    body.style.maxHeight = compact ? "0px" : "";
    if (compact) stage.classList.remove("swap");
    moving = false;
  }

  /* 一条一条落下来,不是一块一块闪出来。 */
  async function drop(nodes, gap = 90) {
    for (const el of nodes) {
      el.classList.add("drop");
      el.hidden = false;
      if (!mini) place();
      await wait(gap);
    }
  }

  const setSay = (text, done = false) => {
    say.textContent = text;
    dot.classList.toggle("done", done);
  };

  /* 卡上的内容照方案填,返回这一轮要落下来的几块。 */
  function fill({ task, speech, chat, plan }) {
    /* 需求写的是方案里的 goal,不是用户敲进来的第一句。第一句可能是「你好」,
       真正的需求是聊出来的——goal 就是模型把这一轮聊下来的东西收成的一句话。
       方案还没出来之前,先摆着用户自己的话。 */
    const want = plan?.goal || task;
    if (want) $(".plan-text").textContent = want;
    const secs = [];
    for (const sec of content.querySelectorAll(".plan-sec")) sec.hidden = true;
    shown = { says: 0, understanding: 0, steps: 0, asks: 0 };
    /* 服务端交回来的 chat 已经把这一轮的回话接在末尾了,所以不再单独补 speech。
       只有还没接上的时候(刷新回来正好卡在中间)才拿 speech 当最后一条。 */
    if (chat) thread = [...chat];
    if (speech && thread.at(-1)?.who !== "agent") thread = [...thread, { who: "agent", text: speech }];
    if (plan) {
      $(".plan-table tbody").innerHTML = plan.understanding
        .map((u) => `<tr><td>${esc(u.quote)}</td><td>${esc(u.reading)}</td></tr>`).join("");
      secs.push($(".sec-understanding"));
      $(".plan-route").innerHTML = plan.steps
        .map((s) => `<span>${esc(s.title)}</span>`).join("<i>→</i>");
      secs.push($(".sec-route"));
      if (plan.openQuestions.length) {
        $(".plan-asks").innerHTML = plan.openQuestions
          .map((q) => `<div class="plan-ask"><span class="q">?</span><div><b>${esc(q.question)}</b><span>${esc(q.reason)}</span></div></div>`).join("");
        secs.push($(".sec-asks"));
      }
    }
    /* 对话摆在最后一块:紧挨着输入框。方案那几块的位置就固定住了,
       不会因为多聊了两句被顶到看不见的地方——待确认尤其不能被顶走。 */
    if (inThread().length) {
      paintChat();
      secs.push($(".sec-chat"));
    }
    return secs;
  }

  return {
    get isMini() { return mini; },

    /* 你按下发送的那一刻卡片就在,里头是你那句话。
       最长的那一段是「什么都还没有」的那一段,那正是最需要有形态的地方。 */
    async ask(text) {
      card.hidden = false;
      card.classList.add("open");
      /* 第一句之后需求就归 goal 管了,这里只在还没有方案的时候顶上。 */
      if (!thread.length) $(".plan-text").textContent = text;
      for (const sec of content.querySelectorAll(".plan-sec")) sec.hidden = true;
      for (const sel of [".plan-table tbody", ".plan-route", ".plan-asks"]) $(sel).innerHTML = "";
      shown = { says: 0, understanding: 0, steps: 0, asks: 0 };
      /* 按下发送这句话就上墙。模型要想三十秒,不能让它先消失三十秒。 */
      thread = [...thread, { who: "user", text }];
      paintChat();
      followChat();
      go.hidden = true;
      close.hidden = true;
      setSay("正在理解需求");
      place();
    },

    /* 交回来了:说明、理解、路线、待确认,一条一条落。 */
    async show(state) {
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
        if (!streamed) $(".plan-body").scrollTop = 0;
        place();
      }
    },

    /* 模型还在写的时候:一条一条补上去,已经露过的不重画。
       写好的先站住,后面的接着长——这才是人读东西的样子。 */
    draft({ speech, plan, phase }) {
      if (mini) return;
      /* 等的时候只报一件事,报到底:先是在想,动笔之后是在写。
         想的内容不上界面——那是内心独白,而且是断的。 */
      if (!plan?.steps.length) setSay(phase === "writing" ? "正在生成方案" : "正在理解需求");
      if (speech && speech.length !== shown.says) {
        paintLive(speech);
        shown.says = speech.length;
      }
      if (!plan) return place();
      const grow = (sel, rows, key, render) => {
        if (rows.length <= shown[key]) return;
        const box = $(sel);
        const before = box.children.length;
        rows.slice(shown[key]).forEach((row, i) => box.insertAdjacentHTML("beforeend", render(row, shown[key] + i)));
        for (const el of [...box.children].slice(before)) el.classList?.add("drop");
        shown[key] = rows.length;
        box.closest(".plan-sec").hidden = false;
      };
      grow(".plan-table tbody", plan.understanding, "understanding",
        (u) => `<tr><td>${esc(u.quote)}</td><td>${esc(u.reading)}</td></tr>`);
      grow(".plan-route", plan.steps, "steps",
        (s, i) => `${i ? "<i>→</i>" : ""}<span>${esc(s.title)}</span>`);
      grow(".plan-asks", plan.openQuestions, "asks",
        (q) => `<div class="plan-ask"><span class="q">?</span><div><b>${esc(q.question)}</b><span>${esc(q.reason ?? "")}</span></div></div>`);
      place();
    },

    /* 刷新页面回来的那一下不重演:已经搭过了就直接是右上角那张。 */
    restore(state, status) {
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
    async toMini(status) {
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
      card.classList.add("morph");
      void card.offsetHeight;
      card.classList.remove("open"); card.classList.add("mini");
      card.style.padding = MINI.pad;
      body.style.maxHeight = "0px"; body.style.opacity = "0"; body.style.marginTop = "0px";
      pin({ ...target, left: leftInset() + (innerWidth - leftInset() - target.width) / 2, top: centerTop(target.height) });
      await settle();
      finishText();
      card.classList.remove("morph");
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

    status(text) { if (mini) setSay(text, true); },
    reflow() { if (!moving) place(); },
    onGo: (fn) => go.addEventListener("click", fn),
    onClose: (fn) => close.addEventListener("click", fn),
  };
}

/* 说明是一段一段的,**重点**加粗,「- 」开头的排成一条条。 */
export function rich(text) {
  return String(text).split(/\n{2,}/).map((block) => {
    const lines = block.split("\n");
    const bold = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    if (lines.every((l) => l.trimStart().startsWith("- "))) {
      return `<ul class="says">${lines.map((l) => `<li>${bold(l.trimStart().slice(2))}</li>`).join("")}</ul>`;
    }
    return `<p>${lines.map(bold).join("<br>")}</p>`;
  }).join("");
}
