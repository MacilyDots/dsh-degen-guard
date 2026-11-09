/* dsh-degen-guard — llm/stream 请求探针。
 *
 * 目的：trip（判定退化）时把「模型当时收到的请求」摘要落盘，用来区分
 *   - 退化在工具调用之前（解码/推理层）——请求已完整送达、流里有数据；
 *   - 还是工具调用/结果回传层异常（那会先看到 tool/call → tool/result 错误）。
 *
 * 数据来源：DSH 的 `llm/stream` 是一条监听器瀑布，监听器拿到的 `options`
 * 就是 agent-loop 构造出的完整请求对象：
 *   { ...header.config, messages, toolHistory, tools?, sessionId, signal }
 * 其中 messages 是深冻结的完整消息数组。本模块只做只读摘要，绝不改写请求；
 * 任何异常都在内部吞掉，不能影响请求本身（探针坏了也不能拖垮 agent）。
 *
 * 采样参数说明：DSH 的请求对象里只有 provider/model/maxTokens/reasoningEffort
 * 这类 config 字段，temperature/top_p 不经过这里（由 adapter 默认值决定）。
 * summarizeRequest 仍会尝试抓取这些字段——未来 DSH 若把它们纳入请求对象，
 * 这里会自动记录，不需要改插件。
 */

/** 单条消息内容参与统计的字符上限，防止一条巨型工具结果拖慢每次请求。 */
const MAX_CONTENT_CHARS = 2_000_000;

/** 从 message.content（字符串或多段数组）里统计字符数与文本片段。 */
function contentStats(content) {
  if (typeof content === "string") {
    return { chars: Math.min(content.length, MAX_CONTENT_CHARS), text: content };
  }
  if (!Array.isArray(content)) return { chars: 0, text: "" };
  let chars = 0;
  const parts = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    if (typeof part.text === "string") {
      chars += part.text.length;
      if (parts.length < 1 && part.type === "text") parts.push(part.text);
    } else if (typeof part.arguments === "string") {
      chars += part.arguments.length;
    }
  }
  return { chars: Math.min(chars, MAX_CONTENT_CHARS), text: parts.join(" ") };
}

function roleOf(message) {
  if (message === null || typeof message !== "object") return "?";
  if (typeof message.role === "string") return message.role;
  return "?";
}

/**
 * 把一次请求摘要成可落盘的 JSON（全部是数字/字符串，不含消息正文）。
 *
 * @param {object} options - llm/stream 的 argv[0]（agent-loop 构造的请求对象）。
 * @returns {null | {
 *   sessionId: string,
 *   provider?: string,
 *   model?: string,
 *   maxTokens?: number,
 *   reasoningEffort?: string,
 *   sampling: Record<string, unknown>,
 *   tools: number,
 *   messages: { count: number, totalChars: number, byRole: Record<string, { count: number, chars: number }> },
 *   at: number,
 * }} 摘要；输入不可用时返回 null。
 */
export function summarizeRequest(options) {
  if (options === null || typeof options !== "object") return null;
  const sessionId = typeof options.sessionId === "string" ? options.sessionId : "";
  if (sessionId.length === 0) return null;

  const sampling = {};
  for (const key of ["temperature", "top_p", "top_k", "seed", "frequency_penalty", "presence_penalty", "thinking"]) {
    if (options[key] !== undefined) sampling[key] = options[key];
  }

  const messages = Array.isArray(options.messages) ? options.messages : [];
  const byRole = {};
  let totalChars = 0;
  for (const message of messages) {
    const role = roleOf(message);
    const stats = contentStats(message?.content);
    totalChars += stats.chars;
    const bucket = byRole[role] ?? (byRole[role] = { count: 0, chars: 0 });
    bucket.count += 1;
    bucket.chars += stats.chars;
  }

  const summary = {
    sessionId,
    tools: Array.isArray(options.tools) ? options.tools.length : 0,
    messages: { count: messages.length, totalChars, byRole },
    sampling,
    at: Date.now(),
  };
  if (typeof options.provider === "string") summary.provider = options.provider;
  if (typeof options.model === "string") summary.model = options.model;
  if (typeof options.maxTokens === "number") summary.maxTokens = options.maxTokens;
  if (typeof options.reasoningEffort === "string") summary.reasoningEffort = options.reasoningEffort;
  return summary;
}

/**
 * 创建 `llm/stream` 瀑布监听器：在请求分发前回调 onRequest，然后原样放行。
 *
 * 只观察、不包裹下游流——返回 `next()` 的原始结果，避免改变流语义
 * （计费/图片路由类插件需要包裹流，那是另一类监听器）。
 *
 * @param {{ onRequest?: (summary: object | null, rawOptions: unknown) => void }} deps
 * @returns {(options: object, next: () => AsyncIterable) => AsyncIterable}
 */
export function createRequestTap({ onRequest } = {}) {
  return (options, next) => {
    try {
      if (typeof onRequest === "function") onRequest(summarizeRequest(options), options);
    } catch {
      /* 探针自身失败绝不能影响请求 */
    }
    return next();
  };
}
