/* 演出版是录下来的那一场,跟主体不共用一行代码:主体往前改,这一场还是当初的样子,
   两边摆在一起才照得出差别。代价是下面这十几行跟 web/dom.mts、shared/demo-data.mts
   长得很像——那是有意的,不是忘了合并。 */
function element<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const found = root.querySelector<E>(selector);
  if (!found) throw new Error(`界面缺少元素：${selector}`);
  return found;
}
interface DemoData {
  task: string; wfName: string; understanding: [string, string][]; route: string[];
  asks: [string, string][]; done: string; reply: string;
  after: { understanding: [string, string][]; route: string[]; answeredAsks: number[]; done: string };
}
function readDemoData(value: unknown): DemoData {
  const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  const pairs = (v: unknown): v is [string, string][] => Array.isArray(v) && v.every((x) => strings(x) && x.length === 2);
  const ok = record(value) && typeof value.task === "string" && typeof value.wfName === "string"
    && pairs(value.understanding) && strings(value.route) && pairs(value.asks)
    && typeof value.done === "string" && typeof value.reply === "string"
    && record(value.after) && pairs(value.after.understanding) && strings(value.after.route)
    && typeof value.after.done === "string" && Array.isArray(value.after.answeredAsks)
    && value.after.answeredAsks.every((x) => Number.isInteger(x) && x >= 0);
  if (!ok) throw new Error("原型演示数据缺失或格式不正确，请先生成 plan-data.js");
  return value as unknown as DemoData;
}

// 这些数组由同一条生成流程建立；缺项意味着内部编排失配，不静默跳过动画。
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("原型编排缺少对应元素");
  return value;
}
interface Point { x: number; y: number }
interface Token { cls: string | null; text: string }
interface Line { el: HTMLDivElement; tokens: Token[]; spans: HTMLSpanElement[]; tw: number[]; width: number; raw: string; cost: number }
interface EdgeView { g: SVGGElement; path: SVGPathElement; len: number; head: number; tail: number; drawn: boolean; outAt: Point; inAt: Point }
interface View { lang: string; content: string[]; note?: string | undefined; engine: string; kind: string; title: string; color: string }
interface Step extends View { id: string; icon: string; hold: number; evidence: string }
interface CardState { status: "new" | "done"; edited: boolean; view: View | null }
interface Prepared { card: HTMLElement; lines: Line[]; codeEl: HTMLElement; inner: HTMLElement; visLines: number; baseH: number; fullH: number }

/* Workflow prototype v6
   在 v5（单格内部的流畅度）之上改三件事：

   1. 需求从输入框发出。逐字打进输入框 → 发送 → 那条消息飞到右上角变成需求框，
      常驻显示全局状态（正在生成哪一步 / 完成后共几步、什么时候跑）。
   2. 去掉待确认/选择模块。
   3. 重做两格之间的衔接。之前有三个结构性问题：
      a. 间距 104、展开宽 600，卡片往左伸 212px —— 一展开就把入边整条盖住、
         把上一张卡压掉六成。图在写内容的整个过程里是断的。
         → 拉开间距（PITCH 436）让展开不压邻居；展开时连线按同一条时长往回缩，
           缩到卡片左沿，那里露出插口。线是插进卡片的，不是被盖掉的。
      b. 因果反了：线要画 700ms，新卡 300ms 就冒出来。
         → 线先走，走到尽头卡片才从尽头长出来。
      c. 一次交接六个节拍，其中 780ms + think(240~820ms) 是纯死等。
         → 压成两拍，think 去掉，收回的尾巴与下一段的出发重叠。 */
(() => {
  "use strict";

  const $ = <E extends Element = HTMLElement>(s: string) => element<E>(document, s);
  const viewport = $("#viewport");
  const world = $("#world");
  const wires = $<SVGSVGElement>("#wires");
  const taskCard = $("#taskCard");
  const stage = $("#stage");
  const planClose = $("#planClose");
  const planGo = $("#planGo");
  const planCard = $("#planCard");
  const planText = $("#planText");
  const planPair = $("#planPair");
  const planRoute = $("#planRoute");
  const planAsks = $("#planAsks");
  const planBody = element(document, ".plan-body");
  const planDot = $("#planDot");
  const planSay = $("#planSay");
  const taskText = $("#taskText");
  const taskDot = $("#taskDot");
  const taskState = $("#taskState");
  const taskFoot = element(document, ".task-foot");
  const engBtn = $("#engBtn");
  const wfNameEl = $("#wfName");
  const formEl = $<HTMLFormElement>("#form");
  const inputEl = $<HTMLTextAreaElement>("#input");
  const sendEl = element<HTMLButtonElement>(formEl, ".send");
  const chipEl = $("#chip");
  const speedBtn = $("#speedBtn");
  const skipBtn = $("#skipBtn");
  const rerunBtn = $("#rerunBtn");
  const zoomPct = $("#zoomPct");
  const SVGNS = "http://www.w3.org/2000/svg";

  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* 展开宽 540、间距 260 → 展开后左右各留 78px，既不压邻居，
     也让连线本身有 260px 的长度可看。 */
  const TILE = 176;
  const GAP = 260;
  const PITCH = TILE + GAP;
  const OPEN_W = 540;
  const CODE_LH = 19;
  const CODE_PAD = 26;
  const MAX_CODE_LINES = 18;          /* 写满这么多行就开始滚，卡片不再变高 */

  /* 一次交接分三拍，每拍只干一件事，互不重叠：
       ① 线画出 + 镜头平移（同一拍出发、同时停）
       ② 线到了，卡片在线的尽头长出来，长完为止
       ③ 钉住不动一小拍（fix），然后才展开
     ②③ 是补上的：原来卡片的出生弹簧还剩 150ms 就开始撑宽高，
     同一张卡上两个几何动画重叠，节点从来没有真正落定过。 */
  const T = REDUCED
    ? { edge: 0, pan: 0, born: 0, fix: 0, open: 0, close: 0, lead: 0, fly: 0 }
    : { edge: 460, pan: 520, born: 420, fix: 160, open: 620, close: 560, lead: 300, fly: 780 };

  /* 节点不排成一条直线：同一条线上的贝塞尔退化成直线，看着就硬。 */
  const BASE_Y = 96, AMP = 48;
  const nodeY = (i: number) => Math.round(BASE_Y + AMP * Math.sin(i * 0.9));
  const nodeX = (i: number) => i * PITCH;

  /* ── Plan 阶段的内容:真实数据 ─────────────────────────
     v7 起不再手写。plan-data.js 由 src/prototype/build-demo-data.mts 从
     fixtures/observed/ 里真实模型输出的修订轮一对生成,生成时过闸门。
     对话、理解、路线、待确认、答掉哪几个,全部来自实录。 */
  const DATA = readDemoData(Reflect.get(window, "PLAN_DATA"));
  const TASK = DATA.task;
  const WF_NAME = DATA.wfName;
  const PLAN = {
    understanding: DATA.understanding,
    route: DATA.route,
    asks: DATA.asks,
    done: DATA.done,
    reply: DATA.reply,
    /* after.answeredAsks:被这句回答清掉的问题下标,由编号差异算出;
       after.route:同编号的步骤标题变了就是原地改,界面上换字不换格。 */
    after: DATA.after,
  };

  const ICONS: Record<string, string> = {
    db: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
    braces: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H8a3 3 0 0 0-3 3v3a3 3 0 0 1-3 3 3 3 0 0 1 3 3v3a3 3 0 0 0 3 3h1"/><path d="M15 3h1a3 3 0 0 1 3 3v3a3 3 0 0 0 3 3 3 3 0 0 0-3 3v3a3 3 0 0 1-3 3h-1"/></svg>',
    code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 17-5-5 5-5M15 7l5 5-5 5"/></svg>',
    table: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  };

  const STEPS: Step[] = [
    {
      id: "read", kind: "数据源", color: "#2f6fed", icon: "db",
      engine: "flow:catalog.source.read.v2",
      lang: "kv", hold: 620,
      note: "先把范围和游标定下来，再看这一批到底扫到了什么。",
      content: [
        "source        s3://contracts-lake/",
        "region        cn-shanghai",
        "match         **/*.pdf",
        "exclude       **/_archive/**",
        "exclude       **/~$*",
        "scope         增量 · 按 last_modified 游标",
        "cursor        2026-07-14T03:22:11Z",
        "batch         256 个文件 / 批",
        "concurrency   8",
        "checksum      etag + size",
        "",
        "扫描结果",
        "  命中        1,284 个文件 · 3.2 GB",
        "  跳过        37 个（已归档）· 12 个（临时文件）",
        "  跨度        2026-01-04 → 2026-07-29",
        "  平均        2.6 MB / 份 · 最大 41 MB",
        "  可读        1,284 份 · 加密 0 份",
        "  重复        按 etag 去重后剩 1,271 份",
      ],
      title: "读取 S3 合同目录", evidence: "1,271 份去重后",
    },
    {
      id: "parse", kind: "文档解析", color: "#7c5cf5", icon: "doc",
      engine: "flow:parser.ocr.document.scan",
      lang: "text", hold: 820,
      note: "合同都是扫描件，走 OCR。抽样第一份，确认识别结果。",
      content: [
        "── contract_20260714_A0031.pdf · 共 9 页 ──",
        "",
        "技术服务合同",
        "",
        "合同编号：SRV-2026-0731",
        "签订地点：上海市浦东新区",
        "签订日期：2026 年 7 月 14 日",
        "",
        "甲方：上海泓远信息科技有限公司",
        "统一社会信用代码：91310115MA1K3RTX8N",
        "联系地址：上海市浦东新区博云路 2 号",
        "",
        "乙方：杭州云枢数据技术有限公司",
        "统一社会信用代码：91330106MA2AB7QN5T",
        "联系地址：杭州市余杭区文一西路 969 号",
        "",
        "第一条  服务内容",
        "乙方为甲方提供数据平台运维与技术支持服务，包括但不",
        "限于：集群巡检、故障响应、版本升级、性能调优。服务",
        "期自 2026 年 8 月 1 日起，为期二十四个月。",
        "",
        "第二条  合同金额",
        "本合同总金额为人民币壹佰贰拾捌万元整",
        "（¥1,280,000.00），已含增值税专用发票税额。",
        "",
        "第三条  付款方式",
        "签订后 30 日内支付合同总额的 30%，其余款项按季度均",
        "摊，于每季度末 15 个工作日内支付。",
        "",
        "第四条  服务级别",
        "一级故障 2 小时内响应、24 小时内恢复；二级故障 8 小",
        "时内响应。年度服务可用性不低于 99.9%。",
      ],
      title: "OCR 识别合同正文", evidence: "9 页 · 保留段落层级",
    },
    {
      id: "extract", kind: "结构化抽取", color: "#d97706", icon: "braces",
      engine: "flow:llm.extract.structured.advanced",
      lang: "json", hold: 700,
      note: "按你说的四项，加上编号、信用代码、币种和终止日期，共 10 个字段。",
      content: [
        "// 字段定义",
        "{",
        '  "contract_no":  { "type": "string",  "required": true },',
        '  "party_a":      { "type": "string",  "required": true },',
        '  "party_a_code": { "type": "string",  "nullable": true },',
        '  "party_b":      { "type": "string",  "required": true },',
        '  "party_b_code": { "type": "string",  "nullable": true },',
        '  "amount":       { "type": "decimal", "required": true },',
        '  "currency":     { "type": "string",  "default": "CNY" },',
        '  "tax_included": { "type": "boolean", "default": true },',
        '  "effective_at": { "type": "date",    "required": true },',
        '  "expire_at":    { "type": "date",    "nullable": true }',
        "}",
        "",
        "// 抽取结果 · contract_20260714_A0031.pdf",
        "{",
        '  "contract_no":  "SRV-2026-0731",',
        '  "party_a":      "上海泓远信息科技有限公司",',
        '  "party_a_code": "91310115MA1K3RTX8N",',
        '  "party_b":      "杭州云枢数据技术有限公司",',
        '  "party_b_code": "91330106MA2AB7QN5T",',
        '  "amount":       1280000.00,',
        '  "currency":     "CNY",',
        '  "tax_included": true,',
        '  "effective_at": "2026-08-01",',
        '  "expire_at":    "2028-08-01"   // 按“自生效起二十四个月”推算',
        "}",
      ],
      title: "抽出合同要素", evidence: "10 字段",
    },
    {
      id: "clean", kind: "自定义代码", color: "#0d9d6e", icon: "code",
      engine: "flow:data.transform · python 3.11",
      lang: "python", hold: 820,
      note: "金额和公司名在源数据里格式不统一，先归一再入库。",
      content: [
        "from decimal import Decimal, ROUND_HALF_UP",
        "import re",
        "",
        'UNIT = {"万元": 10_000, "万": 10_000, "元": 1, "": 1}',
        'NOISE = re.compile(r"[\\s\\u3000（）()]+")',
        'SUFFIX = {"有限责任公司": "有限公司", "股份公司": "股份有限公司"}',
        "",
        "def parse_amount(raw):",
        '    """金额混用「万元」「元」「¥」，统一成元。"""',
        '    s = str(raw).strip().replace(",", "").lstrip("¥￥")',
        '    m = re.match(r"^([\\d.]+)\\s*(万元|万|元)?$", s)',
        "    if not m:",
        '        raise ValueError(f"无法解析金额: {raw!r}")',
        '    value, unit = m.group(1), m.group(2) or ""',
        "    return (Decimal(value) * UNIT[unit]).quantize(",
        '        Decimal("0.01"), rounding=ROUND_HALF_UP',
        "    )",
        "",
        "def normalize_corp(name):",
        '    """两端空白和全角括号会让 upsert 认不出同一家。"""',
        '    n = NOISE.sub("", str(name))',
        "    for old, new in SUFFIX.items():",
        "        n = n.replace(old, new)",
        "    return n",
        "",
        "def clean(row):",
        '    row["amount"] = parse_amount(row["amount"])',
        '    for k in ("party_a", "party_b"):',
        "        row[k] = normalize_corp(row[k])",
        '    row["currency"] = (row.get("currency") or "CNY").upper()',
        '    row["parsed_at"] = now()',
        "    return row",
      ],
      title: "金额与公司名归一", evidence: "命中 1,271 / 1,271",
    },
    {
      id: "sink", kind: "写入数据表", color: "#0e8fa8", icon: "table",
      engine: "flow:data.table.upsert_json",
      lang: "sql", hold: 760,
      note: "建表、建索引、幂等写入，重跑不会产生重复行。",
      content: [
        "CREATE TABLE IF NOT EXISTS dw.contract_facts (",
        "  contract_id    VARCHAR(64)   NOT NULL,",
        "  contract_no    VARCHAR(64)   NOT NULL,",
        "  party_a        VARCHAR(255)  NOT NULL,",
        "  party_a_code   VARCHAR(32)   NULL,",
        "  party_b        VARCHAR(255)  NOT NULL,",
        "  party_b_code   VARCHAR(32)   NULL,",
        "  amount         DECIMAL(18,2) NOT NULL,",
        "  currency       CHAR(3)       NOT NULL DEFAULT 'CNY',",
        "  tax_included   BOOLEAN       NOT NULL DEFAULT TRUE,",
        "  effective_at   DATE          NOT NULL,",
        "  expire_at      DATE          NULL,",
        "  source_uri     VARCHAR(512)  NOT NULL,",
        "  parsed_at      TIMESTAMP     NOT NULL,",
        "  PRIMARY KEY (contract_id)",
        ");",
        "",
        "CREATE INDEX IF NOT EXISTS idx_contract_party",
        "  ON dw.contract_facts (party_a, effective_at);",
        "",
        "CREATE INDEX IF NOT EXISTS idx_contract_effective",
        "  ON dw.contract_facts (effective_at);",
        "",
        "-- 重跑按 contract_id 覆盖，不产生重复行",
        "UPSERT INTO dw.contract_facts",
        "SELECT * FROM staging.contract_batch",
        "ON CONFLICT (contract_id) DO UPDATE SET",
        "  amount     = EXCLUDED.amount,",
        "  expire_at  = EXCLUDED.expire_at,",
        "  parsed_at  = EXCLUDED.parsed_at;",
      ],
      title: "写入合同事实表", evidence: "14 列 · 2 索引 · 幂等",
    },
    {
      id: "cron", kind: "触发", color: "#db2777", icon: "clock",
      engine: "catalog:workflow.cron_volume.dispatch",
      lang: "kv", hold: 700,
      content: [
        "cron          0 8 * * *          默认时间，用户未指定",
        "首次          下一次到点",
        "增量          只处理游标之后新增的文件",
        "游标字段      last_modified",
        "超时          单次运行上限 90 分钟",
        "",
        "失败          重试 2 次 · 间隔 10 分钟",
        "退避          指数退避 · 上限 30 分钟",
        "通知          失败时发到 #data-alerts",
        "              连续 2 次失败额外通知值班",
        "",
        "资源          计算组 etl-default · 8 vCPU",
        "并发          单实例，不允许重叠运行",
        "保留          运行记录保留 90 天",
      ],
      title: "每天定时增量运行", evidence: "时间取默认 08:00 · 可改",
    },
  ];

  const FOLLOWUP = {
    text: "抽取那步别用正则，改成大模型抽",
    target: "extract",
    patch: {
      note: "改用 qwen-plus 抽取，字段不变；读不到的留空，不推断。",
      hold: 820, lang: "json",
      content: [
        "// 模型抽取配置",
        "{",
        '  "model":        "qwen-plus",',
        '  "temperature":  0,',
        '  "max_tokens":   2048,',
        '  "schema_mode":  "strict",',
        '  "on_missing":   "null",',
        '  "few_shot":     3',
        "}",
        "",
        "// 抽取结果 · contract_20260714_A0031.pdf",
        "{",
        '  "contract_no":  "SRV-2026-0731",',
        '  "party_a":      "上海泓远信息科技有限公司",',
        '  "party_a_code": "91310115MA1K3RTX8N",',
        '  "party_b":      "杭州云枢数据技术有限公司",',
        '  "party_b_code": "91330106MA2AB7QN5T",',
        '  "amount":       1280000.00,',
        '  "currency":     "CNY",',
        '  "tax_included": true,',
        '  "effective_at": "2026-08-01",',
        '  "expire_at":    null',
        "}",
      ],
      engine: "flow:llm.extract.structured.advanced · qwen-plus",
      title: "抽出合同要素", evidence: "10 字段 · qwen-plus",
    },
  };

  /* ── 语法上色 ─────────────────────────────────────────── */
  const RULES: Record<string, {cls: string; re: RegExp}[]> = {
    sql: [
      { cls: "com", re: /--[^\n]*/y },
      { cls: "str", re: /'(?:[^']|'')*'/y },
      { cls: "kw", re: /\b(?:CREATE|TABLE|INDEX|IF|NOT|EXISTS|NULL|PRIMARY|KEY|DEFAULT|UPSERT|INTO|ON|CONFLICT|DO|UPDATE|SET|SELECT|FROM|WHERE|AND|OR|AS|INSERT|VALUES|EXCLUDED|TRUE|FALSE)\b/yi },
      { cls: "typ", re: /\b(?:VARCHAR|DECIMAL|DATE|TIMESTAMP|BIGINT|INT|CHAR|TEXT|BOOLEAN|JSON)\b/yi },
      { cls: "num", re: /\b\d+(?:\.\d+)?\b/y },
      { cls: "id", re: /\b[a-zA-Z_][\w.]*\b/y },
    ],
    python: [
      { cls: "com", re: /#[^\n]*/y },
      { cls: "str", re: /"""(?:[^"]|"(?!""))*"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
      { cls: "ctl", re: /\b(?:def|return|if|elif|else|for|in|while|try|except|raise|with|as|import|from|not|and|or)\b/y },
      { cls: "kw", re: /\b(?:None|True|False|is|lambda|class)\b/y },
      { cls: "fn", re: /\b[a-zA-Z_]\w*(?=\()/y },
      { cls: "num", re: /\b\d[\d_]*(?:\.\d+)?\b/y },
      { cls: "id", re: /\b[a-zA-Z_]\w*\b/y },
    ],
    json: [
      { cls: "com", re: /\/\/[^\n]*/y },
      { cls: "key", re: /"[^"]*"(?=\s*:)/y },
      { cls: "str", re: /"(?:\\.|[^"\\])*"/y },
      { cls: "kw", re: /\b(?:true|false|null)\b/y },
      { cls: "num", re: /-?\b\d+(?:\.\d+)?\b/y },
    ],
    kv: [
      { cls: "key", re: /^[ ]*[A-Za-z\u4e00-\u9fa5][A-Za-z\u4e00-\u9fa5_]*(?=[ ]{2,})/y },
      { cls: "str", re: /s3:\/\/\S+|\*\*\/[\S]+|#[\w-]+|Asia\/\w+|etl-[\w-]+/y },
      { cls: "num", re: /\b[\d,]+(?:[-:.]\d+)*[A-Z]{0,2}\b/y },
    ],
    text: [
      { cls: "com", re: /^──[^\n]*/y },
      { cls: "key", re: /^第[一二三四五六七八九十]+条/y },
      { cls: "lbl", re: /^(?:甲方|乙方|合同编号|签订地点|签订日期|统一社会信用代码|联系地址)(?=：)/y },
      { cls: "num", re: /¥?[\d,]+(?:\.\d+)?%?/y },
    ],
  };

  function tokenize(text: string, lang: string): Token[] {
    const rules = RULES[lang] || [];
    const out: Token[] = []; let i = 0, plain = "";
    outer: while (i < text.length) {
      for (const rule of rules) {
        rule.re.lastIndex = i;
        const m = rule.re.exec(text);
        if (m && m[0].length) {
          if (plain) { out.push({ cls: null, text: plain }); plain = ""; }
          out.push({ cls: rule.cls, text: m[0] });
          i += m[0].length;
          continue outer;
        }
      }
      plain += text[i]; i += 1;
    }
    if (plain) out.push({ cls: null, text: plain });
    return out;
  }
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] ?? c));
  function renderTokens(tokens: Token[]) {
    let html = "";
    for (const tk of tokens) html += tk.cls ? `<span class="t-${tk.cls}">${esc(tk.text)}</span>` : esc(tk.text);
    return html;
  }

  let SPEED = 1;
  const SPEEDS = [1, 2, 4];
  let speedIdx = 0;
  let runToken = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, REDUCED ? Math.min(ms, 16) : ms / SPEED));
  const alive = (t: number) => t === runToken;
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

  /* ── 镜头 ─────────────────────────────────────────────
     整个生成过程里镜头只平移、不缩放：卡片高度被 MAX_CODE_LINES 封了顶，
     一次算好比例就够。每格都缩放一次是上一版「一格一格」的一部分。 */
  const cam = { x: 0, y: 0, s: 1 };
  const RESERVE = 344;   /* 右上角需求框占掉的一条，展开的卡片不能钻到它下面 */
  let runScale = 1;
  function computeScale() {
    const estH = 175 + CODE_PAD + MAX_CODE_LINES * CODE_LH;
    runScale = clamp(Math.min(
      (viewport.clientWidth - RESERVE - 80) / OPEN_W,
      (viewport.clientHeight - 170) / estH,
      1), .45, 1);
  }
  function applyCam(animate: boolean) {
    world.classList.toggle("animate", Boolean(animate));
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})`;
    zoomPct.textContent = Math.round(cam.s * 100) + "%";
  }
  function centerOn(wx: number, wy: number, s: number, animate: boolean, reserve?: number) {
    cam.s = s;
    cam.x = (viewport.clientWidth - (reserve === undefined ? RESERVE : reserve)) / 2 - wx * s;
    cam.y = viewport.clientHeight / 2 - 12 - wy * s;
    applyCam(animate);
  }
  /* openH 是这一格展开写满之后的高度。卡片钉住上沿往下长，
     所以镜头瞄的是「上沿 + openH/2」，写满的那一刻它正好落在画面正中。 */
  function focusNode(i: number, animate?: boolean, openH?: number) {
    const cy = nodeY(i) + (openH ? openH / 2 : TILE / 2);
    centerOn(nodeX(i) + TILE / 2, cy, runScale, animate !== false);
  }
  function bounds() {
    const n = Math.max(nodes.length, 1);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { minY = Math.min(minY, nodeY(i)); maxY = Math.max(maxY, nodeY(i) + TILE); }
    return { w: (n - 1) * PITCH + TILE, cy: (minY + maxY) / 2, h: maxY - minY };
  }
  /* 全图一览时不必给需求框让位：这个比例下图的高度远在它下方。 */
  function fitAll() {
    const b = bounds();
    const s = clamp(Math.min((viewport.clientWidth - 140) / b.w, (viewport.clientHeight - 280) / b.h, 1), .25, 1);
    centerOn(b.w / 2, b.cy, s, true, 0);
  }
  function zoomBy(f: number) {
    const ns = clamp(cam.s * f, .25, 2);
    const mx = viewport.clientWidth / 2, my = viewport.clientHeight / 2;
    cam.x = mx - (mx - cam.x) * (ns / cam.s);
    cam.y = my - (my - cam.y) * (ns / cam.s);
    cam.s = ns;
    applyCam(true);
  }

  viewport.addEventListener("wheel", (e) => {
    if (!(e.target instanceof Element)) return;
    /* 卡片展开着的时候，滚轮归这张卡：在代码区里就交给它原生滚（横向也一并），
       在卡片其它地方也把滚动转给代码区。一滚就把整张画布缩掉是不对的。 */
    const open = e.target.closest(".card.open");
    if (open) {
      const sc = open.querySelector(".code-in");
      const scrollable = sc && sc.scrollHeight > sc.clientHeight;
      if (scrollable && e.target.closest(".code-in")) return;
      e.preventDefault();
      if (scrollable) sc.scrollTop += e.deltaY;
      return;
    }
    e.preventDefault();
    const ns = clamp(cam.s * (e.deltaY < 0 ? 1.1 : 1 / 1.1), .25, 2);
    const r = viewport.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    cam.x = mx - (mx - cam.x) * (ns / cam.s);
    cam.y = my - (my - cam.y) * (ns / cam.s);
    cam.s = ns;
    applyCam(false);
  }, { passive: false });

  let drag: {px: number; py: number; x: number; y: number; moved: number; el: Element} | null = null;
  viewport.addEventListener("pointerdown", (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest(".code")) return;
    /* 按下时就把真正命中的元素记住：setPointerCapture 之后
       pointerup 的 target 会被重定向成 viewport，卡片就认不出来了。 */
    drag = { px: e.clientX, py: e.clientY, x: cam.x, y: cam.y, moved: 0, el: e.target };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add("grabbing");
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
    drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
    cam.x = drag.x + dx; cam.y = drag.y + dy;
    applyCam(false);
  });
  viewport.addEventListener("pointerup", () => {
    if (drag && drag.moved < 5) {
      const card = drag.el.closest<HTMLElement>(".card");
      if (card && card.classList.contains("clickable")) expandNode(Number(card.dataset.i));
      else { shutInspect(true); closeWin(); }
    }
    drag = null;
    viewport.classList.remove("grabbing");
  });

  /* ── 节点与连边 ───────────────────────────────────────── */
  const nodes: HTMLElement[] = [];
  const cards: HTMLElement[] = [];
  const edges: EdgeView[] = [];
  const state: CardState[] = [];

  /* 沿路径找到 x = 目标 的位置对应的弧长。控制点的 x 单调，二分足够。 */
  function lengthAtX(path: SVGPathElement, targetX: number) {
    const total = path.getTotalLength();
    let lo = 0, hi = total;
    for (let k = 0; k < 18; k++) {
      const mid = (lo + hi) / 2;
      if (path.getPointAtLength(mid).x < targetX) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /* edges[k]：node k → node k+1 */
  function makeEdge(k: number, to: Step) {
    const x1 = nodeX(k) + TILE, y1 = nodeY(k) + TILE / 2;
    const x2 = nodeX(k + 1), y2 = nodeY(k + 1) + TILE / 2;
    const d = (x2 - x1) * 0.52;

    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "edge");
    g.style.setProperty("--c", to.color);

    const port = document.createElementNS(SVGNS, "circle");
    port.setAttribute("class", "port");
    port.setAttribute("cx", String(x1)); port.setAttribute("cy", String(y1)); port.setAttribute("r", String(3.2));
    g.appendChild(port);

    const path = document.createElementNS(SVGNS, "path");
    path.setAttribute("class", "wire");
    path.setAttribute("d", `M${x1},${y1} C${x1 + d},${y1} ${x2 - d},${y2} ${x2},${y2}`);
    g.appendChild(path);

    const tip = document.createElementNS(SVGNS, "path");
    tip.setAttribute("class", "tip");
    tip.setAttribute("d", `M${x2 - 9},${y2 - 6} L${x2 - 1.5},${y2} L${x2 - 9},${y2 + 6}`);
    g.appendChild(tip);

    wires.appendChild(g);
    const len = path.getTotalLength();
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);

    /* dashoffset 正数收尾端、负数收首端。
       head：源节点展开时被它右沿盖住的那一段。
       tail：目标节点展开时被它左沿盖住的那一段。 */
    const head = lengthAtX(path, nodeX(k) + TILE / 2 + OPEN_W / 2);
    const tail = len - lengthAtX(path, nodeX(k + 1) + TILE / 2 - OPEN_W / 2);
    /* 插口必须钉在线真正被切断的那一点，不是卡片的竖直中点——
       线在卡片左沿处还没爬到目标节点的高度，差 30 多像素，那样就悬空了。 */
    const hp = path.getPointAtLength(head);
    const tp = path.getPointAtLength(len - tail);
    const e = {
      g, path, len, head, tail, drawn: false,
      outAt: { x: hp.x - nodeX(k), y: hp.y - nodeY(k) },
      inAt: { x: tp.x - nodeX(k + 1), y: tp.y - nodeY(k + 1) },
    };
    edges[k] = e;
    return e;
  }
  const placeSocket = (node: HTMLElement, sel: string, pt: Point) => {
    const s = element(node, sel);
    s.style.left = pt.x + "px";
    s.style.top = pt.y + "px";
  };
  function setDash(e: EdgeView, off: number, ms: number) {
    e.path.style.transition = ms
      ? `stroke-dashoffset ${ms}ms var(--ease-flow), stroke 300ms ease, stroke-width 280ms ease`
      : "none";
    e.path.style.strokeDashoffset = String(off);
  }
  function drawEdge(k: number, ms?: number) {
    const e = edges[k];
    if (!e || e.drawn) return;
    e.drawn = true;
    e.g.classList.add("on");
    setDash(e, 0, ms === undefined ? T.edge / SPEED : ms);
  }
  /* 卡片展开／收回时，两侧的线跟着缩回／伸出，始终接在卡片边上。 */
  function plugEdges(i: number, open: boolean, ms: number) {
    const inE = edges[i - 1], outE = edges[i];
    if (inE && inE.drawn) {
      setDash(inE, open ? inE.tail : 0, ms);
      inE.g.classList.toggle("tuck", open);
    }
    if (outE && outE.drawn) setDash(outE, open ? -outE.head : 0, ms);
    present(nodes[i]).classList.toggle("open", open);
  }

  function makeNode(i: number, step: Step) {
    const edge = i > 0 ? makeEdge(i - 1, step) : null;

    const node = document.createElement("div");
    node.className = "node" + (i > 0 ? " has-in" : "");
    node.style.left = nodeX(i) + "px";
    node.style.top = nodeY(i) + "px";
    node.style.setProperty("--c", step.color);
    node.innerHTML = '<i class="socket socket-in"></i><i class="socket socket-out"></i>';
    if (edge) {
      placeSocket(node, ".socket-in", edge.inAt);
      placeSocket(present(nodes[i - 1]), ".socket-out", edge.outAt);
      present(nodes[i - 1]).classList.add("has-out");
    }

    const card = document.createElement("article");
    card.className = "card";
    card.dataset.i = String(i);
    card.style.setProperty("--c", step.color);
    card.innerHTML =
      '<div class="mini">' +
      `<div class="mini-top"><span class="icon">${ICONS[step.icon]}</span><span class="mini-kind"></span><span class="mark"></span></div>` +
      '<div class="mini-fill"></div><h3 class="mini-name"></h3><p class="mini-evi"></p>' +
      "</div>" +
      '<div class="full">' +
      `<div class="full-top"><span class="icon">${ICONS[step.icon]}</span><h3 class="full-name"></h3><span class="full-kind"></span></div>` +
      '<p class="note"></p><div class="code"><div class="code-in"></div></div>' +
      "</div>";
    element(card, ".mini-kind").textContent = step.kind;
    element(card, ".full-kind").textContent = step.kind;
    node.appendChild(card);
    world.appendChild(node);

    nodes.push(node); cards.push(card);
    state.push({ status: "new", edited: false, view: null });
    return card;
  }

  const dimOthers = (active: number | null) => cards.forEach((c, i) => c.classList.toggle("dim", active !== null && i !== active));

  function fillFull(card: HTMLElement, spec: Step) {
    const noteEl = element(card, ".note");
    const codeEl = element(card, ".code");
    const inner = element(card, ".code-in");
    noteEl.textContent = spec.note || "";
    noteEl.style.display = spec.note ? "" : "none";
    inner.innerHTML = "";
    const lines = spec.content.map((raw) => {
      const el = document.createElement("div");
      el.className = "ln";
      const tokens = tokenize(raw, spec.lang);
      /* token 的 span 预先建好、留空。打字时只改光标所在那一个 span 的
         textContent，后面的还是空的——所以光标 append 在行尾就正好落在
         已写出的字后面。 */
      const spans = tokens.map((tk) => {
        const s = document.createElement("span");
        if (tk.cls) s.className = "t-" + tk.cls;
        el.appendChild(s);
        return s;
      });
      inner.appendChild(el);
      /* 每个 token 的显示宽度先算好，逐字揭示时不用反复量。 */
      const tw = tokens.map((tk) => wide(tk.text));
      const width = tw.reduce((a, b) => a + b, 0);
      return { el, tokens, spans, tw, width, raw, cost: width + rest(width ? NL_REST : BLANK_REST) };
    });
    codeEl.style.height = CODE_PAD + "px";   /* 零行，measureOpen 量到的就是 baseH */
    return { lines, codeEl, inner };
  }

  /* 展开的卡片钉住上沿往下长。
     卡片是 translate(-50%,-50%) 居中的，高度一变上下两沿各动一半——
     写字时每多一行就是上沿弹一下 9.5px，一张卡弹三十次。
     位移由高度算出来（h=TILE 时正好是 0，等于收回态），
     上沿就在整个展开、书写、收回的过程里一动不动，只有下沿跟着字往下走。 */
  function setBox(card: HTMLElement, h: number) {
    card.style.width = OPEN_W + "px";
    card.style.height = h + "px";
    card.style.transform = `translate(-50%, calc(-50% + ${((h - TILE) / 2).toFixed(1)}px))`;
  }
  const closeBox = (card: HTMLElement) => {
    card.style.width = TILE + "px"; card.style.height = TILE + "px"; card.style.transform = "";
  };
  function measureOpen(card: HTMLElement) {
    card.classList.add("measuring", "open");
    card.style.width = OPEN_W + "px"; card.style.height = "auto";
    const h = card.offsetHeight;
    card.classList.remove("open"); closeBox(card);
    void card.offsetHeight;
    card.classList.remove("measuring");
    return h;
  }

  /* ── 流式输出 ─────────────────────────────────────────
     一条光标，从第一行第一个字逐字走到最后一行。打字机，不是别的。

     绕过一圈：中间试过「一拍落一块 token」，块整个瞬间出现 = 每 34ms
     顿一下；又给块加了淡入想把这一顿抹平，结果连逐字的手感一起抹掉了。
     两条都退掉。逐字本身没错，错的是另外三处：

       · 太快。旧版 330 字/秒，每帧推进 5.5 个字。现在 240 字宽/秒，
         每帧 4 个字宽（中文两个字）——慢下来，前沿才跟得住。
       · 按字算，不按字宽算。中文一个字占两个字宽，同样 330 字/秒，
         中文那张卡的推进速度是代码卡的 1.7 倍（3600 px/s vs 2160），
         一眼糊过去。现在推进的是「显示宽度」，全角计 2，
         所有卡的前沿速度一样。
       · 框和字是两个时钟。见 streamCard 上面那段。

     行末的气保留旧版那一档（70ms / 空行 120ms）：sink 那张 4.65s 里
     有 1.6s 是停顿，那三分之一才是节奏感的来源，不是每秒多少个字。
     六步合计约 34s（旧版 19.8s）。1× 是给人看清楚的，赶时间按 2×。 */
  const CPS = 240;              /* 每秒推进多少「字宽」（全角计 2） */
  const NL_REST = 70;           /* 行末换气 */
  const BLANK_REST = 120;       /* 空行没有字可落，气留长一点 */
  const rest = (ms: number) => (CPS * ms) / 1000;   /* 把停顿也折成字宽，光标就只有一条时间轴 */
  /* 换气这段时长 CSS 也要用（框在这段里腾地方），从这里写过去，
     省得两边各写一份、改一边忘一边。 */
  document.documentElement.style.setProperty("--breath", NL_REST + "ms");

  const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
  const wide = (s: string) => { let n = 0; for (const c of s) n += WIDE.test(c) ? 2 : 1; return n; };

  const caretEl = document.createElement("span");
  caretEl.className = "caret";

  /* 光标推进到「第 u 个字宽」处。只有它落在中间的那一个 span 需要改，
     后面的 span 还是空的——所以 caret append 在行尾就正好在已写出的字后面。 */
  function revealUnits(line: Line, u: number) {
    const { tokens, spans, tw } = line;
    let acc = 0;
    for (let k = 0; k < spans.length; k++) {
      const t = present(tokens[k]).text;
      let want;
      if (acc >= u) want = 0;
      else if (acc + present(tw[k]) <= u) want = t.length;
      else {
        let i = 0, a = acc;
        while (i < t.length && a + wide(t.charAt(i)) <= u) { a += wide(t.charAt(i)); i++; }
        want = i;
      }
      if ((present(spans[k]).textContent ?? "").length !== want) present(spans[k]).textContent = t.slice(0, want);
      acc += present(tw[k]);
      if (acc >= u) break;
    }
  }

  /* 整张卡一条光标流完，中间不停。行不是节拍单位，只是光标越过换行时
     顺手点亮的一行；行末那口气也折成字宽，所以全程只有一条时间轴。

     框跟着行走：多一行就长 19px。之前是让框按预估时长匀速长，那是两个
     时钟——量出来光标底下常年空着 42~64px，extract 那张在 17~82px 之间
     来回摆。现在长高这一下挪进「行末换气」：那段时间没有字在落，框把
     下一行的位置腾出来，等气换完新行正好写进现成的空当。一步到位地跳
     19px 也是抖，所以给它整段换气的时长走完，和写字互不重叠。
     写满可见行数之后框不再长，改成往上顶一行；光标始终钉在最后一行，
     所以顶的那一下发生在视线之外。 */
  function streamCard(lines: Line[], visLines: number, scrollEl: HTMLElement, grow: (n: number) => void, token: number) {
    return new Promise<boolean>((resolve) => {
      let pos = 0, base = 0, li = 0, last = 0, roomed = false;
      present(lines[0]).el.classList.add("on");
      present(lines[0]).el.appendChild(caretEl);
      const tick = (t: number) => {
        if (!alive(token)) { caretEl.remove(); return resolve(false); }
        if (!last) last = t;
        pos += (CPS * SPEED * Math.min(t - last, 100)) / 1000;   /* 掉帧时不要一次补太多 */
        last = t;
        /* 一帧里可能跨过好几行——掉帧时不能只走一行，否则会越落越远。 */
        for (;;) {
          const line = present(lines[li]);
          const local = pos - base;
          if (local < line.width) { revealUnits(line, local); break; }
          revealUnits(line, line.width);
          if (li === lines.length - 1) { caretEl.remove(); return resolve(true); }
          if (!roomed) { roomed = true; if (li + 2 <= visLines) grow(li + 2); }
          if (local < line.cost) break;      /* 还在换气 */
          base += line.cost; li++; roomed = false;
          const next = present(lines[li]);
          next.el.classList.add("on");
          next.el.appendChild(caretEl);      /* span 都还空着，等于插在行首 */
          if (li + 1 > visLines) scrollEl.scrollTop = scrollEl.scrollHeight;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  /* ── 一个节点：备料 → 到达 → 写 → 收回 ─────────────────
     拆成四段而不是一个大函数，是因为「收回」的尾巴要和下一格的「到达」重叠，
     这段重叠正是之前缺的那口气。 */
  function prepare(i: number, spec: Step, rework: boolean) {
    const card = rework ? present(cards[i]) : makeNode(i, spec);
    card.classList.remove("done", "clickable", "writing", "morph");
    element(card, ".mini-evi").classList.remove("visible");
    element(card, ".mini-kind").textContent = spec.kind;
    element(card, ".full-name").textContent = spec.title;
    element(card, ".full-kind").textContent = spec.kind;
    const { lines, codeEl, inner } = fillFull(card, spec);
    const baseH = measureOpen(card);
    const visLines = Math.min(lines.length, MAX_CODE_LINES);
    return { card, lines, codeEl, inner, visLines, baseH, fullH: baseH + visLines * CODE_LH };
  }

  /* 到达：线先走，镜头同一拍跟着走，两件事同时停；
     线到了卡片才在尽头长出来，而且长完才交棒——
     approach 返回时这一格是完全静止的，展开是从静止开始的。
     镜头要瞄写满之后的那个框，不是脚下这块砖：卡片钉住上沿往下长，
     瞄砖的话写到一半就掉出画面下沿了。这一下也只在这一拍里发生。 */
  async function approach(i: number, spec: Step, prep: Prepared, token: number) {
    const card = present(cards[i]);
    if (i === 0) {
      focusNode(0, false, prep.fullH);
      card.classList.add("shown");
      setStatus(spec.color, "正在生成 · " + spec.kind);
      await wait(T.born);
      return alive(token);
    }
    drawEdge(i - 1);
    focusNode(i, true, prep.fullH);
    await wait(T.edge - 40);
    if (!alive(token)) return false;
    card.classList.add("shown");
    setStatus(spec.color, "正在生成 · " + spec.kind);
    await wait(T.born);   /* 出生弹簧走完，不截断 */
    return alive(token);
  }

  async function write(i: number, spec: Step, prep: Prepared, token: number) {
    const { card, lines, codeEl, inner, visLines, baseH } = prep;
    /* 钉住的这一小拍：卡片已经停稳，只亮起「下一个是我」的点，不动几何。 */
    card.classList.add("frontier");
    if (edges[i - 1]) present(edges[i - 1]).g.classList.add("hot");
    await wait(T.fix);
    if (!alive(token)) return false;

    /* 展开：只开出第一行的高度。往下有多少内容，是内容自己写出来的，
       不是框先划好一块空地等着填。 */
    const grow = (n: number) => {
      codeEl.style.height = CODE_PAD + n * CODE_LH + "px";
      setBox(card, baseH + n * CODE_LH);
    };
    dimOthers(i);
    card.classList.add("morph", "open");
    grow(1);
    plugEdges(i, true, T.open / SPEED);

    /* 等弹簧走完再落第一个字。--spring 的 y2 是 1.28，展开是会冲过头的，
       峰值正好落在 0.55 倍时长上——原来就是在那一刻开始写的，等于字跟着框在晃。
       这一拍不空：标题和说明在弹簧里就已经淡进来了。 */
    await wait(T.open);
    if (!alive(token)) return false;

    /* 写的过程中高度不再走过渡：一行到位，和那一行出现是同一帧。 */
    card.classList.remove("morph");
    card.classList.add("writing");
    const ok = await streamCard(lines, visLines, inner, grow, token);
    if (!ok || !alive(token)) return false;

    await wait(spec.hold || 700);
    return alive(token);
  }

  /* 收回：立牌之后就返回，让弹簧的尾巴和下一格的出发叠在一起。 */
  async function settle(i: number, spec: Step, prep: Prepared, token: number, rework: boolean) {
    const { card } = prep;
    const st = present(state[i]);
    st.status = "done";
    if (rework) st.edited = true;
    st.view = {
      lang: spec.lang, content: prep.lines.map((l) => l.el.textContent ?? ""), note: spec.note,
      engine: spec.engine, kind: spec.kind, title: spec.title, color: spec.color,
    };

    element(card, ".mini-name").textContent = spec.title;
    element(card, ".mini-evi").innerHTML =
      spec.evidence + (st.edited ? ' · <span class="tag-you">已修改</span>' : "");

    /* 收回也得让高度和位移同一条时长走，否则上沿会在收的过程里飘。 */
    card.classList.remove("writing", "open");
    card.classList.add("morph");
    closeBox(card);
    plugEdges(i, false, T.close / SPEED);
    await wait(180);
    if (!alive(token)) return false;
    element(card, ".mini-evi").classList.add("visible");
    card.classList.remove("frontier");
    card.classList.add("done");
    if (edges[i - 1]) present(edges[i - 1]).g.classList.remove("hot");
    await wait(T.lead);
    return alive(token);
  }

  /* ── 全局状态（挂在需求框里） ─────────────────────────── */
  function setStatus(color: string | null, text: string, done?: boolean) {
    taskDot.style.setProperty("--dot", color || "#c9ced6");
    taskDot.classList.toggle("done", Boolean(done));
    taskState.textContent = text;
    engBtn.hidden = !done;
  }
  function showDone() {
    setStatus(null, `已生成 ${state.length} 步 · 每天定时运行`, true);
  }
  function setDock(on: boolean) {
    sendEl.disabled = !on;
    inputEl.disabled = !on;
    inputEl.placeholder = on ? "描述你要改的地方" : "正在生成…";
    chipEl.classList.toggle("visible", on);
    if (on) chipEl.textContent = FOLLOWUP.text;
    /* 生成过程中不给点开：镜头归导演管，两边抢会打架。 */
    cards.forEach((c, i) => c.classList.toggle("clickable", on && present(state[i]).status === "done"));
  }

  /* ── 需求框：从输入框飞到右上角 ───────────────────────── */
  function typeInput(text: string, token: number) {
    inputEl.value = "";
    autosize();
    return new Promise<boolean>((resolve) => {
      let shown = 0, last = 0;
      const tick = (t: number) => {
        if (!alive(token)) return resolve(false);
        if (!last) last = t;
        const dt = Math.min(t - last, 50); last = t;
        shown = Math.min(text.length, shown + (30 * SPEED * dt) / 1000);
        const n = Math.floor(shown);
        if (inputEl.value.length !== n) {
          inputEl.value = text.slice(0, n);
          sendEl.disabled = n === 0;
          autosize();
        }
        if (shown >= text.length) return resolve(true);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
  function autosize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 110) + "px";
  }

  /* 状态栏展开后该多高，量一次写进 --foot-h。
     不能写死：box-sizing 是 border-box，写死的数会把 padding 和分隔线吃掉，
     文字被裁一截。字号或行高一改，量出来的自动跟着变。 */
  function sizeFoot() {
    const had = taskState.textContent;
    if (!had) taskState.textContent = "量";
    taskCard.classList.add("probe", "landed");
    taskCard.style.setProperty("--foot-h", taskFoot.offsetHeight + "px");
    taskCard.classList.remove("probe", "landed");
    if (!had) taskState.textContent = "";
    void taskCard.offsetHeight;
  }


  /* ── Plan 阶段 ─────────────────────────────────────────
     画布空着的时候，注意力自然在这张卡上，所以它落在画布中央。
     谈完之后它收窄、正文塌掉、飞到右上角变成需求框——同一张卡换形态，
     不是消失再出现一个新的。飞行沿用下面 flyTask 那套：先按两块文字的
     左上角对齐算位移，走弧线，中途不重排。 */

  /* 1× 就是真实节奏，不是演示节奏。Plan Agent 出一份计划现实里十几秒，
     其中最长的一段是「还什么都没有」的那一段——那正是最需要有形态的地方。
     想看快的按 4×，所有等待都会除以 SPEED。 */
  const TP = REDUCED
    ? { land: 0, think1: 0, think2: 0, think3: 0, row: 0, gap: 0, reflect: 0 }
    : { land: 900, think1: 2600, think2: 1800, think3: 2000, row: 260, gap: 900, reflect: 2200 };

  /* 结构化内容是一条一条落的，不是一块一块闪出来的——
     真实的流式输出解析出一条就渲染一条，观感本来就是这样。 */
  async function dropRows(host: HTMLElement, htmls: string[], token: number, step: number) {
    for (const h of htmls) {
      const el = document.createElement("div");
      el.innerHTML = h;
      while (el.firstChild) {
        const node = el.firstChild;
        el.removeChild(node);
        if (node instanceof Element) node.classList.add("drop");
        host.appendChild(node);
      }
      await wait(step);
      if (!alive(token)) return false;
    }
    return true;
  }

  const planPairHTML = (rows: [string, string][]) => rows
    .map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join("");

  /* 输入框里那句话飞到画布中央，撑成 Plan 窗口。 */
  async function flyToPlan(token: number) {
    sendEl.disabled = true;
    planText.textContent = TASK;
    planCard.hidden = false;
    planCard.classList.remove("open", "morph", "mini");
    planCard.style.height = "";
    planCard.style.left = ""; planCard.style.top = "";
    planCard.style.width = "560px";
    ["#planSecU", "#planSecR", "#planSecA"].forEach((k) => { $(k).hidden = true; });
    planDot.classList.remove("done");
    planSay.textContent = "";
    planSay.classList.remove("user");
    planCard.getAnimations().forEach((a) => a.cancel());
    /* 先按最终宽度量位置，飞的时候只动 transform，那句话一次都不重排。 */
    planCard.style.transform = "translate(-50%, -50%)";
    void planCard.offsetHeight;

    const a = inputEl.getBoundingClientRect();
    const b = planText.getBoundingClientRect();
    const dx = Math.round(a.left - b.left);
    const dy = Math.round(a.top - b.top);
    const dur = Math.max(1, T.fly / SPEED);

    inputEl.classList.add("gone");
    const N = 40, frames = [];
    for (let k = 0; k <= N; k++) {
      const t = k / N, m = 1 - t;
      const x = m * m * dx + 2 * m * t * dx * 0.70;
      const y = m * m * dy + 2 * m * t * dy * 0.06;
      frames.push({
        offset: t,
        transform: `translate(-50%, -50%) translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${(0.94 + 0.06 * t).toFixed(4)})`,
      });
    }
    planCard.animate(frames, { duration: dur, fill: "both", easing: "cubic-bezier(.4,0,.2,1)" });
    planCard.animate([{ opacity: 0 }, { opacity: 1 }],
      { duration: Math.min(240, dur), easing: "cubic-bezier(.3,.8,.4,1)", fill: "both" });

    setTimeout(() => {
      inputEl.value = ""; inputEl.placeholder = "回答上面待确认的问题";
      inputEl.classList.remove("gone"); autosize();
    }, 160 / SPEED);

    await wait(T.fly);
    if (!alive(token)) return false;
    planCard.getAnimations().forEach((an) => an.cancel());
    planCard.style.transform = "translate(-50%, -50%)";
    return true;
  }

  const showSec = async (sel: string, ms: number, token: number) => {
    const el = $(sel);
    el.hidden = false;
    el.classList.remove("enter"); void el.offsetHeight; el.classList.add("enter");
    await wait(ms);
    return alive(token);
  };

  /* 内容一块一块出来，每块出来前先说一句在做什么——
     用户等的这段时间里，看得见它在往哪走。 */
  async function buildPlan(token: number) {
    planCard.classList.add("open");

    /* 卡片刚落定，什么都还没有。真实场景里这一段最长——
       所以它不是一段空白，它有一行会变的字，说清楚现在在想什么。 */
    await wait(TP.land);
    if (!alive(token)) return false;
    planSay.textContent = "正在理解需求";
    await wait(TP.think1);
    if (!alive(token)) return false;

    $("#planSecU").hidden = false;
    planPair.innerHTML = "";
    if (!(await dropRows(planPair, PLAN.understanding.map(
      ([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`), token, TP.row))) return false;
    await wait(TP.gap);
    if (!alive(token)) return false;

    planSay.textContent = "正在规划路线";
    await wait(TP.think2);
    if (!alive(token)) return false;
    $("#planSecR").hidden = false;
    planRoute.innerHTML = "";
    if (!(await dropRows(planRoute, PLAN.route.map(
      (r, i) => (i ? '<i>→</i>' : '') + `<span>${esc(r)}</span>`), token, TP.row))) return false;
    await wait(TP.gap);
    if (!alive(token)) return false;

    planSay.textContent = "正在核对缺失";
    await wait(TP.think3);
    if (!alive(token)) return false;
    $("#planSecA").hidden = false;
    planAsks.innerHTML = "";
    if (!(await dropRows(planAsks, PLAN.asks.map(
      ([q, why], i) => `<div class="plan-ask"><i class="q">${i + 1}</i><div><b>${esc(q)}</b><span>${esc(why)}</span></div></div>`),
      token, TP.row * 1.6))) return false;
    await wait(TP.gap);
    if (!alive(token)) return false;

    planDot.classList.add("done");
    planSay.textContent = PLAN.done;
    return alive(token);
  }

  /* 用户回答 → 这张卡当场变：问号划掉、理解那一栏跟着改、能做到哪一步也变。
     这是「你看着什么，就改什么」——他在底下打字，变化就发生在他正看的这张卡上。 */
  async function answerPlan(token: number) {
    if (!(await typeInput(PLAN.reply, token))) return false;
    await wait(360);
    if (!alive(token)) return false;
    inputEl.value = ""; autosize();
    planSay.classList.add("user");
    planSay.textContent = PLAN.reply;
    await wait(620);
    if (!alive(token)) return false;

    /* 回答不是立刻生效的。它得先想一下这两句改变了什么。 */
    planDot.classList.remove("done");
    planSay.classList.remove("user");
    planSay.textContent = "正在更新计划";
    await wait(TP.reflect);
    if (!alive(token)) return false;

    /* 只划掉真被这句话答掉的：q1 q2 清了,q3 q4 还留着。
       留着的不挡路——骨架照样生成,那些是骨架上的填空。 */
    planAsks.querySelectorAll(".plan-ask").forEach((el, i) => {
      if (PLAN.after.answeredAsks.includes(i)) el.classList.add("answered");
    });
    await wait(TP.gap);
    if (!alive(token)) return false;

    /* 理解那一栏逐行改写：哪几行变了，看得见。
       补的那句话带来新的理解（u5 u6），在末尾长出来。 */
    const rows = planPair.querySelectorAll("dd");
    for (let i = 0; i < PLAN.after.understanding.length; i++) {
      const [quote, next] = present(PLAN.after.understanding[i]);
      const row = rows[i];
      if (row) {
        if (row.textContent !== next) {
          row.classList.add("swap");
          await wait(TP.row * 0.6);
          row.textContent = next;
          row.classList.remove("swap");
          row.classList.add("drop");
        }
      } else {
        const dt = document.createElement("dt");
        dt.textContent = quote;
        dt.classList.add("drop");
        const dd = document.createElement("dd");
        dd.textContent = next;
        dd.classList.add("drop");
        planPair.append(dt, dd);
      }
      await wait(TP.row * 0.7);
      if (!alive(token)) return false;
    }

    /* 路线上同编号的步骤标题变了就是原地改：s2 从「提取文本」换成 OCR，
       格子不动，字换掉。 */
    const chips = planRoute.querySelectorAll("span");
    for (let i = 0; i < PLAN.after.route.length; i++) {
      const next = present(PLAN.after.route[i]);
      const chip = chips[i];
      if (chip && chip.textContent !== next) {
        chip.classList.add("swap");
        await wait(TP.row * 0.6);
        chip.textContent = next;
        chip.classList.remove("swap");
        chip.classList.add("drop");
      }
      if (!alive(token)) return false;
    }

    planDot.classList.add("done");
    planSay.textContent = PLAN.after.done;
    /* 挡路的答了，入口就出现。出现本身就是提示。 */
    planGo.hidden = false;
    planGo.classList.add("drop");
    inputEl.placeholder = "还想改点什么";
    await wait(TP.gap);
    return alive(token);
  }

  /* 收窄 → 停一拍 → 飞。两个几何动画不叠在一起，
     这是 V6 自己的规矩：一拍只干一件事。 */
  async function flyPlanToTask(token: number) {
    /* 演示里替用户按一下：先停一拍让人看清入口在哪，再按。 */
    await wait(1500);
    if (!alive(token)) return false;
    planGo.classList.add("pressed");
    await wait(160);
    if (!alive(token)) return false;
    planGo.classList.remove("pressed");
    await wait(220);
    if (!alive(token)) return false;
    planGo.hidden = true;
    planGo.classList.remove("drop");

    planCard.classList.remove("open");
    planCard.style.width = "320px";
    await wait(460);
    if (!alive(token)) return false;

    taskText.textContent = TASK;
    taskCard.hidden = false;
    taskCard.classList.remove("landed");
    sizeFoot();
    void taskCard.offsetHeight;

    const a = planText.getBoundingClientRect();
    const b = taskText.getBoundingClientRect();
    const dx = Math.round(b.left - a.left);
    const dy = Math.round(b.top - a.top);
    const dur = Math.max(1, (T.fly * 1.05) / SPEED);

    taskCard.style.opacity = "0";
    const N = 40, frames = [];
    for (let k = 0; k <= N; k++) {
      const t = k / N, m = 1 - t;
      const x = 2 * m * t * dx * 0.30 + t * t * dx;
      const y = 2 * m * t * dy * 0.94 + t * t * dy;
      frames.push({ offset: t, transform: `translate(-50%, -50%) translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)` });
    }
    const legAnim = planCard.animate(frames, { duration: dur, fill: "both", easing: "cubic-bezier(.4,0,.2,1)" });
    await legAnim.finished.catch(() => {});
    if (!alive(token)) return false;

    /* 落位那一刻交接：两张卡的「需求」两行字号行高完全一样，位置也重合，
       所以换手是看不见的。 */
    taskCard.style.opacity = "";
    planCard.getAnimations().forEach((an) => an.cancel());
    planCard.hidden = true;
    planCard.style.transform = "translate(-50%, -50%)";
    taskCard.classList.add("landed");
    taskCard.classList.add("live");
    await wait(T.fly * 0.28);
    return alive(token);
  }


  /* ── 台前调度式的交换 ───────────────────────────────────
     点右上角的卡片，它飞回中央并展开；同一拍里画布往后退。两个动作同时起、
     同时停，读起来是一次交换，不是「先消失再出现」。
     退的是深度不是平面：工作流留在原位一个像素没挪，所以改完回来时
     只有真正被改的那个节点是变了的——退场不会把局部修改的范围盖掉。
     飞行途中只动 transform 和 scale，不改宽高；真正的展开等落位后再走一拍，
     沿用 V6 那条规矩：同一张卡上两个几何动画不叠。 */
  let planOpen = false, planBusy = false;

  /* 起点终点都写全，不靠 reverse——reverse 只翻帧序，不翻 scale 的方向，
     收起时会从 scale(.86) 起步，对着已经 scale(1) 的卡片弹一下。 */
  function arcFrames(x0: number, y0: number, s0: number, x1: number, y1: number, s1: number, cx: number, cy: number) {
    const N = 40, out = [];
    const px = x0 + (x1 - x0) * cx, py = y0 + (y1 - y0) * cy;
    for (let k = 0; k <= N; k++) {
      const t = k / N, m = 1 - t;
      const x = m * m * x0 + 2 * m * t * px + t * t * x1;
      const y = m * m * y0 + 2 * m * t * py + t * t * y1;
      out.push({
        offset: t,
        transform: `translate(-50%, -50%) translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${(s0 + (s1 - s0) * t).toFixed(4)})`,
      });
    }
    return out;
  }

  const SWAP = 620;

  /* 跳到完成态时 buildPlan 没跑过，Plan 里是空的。展开前先补上——
     填的是 after 那一版：路线换过字，被答掉的问题划掉，剩下的留着。 */
  function ensurePlanContent() {
    if (planText.textContent) return;
    planText.textContent = TASK;
    planPair.innerHTML = planPairHTML(PLAN.after.understanding);
    planRoute.innerHTML = PLAN.after.route
      .map((r, i) => (i ? '<i>→</i>' : '') + `<span>${esc(r)}</span>`).join("");
    planAsks.innerHTML = PLAN.asks
      .map(([q, why], i) => `<div class="plan-ask${PLAN.after.answeredAsks.includes(i) ? " answered" : ""}"><i class="q">${i + 1}</i><div><b>${esc(q)}</b><span>${esc(why)}</span></div></div>`)
      .join("");
    ["#planSecU", "#planSecR", "#planSecA"].forEach((k) => { $(k).hidden = false; });
    planDot.classList.add("done");
  }

  /* 把卡片钉在具体像素上。默认那套 left:50%/translate(-50%,-50%) 在宽高变化时
     自己也在移动，和形变叠在一起算不清，所以形变期间一律用实测坐标。 */
  function pinPlan(rect: {left: number; top: number; width?: number; height?: number}) {
    planCard.style.left = rect.left + "px";
    planCard.style.top = rect.top + "px";
    planCard.style.transform = "none";
    if (rect.width) planCard.style.width = rect.width + "px";
    if (rect.height) planCard.style.height = rect.height + "px";
  }
  /* 展开后停在画布中央：中央指的是画布可视区，不是整屏——
     顶栏和底部输入条各占一条，按它们让一让才是真的居中。 */
  function planCenterRect() {
    const w = Math.min(560, innerWidth - 48);
    const top0 = 68, bottom0 = 128;
    planCard.style.width = w + "px";
    const h = planCard.getBoundingClientRect().height;
    return {
      left: Math.round((innerWidth - w) / 2),
      top: Math.round(top0 + (innerHeight - bottom0 - top0 - h) / 2),
      width: w, height: Math.round(h),
    };
  }

  async function openPlanFromTask() {
    if (planBusy || planOpen || taskCard.hidden) return;
    planBusy = true;
    ensurePlanContent();
    closeWin();
    if (shutInspect(false)) { inspectCam = null; await wait(T.close); }

    const dur = Math.max(1, SWAP / SPEED);
    planCard.style.setProperty("--mo", dur + "ms");

    /* ① 先量终态：展开、560 宽，量出正文真实高度、卡片高度和落点。 */
    planCard.classList.remove("morph", "mini");
    planCard.hidden = false;
    planCard.classList.add("open");
    planCard.style.transition = "none";
    planBody.style.maxHeight = "none";
    planCard.style.width = "560px";
    void planCard.offsetHeight;
    const bodyH = Math.min(planBody.scrollHeight, Math.round(innerHeight * 0.62));
    planBody.style.maxHeight = bodyH + "px";
    void planCard.offsetHeight;
    const to = planCenterRect();

    /* ② 再摆初态：收拢、贴着右上角那张卡，逐项对齐——
       同样的 padding、同样的宽度、同样的位置，此刻两张卡是重合的。 */
    const tr = taskCard.getBoundingClientRect();
    planCard.classList.remove("open");
    planCard.classList.add("mini");
    planBody.style.maxHeight = "0px";
    pinPlan({ left: tr.left, top: tr.top, width: tr.width, height: tr.height });
    void planCard.offsetHeight;
    taskCard.hidden = true;

    /* ③ 开闸。位置、宽度、内边距、正文高度同一条时长同一条缓动，一起走。 */
    planCard.style.transition = "";
    planCard.classList.add("morph");
    stage.classList.add("swap");
    stage.classList.add("recede");
    void planCard.offsetHeight;
    planCard.classList.remove("mini");
    planCard.classList.add("open");
    planBody.style.maxHeight = bodyH + "px";
    pinPlan(to);

    await wait(SWAP);
    planCard.classList.remove("morph");
    /* 落定后把高度交回内容，之后内容再变高也跟得上。 */
    planCard.style.height = "";
    planBody.style.maxHeight = "";
    planClose.hidden = false;
    planSay.textContent = PLAN.after.done;
    planOpen = true; planBusy = false;
  }

  async function closePlanToTask() {
    if (planBusy || !planOpen) return;
    planBusy = true;
    planClose.hidden = true;

    const dur = Math.max(1, SWAP / SPEED);
    planCard.style.setProperty("--mo", dur + "ms");

    taskCard.hidden = false;
    /* sizeFoot 会把 landed 一起摘掉（它是靠临时加 probe+landed 来量高度的），
       所以必须先量后加，顺序反了状态栏就永远塌着，右边那条也跟着没了。 */
    sizeFoot();
    /* 状态栏那条有 400ms 的高度过渡。加完 landed 立刻量，量到的是还塌着的高度，
       plan 卡就会收到一个偏矮的终点，末了换手时底下那 39px 晚一拍才冒出来——
       看着就是「先不完整，等一下才完整」。整个形变期间这张卡是全透明的，
       状态栏没人看，直接让它瞬间到位，量出来才是真实终高。 */
    taskFoot.style.transition = "none";
    taskCard.classList.add("landed");
    taskCard.style.opacity = "0";
    void taskCard.offsetHeight;
    const tr = taskCard.getBoundingClientRect();
    taskFoot.style.transition = "";

    /* 起点必须是具体像素，否则从 auto 过渡不了。 */
    planBody.style.maxHeight = planBody.clientHeight + "px";
    planCard.style.height = Math.round(planCard.getBoundingClientRect().height) + "px";
    void planCard.offsetHeight;

    planCard.classList.add("morph");
    stage.classList.add("swap");
    stage.classList.remove("recede");
    void planCard.offsetHeight;
    planCard.classList.remove("open");
    planCard.classList.add("mini");
    planBody.style.maxHeight = "0px";
    pinPlan({ left: tr.left, top: tr.top, width: tr.width, height: tr.height });

    await wait(SWAP);
    /* 收拢到位时两张卡完全重合，这时候换手看不出来。 */
    taskCard.style.opacity = "";
    planCard.hidden = true;
    planCard.classList.remove("morph", "mini");
    planBody.style.maxHeight = "";
    planCard.style.height = "";
    planCard.style.transition = "none";
    planCard.style.left = ""; planCard.style.top = "";
    planCard.style.width = "560px";
    planCard.style.transform = "translate(-50%, -50%)";
    void planCard.offsetHeight;
    planCard.style.transition = "";
    planOpen = false; planBusy = false;
  }

  /* 飞行只有 transform 和 opacity：卡片从头到尾都是最终尺寸，那段话一次都不重排。
     位移按「输入框里的文字」和「需求框里的文字」两块的左上角对齐来算——
     卡片浮出来的时候正好接住输入框里那句话，所以是同一句话换了个身份，
     不是凭空冒出来一个新框。中间那一帧让它先起后走，走的是弧线不是斜对角直线。 */
  async function flyTask(token: number) {
    sendEl.disabled = true;
    taskText.textContent = TASK;
    taskCard.hidden = false;
    taskCard.classList.remove("landed");
    taskCard.getAnimations().forEach((a) => a.cancel());
    sizeFoot();
    void taskCard.offsetHeight;

    const a = inputEl.getBoundingClientRect();
    const b = taskText.getBoundingClientRect();
    const dx = Math.round(a.left - b.left);
    const dy = Math.round(a.top - b.top);
    const dur = Math.max(1, T.fly / SPEED);

    inputEl.classList.add("gone");
    /* 走一条二次贝塞尔：控制点放在「横向 30% / 纵向 94%」处，
       所以它先离开输入框往上走，再横过去落位——弧线，不是斜对角直线。
       路径按 t 均匀采成密集关键帧，快慢完全交给 options.easing 一条曲线，
       整段速度是一条单峰、无回弹的钟形。分两段关键帧各配一条缓动的做法
       会在接缝处先顿一下再窜出去，那才是「生硬」。 */
    const N = 40;
    const frames = [];
    for (let k = 0; k <= N; k++) {
      const t = k / N, m = 1 - t;
      const x = m * m * dx + 2 * m * t * dx * 0.70;
      const y = m * m * dy + 2 * m * t * dy * 0.06;
      frames.push({
        offset: t,
        transform: `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${(0.94 + 0.06 * t).toFixed(4)})`,
      });
    }
    taskCard.animate(frames, { duration: dur, fill: "both", easing: "cubic-bezier(.4,0,.2,1)" });
    taskCard.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: Math.min(240, dur), easing: "cubic-bezier(.3,.8,.4,1)", fill: "both",
    });

    setTimeout(() => {
      inputEl.value = "";
      inputEl.placeholder = "正在生成…";
      inputEl.classList.remove("gone");
      autosize();
    }, 160 / SPEED);

    /* 状态栏等卡片基本停稳了才撑开：撑开是布局变化，不和飞行叠在一起。 */
    await wait(T.fly * 0.88);
    if (!alive(token)) return false;
    taskCard.classList.add("landed");
    await wait(T.fly * 0.32);
    taskCard.getAnimations().forEach((an) => an.cancel());
    return alive(token);
  }
  function showTaskInstant() {
    taskText.textContent = TASK;
    taskCard.hidden = false;
    taskCard.getAnimations().forEach((a) => a.cancel());
    sizeFoot();
    taskCard.classList.add("landed");
    taskCard.classList.add("live");
  }

  /* ── 点开已完成的节点 ─────────────────────────────────
     用的就是生成时那套展开：卡片从中心撑开、两侧的线缩进插口、其余变暗。
     同一个东西不该有两种形态，所以这里不另开浮窗——
     浮窗只留给「引擎节点」那种跨节点的清单。 */
  let inspecting: number | null = null;
  let inspectCam: typeof cam | null = null;
  let inspectToken = 0;

  function fillDone(card: HTMLElement, view: View) {
    const noteEl = element(card, ".note");
    const codeEl = element(card, ".code");
    element(card, ".full-name").textContent = view.title;
    element(card, ".full-kind").textContent = view.kind;
    noteEl.textContent = view.note || "";
    noteEl.style.display = view.note ? "" : "none";
    codeEl.style.height = CODE_PAD + "px";   /* 零行，measureOpen 量到的就是 baseH */
    const inner = element(card, ".code-in");
    inner.innerHTML = view.content
      .map((l) => `<div class="ln on">${renderTokens(tokenize(l, view.lang))}</div>`)
      .join("");
    /* 换内容不会重置滚动位置：写的时候滚到了底，点开就从第 13 行开始看。
       点开是要从头看这一步写了什么。 */
    inner.scrollTop = 0;
    return codeEl;
  }

  /* 关：restoreCam 为 false 表示只是换一格看，镜头不回原位。 */
  function shutInspect(restoreCam?: boolean) {
    if (inspecting === null) return false;
    const i = inspecting;
    inspecting = null;
    ++inspectToken;
    present(cards[i]).classList.remove("open");
    present(cards[i]).classList.add("morph");
    closeBox(present(cards[i]));
    plugEdges(i, false, T.close / SPEED);
    dimOthers(null);
    if (restoreCam !== false && inspectCam) {
      cam.x = inspectCam.x; cam.y = inspectCam.y; cam.s = inspectCam.s;
      applyCam(true);
      inspectCam = null;
    }
    return true;
  }

  async function expandNode(i: number) {
    const st = state[i];
    if (!st || st.status !== "done" || !st.view) return;
    if (inspecting === i) { shutInspect(true); return; }
    if (inspecting !== null) shutInspect(false);        /* 换一格，不等它关完 */
    else inspectCam = { x: cam.x, y: cam.y, s: cam.s };  /* 记住退出时回哪儿 */
    const tk = ++inspectToken;   /* 必须在 shutInspect 之后取：它自己也会递增 */

    const card = present(cards[i]);
    const codeEl = fillDone(card, st.view);
    const baseH = measureOpen(card);
    const visLines = Math.min(st.view.content.length, MAX_CODE_LINES);
    const openH = baseH + visLines * CODE_LH;

    focusNode(i, true, openH);   /* 总览态是缩着的，先把镜头带过去 */
    await wait(300);
    if (tk !== inspectToken) return;
    inspecting = i;
    dimOthers(i);
    codeEl.style.height = CODE_PAD + visLines * CODE_LH + "px";
    card.classList.add("morph", "open");
    setBox(card, openH);
    plugEdges(i, true, T.open / SPEED);
  }

  /* ── 浮窗：只用于引擎节点清单 ─────────────────────────── */
  let winEl: HTMLElement | null = null;
  function closeWin() {
    if (!winEl) return;
    const el = winEl; winEl = null;
    el.classList.remove("open");
    setTimeout(() => el.remove(), 260);
  }
  function placeWin(el: HTMLElement, rect: DOMRect, avoidTask?: boolean) {
    const M = 16;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = rect.right + M;
    if (left + w > innerWidth - M) left = rect.left - w - M;
    left = clamp(left, M, Math.max(M, innerWidth - w - M));
    let top = rect.bottom + M;
    if (top + h > innerHeight - M) top = rect.top - h - M;
    top = clamp(top, 68, Math.max(68, innerHeight - h - M));

    /* 别压住右上角的需求框：先试着让到它下面，让不下就挪到它左边。 */
    if (avoidTask !== false && !taskCard.hidden) {
      const t = taskCard.getBoundingClientRect();
      const hits = left < t.right + 12 && left + w > t.left - 12 && top < t.bottom + 12 && top + h > t.top - 12;
      if (hits) {
        if (t.bottom + 12 + h <= innerHeight - M) top = t.bottom + 12;
        else left = clamp(t.left - w - 12, M, Math.max(M, innerWidth - w - M));
      }
    }
    el.style.left = left + "px"; el.style.top = top + "px";
  }
  function openEngineList() {
    closeWin();
    const el = document.createElement("div");
    el.className = "win";
    el.style.width = "460px";
    el.dataset.i = "engine";
    el.innerHTML =
      '<div class="win-head"><h4>引擎节点</h4><button class="win-close" type="button" aria-label="关闭">×</button></div>' +
      '<div class="eng-list">' +
      state.map((st, i) => {
        const s = present(STEPS[i]);
        return `<div class="eng-row"><span>${esc((st.view && st.view.title) || s.title)}</span><code>${esc((st.view && st.view.engine) || s.engine)}</code></div>`;
      }).join("") + "</div>";
    element(el, ".win-close").addEventListener("click", (e) => { e.stopPropagation(); closeWin(); });
    document.body.appendChild(el);
    placeWin(el, taskCard.getBoundingClientRect());
    winEl = el;
    requestAnimationFrame(() => el.classList.add("open"));
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { shutInspect(true); closeWin(); }
  });

  /* ── 导演 ─────────────────────────────────────────────── */
  function reset() {
    closeWin();
    inspecting = null; inspectCam = null; ++inspectToken;
    nodes.forEach((n) => n.remove());
    wires.innerHTML = "";
    nodes.length = cards.length = edges.length = state.length = 0;
    wfNameEl.textContent = "未命名工作流";
    taskCard.hidden = true;
    taskCard.classList.remove("landed");
    planCard.hidden = true;
    planCard.classList.remove("open", "morph", "mini");
    planBody.style.maxHeight = "";
    planCard.style.height = "";
    planCard.style.left = ""; planCard.style.top = "";
    planCard.style.width = "560px";
    planText.textContent = "";
    planClose.hidden = true;
    planOpen = false; planBusy = false;
    taskCard.classList.remove("live");
    stage.classList.remove("swap", "recede");
    planCard.style.width = "560px";
    planCard.style.transform = "translate(-50%, -50%)";
    planCard.getAnimations().forEach((a) => a.cancel());
    taskCard.getAnimations().forEach((a) => a.cancel());
    inputEl.classList.remove("gone");
    setStatus(null, "");
    computeScale();
    centerOn(nodeX(0) + TILE / 2, nodeY(0) + TILE / 2, runScale, false);
  }

  async function run() {
    const token = ++runToken;
    reset();
    inputEl.disabled = false;
    inputEl.placeholder = "描述你要做的数据处理";
    chipEl.classList.remove("visible");
    await wait(420);
    if (!alive(token)) return;
    if (!(await typeInput(TASK, token))) return;
    await wait(340);
    if (!alive(token)) return;
    /* 先谈成一份 Plan，再开始长节点。原来这里是直接 flyTask——
       那是「一句话就够了」的假设，现在这个假设不成立。 */
    if (!(await flyToPlan(token))) return;
    if (!(await buildPlan(token))) return;
    await wait(520);
    if (!alive(token)) return;
    if (!(await answerPlan(token))) return;
    if (!(await flyPlanToTask(token))) return;
    setDock(false);
    wfNameEl.textContent = WF_NAME;
    setStatus(null, "正在生成…");
    await wait(220);
    if (!alive(token)) return;

    for (let i = 0; i < STEPS.length; i++) {
      const spec = present(STEPS[i]);
      const prep = prepare(i, spec, false);
      if (!(await approach(i, spec, prep, token))) return;
      if (!(await write(i, spec, prep, token))) return;
      if (!(await settle(i, spec, prep, token, false))) return;
    }
    dimOthers(null);
    fitAll();
    showDone();
    setDock(true);
  }

  async function rework() {
    const token = ++runToken;
    closeWin();
    const i = STEPS.findIndex((s) => s.id === FOLLOWUP.target);
    if (i < 0 || !state[i] || present(state[i]).status !== "done") return;
    if (shutInspect(false)) { inspectCam = null; await wait(T.close); }
    if (!alive(token)) return;
    setDock(false);
    const spec = Object.assign({}, present(STEPS[i]), FOLLOWUP.patch);
    const prep = prepare(i, spec, true);
    setStatus(spec.color, "正在修改 · " + spec.kind);
    focusNode(i, true, prep.fullH);
    await wait(T.pan);
    if (!alive(token)) return;
    if (!(await write(i, spec, prep, token))) return;
    if (!(await settle(i, spec, prep, token, true))) return;
    dimOthers(null);
    fitAll();
    showDone();
    setDock(true);
  }

  function skipToEnd() {
    ++runToken;
    reset();
    showTaskInstant();
    wfNameEl.textContent = WF_NAME;
    STEPS.forEach((step, i) => {
      const card = makeNode(i, step);
      const st = present(state[i]);
      st.status = "done";
      st.view = { lang: step.lang, content: step.content.slice(), note: step.note, engine: step.engine, kind: step.kind, title: step.title, color: step.color };
      card.classList.add("shown", "done");
      element(card, ".mini-name").textContent = step.title;
      const evi = element(card, ".mini-evi");
      evi.textContent = step.evidence;
      evi.classList.add("visible");
      if (i > 0) drawEdge(i - 1, 0);
    });
    fitAll();
    showDone();
    setDock(true);
  }

  speedBtn.addEventListener("click", () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    SPEED = present(SPEEDS[speedIdx]);
    speedBtn.textContent = SPEED + "×";
    speedBtn.setAttribute("aria-pressed", String(SPEED !== 1));
    /* CSS 里的过渡时长跟着一起缩，否则提速后编排就散了。 */
    document.documentElement.style.setProperty("--sp", String(SPEED));
  });
  skipBtn.addEventListener("click", skipToEnd);
  rerunBtn.addEventListener("click", run);
  taskCard.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest("#engBtn")) return;
    openPlanFromTask();
  });
  planClose.addEventListener("click", closePlanToTask);
  /* 展开时点卡片以外任何地方都收起。开卡那一下也会冒泡到这里，
     但 planOpen 要等 openPlanFromTask 走完 await 才置真，所以不会开了又关。 */
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    if (!planOpen || planBusy) return;
    if (e.target.closest("#planCard")) return;
    closePlanToTask();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && planOpen && !planBusy) closePlanToTask();
  });
  planGo.addEventListener("click", () => { planGo.hidden = true; });

  engBtn.addEventListener("click", (e) => { e.stopPropagation(); openEngineList(); });
  $("#zoomIn").addEventListener("click", () => zoomBy(1.2));
  $("#zoomOut").addEventListener("click", () => zoomBy(1 / 1.2));
  $("#zoomPct").addEventListener("click", () => { const b = bounds(); centerOn(b.w / 2, b.cy, 1, true, 0); });
  $("#zoomFit").addEventListener("click", fitAll);

  inputEl.addEventListener("input", () => { autosize(); sendEl.disabled = !inputEl.value.trim(); });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); formEl.requestSubmit(); }
  });
  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    if (sendEl.disabled) return;
    inputEl.value = "";
    autosize();
    rework();
  });
  chipEl.addEventListener("click", () => { if (!sendEl.disabled) rework(); });
  addEventListener("resize", () => { closeWin(); computeScale(); });

  run();
})();
