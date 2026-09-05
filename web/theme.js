/* 在首屏绘制前恢复主题；切换独立于工作流服务，连接中断也能使用。 */
(() => {
  const key = 'canvasflow:theme';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  let choice;
  try { choice = localStorage.getItem(key); } catch {}
  if (!['light', 'dark'].includes(choice)) choice = null;
  const apply = () => {
    const dark = (choice ?? (system.matches ? 'dark' : 'light')) === 'dark';
    root.dataset.theme = dark ? 'dark' : 'light';
    for (const input of document.querySelectorAll('.theme-option input')) {
      input.checked = input.value === root.dataset.theme;
    }
  };
  apply();
  system.addEventListener('change', () => { if (!choice) apply(); });
  addEventListener('storage', (event) => {
    if (event.key !== key && event.key !== null) return;
    choice = ['light', 'dark'].includes(event.newValue) ? event.newValue : null;
    apply();
  });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    const settings = document.getElementById('session-settings');
    settings?.addEventListener('change', (event) => {
      if (!event.target.matches('.theme-option input')) return;
      choice = event.target.value;
      try { localStorage.setItem(key, choice); } catch {}
      apply();
    });
    document.addEventListener('click', (event) => {
      if (settings && !settings.contains(event.target)) settings.open = false;
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && settings?.open) {
        settings.open = false;
        settings.querySelector('summary').focus();
      }
    });
  });
})();
