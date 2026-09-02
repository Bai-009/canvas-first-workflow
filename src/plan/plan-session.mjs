import { runPlanAgent, loadSystemPrompt } from "./plan-agent.mjs";
import { diffPlans } from "./plan-diff.mjs";

/* Plan 阶段的会话。持有的就三样:对话记录、过了闸门的每一份方案(最后一份是当前方案)、
   这一轮跑没跑着。规则只有一条:当前方案只在新的一份过了闸门时才换。
   只说话的一轮、被停掉的一轮、几次都没过闸的一轮,都不碰它。
   回合制:一轮在跑的时候不收第二句;要插话先 stop()。 */
export function createPlanSession({ callModel, systemPrompt = loadSystemPrompt("zh") }) {
  const transcript = [];   // 不含 system 那条,每轮交给模型时再拼上
  const versions = [];     // 过了闸门的每一份,按先后
  let controller = null;   // 正在跑的那一轮

  return {
    get transcript() {
      return transcript.map((message) => structuredClone(message));
    },
    get versions() {
      return versions.map((plan) => structuredClone(plan));
    },
    get currentPlan() {
      return versions.length ? structuredClone(versions.at(-1)) : null;
    },
    get revision() {
      return versions.length;
    },
    get running() {
      return controller !== null;
    },

    async say(text, { language } = {}) {
      if (controller) throw new Error("上一轮还在跑,先停掉它再说下一句");
      const userMessage = { role: "user", content: text };
      controller = new AbortController();
      let result;
      try {
        result = await runPlanAgent({
          callModel,
          messages: [...transcript, userMessage],
          systemPrompt: language ? loadSystemPrompt(language) : systemPrompt,
          signal: controller.signal,
        });
      } catch (error) {
        /* 停掉的、或者几次都没过闸的:这轮当没发生,只留用户那句 */
        transcript.push(userMessage);
        throw error;
      } finally {
        controller = null;
      }
      transcript.splice(0, transcript.length, ...result.transcript.slice(1));
      let diff = null;
      if (result.plan) {
        diff = versions.length ? diffPlans(versions.at(-1), result.plan) : null;
        versions.push(result.plan);
      }
      return { speech: result.speech, plan: result.plan, diff, revision: versions.length };
    },

    stop() {
      if (!controller) return false;
      controller.abort();
      return true;
    },
  };
}
