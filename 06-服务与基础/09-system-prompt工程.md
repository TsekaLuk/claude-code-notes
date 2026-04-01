# System Prompt 工程 — Claude Code 源码分析

> 模块路径：`src/constants/prompts.ts`、`src/constants/systemPromptSections.ts`、`src/context.ts`
> 核心职责：动态组装每轮对话的完整上下文，实现 Context Engineering
> 源码版本：v2.1.88

## 一、模块概述

Claude Code 的系统提示不是一个静态字符串，而是在每次 API 调用前动态组装的**结构化文档**。其核心挑战是：

1. **缓存最大化**：Anthropic API 的 prompt caching 按前缀匹配，相同前缀越长，缓存命中率越高，成本越低
2. **动态性需求**：每个会话、每次对话都有独特的上下文（CLAUDE.md 内容、Git 状态、MCP 服务器列表）
3. **工程约束**：LLM 有已知的行为偏差（过度设计、从单次批准泛化），需通过 prompt 工程加以对抗

解决方案是**分段缓存架构**：用一个边界标记将 prompt 分为可缓存的静态区域和不可缓存的动态区域，二者服务于不同目标，统一组装为最终上下文。

---

## 二、架构设计

### 2.1 分段缓存架构：Prompt 级别的 Memoization

系统提示在源码中是 `string[]` 数组，每个元素是一个独立"段落"（可理解为一个缓存单元）。Anthropic API 在接收到 `system` 参数时，将所有段落拼接后，对**最长匹配前缀**应用缓存。

```
system: [
  { text: "段落 A：角色定义", cache_control: { type: "ephemeral" } },  // 全局缓存
  { text: "段落 B：工具使用规则",  cache_control: { type: "ephemeral" } }, // 全局缓存
  // ↑ SYSTEM_PROMPT_DYNAMIC_BOUNDARY 边界
  { text: "段落 C：CLAUDE.md 内容（会话特定）" },   // 动态区域，不跨用户缓存
  { text: "段落 D：Git 状态（会话特定）" },          // 动态区域，不跨用户缓存
]
```

**边界的意义**：`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 常量标记了"从此处开始动态"的分割点。边界之前的所有段落带 `scope: 'global'`，在所有用户的第一轮对话中命中同一份缓存前缀，直接降低首次响应的 API 成本和延迟。

### 2.2 静态区域 vs 动态区域

```
┌────────────────────────────────────────────────────────┐
│  静态区域（Static Sections）                            │
│  ──────────────────────────────────────────────────── │
│  • 角色定义（"You are Claude Code..."）                 │
│  • 工具使用优先级原则（Read/Edit/Glob/Bash 优先级）     │
│  • Doing Tasks 规范（最小化原则）                       │
│  • Actions 授权规则（非传递性授权）                     │
│  • 内部用户额外指令（Anthropic 员工可见）               │
│                                                         │
│  特征：跨所有会话共享 → scope: 'global' 缓存            │
└────────────────────────┬───────────────────────────────┘
                         │
              SYSTEM_PROMPT_DYNAMIC_BOUNDARY
                         │
┌────────────────────────▼───────────────────────────────┐
│  动态区域（Dynamic Sections）                           │
│  ──────────────────────────────────────────────────── │
│  • CLAUDE.md 内容（层级发现，会话特定）                 │
│  • Git 状态（分支/状态/commits/用户名）                 │
│  • MCP 服务器指令（增量注入）                           │
│  • 记忆提示词（loadMemoryPrompt 结果）                  │
│                                                         │
│  特征：每个会话不同 → 无法跨用户缓存                    │
└────────────────────────────────────────────────────────┘
```

### 2.3 模块依赖关系图

```
src/constants/prompts.ts
    │  定义所有静态 prompt 段落文本
    │
    ├──► src/constants/systemPromptSections.ts
    │       定义 SYSTEM_PROMPT_DYNAMIC_BOUNDARY、段落枚举
    │
src/context.ts
    │  运行时组装：staticSections + dynamicSections
    │
    ├──► src/claudemd.ts          CLAUDE.md 层级发现 + 缓存
    ├──► src/utils/git.ts         Git 状态并行获取
    ├──► src/services/mcp/        MCP 指令增量注入
    └──► src/memdir/memdir.ts     记忆提示词加载

QueryEngine.fetchSystemPromptParts()
    │  调用 context.ts 完成组装
    └──► 最终传入 query() → Anthropic API
```

---

## 三、核心实现走读

### 3.1 SYSTEM_PROMPT_DYNAMIC_BOUNDARY 的缓存边界设计

```typescript
// src/constants/systemPromptSections.ts
// 这个常量是一个空字符串哨兵，在 prompt 数组中作为边界标记
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__DYNAMIC_BOUNDARY__' as const

// src/context.ts  ── 组装时按边界拆分为两段，分别设置 cache_control
function buildSystemPromptBlocks(sections: string[]): SystemPromptBlock[] {
  const boundaryIdx = sections.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)

  // 边界前：scope: 'global'，命中跨用户缓存
  const staticBlocks = sections.slice(0, boundaryIdx).map(text => ({
    type: 'text' as const,
    text,
    cache_control: { type: 'ephemeral', scope: 'global' },
  }))

  // 边界后：无 cache_control，不参与全局缓存
  const dynamicBlocks = sections.slice(boundaryIdx + 1).map(text => ({
    type: 'text' as const,
    text,
  }))

  return [...staticBlocks, ...dynamicBlocks]
}
```

**为何不对整个 prompt 设置全局缓存**：动态区域每个会话不同，强行设置 `scope: 'global'` 会导致缓存 key 在每个会话都不同（因为 CLAUDE.md 内容、Git 状态已经改变了前缀），缓存命中率趋近于零，反而增加了序列化和 key 比较的开销。

### 3.2 静态区域：agent 的"宪法"中的关键设计决策

**最小化原则（Doing Tasks 段落）**

静态区域包含多条反复强调"不要过度"的规则，例如：

```
// src/constants/prompts.ts （原文节选）
"Do not add code that is not needed for the current task."
"Do not add files that weren't requested."
"Three similar lines of code is better than a premature abstraction."
"Do not add comments unless they are needed for clarity."
```

这不是风格偏好，而是对 LLM 已知行为偏差的工程化对策：语言模型在「完成任务」时有强烈倾向添加「可能有用」的额外代码、注释、文件。这些规则通过权威语气的重复强调，在模型的上下文中形成抑制信号。

**授权非传递性（Actions 段落）**

```
// src/constants/prompts.ts （原文节选）
"A user approving an action once does NOT mean that they approve
 it in all contexts or in all future uses of this tool."
```

这条规则针对模型的过度泛化倾向：如果用户曾经批准过一次 `rm -rf` 操作，模型不应该在后续类似情境中假设「用户会批准」。授权是具体的、不可传递的。

**内部/外部差异化**

```typescript
// src/constants/prompts.ts
// 仅 Anthropic 内部用户（firstParty）可见的额外段落
const INTERNAL_ONLY_SECTIONS = feature('INTERNAL_PROMPTS') ? [
  "When adding comments to code, prefer to explain WHY rather than WHAT.",
  "Always honestly report the status of completed tasks.",
  // ... 针对内部评估中发现的 29-30% 虚假声明率的对策
] : []
```

内部用户看到更严格的注释规范和诚实报告要求，这是对 Capybara v8 评估中发现的问题的针对性修复，不对外暴露。

### 3.3 DANGEROUS_uncachedSystemPromptSection：代码即文档

```typescript
// src/constants/systemPromptSections.ts
// 函数签名本身就是审查机制：调用者必须提供 _reason 解释为什么破坏缓存
export function DANGEROUS_uncachedSystemPromptSection(
  content: string,
  _reason: string,  // 强制要求解释，_前缀表示运行时不使用，仅作文档
): string {
  // 返回不带 cache_control 的纯字符串，放置在动态区域
  return content
}
```

这个设计模式的精妙之处：`_reason` 参数在运行时被忽略（以 `_` 开头），但在代码审查时，任何调用此函数的代码都必须提供一个字符串来解释「为什么此处不能缓存」。这将架构决策的文档负担转移到了调用方，确保每一处绕过缓存的行为都有明确记录。

### 3.4 CLAUDE.md 的层级发现与缓存

CLAUDE.md 的发现是一个目录向上遍历过程：

```
项目根目录/
    CLAUDE.md          ← 第一层（最接近项目的配置）
    src/
        CLAUDE.md      ← 第二层（子目录配置）
        components/
            CLAUDE.md  ← 第三层（组件级配置）

~/.claude/CLAUDE.md    ← 用户全局配置（始终包含）
```

```typescript
// src/claudemd.ts （简化）
async function discoverClaudeMds(cwd: string): Promise<string[]> {
  const results: string[] = []

  // 从当前目录向上遍历到文件系统根目录
  let dir = cwd
  while (dir !== path.dirname(dir)) {
    const candidatePath = path.join(dir, 'CLAUDE.md')
    if (await fs.exists(candidatePath)) {
      results.unshift(await fs.readFile(candidatePath, 'utf8'))  // 前置：父级优先
    }
    dir = path.dirname(dir)
  }

  return results
}
```

**--bare 模式与 --add-dir 的交互**：`--bare` 模式跳过自动 CLAUDE.md 发现（避免意外读取文件系统），但仍尊重 `--add-dir` 显式指定的目录，确保脚本化调用的可预期性。

**CLAUDE.md 的双重用途**：发现的内容不仅注入动态区域，还被缓存到 `bootstrap/state.ts` 的 `cachedClaudeMdContent`，供 `auto` 模式分类器（yoloClassifier）读取。这打破了潜在循环依赖：`yoloClassifier → claudemd → filesystem` 如果实时读取，可能触发权限检查，而权限检查又依赖 yoloClassifier 的分类结果。缓存打断了这个环。

### 3.5 Git 状态注入的工程细节

```typescript
// src/context.ts （简化）
async function getGitContext(cwd: string): Promise<string> {
  // 并行获取 5 项 Git 信息，避免串行等待
  const [branch, status, recentCommits, username, remoteUrl] = await Promise.allSettled([
    getCurrentBranch(cwd),
    getGitStatus(cwd),
    getRecentCommits(cwd, 5),
    getGitUsername(cwd),
    getRemoteUrl(cwd),
  ])

  const statusText = status.status === 'fulfilled' ? status.value : ''

  // status 超过 2000 字符时截断，提示用 BashTool 获取完整信息
  // 原因：大型仓库的 git status 可能有数千行修改文件，直接注入会消耗大量 token
  const truncatedStatus = statusText.length > 2000
    ? statusText.slice(0, 2000) + '\n... (truncated, use BashTool for full status)'
    : statusText

  return buildGitContextString({ branch, status: truncatedStatus, recentCommits, username })
}
```

**并行获取的理由**：5 个 Git 命令各自独立（`git branch`、`git status`、`git log` 等），串行执行会叠加每个命令的 I/O 等待时间（通常 50-200ms 每个），并行后总时间约等于最慢的单个命令。

**截断阈值 2000 字符**：这是经验值，在「提供足够上下文让模型理解工作状态」和「避免大型仓库的 diff 列表挤占有效上下文」之间的折中。截断后附加提示文本指向 BashTool，确保模型知道如何获取完整信息。

### 3.6 MCP 指令增量注入

```typescript
// src/context.ts
// isMcpInstructionsDeltaEnabled：只在 MCP 服务器集合发生变化时重新构建注入文本
// 原因：MCP 服务器列表在会话中通常稳定，每轮重新序列化会破坏动态区域的局部缓存
if (isMcpInstructionsDeltaEnabled() && !mcpServersChanged(prevMcpClients, mcpClients)) {
  return cachedMcpInstructions  // 命中缓存，直接复用
}

const mcpInstructions = buildMcpInstructions(mcpClients)
cacheMcpInstructions(mcpInstructions)
return mcpInstructions
```

**工具优先级指导原则**（静态区域中明确声明）：

| 优先使用 | 不推荐 | 原因 |
|---------|--------|------|
| Read tool | `cat` via Bash | 专用工具内置权限检查，路径规范化 |
| Edit tool | `sed` via Bash | Edit 有原子性保证，失败时不损坏文件 |
| Glob tool | `find` via Bash | Glob 有 .gitignore 感知，结果更精确 |
| Bash tool | — | 通用工具，权限检查路径更复杂 |

这条原则被显式写入静态区域，是因为 LLM 在训练数据中大量见到 `cat`/`sed`/`find`，需要显式覆盖默认倾向。

---

## 四、高频面试 Q&A

### 设计决策题

**Q1：为什么系统提示是 `string[]` 数组而不是单个字符串？**

> Anthropic API 的 `system` 参数接受对象数组，每个对象可以独立设置 `cache_control`。如果用单字符串，就无法对"边界前"和"边界后"分别设置不同的缓存策略。数组格式让每个段落成为独立的缓存单元：静态段落带 `scope: 'global'` 共享全局缓存，动态段落不带 `cache_control` 以确保每次都带最新内容。这是一种 Prompt 级别的 Memoization，与函数级别的 Memoization 逻辑相同，只是作用域是 API 调用的前缀。

**Q2：内部用户和外部用户看到不同 prompt 的设计，从工程角度有什么风险？它是如何被管理的？**

> 主要风险是"内部评估的模型行为与外部部署的模型行为不一致"——如果内部 prompt 使模型表现更好（更诚实、更谨慎），而外部 prompt 没有这些约束，那么内部的质量指标就无法代表用户实际体验。风险管理方式：内部额外指令通过 `feature('INTERNAL_PROMPTS')` 编译时门控，在外部发布包中完全不存在（tree-shake 掉），而非运行时分支判断，避免外部用户通过某种手段启用内部模式。内部评估时明确标记为「内部条件」，不与外部基准混用。

### 原理分析题

**Q3：`scope: 'global'` 缓存在 Anthropic API 中具体如何工作？它为什么能降低首次响应延迟？**

> Anthropic 的 prompt caching 基于**最长公共前缀**：API 服务器在接收到请求后，将 system prompt 的字节序列与缓存中存储的前缀进行比较。带 `scope: 'global'` 且 `cache_control: { type: 'ephemeral' }` 的段落，其缓存 key 是内容的哈希，与具体用户无关——所有用户的请求如果包含相同的静态前缀，都命中同一份 KV 缓存。这意味着模型无需重新处理静态区域（角色定义、规则集等，可能占 prompt 总 token 的 70% 以上），只处理动态区域（会话特定上下文）。首次响应延迟降低，是因为缓存命中后，静态区域对应的 prefill 计算被跳过，直接从缓存的 KV state 开始续算。

**Q4：Git 状态截断的 2000 字符阈值，如果设置得太小或太大各有什么影响？**

> 太小（如 500 字符）：中型项目（30+ 文件修改）的 git status 会大量截断，模型看到的文件列表不完整，可能错误判断「哪些文件已被修改」，导致重复修改或遗漏。太大（如 20,000 字符）：大型仓库 monorepo 中的暂存区可能有数千个文件，全量注入会消耗 5,000-10,000 token，挤压模型处理用户实际问题的有效上下文。2000 字符覆盖了大多数单项目工作（通常 10-20 个文件的修改），对超出情况则通过提示文本告知模型使用 BashTool 获取完整信息，这是"降级优雅"设计——功能不消失，只是换了获取方式。

**Q5：CLAUDE.md 层级发现时，父目录 vs 子目录的内容谁优先级更高？为什么？**

> 子目录（更靠近代码）的 CLAUDE.md 优先级更高，在 prompt 中排在后面（后面的内容会覆盖前面的指令）。原因：层级越深，配置越具体，具体配置应该覆盖通用配置。例如，全局 `~/.claude/CLAUDE.md` 说「使用 4 空格缩进」，项目根 `CLAUDE.md` 说「使用 2 空格缩进」，组件目录 `CLAUDE.md` 说「使用 Tailwind CSS」——模型应该遵循最具体的配置。这与大多数配置系统（ESLint、tsconfig）的覆盖方向一致。

### 权衡与优化题

**Q6：`DANGEROUS_uncachedSystemPromptSection` 函数名以 DANGEROUS 开头是什么设计哲学？**

> 这是"命名作为安全机制"的设计哲学，也称为 **Pit of Success**（成功陷阱的反面）——让正确的事情简单，让危险的事情有明显摩擦感。正常的 prompt 段落直接添加到静态区域即可，无需调用任何特殊函数；只有需要绕过缓存的情况才调用这个名字显眼的函数，并且必须提供 `_reason` 参数。`DANGEROUS` 前缀会在代码审查中立即引起注意，任何调用此函数的 PR 都会被质疑"是否真的有必要"。这比注释更有效，因为注释可以被忽视，但函数名在调用点始终可见。

**Q7：MCP 指令增量注入（`isMcpInstructionsDeltaEnabled`）的性能意义是什么？**

> MCP 指令通常包含每个 MCP 服务器的工具描述、使用说明，可能占 2,000-8,000 token。如果每次 API 调用都重新序列化这部分内容（即使服务器列表没有变化），动态区域的内容就会"变化"（即使实际内容相同，新字符串对象也会破坏某些缓存检查），导致动态区域的下游缓存失效。增量注入通过引用相等性检查（`mcpServersChanged`），在服务器列表未变化时复用同一字符串对象，保持动态区域内 MCP 段落的局部稳定性，减少不必要的 token 重传。

### 实战应用题

**Q8：如果要为企业用户添加一段"公司安全策略"的 prompt，应该放在静态区域还是动态区域？**

> 取决于策略内容是否因用户/组织而异。如果所有企业用户共享相同的策略文本（如「不得输出包含 PII 的内容」），应放在静态区域并设置 `scope: 'global'`，享受跨用户缓存收益。如果策略包含组织特定内容（如「${公司名}的数据分类标准是...」），则必须放在动态区域，否则不同公司的请求会错误地命中彼此的缓存。实现上，在 `fetchSystemPromptParts()` 中根据用户 tenant 信息，将企业策略段落插入到 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 之前（静态）或之后（动态）即可。

**Q9：如何调试「系统提示组装后 token 超出预期」的问题？**

> 排查路径：1) 在 `buildSystemPromptBlocks()` 出口处添加日志，打印每个段落的名称和字符数，找出"意外大"的段落；2) 检查 CLAUDE.md 发现结果——项目中是否存在超大的 CLAUDE.md（常见：将 API 文档直接粘贴进去）；3) 检查 Git status 是否命中截断（`status.length > 2000`），如果未截断但 monorepo 有大量修改文件则需降低阈值；4) 检查 MCP 指令——注册了过多工具的 MCP 服务器可能贡献数千 token；5) 使用 `countTokens()` 工具函数（`src/utils/tokens.ts`）对每个段落独立计数，可精确定位。

---

> 源码版权归 [Anthropic](https://www.anthropic.com) 所有，本笔记仅供学习研究使用。文档内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议。
