# pi-session-blackboard

> **⚠️ 实验性项目，目前工作尚不稳定。** 核心路径（板→摘要、确定性抽取、归档轮转）有测试覆盖，
> 但 checkpoint 投递、收编解析等依赖真实会话行为，尚未经过长时间多会话验证。
> 发现问题请到 [issues](https://github.com/113636xfh/pi-session-blackboard/issues) 反馈。

**一句话**：把 pi 的压缩摘要从「模型调用」变成「文件渲染」——会话里持续维护的黑板
（`~/.pi/agent/blackboard/<sessionId>.md`）就是压缩时保留的那份事实；压缩不再丢事实，
也不再花一次摘要模型的调用。

## 它解决什么问题

pi 的原生压缩在上下文超限时调用摘要模型把历史压成一段总结。两个代价：

1. **贵**：在本地模型上（W4A16 27B over PCIe）这是整条 pipeline 里最贵的一次调用，
   实测 40 秒内跑不完（同机对比见下文）；
2. **丢**：模型摘要会丢掉文件路径、函数名、报错原文这些精确事实——而这些恰恰是
   压缩后继续干活最需要的。

本扩展的做法不是「更好的摘要模型」，而是**换个信息源**：事实本来就在会话里，
每个用户回合结束后用纯 TS 确定性抽取（毫秒级、零模型），草稿交给**代理自己**在下一回合
审校提交，落盘成一个 markdown 文件。压缩触发时，直接把板子渲染成摘要返回——
pi 的切点算法、`keepRecentTokens` 保留尾部、compaction entry 全部不变，
**只换摘要内容，跳过摘要模型调用**。

## 架构总览

![黑板更新循环](docs/images/01-loop.png)

三个部件：

1. **抽取 —— 确定性，每回合。** 纯 TS 扫 *新增* 会话条目（vcc 风格模式匹配）：
   goal/scope、prefs、files + 导出符号、git commits、`[ERROR]` 行、decisions/next。
   毫秒级，无网络，无调参。
2. **审校 —— 代理自己，在自己的回合里。** 草稿作为隐藏消息（`display: false`）
   搭在你*下一条*提示上投递（零额外 API 调用）。代理审改后调 `blackboard` 工具
   commit，或在没价值时 skip。
3. **归档 —— 机械。** 每节溢出确定性轮转进 append-only 归档文件；每次 commit
   同时把紧凑 digest 镜像进会话 JSONL（`sbb-snapshot` 条目），供 `blackboard_recall` 检索。

这里没有任何后台模型调用。唯一的 LLM 工作是代理自己的审校——而语义判断本来就需要
它：正则分不出「这个决策已死」和「这个决策还有效」，代理分得出。

## 安装

```bash
pi install /path/to/pi-session-blackboard   # 用户级；或 pi install -l ... 项目级
# 重启 pi（扩展在进程启动时加载）
```

移除：`pi remove npm:pi-session-blackboard`（或 `pi list` 显示的安装名）。

注意：在 `settings.json` 的 `packages` 里引用本包必须用**裸字符串**路径——
`"extensions": []` 会禁用该包全部扩展（空数组 = 显式禁用，不是「不筛选」）。
装完用 `pi list` 确认没有 `(filtered)` 标记。

## 压缩：黑板即摘要

![压缩接管：黑板即摘要](docs/images/02-compaction.png)

压缩触发时（手动 `/compact`、上下文阈值、溢出恢复），处理器返回：

```
{ compaction: { summary: <板子按 pi 原生分节形状渲染>,
                firstKeptEntryId, tokensBefore } }
```

- **跳过而不是复制 pi 的摘要模型调用**——摘要就是代理每个 `checkpointTurns` 回合
  审校过的那块板子；
- pi 原生压缩的其余部分全部不动：切点算法、`keepRecentTokens` 保留尾部、
  compaction entry、投影重建；
- 分节按 pi 自己的摘要形状渲染（`## Goal`、`## Constraints & Preferences`、
  `## Key Decisions`、`## Files & Changes`、`## Open Issues`、`## Next Steps`），
  外加页脚：板文件路径 + `blackboard_recall` 检索指引；
- **页脚先预留再截断**：板超过 `summaryMaxChars` 时丢最老的正文行，永不丢检索指引；
- **底线**：真实条目 < 3 条 → 返回 `null` → pi 原生流程照跑。薄板不能变成薄摘要；
- 读取或渲染异常同样回退原生。

同一台本地 27B（W4A16/PCIe）实测：黑板路径 **0.0s**，原生摘要路径 >3min 未跑完。
板子是文件，压缩就是文件渲染。

### 收编（adoption）：原生摘要不浪费

板薄时走了原生流程，模型已经花了调用——那份摘要不该丢。收编把它解析回板：

- **`session_start`**：会话从已有 summary 恢复而板是薄的 → 用该 summary 播种
  薄板（seed）；
- **`session_compact`**：原生压缩完成后，把新 summary 解析成分节条目 commit 进板，
  下次压缩就走黑板了；
- **防自收编环**（三层）：`fromExtension` 守卫（板模式产生的压缩不触发收编）+
  自有摘要标记（`BOARD_SUMMARY_MARKER`）+ 板不薄检查——板子自己渲染出的摘要
  永远不会再被解析回自己；
- 解析规则：**节标题路由**（`## Goal` / `## Constraints & Preferences` /
  `[Files And Changes]` 都认）+ **内容嗅探优先于标题**（`## Progress` 下含 `ENOENT`
  的行归 Issues）；丢弃占位符（`[Scope change]`、`[x]`）；每条目 600 字额度
  （不受 agent 300 字上限约束）；
- 每节只保留最新 6 条，其余写进单个归档文件 `adopted-<stamp>.md` + 1 行指针
  （不再逐条生成 206 个碎片文件）。

端到端实测：14578 字原生 summary → 31 条入板 + 1 个收编归档；8160 字 → 27 条。

### 检索：`blackboard_recall`

摘要即板子之后，模型需要越过摘要找旧事实。`blackboard_recall` 大小写不敏感地子串搜：

1. 活板（`boardDir/<sessionId>.md`），每个命中归属其 `## Section`；
2. 轮转归档（`boardDir/archive/<sessionId>/*.md`）；
3. 会话 JSONL 里的 `sbb-snapshot` digest。

查询是**从对话里抄出来的字面子串**（路径、函数名、报错片段），不是自然语言问题。
digest 逐字段搜索：命中输出的是单条板条目 + 节归属（`recentFiles` 报 `Files`）+
镜像时间戳，数字与 `counts` 对象跳过——匹配计数是噪声不是事实。
输出紧凑卡片，最新在后，硬上限（`limit` 默认 20、最大 60）。`full: true`
恢复整块 dump（要的是板状态而不是单条事实时）。

每条命中一行 + 定位器，永不是一大团：

```
- [board · Decisions] - [2026-10-02 14:46] 薄板自动回退原生：黑板真实条目 < 3 条时返回 null …
- [archive/board-…0005.md · From: Goal] - [2026-10-02 14:46] …尚未验证第一次压缩走黑板
- [snapshot/2291@07-11-24 · Goal] 主线：…板子刚开始积累，尚未验证第一次压缩走黑板
```

## 板的分节

| 节 | 内容 | 谁写 |
|---|---|---|
| `Goal` | 会话开场任务；仅当开头用户文本真的变方向才追加 `[Scope change]` | 抽取 + 代理审校 |
| `Constraints & Preferences` | 「always/never/prefer/请用…」类表述（与板上已有去重） | 抽取 + 代理审校 |
| `Key Decisions` | 助手「I'll use X / decided to / let's go with…」行；**要求写清理由与被否方案** | 代理审校为主 |
| `Files & Changes` | `MODIFIED <path> (symbol1, symbol2)`（成功的 edit/write）+ `COMMIT <hash> <subject>`（成功的 git commit） | 确定性抽取 |
| `Open Issues` | `[ERROR] <cmd>: <首行报错>`（失败的 shell）；引用的文件被修改时自动标 `[RESOLVED <ts>]` | 抽取 + 代理审校 |
| `Findings` | **实验结论与数据**：用户要求做实验时必须记录结论和数据（实验提醒由抽取自动补） | 代理审校 |
| `Next Steps` | 「next step / TODO / after this」行 | 代理审校 |
| `Archived` | 轮转指针，扩展管理，agent 不可写 | 扩展 |

条目单行、自动打时间戳、去重、每条 300 字上限。`##` 分节固定；手工加的未知分节
和杂散行在扩展写入时原样保留。

**事实会变，板上不能留两个版本。** `commit` 只在精确匹配时去重，所以改一条而不带
`supersedes` 会让旧行留在新行旁边。`supersedes` 给出被替换行的唯一子串：旧行当场
归档进 `archive/<sessionId>/board-<ts>.md`（仍可用 `blackboard_recall` 搜到），
`## Archived` 落一行指针，新行成为摘要能显示的唯一版本。

```jsonc
{ "action": "commit", "entries": [
  { "section": "next", "text": "板已有 22 条，下次压缩走黑板",
    "supersedes": "starts empty, need 3 entries" }
]}
```

## 审校循环实际怎么跑

1. 你干活。每个完成的回合后，扩展挖*新增*会话条目：

   - **goal** —— 会话开场任务（一次），之后仅 `[Scope change]`（vcc 模式）；
   - **prefs** —— 「always/never/prefer/请用…」表述（vcc 模式，与板去重）；
   - **files** —— 成功 `edit`/`write` 的 `MODIFIED <path> (symbols)`，导出符号
     从新代码确定性提取（来自工具参数，零启发式）；
   - **files** —— 成功 `git commit` 的 `COMMIT <hash> <subject>`；
   - **issues** —— 失败 shell 的 `[ERROR] <cmd>: <首行报错>`（退出码、
     tsc/pytest/panic/traceback 模式）；
   - **findings** —— 实验结论与数据（配合实验提醒）；
   - **decisions / next** —— 助手「I'll use / decided / next step」行（限量截断，
     代理审校时修正）。

   开放 issue 引用的文件刚被编辑 → 自动标 `[RESOLVED <ts>]`。

2. checkpoint 到期（默认**每回合**；推荐节奏 `checkpointTurns: 3`）：下一条用户
   提示携带隐藏消息（草稿 + 审校指令）。代理审改后 commit 幸存者——或 skip。
   TUI 保持干净，随时 `/bb` 查看。

3. 草稿被连续忽略 3 次 → 停止注入并在 TUI 显示警告（`/bb` 仍可见全部，
   `/bb skip` 可清空）。

## `blackboard` 工具

| action | 作用 |
|---|---|
| `commit` | 记录 `entries=[{section, text, supersedes?}]`（单行、自动时间戳、去重、300 字上限）。节溢出轮转进归档文件。 |
| `commit` + `supersedes` | 单条目：被它替换的板条目的唯一子串。旧行同调用归档，摘要永远不会同时携带两版。目标歧义或缺失会回报（新行仍落）——用更长子串重试，或用 `archive`。 |
| `skip` | 丢弃待审草稿。 |
| `show` | 打印当前板（工具结果截断；磁盘上是全量）。 |
| `archive` | 把单条旧条目（唯一 `target` 子串）移进归档文件，`## Archived` 留指针。 |

## `/bb` 命令

| 形式 | 作用 |
|---|---|
| `/bb` | 状态（路径、版本、各节计数、距 checkpoint 的回合数、待审草稿）+ 板（截断 80 行） |
| `/bb now` | 立即强制投递待审草稿（或按 `delivery` 随下条消息） |
| `/bb skip` | 丢弃待审草稿 |
| `/bb reset` | 确认后删除本会话板 + 状态（归档文件保留） |

## 文件

东西落在哪里——**你从不需要管理**。板只由 `blackboard` 工具在 agent commit 时写：

| 文件 | 谁写 | 内容 |
|---|---|---|
| `~/.pi/agent/blackboard/<sessionId>.md` | `blackboard` 工具（commit 时） | **板** —— 纯 markdown，分节顺序稳定，每节有上限 |
| `~/.pi/agent/blackboard/archive/<sessionId>/board-<ts>.md` | `blackboard` 工具（溢出轮转） | 每节溢出 —— append-only，每次轮转一个文件 |
| `~/.pi/agent/blackboard/archive/<sessionId>/adopted-<stamp>.md` | 收编（session_start / session_compact） | 收编时超出每节 6 条额度的旧条目 —— 单个文件 + 板上 1 行指针 |
| `~/.pi/agent/blackboard/state/<sessionId>.json` | 扩展（确定性） | 抽取游标、待审草稿、计数器 |
| `~/.pi/agent/blackboard/debug/<sessionId>.ndjson` | 扩展，仅 `"debugLog": true` | 调试事件日志 |
| 会话 JSONL（`sbb-snapshot` 条目） | 扩展（可选镜像） | 板状态紧凑 digest —— `blackboard_recall` 可搜 |

板是文件——要拷贝它就在那儿。状态、草稿、镜像、digest **永不进入模型上下文**：
它们是文件和 JSONL custom entry，可 grep、可 commit、可用普通 `read` 工具读
（例如压缩后）。

## 配置

`~/.pi/agent/settings.json`（用户）或 `.pi/settings.json`（项目，优先），
键 `"session-blackboard"`：

```jsonc
{
  "session-blackboard": {
    "enabled": true,              // 主开关
    "checkpointTurns": 1,         // 审校节奏（用户回合数；1 = 每回合）
    "delivery": "next-turn",      // "next-turn"（零额外 LLM 调用）| "immediate"（立即 steer）
    "maxEntriesPerSection": 40,   // 每节轮转阈值
    "maxEntryChars": 300,         // 每条上限
    "maxDraftLines": 60,          // checkpoint 渲染的草稿大小上限
    "mirrorToSession": true,      // 紧凑 digest → 会话 JSONL（sbb-snapshot）
    "compaction": "board",        // "board"（板即摘要）| "digest" | "off"
    "summaryMaxChars": 6000,      // 板渲染为摘要的硬上限
    "compactAssist": false,       // legacy：原生 LLM 摘要 + 追加板节
    "compactAssistMaxChars": 4000, // assist 节硬上限
    "boardDir": "~/.pi/agent/blackboard",  // 绝对路径，或相对 agent 目录
    "debugLog": false
  }
}
```

- **`checkpointTurns`** 默认 1（「每回合抽取、每回合审校」）。嫌吵就调到 3–10——
  抽取和 `[RESOLVED]` 标记仍每回合发生，只变审校节奏。
- **`delivery: "next-turn"`**（默认）：checkpoint 随你下条消息注入，零额外 LLM
  调用。`"immediate"` 立即派发 steer 消息触发一轮短审校（小额外调用，前缀
  基本走缓存）——适合「下一条用户消息」还很远的无人值守运行。

### Legacy：compaction assist（`compactAssist`，默认关）

**辅助，不替换。** 原生压缩运行时，处理器调用 harness 会调用的*同一个*导出
`compact()`（相同模型、prompt、保留尾部、`customInstructions`），并在 LLM 摘要
**末尾追加一节限量确定性板 digest**（goal ≤3、open issues ≤5、files ≤5、next ≤3、
各节统计、板文件与归档目录指针）。所有红分支（任何 gate 或调用本身抛错）都返回
`undefined`：原生流程原样跑，唯一增加是末尾追加的限量节：零额外 LLM 成本。
已被 `"compaction": "board"` 取代——后者根本不需要摘要调用。

### 会话 JSONL 镜像（`mirrorToSession`）

每次 commit（以及 `digest` 模式压缩前）追加一个**紧凑 digest**（goal ≤3、next ≤3、
recent files ≤5、open-issue 数、各节计数）为 `sbb-snapshot` custom entry。
custom entry 不进 LLM 上下文，推理时零成本；它让板状态*持久化在会话记录里*——
`blackboard_recall` 永久可搜，也是未来确定性摘要的输入。

## 成本模型（本扩展不做的事）

| 工作负载 | 本扩展 |
|---|---|
| 后台 LLM 调用 | **永远没有** |
| 额外 prefill | 无（抽取纯 CPU） |
| prompt 开销 | 仅审校时的 checkpoint 消息（~1–3k tokens，追加在尾部——前缀缓存完好） |
| 归档 | 确定性文件轮转（append-only） |
| 压缩 | `"board"` 把板作为摘要返回并跳过 pi 的摘要调用（薄板 → 原生）；切点与保留尾部仍是 pi 的；legacy `compactAssist`（关）向原生 LLM 摘要追加限量节；可选 `digest` 镜像 |

## 兼容性

- pi ≥ 0.84（按 0.84.x 扩展 API 测试：`agent_settled`、`before_agent_start`、
  `session_before_compact`、`session_compact`、`pi.registerTool`、
  `pi.registerCommand`、`pi.appendEntry`、`pi.sendMessage`）。
- 零运行时依赖（只 import `node:*`、`typebox`、`@earendil-works/pi-coding-agent`，
  全部由 pi 扩展加载器解析）。
- 在 pi 的 `settings.json` `packages` 里引用本包必须用**裸字符串**路径
  （`"../../pi-session-blackboard"`）——写 `{"path": "...", "extensions": []}`
  会禁用该包全部扩展（空数组 = 显式禁用），不是「不筛选」。用 `pi list`
  检查有无 `(filtered)` 标记。
- TypeScript strict；`npm install && npm run typecheck`。

## 开发

```bash
npm install        # 仅 devDependencies；扩展本身零运行时依赖
npm run typecheck  # tsc --noEmit
npm test           # build (tsc -> build/) + node test/smoke.mjs
npm run docs:render  # SVG -> PNG（resvg，确定性，无浏览器）
```

`tsconfig.json` 是便携配置。`tsconfig.check.json` / `tsconfig.build.json` 是
本机助手（把 `@earendil-works/*` 和 `typebox` 映射到现成安装）——故意 git-ignore。

纯函数（板→摘要渲染、recall 搜索、收编解析、legacy assist 节）由 `test/smoke.mjs`
断言（32 项）；钩子、checkpoint 注入、压缩交接由真实 pi 会话验证，不在套件里。

## 局限（诚实版）

- 「强制」是 **prompt 强制 + 周期提醒**，不是硬保证：模型可以跳过 checkpoint
  （缓解：最多重注 3 次 + 可见警告；下个用户回合重新触发）。
- 助手文本挖掘（decisions/next）故意轻且限量——这正是代理要审草稿的原因。
  是起点，不是事实源。
- 确定性 `[ERROR]` 抽取器是对原始工具输出的启发式，测试中产生过误报：
  (a) smoke 测试输出里回显的 `[ERROR]` + 429 限流 fixture 行；(b) `grep -c`
  零匹配导致的 shell 退出码 1（测试其实*通过*了）——两者都被挖成真实失败。
  审校步骤是缓解手段；抽取会继续犯这类错。
- `[Scope change]` 检测以开头用户文本为键，分不清真正的方向转变和简短续作
  （「fix these issues and …」）——goal 条目靠代理审校兜底。
- `## Archived` 指针行永不轮转（`src/board.ts`）——每次归档动作 ~150 字无界增长
  （100 次 ≈ 15 KB ≈ ~4k tokens）。设计里唯一无界部分；计划：像其他条目一样
  设上限 + 轮转。
- 每个 session id 一块板。死会话的板是可保留/可 grep/可删的文件
  （`/bb reset` 只碰当前会话）。
- 无跨会话召回：用你自己的 grep；`blackboard_recall` 覆盖的是*本会话*跨压缩的
  活板 + 归档 + 镜像 digest。

## 致谢与许可

Goal/scope-change 与偏好抽取模式改编自
**[@monotykamary/pi-vcc](https://github.com/monotykamary/pi-vcc)**（MIT）。
「确定性抽取 + 代理审校」架构是本包的。

MIT — 见 [LICENSE](./LICENSE)。
