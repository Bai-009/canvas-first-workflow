import type { StepContext, StepResult } from "../../shared/contracts.mjs";
/* 测试用的固定答复,不是执行者。问它做哪一步,它就交回一个写代码节点,名字明写"固定答复",代码是一行注释,
   上游有节点就接一条线过来;画布上已经有这一步的节点、又没有新批注,就说 covered。
   它不看方案的意思,只为了让状态机动起来能被看见。
   用法:EXECUTOR_MODULE=fixtures/doubles/fixed-executor.mjs npm run plan:chat */
export default async function fixedExecutor(context: StepContext): Promise<StepResult> {
  const { step, canvas, openQuestions, instructions } = context;
  const already = canvas.nodes.some((node) => node.step === step.ref);
  if (already && instructions.length === 0) return { kind: "covered" };
  const name = `${step.ref}-固定答复`;
  const edges = step.dependsOn.flatMap((dep) =>
    canvas.nodes.filter((node) => node.step === dep).map((node) => ({ from: node.name, to: name }))
  );
  return {
    kind: "patch",
    nodes: [
      {
        name,
        step: step.ref,
        type: "code",
        params: { code: `// 固定答复,不是执行者写的:${step.title}` },
        blanks: [],
        note: `固定答复。没答的问题:${openQuestions.map((q) => q.ref).join(",") || "无"};批注:${instructions.length}`,
      },
    ],
    edges,
  };
}
