/* Hallmark · component: session navigation · existing Canvas theme
 * pre-emit critique: P4 H4 E4 S4 R5 V3 */
const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LAST = "canvasflow:last-session";
export const draftKey = (id) => `canvasflow:drafts:${id}`;
export const readLocal = (key, fallback = "") => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
export const writeLocal = (key, value) => { try { localStorage.setItem(key, value); } catch {} };

export async function sessionRequest(path, { method = "GET", data } = {}) {
  const response = await fetch(path, { signal: AbortSignal.timeout(15000), method, headers: { "content-type": "application/json" }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "会话操作未完成，请重试。");
  return result;
}
export async function chooseSession() {
  const listing = await sessionRequest("/api/sessions");
  const requested = new URLSearchParams(location.search).get("session") || readLocal(LAST);
  const current = listing.sessions.find((item) => item.id === requested) || listing.sessions[0]
    || { id: (await sessionRequest("/api/sessions", { method: "POST" })).id };
  const url = new URL(location.href);
  url.searchParams.set("session", current.id);
  history.replaceState(null, "", url);
  writeLocal(LAST, current.id);
  return { id: current.id, listing };
}

export function createSessionSidebar({ id, listing, onResize, onRetrySave }) {
  const root = document.getElementById("sessions"), list = document.getElementById("session-list");
  const retrySave = document.getElementById("session-retry-save");
  const error = document.getElementById("session-error"), toggle = document.getElementById("sidebar-toggle");
  const trashToggle = document.getElementById("session-trash");
  const dialog = document.getElementById("session-rename"), name = document.getElementById("session-name");
  const dialogTitle = document.getElementById("session-rename-title"), dialogError = document.getElementById("session-name-error");
  const primary = dialog.querySelector('[value="save"]');
  let submitting = false;
  let data = listing, trash = false, renaming = null, operating = false;
  const collapsed = readLocal("canvasflow:sidebar", matchMedia("(max-width: 760px)").matches ? "closed" : "open") === "closed";
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  const navigate = (target) => { const url = new URL(location.href); url.searchParams.set("session", target); writeLocal(LAST, target); location.assign(url); };
  const message = (text) => { error.textContent = text; error.hidden = !text; };
  const render = () => {
    list.innerHTML = (trash ? data.trash : data.sessions).map((item) => `<div class="session-row"${item.id === id ? ' data-current="true"' : ''}>
      ${trash ? `<span class="session-link"><span>${esc(item.title)}</span></span><button class="session-restore" data-restore="${esc(item.id)}" aria-label="恢复 ${esc(item.title)}">恢复</button>` : `<a class="session-link" href="?session=${esc(item.id)}"${item.id === id ? ' aria-current="page"' : ''} title="${esc(item.title)}"><span>${esc(item.title)}</span>${item.turn !== "user" ? '<i class="session-working" aria-label="正在处理"></i>' : ''}</a>
      <details class="session-menu"><summary aria-label="管理 ${esc(item.title)}"><svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="10" r="1.1"/><circle cx="10" cy="10" r="1.1"/><circle cx="15" cy="10" r="1.1"/></svg></summary><div class="session-actions"><button data-rename="${esc(item.id)}">重命名</button><button data-delete="${esc(item.id)}">删除</button></div></details>`}
    </div>`).join("") || `<p class="session-empty">${trash ? "没有已删除的会话" : "从一条新工作流开始"}</p>`;
    document.getElementById("session-list-title").textContent = trash ? "已删除" : "工作流";
    trashToggle.textContent = trash ? "返回工作流" : "已删除";
    if (data.warnings?.length) message(data.warnings.join("\n"));
    const current = data.sessions.find((item) => item.id === id);
    if (current) document.title = `${current.title} · CanvasFlow`;
  };
  async function act(operation) {
    if (operating) return;
    operating = true; root.dataset.state = "loading"; root.setAttribute("aria-busy", "true");
    message("");
    try { await operation(); data = await sessionRequest("/api/sessions"); render(); root.dataset.state = "success"; }
    catch (e) { message(e.message); root.dataset.state = "error"; }
    finally { operating = false; root.setAttribute("aria-busy", "false"); }
  }
  retrySave.addEventListener("click", () => act(onRetrySave));
  const openNameDialog = (target = null) => {
    if (operating || submitting) return;
    renaming = target;
    dialogTitle.textContent = target ? "重命名工作流" : "新建工作流";
    primary.textContent = target ? "保存" : "创建";
    name.value = target ? data.sessions.find((item) => item.id === target).title : "新工作流";
    name.setCustomValidity("");
    dialogError.hidden = true; dialogError.textContent = "";
    dialog.showModal(); name.focus(); name.select();
  };
  document.getElementById("fresh").addEventListener("click", () => openNameDialog());
  toggle.addEventListener("click", () => {
    const closed = document.body.classList.toggle("sidebar-collapsed");
    toggle.setAttribute("aria-expanded", String(!closed)); writeLocal("canvasflow:sidebar", closed ? "closed" : "open"); onResize();
  });
  trashToggle.addEventListener("click", () => { trash = !trash; render(); });
  list.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); navigate(new URL(link.href).searchParams.get("session")); }
    const button = event.target.closest("button");
    if (!button) return;
    const target = button.dataset.rename || button.dataset.delete || button.dataset.restore;
    if (button.dataset.rename) {
      button.closest("details").open = false;
      openNameDialog(target);
    } else if (button.dataset.delete) act(async () => {
      await sessionRequest(`/api/sessions/${target}`, { method: "DELETE" });
      if (target === id) {
        const next = (await sessionRequest("/api/sessions")).sessions[0];
        navigate(next?.id || (await sessionRequest("/api/sessions", { method: "POST" })).id);
      }
    });
    else act(async () => { await sessionRequest(`/api/sessions/${target}/restore`, { method: "POST" }); });
  });
  name.addEventListener("input", () => name.setCustomValidity(""));
  dialog.addEventListener("cancel", (event) => { if (submitting) event.preventDefault(); });
  dialog.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || operating) return;
    if (event.submitter?.value === "cancel") return dialog.close();
    const title = name.value.trim();
    if (!title) { name.setCustomValidity("请输入工作流名称"); name.reportValidity(); return; }
    submitting = true;
    dialog.setAttribute("aria-busy", "true");
    for (const control of dialog.querySelectorAll("input,button")) control.disabled = true;
    dialogError.hidden = true;
    try {
      if (renaming) {
        await sessionRequest(`/api/sessions/${renaming}`, { method: "PATCH", data: { title } });
        dialog.close();
        await act(async () => {});
      } else {
        const created = await sessionRequest("/api/sessions", { method: "POST", data: { title } });
        dialog.close(); navigate(created.id);
      }
    } catch (e) { dialogError.textContent = e.message; dialogError.hidden = false; }
    finally {
      submitting = false; dialog.setAttribute("aria-busy", "false");
      for (const control of dialog.querySelectorAll("input,button")) control.disabled = false;
    }
  });
  document.addEventListener("click", (event) => { if (!event.target.closest(".session-menu")) for (const menu of list.querySelectorAll("details[open]")) menu.open = false; });
  render();
  return { update(next) { if (next.sessions) { data = { ...data, ...next }; render(); } },
    left: () => document.body.classList.contains("sidebar-collapsed") || innerWidth <= 760 ? 0 : root.offsetWidth,
    saved(text, failed = false) { const el = document.getElementById("session-save"); el.textContent = text; el.dataset.error = String(failed); retrySave.hidden = !failed; },
  };
}
