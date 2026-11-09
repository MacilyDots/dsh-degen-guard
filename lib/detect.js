/* dsh-degen-guard — 判据核心（无副作用，可离线回放验证）。
 *
 * 背景：deepseek-v4.1-flash 在长上下文下会退化成 token 级重复——reasoning 通道反复
 * 吐同一批极短行，既不产出正文也不产出工具调用；而流一直有数据，所以 pi-ai 的
 * idle watchdog（只看"空闲"）永远不触发，界面表现为"卡死"，只能手动中止。
 *
 * 实测到两种形态（2026-10-07，3234 个真实 step）：
 *   形态 A：独占一行的碎念     「好。」/「做。」/「写。」
 *   形态 B：带格式的碎念       「**好** ✓」/「**执行** ✓」/「**停** ✗」/「（执行。）」
 *
 * 判据用「同一非空行重复出现的最高次数」而不是"短行总数"：它同时覆盖两种形态，
 * 且与行长、Markdown 装饰无关。实测落点：
 *   有输出的正常步：最高 84（次高 39）
 *   无输出的卡死步：最低 189，最高 7696
 * 阈值取 100，落在 84 与 189 之间的空档里。
 *
 * 判据刻意做窄：只在「本步还没有任何正文与工具调用」时才看重复度，
 * 所以"先长思考再调工具"的正常形态完全不受影响。
 */

/** 参与重复统计的行：去空白后 1..maxLineChars 个字符。 */
export function isTrackableLine(line, maxChars) {
  const t = line.trim();
  return t.length > 0 && t.length <= maxChars;
}

/** 新建一份探针状态。每次模型尝试（attempt）一份。 */
export function createProbe() {
  return {
    reasoningChars: 0,
    maxRepeat: 0,
    lineCounts: new Map(),
    hasText: false,
    hasToolCall: false,
    /** 尚未闭合的最后一行，跨 chunk 拼接用。 */
    tail: "",
    fired: false,
  };
}

/** 记一行，更新最高重复次数。 */
function countLine(probe, line, config) {
  const key = line.trim();
  if (key.length === 0 || key.length > config.maxLineChars) return;
  const seen = probe.lineCounts.get(key);
  if (seen === undefined) {
    // 键上限保护：退化是"少数行重复很多次"，不同行数不会无限增长；
    // 真到上限就只累加已有键，内存有硬上限，且不影响退化检测。
    if (probe.lineCounts.size >= config.maxTrackedLines) return;
    probe.lineCounts.set(key, 1);
    if (probe.maxRepeat < 1) probe.maxRepeat = 1;
    return;
  }
  const next = seen + 1;
  probe.lineCounts.set(key, next);
  if (next > probe.maxRepeat) probe.maxRepeat = next;
}

/** 本步重复最多的那一行（跨步趋势比较用）。没有任何可跟踪行时返回空串。 */
export function topLine(probe) {
  let best = "";
  let max = 0;
  for (const [line, count] of probe.lineCounts) {
    if (count > max) {
      max = count;
      best = line;
    }
  }
  return best;
}

/**
 * 该行是否只是结构/符号行（不含任何字母、数字或汉字）。
 *
 * 正常步的偶发重复几乎都落在这类行上（``` 围栏、`}` 代码结尾、--- 分隔线），
 * 而退化的碎念是「做。」「好。」「（执行。）」这种含字的短句。
 * 实测：全量 433 会话 / 15306 步里，真退化的 top 行无一例外都含字；
 * 而唯一一类误伤（某会话连续输出 102 个 `}`）恰好被这条排除掉。
 */
export function isStructuralLine(line) {
  const t = line.trim();
  if (t.length === 0) return true;
  return !/[\p{L}\p{N}]/u.test(t);
}

/** 新建一份跨步历史（每个 agent 一份）。 */
export function createHistory() {
  return { steps: [] };
}

/**
 * 记一步的结果。正常结束的步和触发中止的步都要记——趋势判据看的是连续形态。
 * 缺 maxRepeat 的步不进历史。
 */
export function recordStep(history, step, config) {
  if (step === null || typeof step !== "object") return;
  if (!Number.isInteger(step.maxRepeat) || step.maxRepeat <= 0) return;
  history.steps.push({
    maxRepeat: step.maxRepeat,
    topLine: typeof step.topLine === "string" ? step.topLine : "",
  });
  const cap = Math.max(config.trendWindow * 4, config.trendMinSteps);
  if (history.steps.length > cap) history.steps.splice(0, history.steps.length - cap);
}

/**
 * 是否已进入「同一句碎念反复抬升」的爬升期。
 *
 * 判据刻意要求形态而非单次幅度：窗口内至少 trendMinSteps 步的重复数达到
 * trendMinRepeat、这些步的 top 行不是结构行、且去重后种类不超过
 * trendMaxDistinctTopLines。正常会话的重复要么"每步不同"、要么落在结构行上，
 * 两种都过不了这个判据。
 */
export function isEscalating(history, config) {
  const win = history.steps.slice(-config.trendWindow);
  if (win.length < config.trendMinSteps) return false;
  const counts = new Map();
  for (const step of win) {
    if (step.maxRepeat < config.trendMinRepeat) continue;
    if (isStructuralLine(step.topLine)) continue;
    counts.set(step.topLine, (counts.get(step.topLine) ?? 0) + 1);
  }
  for (const count of counts.values()) {
    if (count >= config.trendMinSteps) return true;
  }
  return false;
}

/**
 * 喂一个流式 chunk，就地更新探针。
 * @returns true 表示探针状态发生了变化（调用方据此决定要不要查判据）。
 */
export function feedChunk(probe, chunk, config) {
  if (chunk === null || typeof chunk !== "object") return false;
  switch (chunk.type) {
    case "reasoning-delta": {
      const text = typeof chunk.text === "string" ? chunk.text : "";
      if (text === "") return false;
      probe.reasoningChars += text.length;
      probe.tail += text;
      const parts = probe.tail.split("\n");
      probe.tail = parts.pop() ?? "";
      for (const line of parts) countLine(probe, line, config);
      // 超长单行（模型吐了一整段没有换行的内容）：计一次并丢弃缓冲，避免缓冲无上限增长。
      if (probe.tail.length > 8192) {
        countLine(probe, probe.tail, config);
        probe.tail = "";
      }
      return true;
    }
    case "text-delta": {
      const text = typeof chunk.text === "string" ? chunk.text : "";
      if (text.trim() === "") return false;
      probe.hasText = true;
      return true;
    }
    case "tool-call-delta": {
      probe.hasToolCall = true;
      return true;
    }
    default:
      return false;
  }
}

/**
 * 查判据。
 * @returns null（不干预）或 `{ kind, detail }`。
 */
export function verdict(probe, config, escalated = false) {
  if (probe.fired) return null;
  // 模型在正常干活：有正文或有工具调用，一律不管。
  if (probe.hasText || probe.hasToolCall) return null;
  if (probe.reasoningChars < config.minReasoningChars) return null;

  // 已判定处于爬升期：提前到更低的阈值止血（正常会话走不到这个分支）。
  const threshold = escalated
    ? Math.min(config.escalatedMaxLineRepeat, config.maxLineRepeat)
    : config.maxLineRepeat;
  // 重复的必须是"碎念"（含字的短行）。纯符号行不算——否则连续输出代码块结尾
  // 会误判成退化（实测误伤了某会话连吐 102 个 `}` 的正常步）。
  const repeatTrip = probe.maxRepeat >= threshold && !isStructuralLine(topLine(probe));
  // 长度兜底：真实数据里它没贡献过任何一次命中（40 个卡死 step 全部先被重复度抓住），
  // 所以默认放到 10 万字符，只防"不重复但纯吐字"的新形态，不参与日常判定。
  const lengthTrip = probe.reasoningChars >= config.maxReasoningChars;
  if (!repeatTrip && !lengthTrip) return null;

  return {
    kind: repeatTrip ? "repeat-loop" : "runaway-reasoning",
    detail: {
      reasoningChars: probe.reasoningChars,
      maxRepeat: probe.maxRepeat,
      hasText: probe.hasText,
      hasToolCall: probe.hasToolCall,
      escalated,
      threshold,
    },
  };
}

/** 配置默认值。阈值依据见文件头。 */
export const DEFAULT_CONFIG = {
  mode: "stop",
  minReasoningChars: 1000,
  maxLineRepeat: 100,
  maxReasoningChars: 100000,
  maxLineChars: 64,
  maxTrackedLines: 20000,
  logLines: 200,
  // ── 爬升期拦截（2026-10-08 新增）────────────────────────────────
  // 依据（4445 个真实 step 回放定参）：退化会话在爆发前普遍有一段爬升期——
  // 连续多步的「最高频行」是同一句碎念（「做。」），但单步幅度并不大
  // （多数 3~9 次，偶有一两步跳到 13~30），最后才爆发到 100+。
  // 正常步的偶发重复则落在 ``` 这类结构行上，或每步各不相同。
  // 参数网格实测：trendMinRepeat 取 5~6 会误伤一个"有输出的正常步"
  // （它的 top 恰好也是同一句「好。」、幅度 43），取 8 时 FP=0。
  // 注意边界：开局第一步就爆发（无爬升期）的退化，本判据结构上覆盖不到。
  trendWindow: 8,
  trendMinSteps: 4,
  trendMinRepeat: 8,
  escalatedMaxLineRepeat: 40,
  // ── 熔断（2026-10-08 新增）────────────────────────────────────
  // 同一会话累计触发这么多次后，cancel 不再保留 inbox —— 切断
  // 「中止→唤醒→再退化」的闭环（agent.cancel 的 keepInbox 语义见 lib/index.js）。
  maxTripsPerSession: 2,
  handoff: true,
};

const INT_KEYS = [
  "minReasoningChars",
  "maxLineRepeat",
  "maxReasoningChars",
  "maxLineChars",
  "maxTrackedLines",
  "logLines",
  "trendWindow",
  "trendMinSteps",
  "trendMinRepeat",
  "escalatedMaxLineRepeat",
  "maxTripsPerSession",
];

/** 用默认值补齐用户配置。 */
export function resolveConfig(raw) {
  const out = { ...DEFAULT_CONFIG };
  if (raw === null || typeof raw !== "object") return out;
  if (raw.mode === "stop" || raw.mode === "log") out.mode = raw.mode;
  if (typeof raw.handoff === "boolean") out.handoff = raw.handoff;
  for (const key of INT_KEYS) {
    const value = raw[key];
    if (Number.isInteger(value) && value > 0) out[key] = value;
  }
  return out;
}
