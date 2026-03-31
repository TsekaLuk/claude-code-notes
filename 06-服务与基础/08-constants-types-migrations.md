# 常量、类型与迁移 — Claude Code 源码分析

> 模块路径：`src/constants/`、`src/types/`、`src/migrations/`、`src/memdir/`
> 核心职责：定义全局常量与核心类型系统，管理配置迁移策略，提供持久化记忆目录操作
> 源码版本：v2.1.88

## 一、模块概述

这四个目录构成 Claude Code 的基础设施底层，各有明确职责：

**`src/constants/`**：运行时无副作用的纯常量，作为模块依赖图的叶节点（无 import 依赖），供所有其他层安全引用。

**`src/types/`**：纯类型定义文件，刻意分离到独立目录以打破循环依赖（如 `types/permissions.ts` 提供类型，`utils/permissions/` 提供实现）。

**`src/migrations/`**：一次性数据迁移脚本，将旧版本的用户配置（模型名、功能开关）升级为新格式。每个迁移函数幂等，应用启动时统一执行。

**`src/memdir/`**：管理 Claude Code 的持久化记忆目录系统（`~/.claude/projects/<slug>/memory/`），构建记忆提示文本，支持个人记忆、团队记忆、助手每日日志三种模式。

## 二、架构设计

### 2.1 核心类/接口/函数

| 名称 | 位置 | 类型 | 说明 |
|---|---|---|---|
| `getGrowthBookClientKey` | `constants/keys.ts` | 函数 | 按用户类型（ant/external）返回 GrowthBook 客户端 key |
| `SessionId` / `AgentId` | `types/ids.ts` | 品牌类型 | 防止会话 ID 与代理 ID 混用的编译期约束 |
| `PermissionMode` / `ToolPermissionContext` | `types/permissions.ts` | 类型 | 权限模式枚举与工具权限上下文的完整类型定义 |
| `migrateSonnet45ToSonnet46` | `migrations/` | 函数 | 将 Sonnet 4.5 固定版本号升级为 `sonnet` 别名 |
| `loadMemoryPrompt` | `memdir/memdir.ts` | async 函数 | 根据记忆配置构建注入系统提示的记忆指令文本 |
| `truncateEntrypointContent` | `memdir/memdir.ts` | 纯函数 | 截断 MEMORY.md 至行数/字节双上限 |

### 2.2 模块依赖关系图

```
src/constants/  ◄── 无依赖（叶节点）
    │
    ├── keys.ts ──────────────────────────────► services/analytics/growthbook.ts
    ├── oauth.ts ─────────────────────────────► services/oauth/client.ts
    ├── product.ts ───────────────────────────► bridge/sessionIdCompat.ts
    └── messages.ts（极简常量）

src/types/ ◄── 仅依赖 types/ 内部或 bun:bundle
    │
    ├── ids.ts ──────────────────────────────► bootstrap/state.ts (getSessionId)
    ├── permissions.ts ──────────────────────► utils/permissions/ (实现层)
    ├── hooks.ts ────────────────────────────► utils/hooks/ (执行层)
    └── plugin.ts / logs.ts / command.ts

src/migrations/ ◄── 依赖 utils/settings, utils/auth, services/analytics
    │
    └── 启动时由 setup.ts 统一调用，每个函数幂等

src/memdir/ ◄── 依赖 bootstrap/state, utils/settings, services/analytics
    │
    └── 系统提示构建时由 claudemd.ts 调用 loadMemoryPrompt()
```

### 2.3 关键数据流

**迁移执行流程**：
```
应用启动 setup.ts
    │
    ▼
migrateAutoUpdatesToSettings()
    │  检查 globalConfig.autoUpdates === false
    │  若是且非 native 保护 → 写入 userSettings.env.DISABLE_AUTOUPDATER
    │  → saveGlobalConfig（移除 autoUpdates 字段）
    │
▼
migrateSonnet45ToSonnet46()
    │  仅限 firstParty 且 Pro/Max/Team Premium 用户
    │  检查 userSettings.model 是否为 4.5 固定版本字符串
    │  若是 → 更新为 'sonnet'（或 'sonnet[1m]'）
    │  → 若 numStartups > 1 → saveGlobalConfig（记录迁移时间戳）
    │
▼
...（其他 8 个迁移函数）
```

**记忆提示加载流程**：
```
系统提示构建
    │
    ▼
loadMemoryPrompt()
    │
    ├─[KAIROS + autoEnabled]─► buildAssistantDailyLogPrompt()（每日日志模式）
    │
    ├─[TEAMMEM enabled]──────► buildCombinedMemoryPrompt()（个人+团队）
    │
    ├─[autoEnabled]──────────► buildMemoryLines('auto memory', autoDir)
    │         │                    │
    │         │                ensureMemoryDirExists(autoDir)
    │         │
    │         └─► loadMemoryPrompt 返回拼接文本（注入系统提示）
    │
    └─[disabled]─────────────► logEvent('tengu_memdir_disabled')
                                return null
```

## 三、核心实现走读

### 3.1 关键流程

1. **品牌类型（Branded Types）**：`SessionId = string & { readonly __brand: 'SessionId' }` 通过交叉类型在 TypeScript 类型系统中创建「不透明类型」。普通 string 无法直接赋给 `SessionId`，必须通过 `asSessionId(id)` 显式转换。这防止在有多种 ID 类型（SessionId / AgentId）的系统中混用，编译期即可发现错误。

2. **权限模式的内部/外部区分**：`EXTERNAL_PERMISSION_MODES`（5 种：acceptEdits、bypassPermissions、default、dontAsk、plan）是用户可配置的外部模式；`InternalPermissionMode` 额外包含 `auto`（自动模式分类器）和 `bubble`（弹出请求）。CCR 同步和 SDK 暴露只使用外部模式，内部模式对外不可见。

3. **迁移函数的幂等设计**：以 `migrateSonnet45ToSonnet46` 为例，开头有多重 guard clause：先检查 API 提供器是否为 firstParty、再检查订阅层级、最后检查 model 字符串是否匹配旧值，任一不满足即 `return`。重复执行时，第一次已将 model 改为 `sonnet`，第二次检查旧值不匹配，直接返回，不重复写入。

4. **记忆内容的双重截断（行数 + 字节）**：`truncateEntrypointContent` 先按 `MAX_ENTRYPOINT_LINES`（200 行）截断，再按 `MAX_ENTRYPOINT_BYTES`（25,000 字节）截断。行截断在前，因为行是自然语义边界；字节截断在后，处理极长的单行（如 URL 列表）。截断时寻找最后一个换行符以避免切断 Markdown 行。超出时附加警告信息说明截断原因。

5. **功能开关控制的记忆模式路由**：`loadMemoryPrompt` 的路由逻辑被 `bun:bundle` 的 `feature('KAIROS')` 和 `feature('TEAMMEM')` 门控。这些功能门控在编译时由构建系统解析，未开启的功能分支在外部构建中被 tree-shake 掉，确保功能代码不出现在外部发布包中。

### 3.2 重要源码片段

**`types/ids.ts` — 品牌类型防止 ID 混用**
```typescript
// src/types/ids.ts
export type SessionId = string & { readonly __brand: 'SessionId' }
export type AgentId = string & { readonly __brand: 'AgentId' }

// 验证格式：a + 可选标签 + 16 位十六进制
const AGENT_ID_PATTERN = /^a(?:.+-)?[0-9a-f]{16}$/
export function toAgentId(s: string): AgentId | null {
  return AGENT_ID_PATTERN.test(s) ? (s as AgentId) : null
}
```

**`types/permissions.ts` — 内部/外部权限模式枚举**
```typescript
// src/types/permissions.ts
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan',
] as const

// auto 模式仅在 TRANSCRIPT_CLASSIFIER 功能开启时可用
export const INTERNAL_PERMISSION_MODES = [
  ...EXTERNAL_PERMISSION_MODES,
  ...(feature('TRANSCRIPT_CLASSIFIER') ? ['auto'] as const : [] as const),
] as const satisfies readonly PermissionMode[]
```

**`migrations/migrateSonnet45ToSonnet46.ts` — 幂等迁移模式**
```typescript
// src/migrations/migrateSonnet45ToSonnet46.ts
export function migrateSonnet45ToSonnet46(): void {
  if (getAPIProvider() !== 'firstParty') return  // Guard: 仅限直连
  if (!isProSubscriber() && !isMaxSubscriber() && !isTeamPremiumSubscriber()) return

  const model = getSettingsForSource('userSettings')?.model
  // 匹配 4 种可能的旧版本字符串（含 1m 扩展上下文变体）
  if (model !== 'claude-sonnet-4-5-20250929' && model !== 'claude-sonnet-4-5-20250929[1m]'
    && model !== 'sonnet-4-5-20250929' && model !== 'sonnet-4-5-20250929[1m]') return

  const has1m = model.endsWith('[1m]')
  updateSettingsForSource('userSettings', { model: has1m ? 'sonnet[1m]' : 'sonnet' })
  // 仅老用户记录迁移时间戳（首次启动用户跳过通知）
  if (getGlobalConfig().numStartups > 1) {
    saveGlobalConfig(current => ({ ...current, sonnet45To46MigrationTimestamp: Date.now() }))
  }
}
```

**`memdir/memdir.ts` — MEMORY.md 双重截断逻辑**
```typescript
// src/memdir/memdir.ts
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const contentLines = raw.trim().split('\n')
  const wasLineTruncated = contentLines.length > MAX_ENTRYPOINT_LINES  // 200 行

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : raw.trim()

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {  // 25,000 字节
    // 在字节上限处找最后一个换行符，避免切断 Markdown 行
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  return { content: truncated + warningMessage, /* ... */ }
}
```

### 3.3 设计模式分析

- **品牌类型（Phantom Types）**：`SessionId`、`AgentId` 使用 TypeScript 的交叉类型技巧，在编译期区分相同运行时类型（string）的不同语义，零运行时开销，实现「类型即文档」。
- **命令模式（迁移脚本）**：每个迁移函数是一个独立的「命令对象」，有自己的 guard clause 和幂等保证。`setup.ts` 作为「调用者」按序执行，新迁移只需添加新函数，不修改现有逻辑。
- **策略路由模式**：`loadMemoryPrompt` 根据功能开关和用户配置路由到不同的记忆构建策略（KAIROS 日志模式/团队模式/个人模式），每个策略封装为独立的构建函数。
- **守护子句（Guard Clause）**：迁移函数和 `loadMemoryPrompt` 都大量使用早期 `return`，将正常路径（happy path）保持在最小缩进层级，异常/不匹配条件在前面过滤，提高可读性。

## 四、高频面试 Q&A

### 设计决策题

**Q1：为什么将类型定义单独放到 `src/types/` 而不是与实现代码放在一起？**

> 核心原因是打破循环依赖。`types/permissions.ts` 定义了 `PermissionMode`、`ToolPermissionContext` 等类型，被 `utils/permissions/`（实现层）、`state/AppStateStore.ts`（状态层）、`Tool.ts`（工具基类）同时引用。如果类型定义放在 `utils/permissions/` 下，`state/` 需要从 `utils/permissions/` import，而 `utils/permissions/` 的实现可能又需要从 `state/` 读取状态，形成循环。独立的 `types/` 目录是无依赖的叶节点，任何层都可以安全引用，打断循环。

**Q2：迁移函数为什么不使用版本号控制（如「已运行过迁移 v3」），而是每次都检查数据状态？**

> 版本号方案需要维护已执行迁移的持久化列表，增加了状态管理的复杂性（哪个文件存储？如何处理损坏？）。数据状态检查方案更健壮：即使用户手动修改了配置，或在不同机器间同步了 settings 文件，迁移函数依然能正确判断是否需要执行。幂等设计使得多次运行安全无害，不依赖历史执行记录。

### 原理分析题

**Q3：`feature('KAIROS')` 和 `feature('TEAMMEM')` 的门控如何影响最终包的体积？**

> `bun:bundle` 的 `feature()` 是编译期宏，Bun 构建系统在打包时将未启用的功能替换为 `false`（类似 `#ifdef`），随后死代码消除（DCE）移除永远不执行的分支。外部用户构建中 `feature('TEAMMEM')` 为 false，团队记忆的所有代码（`teamMemPaths.ts`、`teamMemPrompts.ts`）被 tree-shake，不出现在发布包中，既减小体积又确保内部功能不泄漏。

**Q4：`MAX_ENTRYPOINT_LINES = 200` 和 `MAX_ENTRYPOINT_BYTES = 25_000` 这两个上限是如何确定的？**

> 注释说明：200 行 × ~125 字节/行 ≈ 25KB，这是「p97」用户的内存文件大小——97% 的用户内存文件不超过这个大小，因此截断不影响大多数用户。字节限制（25KB）是作为对行限制的补充，专门处理极长行的情况（观测到的 p100 是 197KB，均在 200 行以内，意味着有些行特别长）。两个上限的组合确保无论哪种异常情况（行太多 or 行太长），都能有效限制注入系统提示的内容大小，避免挤占 Claude 处理实际问题的上下文空间。

**Q5：`migrateAutoUpdatesToSettings` 中为什么要同时设置 `process.env.DISABLE_AUTOUPDATER = '1'`？**

> 设置环境变量是为了「立即生效」。`updateSettingsForSource` 将配置写入 `settings.json`，但在当前会话中，`process.env` 已经被应用启动时的配置快照填充。如果只写文件，本次会话的自动更新检查逻辑仍会读取旧的 `process.env.DISABLE_AUTOUPDATER`（未设置），导致本次启动仍然触发更新检查。通过同时设置 `process.env`，迁移立即对当前进程生效，下次启动则从 `settings.json` 中读取。

### 权衡与优化题

**Q6：`MEMORY.md` 的截断是优先截断行还是字节？为什么这个顺序？**

> 先截断行（200 行），再截断字节（25KB）。行是 Markdown 文档的自然语义边界，行截断不会产生半行的损坏内容；字节截断是第二道防线，处理单行内容过长的情况（如一行包含超长 URL 列表）。如果先截字节，可能在某行中间截断，产生半行的 Markdown（如截断 `[Title](url`，破坏链接语法），增加模型理解难度。注释中 `cutAt = lastIndexOf('\n')` 也是在字节截断时寻找安全的换行位置。

**Q7：`agentId` 的格式 `a(?:.+-)?[0-9a-f]{16}` 为什么有可选的标签部分？**

> 标签部分（`.+-` 匹配一个非空标签后跟连字符）是为了可读性调试。在 agent swarm 场景下，多个子代理同时运行，纯十六进制 ID 不易区分。带标签的 ID（如 `a-research-1a2b3c4d5e6f7890`）在日志中直观表明该代理的角色。`toAgentId` 同时接受有标签和无标签两种格式，向后兼容早期只生成 `a[16hex]` 的代码。

### 实战应用题

**Q8：如何为新上线的模型添加一个版本升级迁移脚本？**

> 参照 `migrateSonnet45ToSonnet46.ts` 的模式：1) 创建 `migrations/migrateXxxToYyy.ts`；2) Guard clauses 检查：提供器类型（firstParty/3P）、用户订阅层级（若有限制）、当前 model 字符串是否匹配旧版本；3) 调用 `updateSettingsForSource('userSettings', { model: newAlias })`；4) 可选：通过 `saveGlobalConfig` 记录迁移时间戳供 UI 显示迁移通知；5) 在 `setup.ts` 的迁移调用序列中添加新函数（注意顺序，避免迁移间的依赖冲突）；6) 发布前确认函数幂等——已升级的用户再次运行时应直接 return。

**Q9：如何扩展记忆系统支持「项目级」记忆（区别于用户级记忆）？**

> 当前 `loadMemoryPrompt` 支持「auto memory」（用户级，路径 `~/.claude/projects/<slug>/memory/`）和「team memory」。新增项目级记忆：1) 在 `memdir/paths.ts` 添加 `getProjectMemPath()` 返回项目根目录下的 `.claude/memory/`；2) 在 `memdir/memdir.ts` 的 `loadMemoryPrompt` 路由逻辑中添加新分支（需在 autoEnabled 之前检查，因为项目记忆优先级更高）；3) 调用 `ensureMemoryDirExists(projectMemDir)` 确保目录存在；4) 复用 `buildMemoryLines('project memory', projectMemDir)` 构建提示文本；5) 在 `isAutoMemoryEnabled` 类似的地方添加 `isProjectMemoryEnabled` 开关，支持用户在 settings 中控制。

---
> **版权声明**：源码版权归 [Anthropic](https://www.anthropic.com) 所有，本文档基于 Claude Code v2.1.88 source map 还原版本分析，仅供学习研究使用。文档内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议。
