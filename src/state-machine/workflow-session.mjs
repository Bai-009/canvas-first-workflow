import { createPlanSession } from "../plan/plan-session.mjs";
import { stepWaves, assembleTable } from "./step-context.mjs";

/* 整条链的会话:Plan 那一半原样用 createPlanSession,这里往下长一段。
   手里多攥三样:画布、批注、跑过的记录。多三个动作:开始、批注、停。
   轮到谁只有三种:用户、Plan Agent、执行者。谁在跑,别人的动作一律不收;要插手先停。

   执行者是一个插口:async (context, { signal }) => 结果。context 就是拼好的上下文
   (整份方案、这一步、画布、这一步没答的问题、这一步的批注)。结果两种:
     { kind: "patch", nodes: [{ name, step, type, params, blanks, note }], edges: [{ from, to, output }] }
       —— 这一步的全部节点,整份重出;状态机换掉画布上这一步原有的节点
     { kind: "covered" } —— 画布上已经有了,不动
   结果好不好状态机不看;只查机器缺了转不动的那几条(见 checkResult),查不过就停在这一步。 */
export function createWorkflowSession({ callModel, executor = null, systemPrompt }) {
  const plan = createPlanSession(systemPrompt ? { callModel, systemPrompt } : { callModel });
  const canvas = { nodes: [], edges: [], version: 0 };
  const annotations = [];
  const runs = [];
  let controller = null;

  const turn = () => (plan.running ? "plan" : controller ? "executor" : "user");
  const requireUserTurn = (action) => {
    const now = turn();
    if (now === "user") return;
    const runner = now === "plan" ? "Plan Agent 在跑" : "执行者在跑";
    throw new Error(`${runner},${action}要等它回来,或者先按停`);
  };

  return {
    /* Plan 那一半原样透出 */
    get transcript() { return plan.transcript; },
    get versions() { return plan.versions; },
    get currentPlan() { return plan.currentPlan; },
    get revision() { return plan.revision; },

    get turn() { return turn(); },
    get canvas() { return structuredClone(canvas); },
    get annotations() { return structuredClone(annotations); },
    get runs() { return structuredClone(runs); },
    get hasExecutor() { return typeof executor === "function"; },

    async say(text, options) {
      requireUserTurn("说话");
      return plan.say(text, options);
    },

    /* 批注挂在步骤号上,不挂在节点上:节点重建它还在。 */
    annotate(step, text) {
      requireUserTurn("批注");
      const current = plan.currentPlan;
      if (!current) throw new Error("还没有方案,没有步骤可以批");
      if (!current.steps.some((candidate) => candidate.ref === step)) {
        throw new Error(`方案里没有 ${step} 这一步`);
      }
      const note = String(text ?? "").trim();
      if (!note) throw new Error("批注是空的");
      annotations.push({ step, text: note });
      return structuredClone(annotations);
    },

    /* 按开始:按波次走。一波里的步互不依赖,同时交给执行者;一波走完才开下一波。
       同一波里的步拿到的是这一波开始前的画布 —— 它们本来就互不依赖,看不见对方是对的。
       收回的改动按波内先后一条一条查、一条一条进画布,顺序是定的。
       每次开始都从头走;没变的步执行者会说已经有了。 */
    async start() {
      requireUserTurn("开始");
      const current = plan.currentPlan;
      if (!current) throw new Error("还没有方案,先在主输入框说一句");
      if (typeof executor !== "function") throw new Error("执行者的位置空着,还没插东西进来");

      controller = new AbortController();
      const { signal } = controller;
      const run = { revision: plan.revision, steps: [], endedBy: null, problems: [] };
      try {
        waves: for (const wave of stepWaves(current)) {
          const settled = await Promise.all(
            wave.map(async (ref) => {
              const context = assembleTable(current, ref, { canvas, annotations });
              try {
                return { ref, result: await executor(context, { signal }) };
              } catch (error) {
                return { ref, error };
              }
            })
          );
          for (const { ref, result, error } of settled) {
            if (error) {
              if (signal.aborted || error?.name === "AbortError") {
                run.steps.push({ ref, outcome: "stopped", canvasVersion: canvas.version });
                run.endedBy = "stopped";
              } else {
                run.steps.push({ ref, outcome: "failed", canvasVersion: canvas.version, error: error.message });
                run.endedBy = "error";
              }
              break waves;
            }
            /* 执行者不理会停止信号、停了以后还交回东西的,一样不收:停了画布就停在上次提交 */
            if (signal.aborted) {
              run.steps.push({ ref, outcome: "stopped", canvasVersion: canvas.version });
              run.endedBy = "stopped";
              break waves;
            }
            const reasons = checkResult(result, ref, canvas);
            if (reasons.length) {
              run.steps.push({ ref, outcome: "rejected", canvasVersion: canvas.version, reasons });
              run.endedBy = "rejected";
              break waves;
            }
            if (result.kind === "covered") {
              run.steps.push({ ref, outcome: "covered", canvasVersion: canvas.version });
              continue;
            }
            commit(canvas, ref, result);
            run.steps.push({
              ref,
              outcome: "done",
              canvasVersion: canvas.version,
              nodes: result.nodes.map((node) => node.name),
            });
          }
        }
        if (!run.endedBy) {
          run.endedBy = "finished";
          run.problems = wholeCanvasProblems(current, canvas);
        }
      } finally {
        controller = null;
        runs.push(run);
      }
      return structuredClone(run);
    },

    /* 停:谁在跑就停谁。返回停掉的是谁;没人在跑返回 false。 */
    stop() {
      if (controller) {
        controller.abort();
        return "executor";
      }
      return plan.stop() ? "plan" : false;
    },
  };
}

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/* 画布闸门里机器能查的那几条。节点类型在不在平台目录里、必填的格填没填,要等执行者那一段带着目录来。 */
export function checkResult(result, ref, canvas) {
  if (!isPlainObject(result)) return ["交回的不是一个对象"];
  if (result.kind === "covered") return [];
  if (result.kind !== "patch") return [`交回的 kind 是 ${JSON.stringify(result.kind)},只认 patch 和 covered`];

  const reasons = [];
  const { nodes, edges = [] } = result;
  if (!Array.isArray(nodes) || nodes.length === 0) return ["改动里没有节点;这一步不用做的话该交 covered"];
  if (!Array.isArray(edges)) return ["edges 不是数组"];

  const seen = new Set();
  const others = new Map(canvas.nodes.filter((node) => node.step !== ref).map((node) => [node.name, node.step]));
  nodes.forEach((node, index) => {
    const label = node?.name ? `节点 ${node.name}` : `第 ${index + 1} 个节点`;
    if (!isPlainObject(node)) return reasons.push(`${label} 不是对象`);
    if (typeof node.name !== "string" || !node.name) reasons.push(`${label} 缺 name`);
    if (typeof node.type !== "string" || !node.type) reasons.push(`${label} 缺 type`);
    if (node.step !== ref) reasons.push(`${label} 标的是 ${JSON.stringify(node.step)},这一轮做的是 ${ref}`);
    if (!isPlainObject(node.params)) reasons.push(`${label} 的 params 不是对象`);
    if (!Array.isArray(node.blanks) || node.blanks.some((blank) => typeof blank !== "string")) {
      reasons.push(`${label} 的 blanks 不是字符串数组`);
    }
    if (typeof node.name === "string" && node.name) {
      if (seen.has(node.name)) reasons.push(`节点名 ${node.name} 重复`);
      seen.add(node.name);
      if (others.has(node.name)) reasons.push(`节点名 ${node.name} 已被 ${others.get(node.name)} 用了`);
    }
  });
  if (reasons.length) return reasons;

  const mine = new Set(nodes.map((node) => node.name));
  const all = new Set([...others.keys(), ...mine]);
  for (const edge of edges) {
    if (!isPlainObject(edge) || typeof edge.from !== "string" || typeof edge.to !== "string") {
      reasons.push(`有一条线不是 { from, to }:${JSON.stringify(edge)}`);
      continue;
    }
    const label = `线 ${edge.from}→${edge.to}`;
    if (edge.from === edge.to) reasons.push(`${label} 接到了自己`);
    if (!all.has(edge.from) || !all.has(edge.to)) reasons.push(`${label} 接了不存在的节点`);
    else if (!mine.has(edge.from) && !mine.has(edge.to)) reasons.push(`${label} 两头都不是 ${ref} 的节点`);
  }
  return reasons;
}

/* 换掉这一步原有的节点。线的归属:进这一步的线由这一步自己在改动里声明,所以老的进线全部去掉、
   换成改动里的;出这一步的线是下游声明的,只要这头的节点名还在(原地改),就留着;
   名字没了的,碰到它的线一起去掉,下游那一步重走时会看见自己没接上。版本加一。 */
function commit(canvas, ref, patch) {
  const oldIds = new Set(canvas.nodes.filter((node) => node.step === ref).map((node) => node.name));
  const nodes = [
    ...canvas.nodes.filter((node) => !oldIds.has(node.name)),
    ...patch.nodes.map((node) => structuredClone(node)),
  ];
  const live = new Set(nodes.map((node) => node.name));
  const kept = canvas.edges.filter(
    (edge) => !oldIds.has(edge.to) && live.has(edge.from) && live.has(edge.to)
  );
  const declared = patch.edges ?? [];
  const seen = new Set();
  canvas.nodes = nodes;
  canvas.edges = [...kept, ...declared].filter((edge) => {
    const key = `${edge.from}→${edge.to}#${edge.output ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  canvas.version += 1;
}

/* 整轮走完,拿方案对着整张画布查一遍。查的是形状:每一步在画布上有没有节点,
   接在谁后面的有没有一条线真的从那一步接过来。查出来的只记在这一轮的记录里,先不自动发回。 */
export function wholeCanvasProblems(plan, canvas) {
  const problems = [];
  const ids = new Set(canvas.nodes.map((node) => node.name));
  const nodesOf = (ref) => canvas.nodes.filter((node) => node.step === ref).map((node) => node.name);
  for (const step of plan.steps) {
    const mine = nodesOf(step.ref);
    if (mine.length === 0) {
      problems.push(`${step.ref} 在画布上没有节点`);
      continue;
    }
    for (const dep of step.dependsOn) {
      const upstream = new Set(nodesOf(dep));
      const linked = canvas.edges.some((edge) => upstream.has(edge.from) && mine.includes(edge.to));
      if (!linked) problems.push(`${step.ref} 接在 ${dep} 后面,画布上却没有一条线从 ${dep} 接到 ${step.ref}`);
    }
  }
  for (const edge of canvas.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) problems.push(`线 ${edge.from}→${edge.to} 接了不存在的节点`);
  }
  return problems;
}
