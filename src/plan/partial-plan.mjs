/* 边写边看,就得能读一份还没写完的 JSON。

   模型是一个字一个字往外吐的,任何时刻手上那段都是断的:字符串没收口、
   数组没收口、最后一项才写了一半。做法是往回退到最近一个能收口的地方,
   把该补的括号补上再解析。退不到就返回空,这一拍不刷新。 */

const CLOSERS = { "{": "}", "[": "]" };

/* 从头扫一遍:这段文本停在哪儿、还欠哪几个括号。停在字符串里就不算数。 */
function shape(src) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const c of src) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (CLOSERS[c]) stack.push(CLOSERS[c]);
    else if (c === "}" || c === "]") stack.pop();
  }
  return { inString, stack };
}

export function parsePartial(src) {
  const text = String(src ?? "");
  /* 从尾巴往回找收口点:只在逗号和括号后面切,写了一半的那一项整个丢掉。 */
  for (let end = text.length; end > 0; end--) {
    const c = text[end - 1];
    if (end !== text.length && c !== "," && c !== "}" && c !== "]" && c !== '"') continue;
    let cut = text.slice(0, end).replace(/,\s*$/, "");
    const { inString, stack } = shape(cut);
    if (inString) continue;
    try {
      return JSON.parse(cut + stack.reverse().join(""));
    } catch {
      /* 这个切点收不了口,再往前退一格 */
    }
  }
  return null;
}

/* 半份方案上,哪些字段现在可以拿来看。写了一半的那一条不算数——
   契约里每一条都得有几样东西齐了才成立,缺的那条先不露面。 */
export function draftPlan(partial) {
  if (!partial || typeof partial !== "object") return null;
  const list = (rows, need) =>
    (Array.isArray(rows) ? rows : []).filter((r) => r && need.every((k) => typeof r[k] === "string" && r[k]));
  return {
    goal: typeof partial.goal === "string" ? partial.goal : "",
    readiness: partial.readiness ?? "",
    understanding: list(partial.understanding, ["ref", "quote", "reading"]),
    steps: list(partial.steps, ["ref", "title"]),
    openQuestions: list(partial.openQuestions, ["ref", "question"]),
  };
}
