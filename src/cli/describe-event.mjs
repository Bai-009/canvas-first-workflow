/* 执行者的一个动作印成一行人话。plan:chat 走步时和 executor:step 单跑时共用。 */
const short = (value, n = 90) => {
  const text = JSON.stringify(value);
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

export function describe(event) {
  if (event.kind === "said") return `说:${event.text}`;
  if (event.kind === "bad-args") return `${event.tool} 的参数不是 JSON`;
  if (event.kind === "rejected") return `没收:${event.reasons.join(";")}`;
  if (event.kind === "tool" && event.tool === "search_nodes") {
    const hits = Array.isArray(event.answer) ? event.answer.map((n) => n.displayName).join("、") : short(event.answer);
    return `搜 "${event.args.query}" → ${hits}`;
  }
  if (event.kind === "tool" && event.tool === "describe_node") {
    const where = [event.args.type, event.args.resource, event.args.operation].filter(Boolean).join(" · ");
    const a = event.answer;
    if (a?.error) return `查 ${where} → ${a.error}`;
    if (a?.operations && a.properties?.length === 0) return `查 ${where} → 菜单 ${a.operations.length} 项`;
    return `查 ${where} → ${a.properties.length} 格:${a.properties.map((p) => p.name).join(", ")}`;
  }
  if (event.kind === "submitted") {
    const s = event.submission;
    if (s.kind === "covered") return "交:已经有了";
    const lines = [`交:${s.nodes.length} 个节点`];
    for (const n of s.nodes) lines.push(`  ${n.name} · ${n.type}${n.blanks.length ? ` · 空格:${n.blanks.join(", ")}` : ""}${n.note ? `\n    「${n.note}」` : ""}`);
    for (const e of s.edges ?? []) lines.push(`  ${e.from} →${e.output ? `(${e.output})` : ""} ${e.to}`);
    return lines.join("\n");
  }
  return short(event);
}
