/* Plan 卡片。画布还空着的时候注意力本来就在中央,所以它占中央;
   谈完按开始,同一张卡收窄、正文塌掉、再飞到右上角常驻报状态。
   点它,它飞回中央,画布同时往后退——一进一出,读起来是一次交换。

   两条规矩来自原型(prototype/修改本.md):
   一、同一张卡上两个几何动画不叠:先塌正文,停一拍,再飞。
   二、飞行途中高度是显式写死的,不然正文一重排就顶成一条又高又窄的白板。 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const MINI = { w: 320, right: 24, top: 68, pad: "13px 15px 12px" };
const OPEN = { w: 560, pad: "18px 20px 16px" };

export function createPlanCard({ card, stage, onStart }) {
  const $ = (sel) => card.querySelector(sel);
  const body = $(".plan-body");
  const say = $(".plan-say");
  const dot = $(".plan-dot");
  const go = $(".plan-go");
  const close = $(".plan-close");
  const fresh = $(".plan-new");
  const again = $(".plan-again");
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
    ? `<div class="plan-turn me">${esc(t.text)}</div>`
    : `<div class="plan-turn plan-says">${rich(t.text)}</div>`);

  /* 整条重画。新的那条在最底下,所以画完滚到底。 */
  function paintChat() {
    const box = chatBox();
    box.innerHTML = thread.map(turnHtml).join("");
    $(".sec-chat").hidden = thread.length === 0;
    box.scrollTop = box.scrollHeight;
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
    box.scrollTop = box.scrollHeight;
    followChat();
  }

  const place = () => {
    if (mini) {
      card.style.left = `${innerWidth - MINI.right - MINI.w}px`;
      card.style.top = `${MINI.top}px`;
      card.style.width = `${MINI.w}px`;
    } else {
      card.style.width = `${Math.min(OPEN.w, innerWidth - 48)}px`;
      card.style.left = `${(innerWidth - card.offsetWidth) / 2}px`;
      card.style.top = `${Math.max(24, (innerHeight - card.offsetHeight) / 2 - 60)}px`;
    }
  };

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
    for (const sec of card.querySelectorAll(".plan-sec")) sec.hidden = true;
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
    if (thread.length) {
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
      for (const sec of card.querySelectorAll(".plan-sec")) sec.hidden = true;
      for (const sel of [".plan-table tbody", ".plan-route", ".plan-asks"]) $(sel).innerHTML = "";
      shown = { says: 0, understanding: 0, steps: 0, asks: 0 };
      /* 按下发送这句话就上墙。模型要想三十秒,不能让它先消失三十秒。 */
      thread = [...thread, { who: "user", text }];
      paintChat();
      followChat();
      go.hidden = true;
      close.hidden = true;
      fresh.hidden = true;
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
      fill(state);
      card.hidden = false;
      card.classList.remove("open");
      mini = true;
      card.classList.add("mini");
      card.style.padding = MINI.pad;
      card.style.height = "auto";
      go.hidden = true;
      close.hidden = true;
      fresh.hidden = false;
      place();
      setSay(status, true);
    },

    /* 按开始:先塌正文,停一拍,再飞。落位之后它就是右上角那个需求框。 */
    async toMini(status) {
      if (mini || moving) return;
      moving = true;
      go.hidden = true;
      close.hidden = true;
      card.style.height = `${card.offsetHeight}px`;
      card.classList.add("morph");
      await wait(20);
      body.style.maxHeight = "0px";
      body.style.opacity = "0";
      body.style.marginTop = "0px";
      card.classList.remove("open");
      card.style.height = `${card.scrollHeight}px`;
      await wait(420);
      mini = true;
      card.classList.add("mini");
      card.style.padding = MINI.pad;
      place();
      card.style.height = "auto";
      const h = card.offsetHeight;
      card.style.height = `${h}px`;
      await wait(620);
      card.style.height = "auto";
      card.classList.remove("morph");
      /* 落位后再关一次:这一趟里如果还有没跑完的内容渲染,别让它把入口又亮出来。 */
      go.hidden = true;
      fresh.hidden = false;
      setSay(status, true);
      moving = false;
    },

    /* 点需求框:卡片飞回中央,画布同时往后退。 */
    async toCenter() {
      if (!mini || moving) return;
      moving = true;
      stage.classList.add("swap", "recede");
      card.style.height = `${card.offsetHeight}px`;
      card.classList.add("morph");
      mini = false;
      card.classList.remove("mini");
      card.style.padding = OPEN.pad;
      place();
      card.classList.add("open");
      fresh.hidden = true;
      body.style.maxHeight = "";
      body.style.opacity = "";
      body.style.marginTop = "";
      await wait(20);
      card.style.height = `${card.scrollHeight}px`;
      await wait(620);
      card.style.height = "auto";
      card.classList.remove("morph");
      close.hidden = false;
      place();
      moving = false;
    },

    async back() {
      if (mini || moving) return;
      stage.classList.remove("recede");
      await this.toMini(say.textContent);
      stage.classList.remove("swap");
    },

    status(text) { if (mini) setSay(text, true); },
    reflow() { if (!moving) place(); },
    onGo: (fn) => go.addEventListener("click", fn),
    onClose: (fn) => close.addEventListener("click", fn),
    onNew: (fn) => fresh.addEventListener("click", (e) => { e.stopPropagation(); fn(); }),
    onAgain: (fn) => again.addEventListener("click", (e) => { e.stopPropagation(); fn(); }),
    /* 停在某一步的时候右上角多一个「重走」:停了总得有个出口。 */
    canRerun(on) { again.hidden = !on; },
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
