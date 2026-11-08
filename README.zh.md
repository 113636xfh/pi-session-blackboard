# pi-session-blackboard

**能跨压缩存活的会话笔记；当笔记足够用时，压缩摘要的模型调用次数为零。**

扩展把每个会话的笔记（*黑板*）保存在 **pi 的会话事件**里：分支内生效、只追加、在渲染
之前不进入模型上下文。每个回合用纯 TS 确定性抽取候选事实（零模型），交给代理自己审校。
压缩触发时，只有笔记**确实覆盖了即将离开保留尾部的内容**，才会被渲染成摘要；否则扩展会
向当前模型请求一次有界补写，补写无法安全完成时退回 pi 的原生摘要。

下面每一条都可以被证伪。措辞比 0.2 刻意保守：「事实在黑板里」从不等于「事实一定被记下
了」，「零摘要调用」以覆盖闸门通过为前提。

English: [README.md](README.md)

| | pi 原生压缩 | 本扩展（`"compaction": "board"`） |
|---|---|---|
| 摘要模型调用 | 每次压缩一次 | 覆盖建立后 **零次** |
| 压缩前的额外模型请求 | 0 | **最多 2 次**，仅在笔记不完整时 |
| 摘要内容 | 摘要模型留下什么 | 代理提交了什么就是什么 |
| 事后可检查 / 可检索 | 不能 | 能——事件、`blackboard_recall`、`/bb show`、`/bb export` |
| 后台模型调用 | — | **无**（assist 需显式开启） |

## 目录

- [安装](#安装)
- [模式](#模式)
- [你会看到的循环](#你会看到的循环)
- [压缩策略](#压缩策略)
- [命令与工具](#命令与工具)
- [数据布局与恢复](#数据布局与恢复)
- [从 0.2 迁移](#从-02-迁移)
- [配置](#配置)
- [成本](#成本)
- [测试](#测试)
- [已知局限](#已知局限)
- [许可](#许可)

## 安装

```bash
pi install git:github.com/113636xfh/pi-session-blackboard    # 用户级；加 -l 为项目级
```

pi 直接加载 `src/index.ts`，日常使用不需要构建。开发需要 `npm install`（pi 1.3.0 作为
开发依赖被精确固定）以及 Node ≥ 22.19.0——这正是 pi 1.3 自身的要求。

## 模式

| `compaction` | 行为 |
|---|---|
| `"off"`（默认） | 笔记与工具照常，压缩完全保持原生 |
| `"board"` | **覆盖成立时**笔记即摘要；否则走原生并说明原因 |
| `"digest"` | 仅为迁移保留：不再镜像 digest，并会给出提示 |

`compactAssist` 现在**默认关闭**。开启后它会运行 pi 自己的摘要并追加笔记，且只用于**手动**
压缩且带自定义关注点的场景——这是确定性渲染唯一无法满足「按这个重点总结」的情况。

## 你会看到的循环

**1. 隐藏提醒搭在你下一条消息上**（`display: false`，界面不会变脏）。接近压缩阈值时只提
醒一次，且不带会过期的倒计时数字：

```
[session-blackboard checkpoint]
NEAR COMPACTION: pause task expansion and write important changes now.
Call blackboard action=review to inspect the complete candidates and receive a
content-bound credential; commit useful notes and explicitly confirm the reviewed
range. skip only discards the draft and does not confirm coverage.
```

**2. 代理审校并提交**，一次调用同时完成两件事：

```jsonc
{ "action": "commit",
  "entries": [
    { "section": "decisions", "text": "覆盖绑定 pi 的切点，而不是整条分支",
      "supersedes": "覆盖需要整条分支" }
  ],
  "review": { "id": "review-…", "constraintsChecked": true, "executionChecked": true, "goalChecked": true } }
```

- `review` 可选；普通提交只是记笔记，**不等于**声明这段范围已审校。
- 凭据由 `action: "review"` 发出，绑定到来源条目的内容指纹；一旦消息被 `/tree` 或
  `context_edit` 改写，凭据立即失效，必须重新审校。
- 每条笔记一行、内容完整——不会为了塞进预算而截断。放不进摘要预算的笔记会被当作
  **问题**报出来，而不是被悄悄缩短。

**3. 回执很小，且按条目 ID 说话**：

```
Committed v7.
m-4f2a9c1e5b7d@2 [decisions] 覆盖绑定 pi 的切点，而不是整条分支
Use blackboard show/recall or /bb; there is no default board file.
```

## 压缩策略

`"board"` 模式下 `session_before_compact` 只问一个问题：*笔记是否覆盖了这次准备真正丢弃
的条目？* 只有 `preparation.firstKeptEntryId` 之前的内容算数——保留尾部不需要重新总结。

| 情形 | 处理 |
|---|---|
| 覆盖成立且摘要放得下 | 笔记作为摘要返回，**零**摘要模型调用 |
| 有缺口、配额未用尽、余量可测 | 返回 `{ cancel: true }`，由**正在运行的这个回合**投递一次仅限记忆工具的补写请求（`agent_before_settle` + `continue`），绝不在钩子内部递归调用模型 |
| 有缺口、配额用尽 | 走原生摘要，并在界面、事件日志与诊断日志中写明原因 |
| 上下文已 overflow | 走原生——没有余量再做补写回合 |
| 手动压缩且带自定义关注点 | 若开启 `compactAssist`，用它满足关注点；否则确定性渲染 |
| 显式要求原生（`/bb native`） | 遵从一次，5 分钟 TTL 后自动清理 |
| 用户中断 | 不会偷偷续跑；已用掉的配额不退还，`/bb cancel-repair` 停止后续追问 |

补写配额是**每个压缩世代最多两次请求**，写在事件日志里。重启 pi、再次进入阈值检查、工具
调用失败都不会清零。只有请求真的到达 provider（`context` 事件）才记为「已送达」，所以
「我们发了」和「模型看到了」是两个不同状态。补写请求期间只有记忆工具可用，并在其后结束
该回合——这个边界是成本可控的原因。

## 命令与工具

| 入口 | 用途 |
|---|---|
| `blackboard` 工具 | `commit`、`review`、`retain`、`show`、`archive`、`skip` |
| `blackboard_recall` 工具 | 字面检索；`mode: current \| history \| session`、`limit`、`cursor` |
| `/bb` | `show [section] [limit] [offset]`、`show <ID>`、`review`、`commit <JSON>`、`retain <ID> <revision>`、`archive <ID>`、`skip`、`reset`、`migrate [apply]`、`export --format markdown [--output "路径"] [--overwrite]`、`native`、`cancel-repair`、`debug`、`off`、`on`、`status` |

`off` / `on` 是手动旋钮。它在本分支写入一条事件日志，因此不是进程内存：恢复或继续该会话时
重放分支就仍是禁用状态，`session_start` 会重新播报这个状态。关闭期间是完全关闭——两个工具退出
模型可见集合、不再抽取或注入笔记、压缩回退到 pi 原生摘要。`/bb` 本身仍然可用，所以 `/bb on`
和 `/bb status` 照常工作。旋钮只能把插件往关闭方向调，永远不会覆盖 `session-blackboard.enabled: false`。

两个方向都会先确认并说清代价：两个工具 schema 进出请求的工具块，而聊天模板把工具块渲染在
prompt 最前部，所以下一次请求会重新 prefill 整段上下文（会显示当前 token 数）。这是实测而非推断：
消息列表仍是纯追加时，仅工具集变化也会使 `cached_tokens = 0`。

因为历史里的工具调用还在，模型仍可能去调黑板工具。`/bb off` 后的第一个回合会带上一句短声明
——`[session-blackboard] Disabled on this branch; do not call its tools.`——，它是一条真实的
会话消息，且送达记录写进事件日志，因此不会重复：后续回合不会，恢复会话也不会。一次成功的
压缩会退役它，新一代只会再拿到一条。关闭期间，模型可见投影还会丢掉本插件自己的旧提示。
来自历史的误调会被阻断并给出原因，而不是执行。

分页是真实的：某一页没有命中时会明说「扫描尚未结束」并给出游标；只有扫描完成才允许说
「没有匹配」。游标绑定分支叶节点与笔记版本，分支变化会让游标失效，而不是悄悄返回旧行。
`history` 模式会显示被替换的版本及其状态——已失效的笔记不会伪装成当前事实。

## 数据布局与恢复

- **权威来源**：会话 JSONL 里的 `sbb-event` 自定义条目。它们挂在会话树上，所以 `/tree`、
  fork、clone、reset 继承的都是真实祖先，被放弃的分支不会污染当前摘要。
- **派生物**：每次读取都从事件重建投影，增量投影器复用未变化的前缀。磁盘上不写投影缓存，所以没有需要修复或需要信任的缓存。
- **仅显式**：Markdown。`/bb export` 写出可校验的快照，手工修改永不会被导回，也不会自动
  维护会话 Markdown 黑板。

恢复：缓存损坏或缺失会被忽略（状态从事件重放）；会话本身损坏时停止接管并报错，而不是写
一块空板；迁移中断可幂等重试，字节级备份始终保留。同一会话不允许两个 pi 进程同时写：第二
个直接被拒绝，而不是做「最后写覆盖」。

## 从 0.2 迁移

`/bb migrate` 是 dry run：列出文件、大小、哈希、候选条目和缺失的归档指针，**不写任何
东西**。`/bb migrate apply` 先把旧黑板、状态与归档复制到 `backups/<sid>/<hash>/` 并逐字节
校验，然后把内容作为 **legacy/unscoped、unknown** 笔记导入。

legacy 笔记**不是**当前事实：在审校前不进入摘要渲染；未知分节与散行会被原样保留，不会丢
弃。迁移之前 `/bb show` 会提示存在旧黑板且它不是权威来源。

回退：卸载（或固定版本）本包并重新启用 0.2；想留一份笔记副本就先
`/bb export --output <路径>`。v2 事件留在会话文件里，0.2 会忽略它们。这里不会升级你的全局
pi。

## 配置

`~/.pi/agent/settings.json`（用户）或 `.pi/settings.json`（项目，优先），键
`session-blackboard`：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 设为 `false` 同时把两个工具从模型工具集中移除并停止注入。运行时等价物是 `/bb off`，作用于分支且恢复会话后仍生效 |
| `compaction` | `"off"` | `off` / `board` / `digest`（仅迁移） |
| `checkpointTurns` | `1` | 提醒间隔（回合） |
| `contextPressure` | `false` | 在提醒里注入「距压缩还有多少上下文」的倒计时；默认关，因为这个数字不可执行 |
| `summaryMaxChars` | `6000` | 渲染摘要的精确字符上限 |
| `compactAssist` | `false` | 显式开启「原生摘要 + 笔记」（手动自定义关注点） |
| `compactAssistMaxChars` | `4000` | 追加笔记块的上限 |
| `compactionWarnTokens` | `32768` | 接近阈值的预警区间；`0` 关闭 |
| `draftOnCommit` | `"deterministic"` | 哪些机械草稿行随提交一起落盘 |
| `delivery` | `"next-turn"` | 提醒搭载下一个用户消息（`next-turn`）还是立即 steer |
| `maxEntriesPerSection` | `40` | 每分节条目预算，超出后确定性归档 |
| `maxEntryChars` | `300` | 单条提交笔记的字符上限 |
| `maxDraftLines` | `60` | 单次 checkpoint 渲染的草稿行上限 |
| `commitContextEntries` | `2` | 提交回执旁回显的已有条目数（`0` = 只回显新增） |
| `debugLog` | `false` | 在 `sbb-debug` 条目中记录原因与计数（从不记录原文） |
| `boardDir` | `<agentDir>/blackboard` | 写者锁与迁移备份的位置 |

已废弃的键（`mirrorToSession`、`seedFromPriorSummary`）会在每个会话提示一次，而不是悄悄
失效。

## 成本

- 普通回合：本扩展 **零** 模型调用，提醒搭载在已有请求上。
- 覆盖成立的压缩：**零** 摘要调用，无额外请求。
- 覆盖不成立的压缩：最多 **2** 次仅限记忆工具的额外请求，然后走原生。每次都被限制在记忆
  工具并结束该回合。
- 开启 `compactAssist`，或手动压缩带自定义关注点：**一次** 摘要调用（「assist」就是这个
  意思）。
- 检索、导出、审校：完全本地。

## 测试

```bash
npm run typecheck
npm test            # smoke + 事件日志 + 可靠性 + 导入 + 运行时 + 故障注入 + 平台
                    # + 真实 SDK 契约 + eval / long-eval / 基准边界闸门
npm run test:known  # 曾经的失败复现，保留作回归护栏
```

真实 SDK 测试把本仓库的 `src/index.ts` 装进 pi 1.3.0，模型用进程内固定流。这些测试里
`fetch` 会直接抛错，并断言从未被调用。CI 在 Linux 与 Windows、Node 22.19.0 与 24 上运行。

## 已知局限

- 确定性渲染不会重新叙事。没写下来的语气、保留余地、半成形推理都留不下来；保留尾部仍是
  原文，其余就看笔记里有什么。
- 覆盖是**结构性**的：它证明某段来源在某个内容指纹下被审校过，不证明笔记语义正确。
- 超出摘要预算的笔记必须由模型重写；一条超长的受保护笔记会一直阻止接管，直到它被缩短或
  保留资格到期。
- 手动压缩遇到缺口时这一版会退回原生：目前没有安全办法把补写回合交还给用户主动发起的
  压缩。
- 不做跨进程合并，第二个写者会被拒绝。
- `/bb off` 和 `/bb on` 各付一次全量重 prefill：工具块变了，而聊天模板把它渲染在 prompt 最前部。实测：两个方向都是 `cached_tokens = 0`。
- 旧归档可以被检索，但永远是 unscoped；不会去推断它们属于哪条分支。

- [契约差异：0.2 → 0.3](docs/CONTRACT.md)；`npm run release:check` 是一键本地检查入口。

## 许可

MIT。
