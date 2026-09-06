import type { PlanProposal } from '../../shared/contracts.mjs';
import type { ModelCaller } from '../../shared/model.mjs';
import { draftPlan } from '../../src/plan/partial-plan.mjs';
import { runPlanAgent } from '../../src/plan/plan-agent.mjs';

declare const external: unknown;
// @ts-expect-error 外部未知对象不是已验证的模型消息。
const uncheckedCaller: ModelCaller = async () => external;
const draft = draftPlan({ goal: '一半的方案', steps: [{ ref: 's1', title: '读取' }] });
// @ts-expect-error 流式展示的半份草稿不能替代正式计划。
const plan: PlanProposal = draft;
declare const callModel: ModelCaller;
runPlanAgent({ callModel, messages: [{ role: 'user', content: '处理 PDF' }] });
// @ts-expect-error 工具反馈必须保留对应的调用编号。
runPlanAgent({ callModel, messages: [{ role: 'tool', content: '已收到' }] });
void uncheckedCaller;
void plan;
