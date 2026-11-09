/* dsh-degen-guard — llm/stream 请求探针测试（纯函数 + 监听器契约）。
 * 跑法：node test/test-request-tap.mjs
 */
import { createRequestTap, summarizeRequest } from "../lib/request-tap.js";

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

function stripAt(summary) {
  if (summary === null || typeof summary !== "object") return summary;
  const { at, ...rest } = summary;
  return rest;
}

console.log("summarizeRequest：完整请求对象");
{
  const options = {
    provider: "deepseek-account",
    model: "deepseek-flash",
    maxTokens: 256000,
    reasoningEffort: "high",
    messages: [
      { role: "system", content: [{ type: "text", text: "系统提示" }] },
      { role: "user", content: [{ type: "text", text: "你好" }] },
      { role: "assistant", content: [{ type: "text", text: "改文件" }, { type: "tool-call", name: "edit", arguments: '{"a":1}' }] },
      { role: "tool", content: [{ type: "text", text: "done" }] },
    ],
    tools: [{ name: "read" }, { name: "edit" }],
    sessionId: "session-abc",
  };
  const s = stripAt(summarizeRequest(options));
  check("sessionId", s.sessionId, "session-abc");
  check("provider", s.provider, "deepseek-account");
  check("model", s.model, "deepseek-flash");
  check("maxTokens", s.maxTokens, 256000);
  check("reasoningEffort", s.reasoningEffort, "high");
  check("tools 数", s.tools, 2);
  check("消息数", s.messages.count, 4);
  check("按角色计数", s.messages.byRole, {
    system: { count: 1, chars: 4 },
    user: { count: 1, chars: 2 },
    assistant: { count: 1, chars: 10 },
    tool: { count: 1, chars: 4 },
  });
  check("总字符", s.messages.totalChars, 20);
  check("采样参数为空（DSH 不暴露）", s.sampling, {});
}

console.log("summarizeRequest：字符串 content");
{
  const s = stripAt(summarizeRequest({ sessionId: "s1", messages: [{ role: "user", content: "abcde" }] }));
  check("字符串 content 计数", s.messages.byRole.user, { count: 1, chars: 5 });
}

console.log("summarizeRequest：缺 sessionId / 畸形输入 → null");
{
  check("缺 sessionId", summarizeRequest({ messages: [] }), null);
  check("null", summarizeRequest(null), null);
  check("字符串", summarizeRequest("x"), null);
  check("数组", summarizeRequest([1, 2]), null);
}

console.log("summarizeRequest：畸形 messages 不抛错");
{
  const s = stripAt(summarizeRequest({ sessionId: "s2", messages: [null, {}, { role: "user" }, { role: "user", content: [null, 5] }] }));
  check("兼容畸形消息", s.messages.count, 4);
  check("未知角色", s.messages.byRole["?"], { count: 2, chars: 0 });
}

console.log("summarizeRequest：采样参数若存在则记录");
{
  const s = stripAt(summarizeRequest({ sessionId: "s3", messages: [], temperature: 0.7, top_p: 0.9, seed: 42 }));
  check("sampling", s.sampling, { temperature: 0.7, top_p: 0.9, seed: 42 });
}

console.log("createRequestTap：原样放行 next，返回值不变");
{
  const downstream = { fake: "stream" };
  let seen = null;
  const tap = createRequestTap({ onRequest: (summary) => { seen = summary; } });
  const result = tap({ sessionId: "s4", messages: [] }, () => downstream);
  check("返回 next() 的同一个对象", result === downstream, true);
  check("回调收到摘要", seen?.sessionId, "s4");
}

console.log("createRequestTap：onRequest 抛错不影响请求");
{
  const tap = createRequestTap({ onRequest: () => { throw new Error("boom"); } });
  const downstream = { ok: true };
  const result = tap({ sessionId: "s5", messages: [] }, () => downstream);
  check("请求照常放行", result === downstream, true);
}

console.log("createRequestTap：没有 onRequest 也照常放行");
{
  const tap = createRequestTap();
  const downstream = { ok: true };
  check("放行", tap({ sessionId: "s6", messages: [] }, () => downstream) === downstream, true);
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
