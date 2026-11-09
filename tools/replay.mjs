/* 用真实会话存档回放判据，验证阈值改动的效果。
 *
 * 跑法：
 *   node tools/replay.mjs              # 最近 30 个会话
 *   node tools/replay.mjs 60           # 最近 60 个会话
 *   node tools/replay.mjs 60 --config '{"maxLineRepeat":80}'
 *
 * 输出：TP（拦下真卡死）/ FP（误伤有输出的步）/ FN / TN。
 * 「真卡死」的定义：该 step 最终既无正文也无工具调用。
 *
 * 会话存档是多帧 zstd（session.v4.jsonl.zstd），必须按 magic 逐帧解压——
 * zstdDecompressSync 一次只解第一帧。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { createHistory, createProbe, feedChunk, isEscalating, recordStep, resolveConfig, topLine, verdict } from "../lib/detect.js";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompressMultiFrame(buf) {
  const starts = [];
  let idx = buf.indexOf(MAGIC, 0);
  while (idx !== -1) {
    starts.push(idx);
    idx = buf.indexOf(MAGIC, idx + 1);
  }
  if (starts.length === 0) return "";
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try {
      out.push(zlib.zstdDecompressSync(buf.subarray(s, e)));
    } catch {
      /* 半截帧（会话正在写）：跳过 */
    }
  }
  return Buffer.concat(out).toString("utf8");
}

function readEvents(file) {
  const events = [];
  for (const line of decompressMultiFrame(readFileSync(file)).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* 忽略残行 */
    }
  }
  return events;
}

const limit = Number.parseInt(process.argv[2] ?? "30", 10) || 30;
const cfgIdx = process.argv.indexOf("--config");
const config = resolveConfig(cfgIdx === -1 ? {} : JSON.parse(process.argv[cfgIdx + 1]));

const sessionsRoot = join(DSH_HOME, "sessions");
const dirs = [];
if (existsSync(sessionsRoot)) {
  for (const scope of readdirSync(sessionsRoot)) {
    const scopePath = join(sessionsRoot, scope);
    if (!statSync(scopePath).isDirectory()) continue;
    for (const name of readdirSync(scopePath)) {
      const full = join(scopePath, name);
      if (!statSync(full).isDirectory()) continue;
      const v4 = join(full, "session.v4.jsonl.zstd");
      const v3 = join(full, "session.v3.jsonl.zstd");
      const file = existsSync(v4) ? v4 : existsSync(v3) ? v3 : null;
      if (file === null) continue;
      dirs.push({ name, file, mtime: statSync(full).mtimeMs });
    }
  }
}
dirs.sort((a, b) => b.mtime - a.mtime);

/** 回放一个 step：把 reasoning 按 64 字符切片喂入，遇到触发即停。 */
function replayStep(reasoning, hasText, hasToolCall, escalated, config) {
  const probe = createProbe();
  for (let i = 0; i < reasoning.length; i += 64) {
    const chunk = { type: "reasoning-delta", index: 0, text: reasoning.slice(i, i + 64) };
    if (!feedChunk(probe, chunk, config)) continue;
    const hit = verdict(probe, config, escalated);
    if (hit !== null) {
      return { fired: true, kind: hit.kind, at: hit.detail, maxRepeat: probe.maxRepeat, topLine: topLine(probe) };
    }
  }
  if (hasText && !probe.hasText) feedChunk(probe, { type: "text-delta", index: 1, text: "x" }, config);
  if (hasToolCall && !probe.hasToolCall) feedChunk(probe, { type: "tool-call-delta", index: 1, id: "c", argumentsDelta: "{}" }, config);
  const hit = verdict(probe, config, escalated);
  if (hit !== null) {
    return { fired: true, kind: hit.kind, at: hit.detail, maxRepeat: probe.maxRepeat, topLine: topLine(probe) };
  }
  return {
    fired: false,
    kind: null,
    at: { reasoningChars: probe.reasoningChars, maxRepeat: probe.maxRepeat },
    maxRepeat: probe.maxRepeat,
    topLine: topLine(probe),
  };
}

const TREND = process.argv.includes("--trend");
const rows = [];
for (const d of dirs.slice(0, limit)) {
  let events;
  try {
    events = readEvents(d.file);
  } catch {
    continue;
  }
  // 跨步模式：一个会话一份历史，按事件顺序喂，复现真实插件看到的状态序列。
  const history = createHistory();
  for (const e of events) {
    if (e.type !== "assistant/message") continue;
    const data = e.data ?? {};
    const content = data.message?.content ?? [];
    const reasoning = content.filter((c) => c.type === "reasoning").map((c) => c.text).join("");
    if (reasoning.length === 0) continue;
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("");
    const calls = content.filter((c) => c.type === "tool-call").length;
    const escalated = TREND && isEscalating(history, config);
    const res = replayStep(reasoning, text.trim().length > 0, calls > 0, escalated, config);
    if (TREND) recordStep(history, { maxRepeat: res.maxRepeat, topLine: res.topLine }, config);
    rows.push({
      session: d.name.slice(8, 16),
      turn: data.turn,
      step: data.step,
      rLen: reasoning.length,
      calls,
      hasText: text.trim().length > 0,
      escalated,
      topLine: res.topLine,
      ...res,
    });
  }
}

const stalled = (r) => r.calls === 0 && !r.hasText;
const tp = rows.filter((r) => r.fired && stalled(r)).length;
const fp = rows.filter((r) => r.fired && !stalled(r)).length;
const fn = rows.filter((r) => !r.fired && stalled(r)).length;
const tn = rows.length - tp - fp - fn;

console.log(`模式: ${TREND ? "跨步趋势（--trend）" : "逐 step 独立（默认）"}`);
console.log(`配置: ${JSON.stringify({ mode: config.mode, maxLineRepeat: config.maxLineRepeat, escalatedMaxLineRepeat: config.escalatedMaxLineRepeat, maxReasoningChars: config.maxReasoningChars })}`);
console.log(`扫描会话: ${Math.min(limit, dirs.length)} 个，step 总数: ${rows.length}`);
console.log(`无输出 step（真卡死形态）: ${rows.filter(stalled).length}`);
console.log("");
console.log("混淆矩阵");
console.log(`  TP 拦下真卡死 : ${tp}`);
console.log(`  FP 误伤有输出 : ${fp}`);
console.log(`  FN 漏掉卡死   : ${fn}`);
console.log(`  TN 正常未干预 : ${tn}`);
console.log("");
console.log("触发明细");
for (const r of rows.filter((x) => x.fired)) {
  console.log(`  ${r.session} T${r.turn}.${r.step}  ${r.kind}  触发于 r=${r.at.reasoningChars} maxRepeat=${r.at.maxRepeat} esc=${r.escalated ? "是" : "否"} top=${JSON.stringify(String(r.topLine ?? "").slice(0, 12))}  |  最终 r=${r.rLen} calls=${r.calls} text=${r.hasText ? "有" : "无"}  ${stalled(r) ? "[真卡死]" : "[有输出→误伤]"}`);
}

if (TREND) {
  const early = rows.filter((r) => r.fired && r.escalated);
  const saved = early.reduce((sum, r) => sum + Math.max(0, r.rLen - r.at.reasoningChars), 0);
  console.log("");
  console.log(`爬升期提前拦截: ${early.length} 次，累计少生成 ${saved} 字符`);
}
process.exit(fp === 0 ? 0 : 1);
