// 调用点的选择器对应本组件创建的固定模板；缺失时明确暴露模板与逻辑的不一致。
export function element<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const found = root.querySelector<E>(selector);
  if (!found) throw new Error(`界面缺少元素：${selector}`);
  return found;
}

/* 过渡时长写在样式里(--send-fade / --send-close),代码从那儿读。
   两边各写一份迟早对不上:改了样式忘了改代码,字还没淡完框就开始收。 */
export function motionMs(name: string, fallback: number): number {
  // 测试跑在没有浏览器的地方,那儿没有样式可读,用兜底值。
  if (typeof getComputedStyle !== "function" || typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ms = raw.endsWith("ms") ? parseFloat(raw) : raw.endsWith("s") ? parseFloat(raw) * 1000 : NaN;
  return Number.isFinite(ms) ? ms : fallback;
}
