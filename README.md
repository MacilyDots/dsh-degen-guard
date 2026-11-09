# dsh-degen-guard

给 DeepSeek Harness 的**推理退化守卫**：模型在思考通道里陷入 token 级重复循环时自动中止该步，不必再手动点停止。

## 它解决什么问题

长上下文下，`deepseek-v4.1-flash` 的 reasoning 通道会退化成 token 级重复——反复吐同一批极短行，既不产出正文也不产出工具调用。而流一直有数据，所以：

- `@deepseek-ai/dsh-llm-pi-ai` 的 `streamIdleTimeoutMs`（默认 5 分钟）**永远不会触发**，因为它只统计"空闲"；
- `@deepseek-ai/dsh-compaction-basic` 的自动压缩阈值（该模型默认 550,464 token）远高于退化起点，也不会触发。

结果就是界面看起来"卡死"，只能手动中止。2026-10-07 实测最严重的一次，用户等了 **8 分 15 秒**；同一天另一个会话的单步推理吐到 **106,250 字符**。

**上下文压缩治不了它**：2026-10-08 实测把上下文从 541,227 token 压到 25,602 token（-95%）后，4 步之内再次退化，且新回合第一步就退化——重复词从「做。」换成了「好。」。压缩改的是喂进去的历史，改不了解码层的自增强循环。

## 三道防线

| 层 | 触发条件 | 动作 |
|---|---|---|
| ① 重复度（主力） | 本步同一非空行重复 ≥ `maxLineRepeat`（默认 100），且该步尚无正文与工具调用 | 中止本步 |
| ② 爬升期提前拦截 | 最近 8 步里有 ≥ 4 步的「最高频行」是**同一句含字碎念**、且这些步重复数 ≥ 8 | 本步阈值降到 `escalatedMaxLineRepeat`（默认 40） |
| ③ 熔断 | 同一会话累计触发 ≥ `maxTripsPerSession`（默认 2） | 中止时**不再保留待处理工作**，切断「中止→唤醒→再退化」的闭环 |

每次触发（无论第几次）都会在 `%DSH_HOME%\handoff\` 落盘一份**交接单**，含会话 id、工作区、触发状态、重复的那一行、触发时刻的请求摘要、以及从会话存档里抽出的最近用户消息 / 工具调用 / 最后一次 `todo/write`——方便开新会话续。交接单路径同时写进中止原因，界面上能看到。

## 触发时刻的请求摘要（llm/stream 探针）

trip 日志和交接单里带一个 `request` 字段，记的是**模型当时收到的请求**摘要：

- 路由（provider / model）、`maxTokens`、`reasoningEffort`、tools 数量；
- messages 条数、总字符数、按角色（system/user/assistant/tool）分布的条数与字符数；
- 采样参数——**DSH 的请求对象里没有 temperature/top_p**，这些字段由适配器默认值决定，探针会如实记录"没有"，不会编造。

用途：区分「退化发生在工具调用之前（解码层）」和「工具调用/结果回传层异常」。前者 trip 时该步没有任何 `tool/call` 事件；后者会先看到失败的 `tool/result`。

数据来源是 `llm/stream` 监听器瀑布——监听器拿到的就是 agent-loop 构造的完整请求对象（`{ ...header.config, messages, tools?, sessionId, signal }`），messages 是深冻结的。探针只做只读摘要并原样放行 `next()`，自身任何异常都被吞掉，不影响请求。

第③层是必需的：`agent.cancel` 的签名是

```js
cancel(cause, options = {}) {
  if (!options.keepInbox) {
    this.inbox.clear();                                          // 清空待处理工作
    if (this.phase.kind !== "idle") this.phase.wakeRequested = false;  // 不再唤醒
  }
  if (this.phase.kind !== "idle") this.phase.abort.abort(cause);
}
```

传 `keepInbox: true`（本插件原先的做法）会保留待处理工作与唤醒请求，于是中止之后 agent 立刻又跑，再次撞上同一个状态——2026-10-08 的一次实测里，5 次触发有 2 次就是这么来的。

## 实测到的两种退化形态

| 形态 | 长什么样 | 例 |
|---|---|---|
| A：独占一行的碎念 | `好。` / `做。` / `写。` | 33,855 字符里「好。」重复 **4,616 次** |
| B：带格式的碎念 | `**好** ✓` / `**执行** ✓` / `（执行。）` | 106,250 字符里同一行重复 **6,316 次** |

共同点是**同一非空行反复出现**，所以判据用它，而不是"短行总数"——形态 B 的行长是 5~8 字符，按"短行"统计会整批漏掉。

## 判据与阈值

只在「本步还没有任何正文、也没有任何工具调用」时才判定，所以"先长思考再调工具"的正常形态完全不受影响。

```
maxRepeat ≥ 100（或爬升期内的 40）  →  repeat-loop
reasoningChars ≥ 100000             →  runaway-reasoning（兜底，真实数据里从未命中）
```

**重复的必须是含字的行**：纯符号行（``` 围栏、`}`、`---`）不算碎念。这条修掉了全量回放里 6 例既有误伤——某个会话连续输出 102 个 `}` 然后正常调用了 4 次工具。

### 回放数据（全量 433 个会话 / 15,324 步）

| 配置 | TP 拦下真卡死 | FP 误伤有输出 | TN |
|---|---|---|---|
| 仅第①层 | 21 | **0** | 15,158 |
| ①+②（默认） | 21 | **2** | 15,157 |

第②层带来 **10 次提前拦截，累计少生成 188,104 字符**：例如某步从 33,855 字符截到 3,200，另一会话从 76,643 截到 2,944。

代价是 **2 例新误伤**，都落在同一个会话 `29e13f8c` 的相邻两步（T28.9、T28.10，重复 40/42 次后仍输出了工具调用）。该会话紧接着的 T29.1 就彻底退化到 66,328 字符——**在那两步拦住，恰好避免了后面这一次真卡死**。

参数不是拍的，是网格扫出来的：`trendMinRepeat` 取 5~6 时误伤一个 top 恰好也是「好。」、幅度 43 的正常步；取 8 才把误伤压到上面这 2 例。想完全关掉第②层，把 `escalatedMaxLineRepeat` 设成 100 即可。

**结构上的边界**：第②层要求先有爬升期。开局第一步就爆发的退化（实测有一步直接吐到 4,125 次重复）没有历史可依，只能靠第①层。全量里 10 次提前拦截对应 21 次总触发，覆盖不到一半。

## 安装

```bash
node install.mjs                 # 装进 %DSH_HOME%\profiles\desktop
node install.mjs web             # 或指定 profile 名 / 绝对路径
```

脚本会：加 `file:` 依赖、把插件名写进 `dsh.profile.bundles`、用 **junction** 把 `node_modules/<name>` 指向本目录（改源码即生效，不必同步副本）。**装完要重启 DSH。**

## 配置

默认值在 `lib/detect.js` 的 `DEFAULT_CONFIG`。要覆盖就在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: degen-guard
  config:
    mode: log                 # log = 只记日志不干预；stop = 中止（默认）
    maxLineRepeat: 100        # 第①层的线
    minReasoningChars: 1000
    escalatedMaxLineRepeat: 40 # 第②层降档后的线；设成 100 等于关掉第②层
    trendWindow: 8
    trendMinSteps: 4
    trendMinRepeat: 8
    maxTripsPerSession: 2     # 第③层熔断阈值
    handoff: true             # 是否落盘交接单
```

想先观察一段时间再开杀，就把 `mode` 设成 `log`。

## 诊断

装好后有三个只读端点（由宿主 webServer 提供）：

| 端点 | 作用 |
|---|---|
| `GET /dsh-degen-guard/log` | 最近日志 + 本进程统计 |
| `GET /dsh-degen-guard/stats` | 触发计数、按类型分布、活跃 agent 数 |
| `POST /dsh-degen-guard/clear` | 清空日志 |

日志文件：`%DSH_HOME%\logs\dsh-degen-guard.log`（**时间戳是 UTC**，本地时间要 +8）。

触发时插件用官方 `agent.cancel({ kind: 'hook', reason })` 中止当前步——`hook` 是 `AgentCancelCause` 为插件预留的取消原因，所以会话记录里能看出是守卫干的，不是用户点的停止。

## 离线回放

```bash
node tools/replay.mjs 999 --trend          # 全量会话，带跨步趋势
node tools/replay.mjs 999                  # 只跑第①层做对照
node tools/replay.mjs 999 --trend --config '{"escalatedMaxLineRepeat":60}'
```

输出混淆矩阵（TP/FP/FN/TN）、每次触发的明细、以及提前拦截的累计收益。**改任何阈值都应该先跑它**——`trendMinRepeat` 从 8 降到 5 会让 FP 从 2 涨到 8，这个只有回放能看出来。

## 测试

```bash
node test/test-detect.mjs      # 50 项判据单测（合成数据）
node test/test-request-tap.mjs # 22 项请求探针单测
node test/test-plugin.mjs      # 32 项宿主接线测试（mock ctx）
```
