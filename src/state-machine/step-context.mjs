/* 状态机接方案的那一段。方案是 Plan Agent 过了闸门交出来的整份 JSON,状态机从里面读三样:
   走步的顺序(按"接在谁后面")、每一步挂着哪些没答的问题(按"影响到哪几步")、
   以及每一步开工时摆在执行者桌上的五样。方案里其余的字(意图、形态、回读)状态机不解读,
   整份原样递给执行者。 */

/* 走步的波次:前序都走过了的,凑成一波,这一波里的步互不依赖,可以同时走。
   一波走完才开下一波。同一波内按方案里的先后。
   接了一个不存在的编号、或者绕成了圈,方案闸门本该拦住;这里再守一道,免得走步死循环。 */
export function stepWaves(plan) {
  const steps = plan.steps;
  const known = new Set(steps.map((step) => step.ref));
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!known.has(dep)) throw new Error(`${step.ref} 接在 ${dep} 后面,方案里没有 ${dep}`);
    }
  }
  const done = new Set();
  const waves = [];
  while (done.size < steps.length) {
    const wave = steps.filter(
      (step) => !done.has(step.ref) && step.dependsOn.every((dep) => done.has(dep))
    );
    if (!wave.length) {
      const stuck = steps.filter((step) => !done.has(step.ref)).map((step) => step.ref);
      throw new Error(`这几步互相等着,走不下去:${stuck.join("、")}`);
    }
    waves.push(wave.map((step) => step.ref));
    for (const step of wave) done.add(step.ref);
  }
  return waves;
}

/* 摊平的走步顺序。只有一条走法,波次是它的唯一来源。 */
export const stepOrder = (plan) => stepWaves(plan).flat();

/* 挂在某一步上的、还没答的问题。 */
export function questionsFor(plan, stepRef) {
  return plan.openQuestions.filter((question) => question.affects.includes(stepRef));
}

/* 某一步开工时,桌上的五样。canvas 原样递过去,它长什么样由画布那一段定;
   annotations 是用户挂在步骤上的批注,形状 { step, text }。 */
export function assembleTable(plan, stepRef, { canvas, annotations = [] }) {
  const step = plan.steps.find((candidate) => candidate.ref === stepRef);
  if (!step) throw new Error(`方案里没有 ${stepRef} 这一步`);
  return {
    plan: structuredClone(plan),
    step: structuredClone(step),
    canvas: structuredClone(canvas),
    openQuestions: questionsFor(plan, stepRef).map((question) => structuredClone(question)),
    instructions: annotations
      .filter((note) => note.step === stepRef)
      .map((note) => note.text),
  };
}
