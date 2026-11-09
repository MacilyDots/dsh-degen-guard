/* dsh-degen-guard — 退化熔断时落盘一份「交接单」。
 *
 * 目的：会话被判定退化后，用户唯一可靠的处置是开新会话。但任务状态全在那份
 * 已经背不动的会话历史里，所以熔断时立刻把可续的信息抽出来写成一个 markdown，
 * 让新会话有起点。
 *
 * 数据来源刻意绕开 host API：直接读 %DSH_HOME%\sessions\<scope>\<sessionId>\
 * session.v*.jsonl.zstd（多帧 zstd，逐帧解压）。这样不依赖任何 DSH 内部服务，
 * 0.1.x / 0.2.x 都能读，也不会因为 API 变更让插件加载失败。
 *
 * 本模块的任何失败都必须被调用方吞掉——交接是便利功能，不能影响 agent 循环。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_TEXT = 400;
const MAX_TODO = 3000;

/** 逐帧解压一个多帧 zstd 文件（session.v*.jsonl.zstd 的格式）。半截帧直接跳过。 */
export function decompressMultiFrame(buf) {
  const starts = [];
  let idx = buf.indexOf(MAGIC, 0);
  while (idx !== -1) {
    starts.push(idx);
    idx = buf.indexOf(MAGIC, idx + 1);
  }
  const out = [];
  for (const start of starts) {
    try {
      out.push(zlib.zstdDecompressSync(buf.subarray(start)));
    } catch {
      /* 半截帧（会话正在写）或压缩数据里的假魔数：跳过 */
    }
  }
  return Buffer.concat(out).toString("utf8");
}

/** 按会话 id 找到存档文件。 */
export function findSessionFile(dshHome, sessionId) {
  const root = join(dshHome, "sessions");
  if (!existsSync(root) || typeof sessionId !== "string" || sessionId.length === 0) return null;
  for (const scope of readdirSync(root)) {
    const dir = join(root, scope, sessionId);
    if (!existsSync(dir)) continue;
    for (const name of ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd"]) {
      const file = join(dir, name);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

/** 从一条 message 里抽纯文本（content 既可能是字符串，也可能是 part 数组）。 */
function messageText(message) {
  if (message === null || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content.slice(0, MAX_TEXT);
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part.type === "tool-call" && typeof part.name === "string") parts.push("[tool-call " + part.name + "]");
  }
  return parts.join(" ").replace(/\s+/g, " ").slice(0, MAX_TEXT);
}

/** 从事件流里抽可续的信息：工作区、最近用户消息、最后一次 todo、最近工具调用。 */
export function summarize(events) {
  let cwd = "";
  const userMessages = [];
  let todo = "";
  const tools = [];
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    if (event.type === "session" && typeof event.cwd === "string") cwd = event.cwd;
    if (event.type === "user/message") {
      const text = messageText(event.data?.message).trim();
      if (text.length > 0) userMessages.push(text);
    }
    if (event.type === "todo/write") {
      const raw = JSON.stringify(event.data ?? {});
      todo = raw.length > MAX_TODO ? raw.slice(0, MAX_TODO) + "…" : raw;
    }
    if (event.type === "tool/call") {
      const name = event.data?.name ?? event.data?.toolName ?? event.data?.tool;
      if (typeof name === "string" && name.length > 0) tools.push(name);
    }
  }
  return {
    cwd,
    userMessages: userMessages.slice(-3),
    todo,
    tools: tools.slice(-12),
  };
}

function localStamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "-" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function localIso(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes()) +
    ":" +
    pad(date.getSeconds()) +
    " " +
    sign +
    pad(Math.floor(abs / 60)) +
    ":" +
    pad(abs % 60)
  );
}

/**
 * 落盘一份交接单。
 *
 * @param options.dshHome - DSH home（日志与会话存档的根）。
 * @param options.sessionId - 触发退化的 agent / 会话 id。
 * @param options.trips - 该会话累计触发次数（含本次）。
 * @param options.detail - verdict 的 detail（reasoningChars / maxRepeat / threshold / escalated）。
 * @param options.topLine - 本步重复最多的那一行（最能帮助用户认出退化形态）。
 * @param options.fused - 是否已熔断（本次之后不再自动重试）。
 * @param options.request - 触发时刻的请求摘要（llm/stream 探针，可缺省）。
 * @param options.now - 时间戳（便于测试注入）。
 * @returns 交接文件的绝对路径；失败时返回 null（绝不抛）。
 */
export function writeHandoff(options) {
  try {
    const now = options.now instanceof Date ? options.now : new Date();
    const dir = join(options.dshHome, "handoff");
    mkdirSync(dir, { recursive: true });

    const shortId = String(options.sessionId).replace(/^session-/, "").slice(0, 8);
    const file = join(dir, "session-" + shortId + "-" + localStamp(now) + ".md");

    let sessionFile = "";
    let info = { cwd: "", userMessages: [], todo: "", tools: [] };
    try {
      const found = findSessionFile(options.dshHome, options.sessionId);
      if (found !== null) {
        sessionFile = found;
        const text = decompressMultiFrame(readFileSync(found));
        const events = [];
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            events.push(JSON.parse(trimmed));
          } catch {
            /* 残行 */
          }
        }
        info = summarize(events);
      }
    } catch {
      /* 存档读不到不影响交接单本身 */
    }

    const detail = options.detail ?? {};
    const lines = [];
    lines.push("# dsh-degen-guard 交接单");
    lines.push("");
    lines.push("这个会话已被判定**推理退化**（同一行碎念反复重复、无正文、无工具调用），");
    lines.push("并且已经触发 " + options.trips + " 次。继续在原会话里重试会再次撞上同一个状态。");
    lines.push("");
    lines.push("| 项 | 值 |");
    lines.push("|---|---|");
    lines.push("| 时间 | " + localIso(now) + " |");
    lines.push("| 会话 id | `" + options.sessionId + "` |");
    if (info.cwd.length > 0) lines.push("| 工作区 | `" + info.cwd + "` |");
    lines.push("| 累计触发 | " + options.trips + " 次" + (options.fused === true ? "（已达熔断阈值，本次未保留待处理工作）" : "") + " |");
    lines.push(
      "| 触发时状态 | reasoning " +
        (detail.reasoningChars ?? "?") +
        " 字符，同一行重复 " +
        (detail.maxRepeat ?? "?") +
        " 次，阈值 " +
        (detail.threshold ?? "?") +
        (detail.escalated === true ? "（爬升期降级阈值）" : "") +
        " |",
    );
    if (typeof options.topLine === "string" && options.topLine.length > 0) {
      lines.push("| 重复的行 | `" + options.topLine.slice(0, 60) + "` |");
    }
    if (sessionFile.length > 0) lines.push("| 会话存档 | `" + sessionFile + "` |");
    lines.push("");

    const request = options.request;
    if (request !== null && typeof request === "object") {
      lines.push("## 触发时刻的请求（llm/stream 探针）");
      lines.push("");
      const route = [request.provider, request.model].filter((v) => typeof v === "string" && v.length > 0).join(" / ");
      if (route.length > 0) lines.push("- 路由：" + route);
      if (typeof request.maxTokens === "number") lines.push("- maxTokens：" + request.maxTokens);
      if (typeof request.reasoningEffort === "string") lines.push("- reasoningEffort：" + request.reasoningEffort);
      if (typeof request.tools === "number") lines.push("- tools：" + request.tools + " 个");
      const samplingKeys = request.sampling !== null && typeof request.sampling === "object" ? Object.keys(request.sampling) : [];
      lines.push(
        "- 采样参数：" +
          (samplingKeys.length > 0 ? samplingKeys.map((k) => k + "=" + JSON.stringify(request.sampling[k])).join("，") : "请求对象里没有这些字段（DSH 不暴露 temperature/top_p）"),
      );
      if (request.messages !== null && typeof request.messages === "object") {
        const messages = request.messages;
        lines.push("- 消息：" + (messages.count ?? "?") + " 条，共 " + (messages.totalChars ?? "?") + " 字符");
        const byRole = messages.byRole !== null && typeof messages.byRole === "object" ? messages.byRole : {};
        const roles = Object.keys(byRole);
        if (roles.length > 0) {
          lines.push(
            "  - 分布：" +
              roles.map((role) => role + " " + (byRole[role].count ?? "?") + " 条/" + (byRole[role].chars ?? "?") + " 字符").join("，"),
          );
        }
      }
      lines.push("");
    }

    lines.push("## 建议");
    lines.push("");
    lines.push("1. **开一个新会话**，不要在原会话里重试——压缩和重试都不改变这个状态。");
    lines.push("2. 把下面「任务状态」贴给新会话，或者让新会话读这个文件。");
    lines.push("3. 新会话里如果再次触发同样的退化，说明该任务的分片粒度还是太大，需要再切细。");
    lines.push("");

    lines.push("## 任务状态（从会话存档抽取）");
    lines.push("");
    if (info.userMessages.length > 0) {
      lines.push("### 最近的用户消息");
      lines.push("");
      for (const message of info.userMessages) lines.push("- " + message);
      lines.push("");
    }
    if (info.tools.length > 0) {
      lines.push("### 最近的工具调用");
      lines.push("");
      lines.push("`" + info.tools.join("` → `") + "`");
      lines.push("");
    }
    if (info.todo.length > 0) {
      lines.push("### 最后一次 todo/write");
      lines.push("");
      lines.push("```json");
      lines.push(info.todo);
      lines.push("```");
      lines.push("");
    }
    if (info.userMessages.length === 0 && info.tools.length === 0 && info.todo.length === 0) {
      lines.push("（没能从会话存档里抽出可用状态，请回到原会话对应的会话记录里人工确认。）");
      lines.push("");
    }

    writeFileSync(file, lines.join("\n"), "utf8");
    return file;
  } catch {
    return null;
  }
}
