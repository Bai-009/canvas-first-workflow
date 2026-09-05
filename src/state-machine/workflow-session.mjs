import { checkAgainstNodeTable, checkFlow } from "../nodes/check-nodes.mjs";
import { createPlanSession } from "../plan/plan-session.mjs";
import { stepWaves, assembleTable } from "./step-context.mjs";
import { inspectCanvas, inspectRevision } from "./workflow-revision.mjs";
import { findNodeDefinition } from "../nodes/node-table.mjs";

/* 整条链的会话:Plan 那一半原样用 createPlanSession,这里往下长一段。
   手里多攥三样:画布、批注、跑过的记录。多三个动作:开始、批注、停。
   执行权在用户、Plan Agent、逐步构建和整图修订之间切换。谁在跑，其他写入动作不收；要插手先停。

   执行者是一个插口:async (context, { signal }) => 结果。context 就是拼好的上下文
   (整份方案、这一步、画布、这一步没答的问题、这一步的批注)。结果两种:
     { kind: "patch", nodes: [{ name, step, type, params, blanks, note }], edges: [{ from, to, output }] }
       —— 这一步的全部节点,整份重出;状态机换掉画布上这一步原有的节点
     { kind: "covered" } —— 画布上已经有了,不动
   结果好不好状态机不看;只查机器缺了转不动的那几条(见 checkResult),查不过就停在这一步。 */
export function createWorkflowSession({ callModel, executor = null, reviser = null, systemPrompt, savedState }) {
  if (savedState && savedState.formatVersion !== 1) throw new Error("不支持的会话存档版本");
  const plan = createPlanSession({ callModel, ...(systemPrompt ? { systemPrompt } : {}), savedState: savedState?.plan });
  const canvas = structuredClone(savedState?.canvas ?? { nodes: [], edges: [], version: 0 });
  const annotations = structuredClone(savedState?.annotations ?? []);
  const runs = structuredClone(savedState?.runs ?? []);
  const edits = structuredClone(savedState?.edits ?? []);
  let canvasPlanRevision = savedState?.canvasPlanRevision ?? null;
  let activeRun = null;
  // 恢复的是已提交的状态，不复活进程中的 Promise，也不自动重新调用模型。
  if (savedState?.activeRun) {
    runs.push({ ...structuredClone(savedState.activeRun), endedBy: "interrupted" });
    canvasPlanRevision = null;
  }
  for (const edit of edits) if (["processing", "checking"].includes(edit.status)) {
    edit.status = "stopped";
    edit.summary = "服务中断，未完成的修订没有应用；可以重新发送。";
    edit.completedAt = new Date().toISOString();
  }
  let controller = null;
  let operation = null;

  const turn = () => (plan.running ? "plan" : controller ? operation : "user");
  const requireUserTurn = (action) => {
    const now = turn();
    if (now === "user") return;
    const runner = now === "plan" ? "Plan Agent 在跑" : now === "revision" ? "工作流修订在跑" : "执行者在跑";
    throw new Error(`${runner},${action}要等它回来,或者先按停`);
  };
  const requirements = () => edits.filter((edit) => edit.status === "applied" || edit.status === "unchanged")
    .map((edit) => structuredClone({ target: edit.target, text: edit.text }));

  return {
    exportState() {
      return structuredClone({ formatVersion: 1, plan: plan.exportState(), canvas, annotations, runs, edits,
        canvasPlanRevision, activeRun, turn: turn() });
    },
    /* Plan 那一半原样透出 */
    get transcript() { return plan.transcript; },
    get versions() { return plan.versions; },
    get currentPlan() { return plan.currentPlan; },
    get revision() { return plan.revision; },

    get turn() { return turn(); },
    get canvas() { return structuredClone(canvas); },
    get annotations() { return structuredClone(annotations); },
    get runs() { return structuredClone(runs); },
    get edits() { return structuredClone(edits); },
    get canvasPlanRevision() { return canvasPlanRevision; },
    get hasExecutor() { return typeof executor === "function"; },
    get hasReviser() { return typeof reviser === "function"; },

    configure({ node: name, key, value, canvasVersion }) {
      requireUserTurn("配置节点");
      if (canvasVersion !== canvas.version) throw new Error("画布已更新，请重新打开配置后保存");
      const node = canvas.nodes.find((item) => item.name === name);
      const slot = node && findNodeDefinition(node.type)?.slots.find((item) => item.key === key);
      if (!slot) throw new Error("节点或参数已不存在");
      const parsed = slot.kind === "number" ? Number(value) : value;
      if (value === "" || value == null || (slot.kind === "number" && !Number.isFinite(parsed))) throw new Error("参数值无效");
      const candidate = { ...node, params: { ...node.params, [key]: parsed }, blanks: node.blanks.filter((item) => item !== key) };
      const reasons = checkAgainstNodeTable([candidate], [], canvas.nodes);
      if (reasons.length) throw new Error(reasons.join("；"));
      const next = { ...canvas, nodes: canvas.nodes.map((item) => item === node ? candidate : item) };
      const flowProblems = checkFlow(next.nodes, next);
      const existing = new Set(checkFlow(canvas.nodes, canvas));
      const added = flowProblems.filter((problem) => !existing.has(problem));
      if (added.length) throw new Error(added.join("；"));
      canvas.nodes = next.nodes;
      canvas.version += 1;
      return structuredClone(canvas);
    },

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
    async start({ onStep, onWave } = {}) {
      requireUserTurn("开始");
      const current = plan.currentPlan;
      if (!current) throw new Error("还没有方案,先在主输入框说一句");
      if (typeof executor !== "function") throw new Error("执行者的位置空着,还没插东西进来");

      controller = new AbortController();
      operation = "executor";
      canvasPlanRevision = null;
      const { signal } = controller;
      const run = { revision: plan.revision, steps: [], endedBy: null, problems: [] };
      activeRun = run;
      /* 一步一个信号往外发,画布那头照着长。发不出去是画布的事,不能把这一趟带塌。 */
      const record = (entry) => {
        run.steps.push(entry);
        try {
          onStep?.(structuredClone({ step: entry, canvas }));
        } catch {}
      };
      try {
        waves: for (const wave of stepWaves(current)) {
          /* 开工前先喊一声这一波要做哪几步:画布上等着的人得知道当下在做什么。 */
          try { onWave?.([...wave]); } catch {}
          const settled = await Promise.all(
            wave.map(async (ref) => {
              const context = assembleTable(current, ref, { canvas, annotations });
              const confirmed = requirements();
              if (confirmed.length) context.requirements = confirmed;
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
                record({ ref, outcome: "stopped", canvasVersion: canvas.version });
                run.endedBy = "stopped";
              } else {
                record({ ref, outcome: "failed", canvasVersion: canvas.version, error: error.message });
                run.endedBy = "error";
              }
              break waves;
            }
            /* 执行者不理会停止信号、停了以后还交回东西的,一样不收:停了画布就停在上次提交 */
            if (signal.aborted) {
              record({ ref, outcome: "stopped", canvasVersion: canvas.version });
              run.endedBy = "stopped";
              break waves;
            }
            const reasons = checkResult(result, current.steps.find((step) => step.ref === ref), canvas);
            if (reasons.length) {
              record({ ref, outcome: "rejected", canvasVersion: canvas.version, reasons });
              run.endedBy = "rejected";
              break waves;
            }
            if (result.kind === "covered") {
              record({ ref, outcome: "covered", canvasVersion: canvas.version });
              continue;
            }
            commit(canvas, ref, result);
            record({
              ref,
              outcome: "done",
              canvasVersion: canvas.version,
              nodes: result.nodes.map((node) => node.name),
            });
          }
        }
        if (!run.endedBy) {
          run.endedBy = "finished";
          run.problems = [...new Set([...wholeCanvasProblems(current, canvas), ...inspectCanvas(canvas, current)])];
          if (!run.problems.length) canvasPlanRevision = plan.revision;
        }
      } finally {
        controller = null;
        operation = null;
        runs.push(run);
        activeRun = null;
      }
      return structuredClone(run);
    },

    /* 节点是指令的发起点，修订对象是已构建的完整工作流。
       普通函数先同步查请求并占住执行权，服务器只有接受成功后才返回成功响应。
       模型只拿快照；整图候选过闸后才一次提交，Plan 会话不参与这次修改。 */
    revise(request, { onEdit } = {}) {
      requireUserTurn("修订工作流");
      if (!isPlainObject(request)) throw new Error("修订请求不是对象");
      if (typeof reviser !== "function") throw new Error("工作流修订者未接入");
      const current = plan.currentPlan;
      if (!current) throw new Error("还没有方案，先生成并构建工作流");
      if (canvasPlanRevision !== plan.revision) throw new Error("当前方案尚未完成构建，请先应用当前方案");
      if (!Number.isInteger(request.canvasVersion) || request.canvasVersion !== canvas.version) throw new Error("画布已更新，请基于最新画布重新发送");
      const target = canvas.nodes.find((node) => node.name === request.node);
      if (!target || target.step !== request.step || !current.steps.some((step) => step.ref === target.step)) {
        throw new Error("目标节点已不存在或所属步骤已改变，请重新选择");
      }
      if (typeof request.text !== "string" || !request.text.trim()) throw new Error("修订指令是空的");
      if (current.steps.some((step) => !canvas.nodes.some((node) => node.step === step.ref))) throw new Error("工作流尚未完成构建");

      const startedAt = Date.now();
      const edit = {
        id: `edit-${edits.length + 1}`, target: { node: target.name, step: target.step },
        text: request.text.trim(), status: "processing", summary: "正在结合完整工作流处理指令",
        changes: [], review: [], baseVersion: canvas.version, canvasVersion: canvas.version,
        planRevision: plan.revision, createdAt: new Date(startedAt).toISOString(),
      };
      const context = {
        plan: current, canvas: structuredClone(canvas), target: structuredClone(edit.target),
        instruction: { id: edit.id, text: edit.text }, requirements: requirements(),
        annotations: structuredClone(annotations),
        history: {
          runs: structuredClone(runs.slice(-3)),
          edits: edits.filter((previous) => previous.completedAt).slice(-10).map((previous) => structuredClone({
            id: previous.id, target: previous.target, text: previous.text, status: previous.status,
            summary: previous.summary, changes: previous.changes, review: previous.review,
            ...(previous.error ? { error: previous.error } : {}),
            ...(previous.reasons ? { reasons: previous.reasons } : {}),
            baseVersion: previous.baseVersion, canvasVersion: previous.canvasVersion,
            planRevision: previous.planRevision, completedAt: previous.completedAt,
          })),
        },
      };
      const owned = new AbortController();
      controller = owned;
      operation = "revision";
      edits.push(edit);
      const emit = () => { try { onEdit?.(structuredClone(edit)); } catch {} };
      emit();

      return (async () => {
        let abort;
        const stopped = new Promise((_, reject) => {
          abort = () => reject(new DOMException("修订已停止", "AbortError"));
          owned.signal.addEventListener("abort", abort, { once: true });
          if (owned.signal.aborted) abort();
        });
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => {
              if (owned.signal.aborted) throw new DOMException("修订已停止", "AbortError");
              return reviser(structuredClone(context), { signal: owned.signal });
            }),
            stopped,
          ]);
          if (owned.signal.aborted) throw new DOMException("修订已停止", "AbortError");
          edit.status = "checking";
          edit.summary = "正在检查修订后的完整画布";
          emit();
          if (owned.signal.aborted) throw new DOMException("修订已停止", "AbortError");
          const inspection = inspectRevision(result, context);
          if (inspection.reasons.length) {
            edit.status = "failed";
            edit.summary = "修订未通过检查，画布保持不变";
            edit.reasons = inspection.reasons;
          } else {
            if (owned.signal.aborted) throw new DOMException("修订已停止", "AbortError");
            if (canvas.version !== edit.baseVersion || plan.revision !== edit.planRevision || controller !== owned) {
              throw new Error("修订所依据的画布或方案已更新，结果未应用");
            }
            edit.summary = result.summary;
            edit.review = structuredClone(result.review);
            if (result.kind === "patch") {
              canvas.nodes = inspection.candidate.nodes;
              canvas.edges = inspection.candidate.edges;
              canvas.version += 1;
              edit.status = "applied";
              edit.changes = inspection.changes;
              edit.canvasVersion = canvas.version;
            } else edit.status = result.kind;
          }
        } catch (error) {
          edit.status = owned.signal.aborted || error?.name === "AbortError" ? "stopped" : "failed";
          edit.summary = edit.status === "stopped" ? "修订已停止，画布保持不变" : "修订失败，画布保持不变";
          if (edit.status === "failed") {
            edit.error = error?.message ?? String(error);
            const rejected = error?.events?.filter((event) => event.kind === "rejected").at(-1)?.reasons;
            if (Array.isArray(rejected)) edit.reasons = structuredClone(rejected);
          }
        } finally {
          owned.signal.removeEventListener("abort", abort);
          edit.completedAt = new Date().toISOString();
          edit.durationMs = Date.now() - startedAt;
          if (controller === owned) { controller = null; operation = null; }
          /* 完成通知到达时用户已经拿回执行权，可直接发送下一条。 */
          emit();
        }
        return structuredClone(edit);
      })();
    },

    /* 交给设计者。断口不是搭法的问题、是方案少了一步或者接错了地方的时候,人按一下,
       停在哪儿、闸门退了什么,原样作为一句话交给设计者,让它出新方案。
       架构里这条路叫「执行者说不的出口」,执行者自己还没有这个口;现在是人替它说,走同一条路。
       onSaid 在话说出去之前喊一声:界面要把这句话先摆上墙,跟人自己打的一句一样。 */
    async escalate({ onSaid, ...options } = {}) {
      requireUserTurn("交给设计者");
      const stop = breakOf(runs.at(-1), plan.currentPlan);
      if (!stop) throw new Error("上一趟没停在哪一步,没什么可交给设计者的");
      const text = handoffText(stop);
      onSaid?.(text);
      const turn = await plan.say(text, options);
      return { ...turn, text };
    },

    /* 停:谁在跑就停谁。返回停掉的是谁;没人在跑返回 false。 */
    stop() {
      if (controller) {
        const stopping = operation;
        controller.abort();
        return stopping;
      }
      return plan.stop() ? "plan" : false;
    },
  };
}

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/* 画布闸门:第一道是信封(形状对不对、名字撞不撞、线接没接上),第二道是对得上节点表(src/nodes/check-nodes.mjs)。
   两道在同一个函数里,执行者交回时和状态机提交前走的是同一道。 */
/* 闸门。收的是方案里那一步本身,不是它的编号:这一道要看「接在谁后面」,
   而可选参数是会被忘的——执行者自己那一道就忘过,于是它查得比状态机松,
   自己那关过了、到状态机才被退,而它已经没有机会改了。 */
export function checkResult(result, step, canvas) {
  const { ref, dependsOn = [] } = step;
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
  if (reasons.length) return reasons;

  /* 一步交回好几个节点,这几个节点得连成一片——彼此相连,或者都挂在同一个上游节点上。
     连不成的话交回的不是一段流程,是几张并排的卡:下一步只有一个落点,接哪张都不对。
     只交回一个节点的不查:它的进线可能是上游那一步的,出线由下游那一步声明。 */
  if (nodes.length > 1) {
    const near = new Map();
    const link = (a, b) => { if (!near.has(a)) near.set(a, new Set()); near.get(a).add(b); };
    for (const edge of edges) { link(edge.from, edge.to); link(edge.to, edge.from); }
    const reached = new Set([nodes[0].name]);
    const stack = [nodes[0].name];
    while (stack.length) {
      for (const next of near.get(stack.pop()) ?? []) if (!reached.has(next)) { reached.add(next); stack.push(next); }
    }
    const cut = nodes.map((node) => node.name).filter((name) => !reached.has(name));
    if (cut.length) reasons.push(`这一步交回 ${nodes.length} 个节点,${cut.join("、")} 没跟其它几个连在一起,下一步只有一个落点`);
  }
  /* 这一步接在谁后面,方案里写着。接在别人后面就得真的接上去——
     一条从上游节点进来的线。没有这条线,这一段和前面是两座孤岛,
     画布连不成一条链,跑起来后面这半截拿不到任何输入。
     方案里 dependsOn 为空的那一步(链路的头)不查:它本来就没有上游。
     上游那几步一个节点都没出的时候也不查:接不到不存在的东西上。 */
  const upstream = new Set(dependsOn);
  if (upstream.size) {
    const above = new Set(canvas.nodes.filter((node) => upstream.has(node.step)).map((node) => node.name));
    if (above.size && !edges.some((edge) => above.has(edge.from) && mine.has(edge.to))) {
      reasons.push(`${ref} 接在 ${[...upstream].join("、")} 后面,却没有一条线从那几步的节点接进来`);
    }
  }
  if (reasons.length) return reasons;

  const table = checkAgainstNodeTable(nodes, edges, canvas.nodes);
  if (table.length) return table;
  /* 接得上要看这一步进去之后的画布——老节点换掉、新线接上——所以先照 commit 的规矩拼一份,不真提交。 */
  return checkFlow(nodes, merged(canvas, ref, { nodes, edges }));
}

/* 换掉这一步原有的节点。线的归属:进这一步的线由这一步自己在改动里声明,所以老的进线全部去掉、
   换成改动里的;出这一步的线是下游声明的,只要这头的节点名还在(原地改),就留着;
   名字没了的,碰到它的线一起去掉,下游那一步重走时会看见自己没接上。版本加一。 */
function merged(canvas, ref, patch) {
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
  const edges = [...kept, ...declared].filter((edge) => {
    const key = `${edge.from}→${edge.to}#${edge.output ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { nodes, edges };
}

function commit(canvas, ref, patch) {
  const next = merged(canvas, ref, patch);
  canvas.nodes = next.nodes;
  canvas.edges = next.edges;
  canvas.version += 1;
}

/* 上一趟停在哪儿、为什么。跑完了、或者最后一步是做完/已经有了,就是没停。
   原因是一条一条的:闸门退几条就是几条;出错是一条;按了停也是一条。 */
export function breakOf(run, plan) {
  if (!run || run.endedBy === "finished") return null;
  const last = run.steps.at(-1);
  if (!last || last.outcome === "done" || last.outcome === "covered") return null;
  const reasons = last.reasons ?? (last.error ? [last.error] : last.outcome === "stopped" ? ["按了停"] : []);
  return { ref: last.ref, title: plan?.steps.find((step) => step.ref === last.ref)?.title ?? last.ref, reasons };
}

/* 交给设计者时说的话:停在哪儿、闸门退了什么,原样。不替设计者下结论该怎么改——
   它读到这些自己会问、会改;它看不见画布,这几行就是它眼前唯一的画布。 */
export const handoffText = ({ ref, title, reasons }) =>
  `「${title}」（${ref}）在画布上没搭成，闸门退回：\n${reasons.map((why) => `- ${why}`).join("\n")}`;

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
