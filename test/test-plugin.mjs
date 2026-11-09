/* dsh-degen-guard — 宿主接线集成测试（mock ctx，不依赖真实 DSH 进程）。
 * 跑法：node test/test-plugin.mjs
 *
 * 验证 apply() 的真实行为：事件监听、探针生命周期、agent.cancel 调用与参数、
 * 日志落盘、以及"正常步绝不干预"。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "degen-guard-test-"));
process.env.DSH_HOME = sandbox;

const { apply, name } = await import("../lib/index.js");

let failed = 0;
let passed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log("  ok   " + label);
  } else {
    failed += 1;
    console.log("  FAIL " + label + "\n       expected " + JSON.stringify(expected) + "\n       actual   " + JSON.stringify(actual));
  }
}

/** 造一个最小 ctx：只实现插件用到的 on / inject。 */
function makeCtx() {
  const listeners = new Map();
  return {
    listeners,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    inject() {
      /* 没有 webServer：插件必须照常工作（作用域注入分支不该让加载失败） */
    },
    fire(event, payload) {
      for (const h of listeners.get(event) ?? []) h(payload);
    },
  };
}

function makeAgent(id) {
  const calls = [];
  return {
    id,
    calls,
    cancel(cause, options) {
      calls.push({ cause, options });
    },
  };
}

/** 把一段 reasoning 文本切成 chunk 帧推给插件。 */
function feedReasoning(ctx, agent, attemptId, text, extra = []) {
  const emit = (frame) => ctx.fire("agent/assistant-stream", { agent, frame });
  emit({ type: "start", attemptId, turn: 1, step: 1, revision: 1 });
  let revision = 1;
  const chunks = [];
  for (let i = 0; i < text.length; i += 64) chunks.push({ type: "reasoning-delta", index: 0, text: text.slice(i, i + 64) });
  chunks.push(...extra);
  for (const chunk of chunks) emit({ type: "chunk", attemptId, turn: 1, step: 1, revision: ++revision, index: revision, chunk });
  emit({ type: "end", attemptId, turn: 1, step: 1, revision: ++revision, index: revision, outcome: { kind: "committed", eventType: "assistant/message", seq: 1 } });
}

console.log("导出");
check("name", name, "dsh-degen-guard");
check("apply 是函数", typeof apply, "function");

console.log("退化流 → 调 agent.cancel({kind:'hook'}) 且 keepInbox");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop" });
  const agent = makeAgent("session-degen");
  feedReasoning(ctx, agent, "attempt-1", Array.from({ length: 400 }, () => "好。").join("\n"));
  check("cancel 调用次数", agent.calls.length, 1);
  check("cause.kind", agent.calls[0]?.cause?.kind, "hook");
  check("reason 提到重复", /dsh-degen-guard/.test(agent.calls[0]?.cause?.reason ?? ""), true);
  check("keepInbox", agent.calls[0]?.options?.keepInbox, true);
}

console.log("正常流（每行不同）→ 不干预");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop" });
  const agent = makeAgent("session-normal");
  feedReasoning(ctx, agent, "attempt-1", Array.from({ length: 800 }, (_, i) => `第 ${i} 步：检查工单判据口径是否一致。`).join("\n"));
  check("cancel 未被调用", agent.calls.length, 0);
}

console.log("正常流 + 工具调用 → 不干预");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop" });
  const agent = makeAgent("session-tool");
  feedReasoning(ctx, agent, "attempt-1", Array.from({ length: 400 }, (_, i) => `第 ${i} 步：读文件。`).join("\n"), [
    { type: "tool-call-delta", index: 1, id: "c1", name: "read", argumentsDelta: "{}" },
  ]);
  check("cancel 未被调用", agent.calls.length, 0);
}

console.log("同一 attempt 只触发一次");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop" });
  const agent = makeAgent("session-once");
  const emit = (frame) => ctx.fire("agent/assistant-stream", { agent, frame });
  emit({ type: "start", attemptId: "a", turn: 1, step: 1, revision: 1 });
  for (let i = 0; i < 2000; i++) {
    emit({ type: "chunk", attemptId: "a", turn: 1, step: 1, revision: i + 2, index: i, chunk: { type: "reasoning-delta", index: 0, text: "好。\n" } });
  }
  check("只 cancel 一次", agent.calls.length, 1);
}

console.log("mode: log → 只记录不干预");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "log" });
  const agent = makeAgent("session-log");
  feedReasoning(ctx, agent, "attempt-1", Array.from({ length: 400 }, () => "好。").join("\n"));
  check("cancel 未被调用", agent.calls.length, 0);
  const log = readFileSync(join(sandbox, "logs", "dsh-degen-guard.log"), "utf8");
  check("日志里有 trip 记录", /trip .*"kind":"repeat-loop"/.test(log), true);
}

console.log("attempt end 清理探针（不泄漏）");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop" });
  const agent = makeAgent("session-clean");
  for (let i = 0; i < 50; i++) {
    feedReasoning(ctx, agent, "attempt-" + i, "短推理，不触发。");
  }
  const agent2 = makeAgent("session-clean");
  feedReasoning(ctx, agent2, "attempt-after", Array.from({ length: 400 }, () => "好。").join("\n"));
  check("清理后仍能正常判定", agent2.calls.length, 1);
}

console.log("agent/disposed 清理该 agent 的探针");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop" });
  const agent = makeAgent("session-disposed");
  ctx.fire("agent/assistant-stream", { agent, frame: { type: "start", attemptId: "x", turn: 1, step: 1, revision: 1 } });
  ctx.fire("agent/disposed", { agent });
  check("disposed 不抛错", true, true);
}

console.log("畸形输入不抛错（守卫绝不能影响 agent 循环）");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop" });
  ctx.fire("agent/assistant-stream", { agent: null, frame: null });
  ctx.fire("agent/assistant-stream", { agent: makeAgent("s"), frame: { type: "chunk", attemptId: "nope", chunk: null } });
  ctx.fire("agent/assistant-stream", { agent: makeAgent("s"), frame: { type: "chunk", attemptId: "nope", chunk: { type: "reasoning-delta", text: 123 } } });
  ctx.fire("agent/assistant-stream", { agent: makeAgent("s"), frame: { type: "weird" } });
  check("全部静默处理", true, true);
}

console.log("cancel 抛错被吞掉并记日志");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop" });
  const agent = {
    id: "session-throw",
    cancel() {
      throw new Error("boom");
    },
  };
  feedReasoning(ctx, agent, "attempt-1", Array.from({ length: 400 }, () => "好。").join("\n"));
  const log = readFileSync(join(sandbox, "logs", "dsh-degen-guard.log"), "utf8");
  check("记录了 cancel-failed", /cancel-failed/.test(log), true);
}

console.log("熔断：同一会话第 2 次触发起不再保留 inbox");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop" });
  const agent = makeAgent("session-fuse");
  const loop = Array.from({ length: 400 }, () => "好。").join("\n");
  feedReasoning(ctx, agent, "attempt-1", loop);
  feedReasoning(ctx, agent, "attempt-2", loop);
  check("触发 2 次", agent.calls.length, 2);
  check("第 1 次保留 inbox", agent.calls[0]?.options?.keepInbox, true);
  check("第 2 次不保留 inbox", agent.calls[1]?.options?.keepInbox, undefined);
  check("第 1 次 reason 不含熔断话术", /请开新会话/.test(agent.calls[0]?.cause?.reason ?? ""), false);
  check("第 2 次 reason 要求开新会话", /请开新会话/.test(agent.calls[1]?.cause?.reason ?? ""), true);
}

console.log("熔断阈值可配（3 次才断）");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop", maxTripsPerSession: 3 });
  const agent = makeAgent("session-fuse3");
  const loop = Array.from({ length: 400 }, () => "好。").join("\n");
  for (let i = 0; i < 3; i++) feedReasoning(ctx, agent, "attempt-" + i, loop);
  check("前 2 次保留 inbox", [agent.calls[0]?.options?.keepInbox, agent.calls[1]?.options?.keepInbox], [true, true]);
  check("第 3 次熔断", agent.calls[2]?.options?.keepInbox, undefined);
}

console.log("触发即落盘交接单");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop" });
  const agent = makeAgent("session-handoff");
  const loop = Array.from({ length: 400 }, () => "好。").join("\n");
  feedReasoning(ctx, agent, "attempt-1", loop);
  const dir = join(sandbox, "handoff");
  const files = existsSync(dir) ? readdirSync(dir) : [];
  // 前面的用例也触发过 trip，会留下各自的交接单 —— 拼起来找本会话那一份。
  const bodies = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  check("写了交接单", files.length >= 1, true);
  check("交接单含本会话 id", /session-handoff/.test(bodies), true);
  check("交接单含处置建议", /开一个新会话/.test(bodies), true);
  check("第 1 次 reason 就给交接单路径", /交接单/.test(agent.calls[0]?.cause?.reason ?? ""), true);
  feedReasoning(ctx, agent, "attempt-2", loop);
  check("熔断 reason 也带交接单路径", /交接单/.test(agent.calls[1]?.cause?.reason ?? ""), true);
}

console.log("handoff 可关");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop", handoff: false });
  const agent = makeAgent("session-nohandoff");
  feedReasoning(ctx, agent, "attempt-1", Array.from({ length: 400 }, () => "好。").join("\n"));
  check("reason 不含交接单", /交接单/.test(agent.calls[0]?.cause?.reason ?? ""), false);
}

console.log("llm/stream 请求摘要进入 trip 日志与交接单");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop" });
  const agent = makeAgent("session-req");
  const tap = (ctx.listeners.get("llm/stream") ?? [])[0];
  check("挂了 llm/stream 监听器", typeof tap, "function");
  let released = 0;
  const ret = tap(
    {
      sessionId: "session-req",
      provider: "deepseek-account",
      model: "deepseek-flash",
      maxTokens: 256000,
      reasoningEffort: "high",
      messages: [
        { role: "system", content: [{ type: "text", text: "sys" }] },
        { role: "user", content: "hi" },
      ],
      tools: [{ name: "read" }],
    },
    () => {
      released += 1;
      return { done: true };
    },
  );
  check("next 被调用", released, 1);
  check("放行返回值", ret.done, true);
  feedReasoning(ctx, agent, "attempt-1", Array.from({ length: 400 }, () => "做。").join("\n"));
  check("trip 被触发", agent.calls.length, 1);
  const log = readFileSync(join(sandbox, "logs", "dsh-degen-guard.log"), "utf8");
  const tripLine = log
    .split("\n")
    .filter((line) => line.includes("trip ") && line.includes("session-req"))
    .pop() ?? "";
  check("trip 日志行含 request 摘要", /"request":\{"sessionId":"session-req"/.test(tripLine), true);
  const dir = join(sandbox, "handoff");
  const bodies = readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
  check("交接单含触发时刻的请求", /触发时刻的请求/.test(bodies), true);
  check("交接单含路由", /deepseek-flash/.test(bodies), true);
}

console.log("跨步趋势：前面几步同一句碎念 → 下一步提前拦截");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop" });
  const agent = makeAgent("session-trend");
  const filler = Array.from({ length: 120 }, (_, i) => `唯一行 ${i}：凑长度。`).join("\n");
  const medium = Array.from({ length: 9 }, () => "做。").join("\n") + "\n" + filler;
  for (let i = 0; i < 4; i++) feedReasoning(ctx, agent, "warm-" + i, medium);
  check("预热阶段不干预", agent.calls.length, 0);
  const burst = Array.from({ length: 60 }, () => "做。").join("\n") + "\n" + filler; // 60：低于 100、高于 40
  feedReasoning(ctx, agent, "burst", burst);
  check("升档后提前拦截", agent.calls.length, 1);
  check("reason 标注爬升期", /爬升期提前拦截/.test(agent.calls[0]?.cause?.reason ?? ""), true);
}

console.log("跨步趋势：top 行每步都不同的正常会话不升档");
{
  const ctx = makeCtx();
  apply(ctx, { mode: "stop" });
  const agent = makeAgent("session-notrend");
  const filler = Array.from({ length: 120 }, (_, j) => `唯一 ${j}：凑长度。`).join("\n");
  for (let i = 0; i < 6; i++) {
    const text = Array.from({ length: 9 }, () => `第 ${i} 类念头。`).join("\n") + "\n" + filler;
    feedReasoning(ctx, agent, "warm-" + i, text);
  }
  const burst = Array.from({ length: 60 }, () => "好。").join("\n") + "\n" + filler;
  feedReasoning(ctx, agent, "burst", burst);
  check("未升档 → 不干预", agent.calls.length, 0);
}

rmSync(sandbox, { recursive: true, force: true });
console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
