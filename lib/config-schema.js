/* dsh-degen-guard — Config schema（Settings 识别入口）。
 *
 * 旧字段全部 z.any()：保留原键原语义，具体取值与兜底由 detect.js 的
 * resolveConfig 负责；schemastery 非 strict 解析会透传未声明键，这里声明是为了
 * autofix 路径下也不删。新三字段 .volatile()：命令 /degen-mode 通过
 * configEditor.edit 持久化后就地更新，运行时必须用 config.field.get() 读。
 */
import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  // ── 旧字段：原键原语义，宽松兼容 ─────────────────────────────────
  mode: z.any(),
  minReasoningChars: z.any(),
  maxLineRepeat: z.any(),
  maxReasoningChars: z.any(),
  maxLineChars: z.any(),
  maxTrackedLines: z.any(),
  logLines: z.any(),
  trendWindow: z.any(),
  trendMinSteps: z.any(),
  trendMinRepeat: z.any(),
  escalatedMaxLineRepeat: z.any(),
  maxTripsPerSession: z.any(),
  handoff: z.any(),

  // ── 新字段：volatile ──────────────────────────────────────────────
  onFused: z
    .union(["hint", "draft", "auto"])
    .default("hint")
    .volatile()
    .description("熔断后的恢复动作：hint=在停止原因里给出 /inherit 提示；draft=静态创建继承草稿；auto=自动启动新会话（受 maxAutoChain 限制）"),
  maxAutoChain: z
    .number()
    .step(1)
    .min(1)
    .max(3)
    .default(1)
    .volatile()
    .description("每条继承链最多自动启动新会话的次数（1..3）；达到上限后降为 draft"),
  autoNextStep: z
    .string()
    .default(
      "上一会话因连续退化（重复无效输出或死循环）被熔断。请先只读检查交接单涉及的最近修改文件与当前工作区状态，确认停在哪里；" +
        "严禁原样重试上次卡住或失败的操作，必须换一种实现路径或先缩小改动范围；" +
        "若发现缺少关键上下文或环境阻塞无法绕过，立即停止并列出需要人工确认的问题。",
    )
    .volatile()
    .description("自动继承时注入新会话的默认破局提示；空串表示不指定"),
});
