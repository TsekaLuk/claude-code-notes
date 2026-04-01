# Fork 子 Agent 与提示词缓存优化 — Claude Code 源码分析

> 模块路径：`src/tools/AgentTool/fork.ts`、`src/constants/prompts.ts`
> 核心职责：通过 Fork 机制最大化提示词缓存命中率，降低多 Agent 场景下的 API 成本
> 源码版本：v2.1.88

---

## 一、模块概述

Fork Subagent 是 Claude Code 多 Agent 系统中一种特殊的并行化机制。与普通的 `AgentTool` 启动独立子 Agent 不同，`fork` 从父 Agent 的当前执行上下文中"分叉"出多个子 Agent——每个子 Agent 继承父 Agent 的完整对话历史，但接受不同的独立任务指令。

Fork 机制存在的核心动机不是功能扩展，而是**成本优化**：在 Anthropic API 的提示词缓存（prompt cache）机制下，如果多个 API 请求共享相同的前缀，只需支付一次 cache write 费用，后续命中只需 cache read 费用（约为全量输入 token 价格的 1/10）。Fork 的整体架构设计就是围绕这一特性展开的——通过刻意让多个并行子 Agent 的消息前缀完全相同，将缓存命中率推向理论上的最大值。

在 Claude Code 的实验性功能列表中，Fork 被标注为"最复杂的优化"之一，原因在于它同时涉及三个相互交织的工程难题：如何在不破坏 LLM 推理连贯性的前提下构造缓存友好的消息结构，如何防止子 Agent 递归地再次发起 fork，以及如何对抗子 Agent 从父 Agent 继承的 system prompt 所带来的行为干扰。

---

## 二、架构设计

### 2.1 Prompt Cache 的工作原理

Anthropic API 的提示词缓存工作在"前缀匹配"的原则下。当一次 API 请求被处理时，服务端会检查请求的 `messages` 数组是否与已缓存的前缀完全相同（逐 token 比对）。若匹配，缓存前缀部分的 token 按 cache read 价格计费（约为标准输入价格的 10%）；若未匹配但请求本身携带了 `cache_control: {type: "ephemeral"}` 标记，服务端会写入新缓存（cache write，约为标准价格的 125%，但后续命中可大幅节约）。

关键约束：**前缀的任何一个字节改变都会导致缓存失效**，后续 token 全部重新计费。这意味着如果两个 API 请求的消息数组中，第 N 条消息存在差异，那么从第 N 条消息起的所有 token 都无法命中缓存。

对于 fork 并行场景而言，天然的挑战是：每个子 Agent 需要接受"不同的任务指令"，这意味着消息内容必然存在差异，缓存前缀也因此缩短。Fork 机制的设计目标，就是通过精心的消息结构设计，将这个"差异点"尽量推到消息数组的末尾，使差异点之前的所有 token 可以完整命中缓存。

### 2.2 Fork 的核心思路：最大化前缀相同率

Fork 子 Agent 的消息构建分为三个层次：

**第一层：保留父 Agent 的完整 assistant message**

父 Agent 在发起 fork 之前已经执行了若干轮工具调用。这些历史消息（包括 `assistant` 消息中的所有 `tool_use` blocks）被原封不动地保留在每个 fork 子 Agent 的 `messages` 数组中。所有 fork 子 Agent 共享这段完全相同的前缀，这部分 token 在所有并行 API 请求中命中同一个缓存。

**第二层：为每个 tool_use 生成相同的占位 tool_result**

父 Agent assistant message 中包含多个 `tool_use` 块（每个块对应一个任务分支）。Fork 机制为每个 `tool_use` 生成一个**内容相同**的占位 `tool_result`——不是真实的执行结果，而是一个"acknowledgement"占位符，使消息结构保持合法（`tool_result` 必须紧跟对应的 `tool_use`，API 才接受该消息）。

这个设计的巧妙之处在于：占位内容对所有 fork 子 Agent 一致，所以这一层消息仍然 100% 命中缓存。

**第三层：追加 per-child 指令文本块**

唯一因子 Agent 不同而差异的内容是最后追加的"任务指令"文本块（`<fork-boilerplate>` 包裹的纯文本）。这个文本块明确告知当前子 Agent 它的具体任务、身份以及需要忽略继承 system prompt 中的 fork 默认行为。

**结果：只有最后一个文本块因 child 而异，前面所有内容字节完全相同。多个 fork 并行启动时，共享同一个 prompt cache 前缀，前缀命中率趋近 100%。**

### 2.3 贯穿全系统的 Cache 感知设计

Fork 机制是 Claude Code 缓存感知设计的集中体现，但这套思想在整个系统中无处不在：

**System prompt 分段缓存（`src/constants/prompts.ts`）**

系统提示词通过 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记分为两段：
- **静态区域**（标记之前）：内容稳定，携带 `scope: 'global'`，由 API 服务端跨用户全局缓存共享。任何用户第一次请求后写入缓存，其他用户命中同一缓存。
- **动态区域**（标记之后）：包含用户特定内容（工作目录、自定义提示词等），无法跨用户缓存，每次请求按标准输入计费。

**工具集分区排序**

内建工具（Bash、Read、Write 等）始终排在工具列表前面，MCP 工具排在后面，两组不混合。原因：Anthropic 服务端在**最后一个内建工具定义之后**放置缓存断点。若 MCP 工具被插入到内建工具列表中间，断点位置提前，内建工具后的所有工具定义全部落入非缓存区，每次 MCP 工具集变动都会导致整个工具定义区域缓存失效。分区排序确保缓存断点始终在稳定的内建工具集之后，MCP 工具的增删只影响断点之后的部分。

**`DANGEROUS_uncachedSystemPromptSection`**

这是一个强制要求调用方传入 `_reason` 参数的函数，用于生成不进入缓存的 system prompt 片段。将"危险"写进函数名，目的是让开发者在每次使用时都被迫意识到自己正在破坏缓存优化，并在代码审查中留下可追溯的理由。

### 2.4 模块依赖关系图

```
fork.ts
  │
  ├── 读取父 Agent 消息历史
  │     └── AgentTool.ts → query.ts → mutableMessages
  │
  ├── 消息构建（占位 tool_result + per-child 指令块）
  │     └── buildForkMessages()
  │
  ├── 防递归检查
  │     ├── querySource 字段检查（compaction 后仍有效）
  │     └── <fork-boilerplate> 标签扫描（fallback）
  │
  ├── 并行调用
  │     └── Promise.all(children.map(child => query(...)))
  │
  └── 继承父 Agent 工具集（cache-identical 工具定义）
        └── AgentTool.ts 工具列表（不变，保证 cache 前缀一致）

prompts.ts
  │
  ├── SYSTEM_PROMPT_DYNAMIC_BOUNDARY（静态/动态分界标记）
  ├── scope: 'global'（全局跨用户缓存标记）
  ├── DANGEROUS_uncachedSystemPromptSection（强制 _reason 参数）
  └── 工具集分区排序逻辑（内建工具前置，MCP 工具后置）
```

---

## 三、核心实现走读

### 3.1 消息构建策略：完整实现

Fork 子 Agent 的消息数组构建逻辑（`src/tools/AgentTool/fork.ts`）：

```typescript
// fork.ts — buildForkMessages（概念性还原，≈实际实现）
function buildForkMessages(
  parentMessages: Message[],  // 父 Agent 完整消息历史
  parentLastAssistant: AssistantMessage,  // 父 Agent 最后一条 assistant 消息
  childInstruction: string    // per-child 任务指令（唯一差异点）
): Message[] {
  // 第一层：保留父 Agent 完整历史（所有 tool_use blocks 原封保留）
  const sharedPrefix = [...parentMessages]

  // 第二层：为 lastAssistant 中的每个 tool_use 生成相同的占位 tool_result
  // 占位内容对所有 fork 子 Agent 一致 → 继续命中缓存
  const placeholderToolResults = parentLastAssistant.content
    .filter(block => block.type === 'tool_use')
    .map(block => ({
      type: 'tool_result' as const,
      tool_use_id: block.id,
      content: FORK_PLACEHOLDER_RESULT,  // 常量，所有 child 相同
    }))

  // 第三层：追加 per-child 指令块（<fork-boilerplate> 包裹）
  // 这是唯一因 child 不同而差异的内容
  const perChildBlock = {
    type: 'text' as const,
    text: wrapForkBoilerplate(childInstruction),
  }

  return [
    ...sharedPrefix,
    { role: 'user', content: [...placeholderToolResults, perChildBlock] },
  ]
}
```

这段逻辑实现了"只有最后一个文本块不同"的设计目标：`sharedPrefix` 和 `placeholderToolResults` 对所有并行 fork 子 Agent 字节完全相同，API 服务端的缓存前缀可以覆盖这两部分的全部 token。

### 3.2 防递归的双重保险

Fork 子 Agent 继承了父 Agent 的完整工具集（包括 `AgentTool`，它本身就包含 fork 能力）。这是为了保证工具定义的 cache-identical——改变工具集会使缓存前缀失效。然而，这带来了一个工程风险：子 Agent 可能再次发起 fork，形成无限递归。

为此，Claude Code 实现了两层防递归检查（`fork.ts:call()`）：

**第一层：querySource 检查**

```typescript
// fork.ts — 防递归：第一层（compaction-resistant）
// querySource 是注入到子 Agent 查询上下文中的标记字段
// 即使消息历史被 compaction 压缩，querySource 字段仍然保留
if (querySource === 'fork') {
  return { error: 'Fork subagent cannot initiate another fork.' }
}
```

`querySource` 通过 `query()` 函数的参数传递，不依赖消息内容。即使子 Agent 的上下文被 compaction（消息压缩）处理后，该字段仍然有效，是防递归的主要屏障。

**第二层：`<fork-boilerplate>` 标签扫描**

第一层是 compaction-resistant 的，但 compaction 可能修改 querySource 的传播路径（例如极端情况下 querySource 被初始化为默认值）。第二层作为 fallback：扫描当前消息历史，检查是否存在 `<fork-boilerplate>` 标签，若存在则说明当前 Agent 已经是某个 fork 子 Agent，不允许再次 fork。

两层检查互为备份，在不同的失效场景下各自发挥作用，共同保证递归不可能发生。

### 3.3 指令格式：对抗 system prompt 继承的干扰

Fork 子 Agent 继承了父 Agent 的完整 system prompt。然而，父 Agent 的 system prompt 中可能包含"默认使用 fork 策略"的指导（Claude Code 内部默认 system prompt 中的一部分），这会导致子 Agent 误以为自己也应该 fork 下一层任务。

为此，fork 的指令文本块使用了刻意强调的格式（`fork.ts:wrapForkBoilerplate()`）：

```typescript
// fork.ts — per-child 指令块的格式设计
function wrapForkBoilerplate(instruction: string): string {
  return `<fork-boilerplate>
STOP. READ THIS FIRST.

You are a fork subagent. Your system prompt says to use fork by default — IGNORE THAT.
You are NOT the coordinator. You have ONE specific task:

${instruction}

Complete ONLY this task. Do not fork further. Do not orchestrate.
</fork-boilerplate>`
}
```

**"STOP. READ THIS FIRST."** 是刻意使用大写和感叹句的，目的是确保 LLM 在解析后续内容之前优先处理这段身份说明。LLM 的 attention 机制会对显著的格式变化（全大写、特殊标点）赋予更高权重，降低被继承 system prompt 中的"fork 默认行为"覆盖的概率。

明确说明"你的 system prompt 说'默认 fork'，忽略它"——而非只说"不要 fork"——是为了让 LLM 理解冲突的来源，而不是产生"为什么这两条指令矛盾"的困惑，从而更确定地选择正确行为。

### 3.4 Coordinator 与 Fork 的互斥

在 Claude Code 的多 Agent 架构中，Coordinator（协调器模式）和 Fork 是互斥的：一个 Coordinator 不能被 fork。

原因从语义上很直接：**Fork 机制的核心是继承执行上下文**。fork 子 Agent 之所以能够最大化缓存命中率，依赖于父 Agent 已经积累了大量消息历史（工具调用记录、代码分析结果等），这些历史构成了 cache 前缀的主体。

Coordinator 是一个纯编排者（orchestrator），它的职责是派发任务、汇总结果，自身不执行具体代码操作，没有积累"执行上下文"这一概念。Fork 一个 Coordinator 会得到另一个编排者——两个编排者并行运行，但它们继承的前缀中几乎没有可以共享价值的执行历史，缓存优化意义丧失。

更根本的问题是：Coordinator 派发的工作者工具（`AgentTool`、`SendMessageTool`）语义与 fork 的工作者工具是不同层次的抽象，两者组合会产生拓扑语义混乱——fork 子 Agent 应该"完成一件具体事情"，但 Coordinator 的行为模式是"继续派发"，方向相悖。

### 3.5 工具集排序的 Cache 感知

工具集的排序规则（`src/constants/prompts.ts` 及 `AgentTool.ts`）是 cache 感知设计的重要细节：

**内建工具前置，MCP 工具后置，两组不混合**

Anthropic API 在解析工具定义时，会在**最后一个内建工具定义之后**放置缓存断点（cache breakpoint）。断点之前的工具定义纳入前缀缓存，断点之后的不缓存。

如果 MCP 工具被插入到内建工具列表中间（例如按字母序混排），缓存断点将被提前到第一个 MCP 工具出现之前，原本应进入缓存的内建工具后半段就此落入非缓存区。每当 MCP 工具集变动（用户增删 MCP 服务器），所有工具定义的缓存都会因断点位置变化而失效。

分区排序确保：无论 MCP 工具如何变化，内建工具的断点位置不变，内建工具全部命中缓存。

### 3.6 DANGEROUS_uncachedSystemPromptSection

`prompts.ts` 中定义了一个特殊函数，其签名强制要求传入 `_reason` 参数：

```typescript
// src/constants/prompts.ts — 强制 _reason 参数的设计
// 函数名将"DANGEROUS"写入，代码审查时一眼可见
function DANGEROUS_uncachedSystemPromptSection(
  content: string,
  _reason: string  // 下划线前缀表示仅用于文档，运行时不消耗
): SystemPromptSection {
  // 返回不携带 cache_control 标记的 system prompt 片段
  // 这部分内容每次请求都按全量 input token 计费
  return { type: 'text', text: content }
}
```

设计理念：
1. **命名即文档**：函数名中的"DANGEROUS"在代码搜索、diff 审查时立即引起注意，无需阅读注释也能理解后果。
2. **强制留档**：`_reason` 参数虽然运行时无用，但要求每个调用方留下理由字符串，形成"为什么在这里放弃缓存"的决策记录。在大型团队中，这防止了"某人忽视缓存影响随手添加动态内容"的情况。
3. **分级缓存意识**：与之对比，普通的缓存 section 直接在内容携带 `cache_control` 标记。两种函数的命名风格差异本身就是一种"缓存感知"的代码文化推广。

---

## 四、高频面试 Q&A

### 设计决策题

**Q1：Fork Subagent 为什么要保留父 Agent 的完整对话历史，而不是只给任务指令？**

A：这是缓存优化与信息传递的联合设计，两者缺一不可。

从**缓存角度**：父 Agent 的完整对话历史（工具调用记录、代码读取结果、分析过程）构成了所有 fork 子 Agent 共享的缓存前缀主体。历史越长，缓存命中节约的 token 越多。若只传任务指令，并行的 N 个子 Agent 各自只有一行"新增消息"，没有共享前缀，缓存优化完全失效。

从**信息角度**：任务指令通常是高度依赖上下文的（"修复刚才分析出的那个 off-by-one 错误"），子 Agent 需要父 Agent 的历史才能理解"刚才分析出的"是什么。若只传抽象指令而不传上下文，任务指令必须变得冗长（把所有必要背景显式写入），反而增加了 per-child 差异部分的 token 数，缓存优势进一步缩小。

完整历史的保留，使任务指令可以极度精简——per-child 差异文本块的 token 数降到最低，前缀命中率最高。

**Q2：为什么 `DANGEROUS_uncachedSystemPromptSection` 要把"危险"写进函数名？**

A：这是一种"代码即政策"（policy as code）的工程文化实践，而非单纯的命名风格选择。

在 Claude Code 这类 API 成本敏感的产品中，任何一处不必要的 uncached system prompt section 都会在大规模用户调用下累积显著费用。传统的做法（代码注释、wiki 文档）对于大型团队的约束力有限——注释可以不读，文档可以过时。将"危险"硬编码进函数名，产生三种约束效果：

1. **代码审查可见**：PR 中任何新增的 `DANGEROUS_uncachedSystemPromptSection` 调用都会被 reviewer 立即注意到，形成强制讨论。
2. **搜索可追踪**：`grep DANGEROUS_uncachedSystemPromptSection` 可以在整个代码库中快速定位所有"故意放弃缓存"的位置，方便成本审计。
3. **`_reason` 强制留档**：所有调用点都留有决策理由，未来维护者可以判断理由是否仍然成立，决定是否可以迁移为缓存版本。

### 原理分析题

**Q3：多个 fork 并行启动时，prompt cache 的命中率为什么更高？**

A：这需要理解 Anthropic API 缓存的工作方式与 fork 消息结构的联动。

当第一个 fork 子 Agent 的 API 请求到达服务端时，服务端发现这段前缀（父 Agent 历史 + 占位 tool_result）未被缓存，执行 cache write（按 125% 标准价格计费，写入缓存）。

从第二个 fork 子 Agent 的 API 请求开始，服务端检测到相同的前缀已经在缓存中，直接读取，支付 cache read 费用（约 10% 标准价格）。

假设父 Agent 历史有 50,000 tokens，每个 fork 子 Agent 各自的任务指令只有 100 tokens。N 个并行 fork 子 Agent 的总 token 成本为：
- **无缓存**：N × 50,100 tokens × 标准价格
- **有 fork 缓存**：50,100 tokens × 125%（cache write，只写一次）+ (N-1) × 50,000 tokens × 10%（cache read）+ N × 100 tokens × 标准价格（per-child 差异部分）

N 越大，cache read 节约的绝对量越大。这就是 fork 并行数量越多，缓存收益越高的原因。

**Q4：描述 fork 的防递归机制，为什么需要两层检查？**

A：两层检查针对两种不同的"失效场景"，不能用其中任何一层单独替代另一层。

**第一层（querySource 检查）** 在查询上下文级别工作：`query()` 函数接受 `querySource` 参数，fork 子 Agent 的 `query()` 调用传入 `querySource: 'fork'`，子 Agent 在 `call()` 入口检查这一字段，若为 `'fork'` 则直接拒绝。

这层检查的优势是 compaction-resistant：Compaction 是 Claude Code 的上下文压缩机制，会截断旧消息历史，但它不会影响 `querySource` 这个 `query()` 参数——参数在函数调用栈中传递，不存在于消息历史里，compaction 无法触及。

然而，`querySource` 依赖于 fork 调用时的初始化逻辑正确传递该字段。在某些极端情况下（比如代码 refactor 遗漏了该参数传递），第一层可能静默失效。

**第二层（`<fork-boilerplate>` 标签扫描）** 作为 fallback，直接从消息历史中查找 `<fork-boilerplate>` 标签。只要子 Agent 是通过 fork 机制启动的，其消息历史中必然包含该标签（fork 指令块的 wrapper）。这层检查完全独立于函数参数传递链路，即使第一层因任何原因失效，第二层仍能阻断递归。

代价是第二层需要扫描消息历史（O(n) 文本查找），而第一层只是一次字段比较（O(1)）。双层设计以可忽略的扫描开销换取递归防护的可靠性。

**Q5：解释工具集分区排序如何影响 prompt cache 命中率**

A：Anthropic 服务端的缓存断点（cache breakpoint）机制与工具定义列表的结构密切相关。

服务端在处理工具定义时，会识别内建工具（Claude Code 定义的原生工具）与 MCP 工具（外部服务器注册的工具）的边界。当找到"最后一个内建工具定义"之后，服务端在该位置插入缓存断点：断点之前的内容（包括 system prompt + 内建工具定义）进入可缓存区，断点之后的内容（MCP 工具定义）不进入缓存。

这一机制的设计逻辑在于：内建工具定义是稳定的（Claude Code 版本不变则工具集不变），适合缓存；MCP 工具定义是用户可配置的，随 MCP 服务器的增删频繁变化，不适合缓存（否则每次 MCP 配置变更就需要 cache write，成本反而更高）。

如果 MCP 工具被混入内建工具列表中间（例如按字母序 `AgentTool → bash-mcp-server → BashTool`），"最后一个内建工具"的位置被提前，缓存断点也随之提前。原本属于内建工具的后半段定义被推入非缓存区，每次请求都需要全量计费。

分区排序（`内建工具全部在前，MCP 工具全部在后`）确保断点始终紧贴最后一个内建工具，MCP 工具的变动不影响断点位置，内建工具定义的缓存命中率保持稳定。

### 权衡与优化题

**Q6：Fork 机制的缺点是什么？什么场景不适合用 fork？**

A：Fork 机制在以下场景中收益降低甚至产生负面效果：

**父 Agent 历史极短时**：前缀太短，cache 节约的绝对 token 数有限，但 fork 带来的消息构建（占位 tool_result 生成）和防递归检查的开销变得相对显著。此时直接用独立的 `AgentTool` 子 Agent 可能更高效。

**高度差异化的子任务**：如果各子 Agent 的任务需要大量 per-child 上下文（每个任务指令有数千 tokens 的背景说明），per-child 差异部分的 token 数接近前缀长度，cache 节约效果被稀释，而 fork 的消息构建复杂度仍然存在。

**单一子任务（不并行）**：Fork 设计为并行 N 个子 Agent，N=1 时没有任何缓存收益（只有一次请求，前缀是否相同无意义），反而引入了占位 tool_result 的结构复杂度。

**LLM 对占位 tool_result 产生混淆**：占位 tool_result 是"假的"执行结果，LLM 可能依据这些占位内容产生错误推断。精心设计的占位内容（如 `"[Task acknowledged, proceeding as instructed]"`）可以降低混淆概率，但无法完全消除。

**Q7：如果 MCP 工具插入到内建工具列表中间，会有什么后果？**

A：后果分为**直接成本影响**和**间接行为影响**两个层面。

**直接成本影响**：假设内建工具定义共 8,000 tokens，MCP 工具插入在第 4,000 token 位置。缓存断点前移到该位置，原本可以缓存的后 4,000 tokens 内建工具定义变为每次请求全量计费。按 Claude 的 API 定价，对高频使用的系统（每天数万次请求），这可能导致每月数百至数千美元的额外成本。

**间接行为影响**：每次 MCP 服务器配置变化（新增、删除、重排）都会改变工具列表中 MCP 工具的位置，导致原本命中缓存的"内建工具前半段"也失效（因为前缀发生了变化）。频繁的 MCP 配置变更在这种情况下会产生大量 cache write，原本应该稳定的系统 prompt 缓存持续失效，整体缓存命中率下降。

### 实战应用题

**Q8：如果你要实现一个类似 fork 的多 Agent 并行机制，核心挑战是什么？**

A：核心挑战有三个，难度依次递进：

**第一，共享前缀的边界如何确定**：Fork 机制中，前缀边界是"父 Agent 最后一条 assistant message 的末尾"。但这个边界取决于父 Agent 的执行状态，不是静态可配置的。实现时需要在父 Agent 决定"发起 fork"的时刻快照当前消息历史，并确保这个快照在并行子任务全部完成之前不被修改（immutable snapshot 语义）。

**第二，占位 tool_result 的内容设计**：占位内容必须满足两个相互约束的条件：（a）语法合法，使 API 接受该消息结构；（b）语义中性，不让 LLM 产生错误的前提假设。设计一个对各种任务类型都"中性"的占位文本比想象中困难，尤其是当 tool_use 的内容是代码执行结果时（LLM 可能根据占位内容推断"代码已成功执行"）。

**第三，继承 system prompt 的干扰**：子 Agent 继承父 Agent 的 system prompt 是缓存优化的必要条件，但同时带来了行为控制问题。父 Agent 的 system prompt 可能包含特定于父 Agent 角色的指导（如"你是代码审查专家"），子 Agent 继承后可能错误地以该角色行事而非执行分配的具体任务。解决这一问题需要在指令格式上做细致的工程设计（类似 `fork.ts` 的"STOP. READ THIS FIRST."策略）。

**Q9：如何用 prompt cache 感知的设计降低自己项目的 API 成本？**

A：在自己的项目中应用 prompt cache 感知设计，核心是识别并稳定"高频请求中的共享前缀"：

**识别共享前缀**：分析你的 API 调用，找出所有请求中"内容几乎不变的部分"（system prompt、工具定义、固定上下文文档），将它们集中到消息数组的最前面，并确保它们在不同请求间字节完全一致（避免动态时间戳、随机 ID 等）。

**使用 `cache_control` 标记**：在 Anthropic API 中，对共享前缀的最后一条消息（或 system prompt 的最后一个静态段）添加 `cache_control: {type: "ephemeral"}` 标记，告知服务端在此处建立缓存断点。未标记的内容不会被缓存，即使内容相同。

**动态内容后置**：任何随请求变化的内容（用户输入、会话 ID、当前时间）放到消息数组末尾，确保差异点尽量靠后，前缀命中范围最大化。

**监控缓存命中率**：API 响应的 `usage` 字段包含 `cache_read_input_tokens` 和 `cache_creation_input_tokens`。持续监控这两个指标，若 `cache_read` 占比持续低于 50%，说明前缀稳定性不足，需要重新审查消息构建逻辑。

---

> **版权声明**：源码版权归 [Anthropic](https://www.anthropic.com) 所有，本文档基于 Claude Code v2.1.88 source map 还原版本分析，仅供学习研究使用。文档内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议。
