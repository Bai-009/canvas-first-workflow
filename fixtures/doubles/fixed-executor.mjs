/* 测试用的固定答复,不是执行者。问它做哪一步,它就交回一个占位节点,类型明写"固定答复",
   上游有节点就接一条线过来;画布上已经有这一步的节点、又没有新批注,就说 covered。
   它不看方案的意思,不查平台,只为了让状态机动起来能被看见。
   用法:EXECUTOR_MODULE=fixtures/doubles/fixed-executor.mjs npm run plan:chat */
export default async function fixedExecutor(context) {
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
        type: "固定答复(不是真节点)",
        params: { 标题: step.title, 批注: instructions },
        blanks: openQuestions.map((question) => question.ref),
      },
    ],
    edges,
  };
}
