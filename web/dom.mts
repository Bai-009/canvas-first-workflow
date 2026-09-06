// 调用点的选择器对应本组件创建的固定模板；缺失时明确暴露模板与逻辑的不一致。
export function element<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const found = root.querySelector<E>(selector);
  if (!found) throw new Error(`界面缺少元素：${selector}`);
  return found;
}
