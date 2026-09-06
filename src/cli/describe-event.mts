import type { AgentEvent } from '../../shared/workflow.mjs';
import { isRecord } from '../../shared/json.mjs';
interface DisplayNode { name: string; type: string; blanks: string[]; note?: unknown }
interface DisplayEdge { from: string; to: string; output?: unknown }
const isNode = (value: unknown): value is DisplayNode => isRecord(value) && typeof value.name === 'string'
  && typeof value.type === 'string' && Array.isArray(value.blanks) && value.blanks.every((blank: unknown) => typeof blank === 'string');
const isEdge = (value: unknown): value is DisplayEdge => isRecord(value) && typeof value.from === 'string' && typeof value.to === 'string';
/* 执行者的一个动作印成一行人话。plan:chat 走步时和 executor:step 单跑时共用。 */
const short = (value: unknown, n = 90) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

export function describe(event: AgentEvent) {
  if (event.kind === "said") return `说:${event.text}`;
  if (event.kind === "bad-args") return `${event.tool} 的参数不是 JSON`;
  if (event.kind === "rejected") return `没收:${event.reasons.join(";")}`;
  if (event.kind === "tool") return `叫了 ${event.tool} → ${short(event.answer)}`;
  if (event.kind === "submitted") {
    const s = event.submission;
    if (!isRecord(s)) return short(event);
    if (s.kind === "covered") return "交:已经有了";
    if (!Array.isArray(s.nodes) || !s.nodes.every(isNode)) return short(event);
    const edges: unknown = s.edges ?? [];
    if (!Array.isArray(edges) || !edges.every(isEdge)) return short(event);
    const lines = [`交:${s.nodes.length} 个节点`];
    for (const n of s.nodes) lines.push(`  ${n.name} · ${n.type}${n.blanks.length ? ` · 空格:${n.blanks.join(", ")}` : ""}${n.note ? `\n    「${n.note}」` : ""}`);
    for (const e of edges) lines.push(`  ${e.from} →${e.output ? `(${e.output})` : ""} ${e.to}`);
    return lines.join("\n");
  }
  return short(event);
}
