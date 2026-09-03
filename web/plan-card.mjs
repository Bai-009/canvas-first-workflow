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
  let mini = false;
  let moving = false;

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
  function fill({ task, speech, plan }) {
    if (task) $(".plan-text").textContent = task;
    const secs = [];
    for (const sec of card.querySelectorAll(".plan-sec")) sec.hidden = true;
    if (speech) {
      $(".plan-says").innerHTML = rich(speech);
      secs.push($(".sec-says"));
    }
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
    return secs;
  }

  return {
    get isMini() { return mini; },

    /* 你按下发送的那一刻卡片就在,里头是你那句话。
       最长的那一段是「什么都还没有」的那一段,那正是最需要有形态的地方。 */
    async ask(text) {
      card.hidden = false;
      card.classList.add("open");
      $(".plan-text").textContent = text;
      for (const sec of card.querySelectorAll(".plan-sec")) sec.hidden = true;
      go.hidden = true;
      close.hidden = true;
      fresh.hidden = true;
      setSay("正在生成方案");
      place();
    },

    /* 交回来了:说明、理解、路线、待确认,一条一条落。 */
    async show(state) {
      await drop(fill(state));
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
      if (!mini) place();
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
