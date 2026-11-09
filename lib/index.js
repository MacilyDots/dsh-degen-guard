/* dsh-degen-guard — 宿主半。
 *
 * 问题：deepseek-v4.1-flash 在长上下文下会退化成 token 级重复——reasoning 通道反复吐
 * 同一批极短行（「好。」/「**执行** ✓」…），既不产出正文也不产出工具调用。而流一直
 * 有数据，所以 @deepseek-ai/dsh-llm-pi-ai 的 idle watchdog（只看"空闲"）永远不触发，
 * 界面表现为"卡死"，只能手动中止。实测最严重的一次用户等了 8 分 15 秒。
 *
 * 做法：监听 agent/assistant-stream（token 级流式帧），对每一步维护"同一非空行重复
 * 出现的最高次数"。越线且该步还没有任何正文与工具调用时，用官方的
 * `agent.cancel({ kind: 'hook' })` 止损——'hook' 正是 AgentCancelCause 为插件预留的原因。
 *
 * 阈值来源（2026-10-07，3240 个真实 step 离线回放）：
 *   正常步最高重复 84；卡死步最低 189，最高 7696
 *   阈值 100 → 命中 14 个卡死步，误伤 0，触发点平均 r≈3000 字符（退化总长的 10% 以内）
 *
 * 路由：
 *   GET /dsh-degen-guard/log    读回最近日志
 *   GET /dsh-degen-guard/stats  本进程内的触发计数
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createHistory,
  createProbe,
  feedChunk,
  isEscalating,
  recordStep,
  resolveConfig,
  topLine,
  verdict,
} from "./detect.js";
import { writeHandoff } from "./handoff.js";
import { createRequestTap, summarizeRequest } from "./request-tap.js";

export const name = "dsh-degen-guard";

const ROUTE_PREFIX = "/dsh-degen-guard";
const MAX_LOG_BYTES = 512 * 1024;
const MAX_PROBES = 256;
const MAX_REQUEST_ENTRIES = 64;

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function logDir() {
  return join(dshHome(), "logs");
}

function logPath() {
  return join(logDir(), "dsh-degen-guard.log");
}

/** Append one line, rotating the file once it grows past the cap. Never throws. */
function appendLog(line) {
  const file = logPath();
  try {
    mkdirSync(logDir(), { recursive: true });
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, file + ".1");
    } catch {
      /* missing file or rename race — appending below still works */
    }
    appendFileSync(file, line + "\n");
  } catch {
    /* logging must never break the plugin */
  }
}

function readTail(maxLines) {
  try {
    const text = readFileSync(logPath(), "utf8");
    return text.split("\n").filter((l) => l !== "").slice(-maxLines);
  } catch {
    return [];
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);

  /** key = `${agentId}:${attemptId}` → 探针。 */
  const probes = new Map();
  /** agentId → { history, trips }：跨步趋势与熔断计数（2026-10-08 新增）。 */
  const agents = new Map();
  /** sessionId → 最近一次请求摘要（trip 时落盘，2026-10-17 新增）。 */
  const recentRequests = new Map();
  const stats = { attempts: 0, trips: 0, canceled: 0, cancelFailed: 0, fused: 0, handoffs: 0, byKind: {} };

  function drop(key) {
    probes.delete(key);
  }

  /** 取（或建）该 agent 的跨步状态。 */
  function stateFor(agentId) {
    let state = agents.get(agentId);
    if (state === undefined) {
      state = { history: createHistory(), trips: 0 };
      agents.set(agentId, state);
      evictAgentsIfNeeded();
    }
    return state;
  }

  /** 与探针表同理的兜底上限：正常情况下 agent/disposed 会清理。 */
  function evictAgentsIfNeeded() {
    while (agents.size > MAX_PROBES) {
      const oldest = agents.keys().next();
      if (oldest.done) return;
      agents.delete(oldest.value);
    }
  }

  /** 探针表兜底上限：正常情况下 attempt end 会清理，这里只防异常残留。 */
  function evictIfNeeded() {
    while (probes.size > MAX_PROBES) {
      const oldest = probes.keys().next();
      if (oldest.done) return;
      probes.delete(oldest.value);
    }
  }

  // 请求探针（2026-10-17）：trip 之前模型收到的请求摘要 → 落进 trip 日志与交接单。
  // llm/stream 是一条监听器瀑布，监听器拿到完整请求对象（messages/config/sessionId）。
  // 这里只做只读摘要并原样放行 next()；探针自身失败绝不影响请求。
  ctx.on(
    "llm/stream",
    createRequestTap({
      onRequest: (summary) => {
        if (summary === null) return;
        recentRequests.set(summary.sessionId, summary);
        while (recentRequests.size > MAX_REQUEST_ENTRIES) {
          const oldest = recentRequests.keys().next();
          if (oldest.done) break;
          recentRequests.delete(oldest.value);
        }
      },
    }),
  );

  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    try {
      if (!agent || !frame) return;
      const key = agent.id + ":" + frame.attemptId;
      if (frame.type === "start") {
        stats.attempts += 1;
        const probe = createProbe();
        // 已处于爬升期 → 本步用更低的阈值止血（正常会话走不到这里）。
        probe.escalated = isEscalating(stateFor(agent.id).history, config);
        probes.set(key, probe);
        evictIfNeeded();
        return;
      }
      if (frame.type === "end") {
        const probe = probes.get(key);
        if (probe !== undefined && !probe.fired) {
          // 正常结束的步也要进历史：趋势判据看的是连续形态。
          recordStep(stateFor(agent.id).history, { maxRepeat: probe.maxRepeat, topLine: topLine(probe) }, config);
        }
        drop(key);
        return;
      }
      if (frame.type !== "chunk") return;

      const probe = probes.get(key);
      if (probe === undefined || probe.fired) return;
      if (!feedChunk(probe, frame.chunk, config)) return;
      const hit = verdict(probe, config, probe.escalated === true);
      if (hit === null) return;

      probe.fired = true;
      stats.trips += 1;
      stats.byKind[hit.kind] = (stats.byKind[hit.kind] ?? 0) + 1;

      const state = stateFor(agent.id);
      state.trips += 1;
      const repeatLine = topLine(probe);
      recordStep(state.history, { maxRepeat: probe.maxRepeat, topLine: repeatLine }, config);
      // 熔断：同一会话反复退化时，自第二次起不再保留待处理工作
      // （不传 keepInbox → agent.cancel 会清空 inbox 并取消唤醒请求）。
      const fused = state.trips >= config.maxTripsPerSession;

      let handoffPath = null;
      if (config.handoff) {
        handoffPath = writeHandoff({
          dshHome: dshHome(),
          sessionId: agent.id,
          trips: state.trips,
          detail: hit.detail,
          topLine: repeatLine,
          fused,
          request: recentRequests.get(agent.id) ?? null,
        });
        if (handoffPath !== null) stats.handoffs += 1;
      }

      const detail = {
        sessionId: agent.id,
        turn: frame.turn,
        step: frame.step,
        kind: hit.kind,
        reasoningChars: hit.detail.reasoningChars,
        maxRepeat: hit.detail.maxRepeat,
        hasText: hit.detail.hasText,
        hasToolCall: hit.detail.hasToolCall,
        escalated: hit.detail.escalated === true,
        trips: state.trips,
        fused,
        handoff: handoffPath,
        request: recentRequests.get(agent.id) ?? null,
      };
      appendLog(new Date().toISOString() + " trip " + JSON.stringify(detail));

      if (config.mode !== "stop") return;
      try {
        const reason =
          "dsh-degen-guard: " +
          hit.kind +
          " — 单步推理已重复同一行 " +
          hit.detail.maxRepeat +
          " 次（" +
          hit.detail.reasoningChars +
          " 字符），且尚无正文与工具调用；判定为推理退化循环，已中止本步" +
          (hit.detail.escalated === true ? "（爬升期提前拦截）" : "") +
          (handoffPath !== null ? "。交接单：" + handoffPath : "") +
          (fused
            ? "。本会话已累计 " + state.trips + " 次退化，已停止保留待处理工作——请开新会话"
            : "");
        agent.cancel({ kind: "hook", reason }, fused ? {} : { keepInbox: true });
        if (fused) stats.fused += 1;
        stats.canceled += 1;
        appendLog(
          new Date().toISOString() +
            " canceled " +
            JSON.stringify({ sessionId: agent.id, turn: frame.turn, step: frame.step, fused, handoff: handoffPath }),
        );
      } catch (error) {
        stats.cancelFailed += 1;
        appendLog(new Date().toISOString() + " cancel-failed " + JSON.stringify({ sessionId: agent.id, message: String(error?.message ?? error) }));
      }
    } catch (error) {
      // 守卫自身绝不能影响 agent 循环
      appendLog(new Date().toISOString() + " listener-error " + JSON.stringify({ message: String(error?.message ?? error) }));
    }
  });

  ctx.on("agent/disposed", ({ agent }) => {
    if (!agent) return;
    const prefix = agent.id + ":";
    for (const key of [...probes.keys()]) if (key.startsWith(prefix)) probes.delete(key);
    agents.delete(agent.id);
    recentRequests.delete(agent.id);
  });

  // 作用域注入：没有 webServer 的宿主不该让整个插件加载失败。
  ctx.inject(["webServer"], (host) => {
    host.effect(() => {
      const disposers = [];

      const logHandler = (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        sendJson(res, 200, { ok: true, mode: config.mode, path: logPath(), stats, lines: readTail(config.logLines) });
      };

      const statsHandler = (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        sendJson(res, 200, { ok: true, mode: config.mode, live: probes.size, agents: agents.size, stats });
      };

      const clearHandler = (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        try {
          writeFileSync(logPath(), "");
          sendJson(res, 200, { ok: true });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      };

      disposers.push(host.webServer.register({ kind: "exact", path: ROUTE_PREFIX + "/log", handler: logHandler }));
      disposers.push(host.webServer.register({ kind: "exact", path: ROUTE_PREFIX + "/stats", handler: statsHandler }));
      disposers.push(host.webServer.register({ kind: "exact", path: ROUTE_PREFIX + "/clear", handler: clearHandler }));

      appendLog(
        new Date().toISOString() +
          " host-ready " +
          JSON.stringify({ mode: config.mode, maxLineRepeat: config.maxLineRepeat, log: logPath() }),
      );

      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* ignore */
          }
        }
      };
    }, "dsh-degen-guard: diagnostics routes");
  });
}
