/* dsh-degen-guard — 判据单测（合成数据，不依赖任何本机会话存档）。
 * 跑法：node test/test-detect.mjs
 */
import {
  createHistory,
  createProbe,
  feedChunk,
  isEscalating,
  isStructuralLine,
  isTrackableLine,
  recordStep,
  resolveConfig,
  topLine,
  verdict,
} from "../lib/detect.js";

const cfg = resolveConfig({});
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

/** 把一段文本按固定宽度切成 reasoning-delta 流。 */
function* reasonStream(text, width) {
  for (let i = 0; i < text.length; i += width) {
    yield { type: "reasoning-delta", index: 0, text: text.slice(i, i + width) };
  }
}

/** 喂完整段，返回判据结果（模拟宿主每 chunk 查一次）。 */
function run(chunks, config = cfg) {
  const probe = createProbe();
  let hit = null;
  for (const chunk of chunks) {
    if (!feedChunk(probe, chunk, config)) continue;
    const v = verdict(probe, config);
    if (v !== null) {
      hit = v;
      probe.fired = true;
      break;
    }
  }
  return { hit, probe };
}

console.log("isTrackableLine");
check("「好。」可统计", isTrackableLine("好。", 64), true);
check("空行不统计", isTrackableLine("   ", 64), false);
check("带格式的「**好** ✓」可统计", isTrackableLine("**好** ✓", 64), true);
check("超长行不统计", isTrackableLine("x".repeat(65), 64), false);

console.log("形态 A：独占一行的碎念 → repeat-loop");
{
  const text = Array.from({ length: 400 }, () => ["好。", "做。", "写。"][Math.floor(Math.random() * 3)]).join("\n");
  const { hit } = run(reasonStream(text, 64));
  check("触发", hit?.kind, "repeat-loop");
  check("重复计数达标", hit.detail.maxRepeat >= cfg.maxLineRepeat, true);
}

console.log("形态 B：带格式的碎念 → repeat-loop（旧判据漏掉的形态）");
{
  const text = Array.from({ length: 400 }, () => ["**好** ✓", "**执行** ✓", "**停** ✗", "（执行。）"][Math.floor(Math.random() * 4)]).join("\n\n");
  const { hit } = run(reasonStream(text, 64));
  check("触发", hit?.kind, "repeat-loop");
}

console.log("正常长推理（每行都不同）不触发");
{
  const text = Array.from({ length: 2000 }, (_, i) => `第 ${i} 步：先确认工单里的判据口径，再决定要不要改 ART_BIBLE。`).join("\n");
  const { hit, probe } = run(reasonStream(text, 64));
  check("不触发", hit, null);
  check("长度确实超 3 万", probe.reasoningChars > 30000, true);
  check("最高重复只有 1", probe.maxRepeat, 1);
}
console.log("未越线、且随后有工具调用 → 不干预");
{
  const text = Array.from({ length: 60 }, () => "好。").join("\n"); // 重复 60 < 100
  const chunks = [...reasonStream(text, 64), { type: "tool-call-delta", index: 1, id: "c1", argumentsDelta: "{}" }];
  check("不触发", run(chunks).hit, null);
}

console.log("未越线、且随后有正文 → 不干预");
{
  const text = Array.from({ length: 60 }, () => "好。").join("\n");
  const chunks = [...reasonStream(text, 64), { type: "text-delta", index: 1, text: "我先写工单。" }];
  check("不触发", run(chunks).hit, null);
}

console.log("远超阈值后才有工具调用 → 仍然止损（设计意图）");
{
  const text = Array.from({ length: 1000 }, () => "好。").join("\n");
  const chunks = [...reasonStream(text, 64), { type: "tool-call-delta", index: 1, id: "c1", argumentsDelta: "{}" }];
  check("触发", run(chunks).hit?.kind, "repeat-loop");
}

console.log("纯长度失控（无重复行）→ runaway-reasoning");
{
  const text = "啊".repeat(120000); // 一个超长行：不计入重复统计
  const { hit, probe } = run(reasonStream(text, 128));
  check("触发", hit?.kind, "runaway-reasoning");
  check("重复统计确实没动", probe.maxRepeat, 0);
}

console.log("短推理不触发");
{
  check("不触发", run(reasonStream("好。做。写。", 4)).hit, null);
}

console.log("跨 chunk 的行边界");
{
  const text = Array.from({ length: 500 }, () => "好。").join("\n");
  // 直接喂满，不走 run()（run 会在触发点停下，看不到最终计数）
  const probe = createProbe();
  for (const c of reasonStream(text, 3)) feedChunk(probe, c, cfg); // 每 chunk 3 字符，必然切断「好。」与换行
  // 最后一行没有收尾换行，留在 tail 缓冲里不计 —— 499 是正确值
  check("计数正确", probe.maxRepeat, 499);
}

console.log("fired 后不重复触发");
{
  const probe = createProbe();
  for (const c of reasonStream(Array.from({ length: 400 }, () => "好。").join("\n"), 64)) feedChunk(probe, c, cfg);
  check("首次有结果", verdict(probe, cfg)?.kind, "repeat-loop");
  probe.fired = true;
  check("再次为 null", verdict(probe, cfg), null);
}

console.log("行键上限保护：不同行极多时不无界增长");
{
  const config = resolveConfig({ maxTrackedLines: 50 });
  const probe = createProbe();
  for (let i = 0; i < 5000; i++) feedChunk(probe, { type: "reasoning-delta", index: 0, text: `唯一行 ${i}\n` }, config);
  check("Map 不超上限", probe.lineCounts.size <= 50, true);
}

console.log("resolveConfig 只接受合法值");
check("mode 非法值被忽略", resolveConfig({ mode: "boom" }).mode, "stop");
check("负值被忽略", resolveConfig({ maxLineRepeat: -1 }).maxLineRepeat, 100);
check("合法覆盖生效", resolveConfig({ maxLineRepeat: 50, mode: "log" }).maxLineRepeat, 50);
check("合法覆盖 mode", resolveConfig({ mode: "log" }).mode, "log");

console.log("isStructuralLine：纯符号行不算碎念");
check("``` 是结构行", isStructuralLine("```"), true);
check("} 是符号行", isStructuralLine("}"), true);
check("--- 是结构行", isStructuralLine("---"), true);
check("空行是结构行", isStructuralLine("   "), true);
check("「做。」不是结构行", isStructuralLine("做。"), false);
check("「（执行。）」不是结构行", isStructuralLine("（执行。）"), false);
check("「**好** ✓」不是结构行", isStructuralLine("**好** ✓"), false);

console.log("topLine：取重复最多的那一行");
{
  const probe = createProbe();
  for (const c of reasonStream("做。\n做。\n做。\n别的。\n", 4)) feedChunk(probe, c, cfg);
  check("topLine", topLine(probe), "做。");
}

console.log("纯符号行的高重复不算退化（修掉连吐 102 个 } 的既有误伤）");
{
  const text = Array.from({ length: 200 }, () => "}").join("\n");
  check("不触发", run(reasonStream(text, 64)).hit, null);
}

console.log("escalated：爬到阈值时用更低的线");
{
  // 重复 60 次：低于基础线 100、高于升档线 40；再用各不相同的行把
  // 本步总长推过 minReasoningChars，否则判据在长度门槛就返回了。
  const filler = Array.from({ length: 120 }, (_, i) => `唯一行 ${i}：把本步推理长度推过 minReasoningChars。`).join("\n");
  const text = Array.from({ length: 60 }, () => "好。").join("\n") + "\n" + filler;
  const probe = createProbe();
  let hit = null;
  for (const c of reasonStream(text, 64)) {
    if (!feedChunk(probe, c, cfg)) continue;
    const v = verdict(probe, cfg, true);
    if (v !== null) {
      hit = v;
      break;
    }
  }
  check("escalated 触发", hit?.kind, "repeat-loop");
  check("detail.escalated", hit?.detail.escalated, true);
  check("detail.threshold", hit?.detail.threshold, cfg.escalatedMaxLineRepeat);
  check("同一文本未升档时不触发", run(reasonStream(text, 64)).hit, null);
}

console.log("isEscalating：窗口内同一句碎念反复出现");
{
  const h = createHistory();
  for (let i = 0; i < 4; i++) recordStep(h, { maxRepeat: 9, topLine: "做。" }, cfg);
  check("同 top 行 4 步 → 爬升", isEscalating(h, cfg), true);
}
{
  const h = createHistory();
  for (let i = 0; i < 4; i++) recordStep(h, { maxRepeat: 9, topLine: `第 ${i} 行` }, cfg);
  check("top 行每步不同 → 不是爬升", isEscalating(h, cfg), false);
}
{
  const h = createHistory();
  for (let i = 0; i < 4; i++) recordStep(h, { maxRepeat: 9, topLine: "```" }, cfg);
  check("同 top 行但是结构行 → 不是爬升", isEscalating(h, cfg), false);
}
{
  const h = createHistory();
  for (let i = 0; i < 3; i++) recordStep(h, { maxRepeat: 9, topLine: "做。" }, cfg);
  check("只 3 步 → 不够 trendMinSteps", isEscalating(h, cfg), false);
}
{
  const h = createHistory();
  for (let i = 0; i < 4; i++) recordStep(h, { maxRepeat: 3, topLine: "做。" }, cfg);
  check("4 步但幅度不足 trendMinRepeat", isEscalating(h, cfg), false);
}
{
  const h = createHistory();
  for (let i = 0; i < 40; i++) recordStep(h, { maxRepeat: 9, topLine: `第 ${i} 行` }, cfg);
  check("历史有硬上限", h.steps.length <= cfg.trendWindow * 4, true);
}
{
  const h = createHistory();
  recordStep(h, { maxRepeat: 0, topLine: "做。" }, cfg);
  recordStep(h, undefined, cfg);
  check("非法步不进历史", h.steps.length, 0);
}

console.log("resolveConfig 新增键");
check("escalatedMaxLineRepeat 可覆盖", resolveConfig({ escalatedMaxLineRepeat: 60 }).escalatedMaxLineRepeat, 60);
check("maxTripsPerSession 默认 2", resolveConfig({}).maxTripsPerSession, 2);
check("turn 阈值可覆盖", resolveConfig({ maxTripsPerSession: 5 }).maxTripsPerSession, 5);
check("handoff 默认开", resolveConfig({}).handoff, true);
check("handoff 可关", resolveConfig({ handoff: false }).handoff, false);
check("handoff 非布尔被忽略", resolveConfig({ handoff: "no" }).handoff, true);

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
