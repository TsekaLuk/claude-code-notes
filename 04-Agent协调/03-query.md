# query（查询抽象层）— Claude Code 源码分析

> 模块路径：`src/query.ts`
> 核心职责：驱动"请求 → 流式响应 → 工具执行 → 继续请求"的完整查询循环，是 Claude API 调用与工具编排的核心协调者
> 源码版本：v2.1.88

## 一、模块概述

`query.ts` 是 Claude Code 的**查询引擎内核**。它实现了一个 `while (true)` 驱动的异步生成器循环，每轮迭代执行以下操作：

1. 对消息历史做压缩预处理（snip、microcompact、autocompact）
2. 通过 `callModel()` 发起流式 API 请求
3. 实时 yield 流式消息给上游消费者
4. 收集工具调用块（`tool_use`），执行工具
5. 根据执行结果决定是终止（`Terminal`）还是继续下一轮

整个函数签名为异步生成器，输出类型是 `StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage`，返回类型（`Terminal`）携带终止原因。

与 `QueryEngine.ts` 的关系：`QueryEngine` 是会话级别的持久对象，管理跨轮次的消息历史和 token 计数；`query.ts` 的 `query()` 函数是其内部的单次"查询循环执行器"，由 `QueryEngine.submitMessage()` 在每次用户输入时调用。

---

## 二、架构设计

### 2.1 核心类/接口/函数

**`query(params: QueryParams)`**：公开导出的入口函数，是一个异步生成器。它将具体循环委托给 `queryLoop()`，在循环正常退出后触发 `notifyCommandLifecycle` 事件（命令生命周期通知）。

**`queryLoop(params, consumedCommandUuids)`**：真正的循环执行函数，包含完整的 `while (true)` 状态机。

**`State`**（内部类型）：循环迭代间传递的可变状态，包括当前消息列表、工具上下文、压缩追踪状态、恢复计数器、当前轮次等。每个 `continue` 站点通过 `state = { ...next }` 整体替换，而非逐字段赋值，保证状态一致性。

**`QueryParams`**：查询参数类型，携带消息历史、系统提示词、用户上下文、工具集、`canUseTool` 权限检查函数、`taskBudget` 预算等。

**`Terminal`**：终止值类型（来自 `query/transitions.ts`），携带 `reason` 字段，记录循环退出原因（如 `'aborted_streaming'`、`'blocking_limit'`、`'prompt_too_long'`、`'max_turns'` 等）。

### 2.2 模块依赖关系图

```
QueryEngine.submitMessage()
        │ 调用
        ▼
  query(params)  ── yield* ──►  queryLoop(params)
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
              ▼                      ▼                      ▼
  deps.microcompact()       deps.autocompact()      deps.callModel()
  (消息压缩)                 (自动紧缩)               (API 流式调用)
              │                      │                      │
              │                snipModule                   │
              │                contextCollapse              │
              │                                            ▼
              │                              StreamingToolExecutor
              │                                  (并行工具执行)
              ▼                                      │
      messagesForQuery                          toolResults[]
         (本轮消息)                                   │
                                                     ▼
                                            runTools() / 工具执行
                                                     │
                                              continue (下一轮)
```

**关键依赖注入**：`deps` 对象（来自 `productionDeps()` 或测试注入）封装了 `callModel`、`autocompact`、`microcompact`、`uuid` 等外部依赖，使 `queryLoop` 的核心逻辑可在测试中替换任何依赖。

### 2.3 关键数据流

```
[进入循环]
      │
      ▼  (每轮迭代)
① applyToolResultBudget(messagesForQuery) — 限制工具结果总大小
      │
      ▼
② snipCompactIfNeeded(messagesForQuery)   — HISTORY_SNIP 特性：片段压缩
      │
      ▼
③ microcompact(messagesForQuery)          — 微压缩（单工具结果压缩）
      │
      ▼
④ contextCollapse.applyCollapsesIfNeeded()— 上下文折叠
      │
      ▼
⑤ autocompact(messagesForQuery)           — 自动完整压缩（阈值触发）
      │
      ▼
⑥ calculateTokenWarningState()            — 检查是否达到阻塞限制
      │ (未达限制)
      ▼
⑦ for await...of deps.callModel(...)     — 发起流式 API 请求
      │ 每个流式消息
      ├── yield message                   — 透传给上游
      ├── 记录 tool_use 块               — 累积到 toolUseBlocks[]
      └── StreamingToolExecutor.addTool() — 并行工具执行（可选）
      │ 流结束
      ▼
⑧ needsFollowUp?
      ├── 是 → 执行工具 → 收集 toolResults → state = {messages: [..., results]} → continue
      └── 否 → 检查异常状态（prompt_too_long, max_output_tokens）
                   ├── 可恢复 → 压缩/escalate → continue
                   └── 不可恢复 → return Terminal
```

---

## 三、核心实现走读

### 3.1 关键流程（编号步骤）

**完整查询循环的 10 个关键决策点**

1. **令牌预算检查**：`checkTokenBudget()` 若超出 `taskBudget.total` 则提前终止，防止无边界 Agent 运行
2. **工具结果预算**：`applyToolResultBudget()` 截断超大工具结果（如读取超大文件），保留有效工具调用 ID 的关联
3. **片段压缩**（HISTORY_SNIP）：保留对话尾部，压缩中间历史，减少 token 占用同时保持近期上下文完整
4. **微压缩**：对单个工具结果进行摘要，不替换整个历史
5. **上下文折叠**（CONTEXT_COLLAPSE）：将部分旧消息折叠为摘要，比完整 autocompact 粒度更细
6. **自动压缩**（autocompact）：当 token 数超过阈值时，fork 出一个单独的 API 调用生成全历史摘要，替换消息历史
7. **流式工具执行**（StreamingToolExecutor）：可在流式响应到达时并行开始执行工具，不等全部流结束
8. **模型回退**（Fallback）：捕获 `FallbackTriggeredError`，切换到备用模型重试，发出 Tombstone 消息清理孤立消息
9. **max_output_tokens 恢复**：遇到输出 token 上限时，自动注入恢复元消息（"Output token limit hit. Resume directly..."）并继续，最多 3 次
10. **停止钩子**（Stop Hooks）：模型停止后执行 `postSamplingHooks`，可能触发工具重新执行

### 3.2 重要源码片段（带中文注释）

**查询入口——异步生成器签名（`src/query.ts:219-238`）**

```typescript
// 公开入口：只包装 queryLoop，确保命令生命周期通知在成功路径上触发
export async function* query(
  params: QueryParams,
): AsyncGenerator<StreamEvent | RequestStartEvent | Message | ..., Terminal> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // 仅正常退出时触发（throw 会跳过这里，.return() 关闭两个生成器）
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

**循环状态初始化（`src/query.ts:268-278`）**

```typescript
// 所有跨轮次的可变状态统一放在 State 对象
let state: State = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  maxOutputTokensOverride: params.maxOutputTokensOverride,
  autoCompactTracking: undefined,
  maxOutputTokensRecoveryCount: 0,  // max_output_tokens 恢复计数，上限 3
  hasAttemptedReactiveCompact: false,
  turnCount: 1,
  pendingToolUseSummary: undefined,
  transition: undefined,  // 上一次 continue 的原因（测试用于断言恢复路径）
}
```

**自动压缩触发（`src/query.ts:453-543`）**

```typescript
// autocompact 同时接收 snipTokensFreed，使阈值判断反映片段压缩已释放的空间
const { compactionResult, consecutiveFailures } = await deps.autocompact(
  messagesForQuery, toolUseContext, cacheSafeParams, querySource, tracking, snipTokensFreed,
)
if (compactionResult) {
  // task_budget: 压缩前记录最终上下文窗口大小，用于计算剩余预算
  if (params.taskBudget) {
    taskBudgetRemaining = Math.max(0,
      (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext)
  }
  const postCompactMessages = buildPostCompactMessages(compactionResult)
  for (const message of postCompactMessages) yield message  // 通知上游压缩边界
  messagesForQuery = postCompactMessages
}
```

**流式响应处理核心（`src/query.ts:659-845`，关键节选）**

```typescript
for await (const message of deps.callModel({ messages, systemPrompt, ... })) {
  // 过滤"可恢复错误"：prompt_too_long、max_output_tokens — 先扣留，待确认是否能恢复
  let withheld = false
  if (reactiveCompact?.isWithheldPromptTooLong(message)) withheld = true
  if (isWithheldMaxOutputTokens(message)) withheld = true
  if (!withheld) yield yieldMessage  // 正常消息立即透传

  if (message.type === 'assistant') {
    assistantMessages.push(message)
    // 收集工具调用块，设置 needsFollowUp 标志
    const toolUseBlocks = message.message.content.filter(b => b.type === 'tool_use')
    if (toolUseBlocks.length > 0) needsFollowUp = true
  }
}
```

**max_output_tokens 恢复策略（`src/query.ts:1188-1249`）**

```typescript
if (isWithheldMaxOutputTokens(lastMessage)) {
  // 策略一：先尝试将输出上限从默认 8k 提升到 64k（一次性机会）
  if (capEnabled && maxOutputTokensOverride === undefined) {
    state = { ...state, maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
              transition: { reason: 'max_output_tokens_escalate' } }
    continue  // 重试同一请求，更大输出窗口
  }
  // 策略二：注入元消息，要求模型"接着说"，最多 3 次
  if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    const recoveryMessage = createUserMessage({
      content: `Output token limit hit. Resume directly — no apology, no recap...`,
      isMeta: true,  // 元消息不展示给用户，不计入命令历史
    })
    state = { ...state, messages: [...messagesForQuery, ...assistantMessages, recoveryMessage],
              maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1 }
    continue
  }
}
```

### 3.3 设计模式分析

**生成器作为协议（Generator-as-Protocol）**：`query()` 是异步生成器，上游消费者以 `for await...of` 拉取消息。这一模式让调用者能实时处理每条流式消息（渲染到 UI），而不需要等待完整响应——消费速度自然地通过背压（backpressure）控制生产速度。

**可替换依赖（Injectable Dependencies）**：`deps = params.deps ?? productionDeps()` 让测试可以注入 mock 的 `callModel`、`autocompact` 等，在不发起真实 API 请求的情况下测试恢复逻辑、压缩触发路径等。这是复杂异步状态机可测试性的关键设计。

**状态机显式化（Explicit State Machine）**：循环的每个 `continue` 都先构建完整的 `next: State` 对象，并在 `transition` 字段记录跳转原因（`'max_output_tokens_escalate'`、`'reactive_compact_retry'` 等）。这使故障排查时可通过检查 `state.transition` 追溯恢复路径，测试也可断言特定恢复策略是否触发，而无需检查消息内容。

**扣留模式（Withhold-then-Recover）**：对 prompt_too_long 和 max_output_tokens 错误，流式消息先被"扣留"（不 yield），等待恢复逻辑决定：能恢复则 `continue`（用户看不到中间错误），不能恢复才释放并终止。防止 SDK 消费者（如 claude-desktop）在看到第一个 `error` 字段时提前关闭会话。

---

## 四、高频面试 Q&A

### 设计决策题

**Q1：为什么 `query()` 只是一层薄包装，将真正逻辑放在私有的 `queryLoop()` 中？**

A：分离的目的是**命令生命周期通知的对称性**。`query()` 只在 `queryLoop()` **正常返回**时调用 `notifyCommandLifecycle(uuid, 'completed')`——若 `queryLoop` 抛出异常，异常穿越 `yield*` 传播，`notifyCommandLifecycle` 不会被调用（对应"started but not completed"语义）。若将通知放在 `queryLoop` 内部 `try/finally` 中，每次中途退出都会错误地触发 completed。外层 `query()` 通过 `yield*` 的 completion value 机制精确捕获正常返回路径。

**Q2：`State.transition` 字段的值只用于测试，为何要在生产代码中保留？**

A：注释明确说明"Lets tests assert recovery paths fired without inspecting message contents"——消息内容在不同版本间可能变化，基于内容的断言脆弱；而 `transition.reason` 是语义稳定的枚举字符串，断言它比匹配消息文本更健壮。在生产中该字段零成本（仅赋值，不额外计算），保留它使调试和可观测性受益（可在日志/trace 中记录恢复路径）。

### 原理分析题

**Q3：`snipTokensFreed` 为何要传递给 `autocompact()`？两者不是独立的压缩机制吗？**

A：`calculateTokenWarningState()` 用来判断是否触发 autocompact，它读取消息历史中**最后一条助手消息**的 `usage.input_tokens`（API 报告的累计值）作为当前 token 数估算。但 `snipCompact` 在 API 调用前截断了消息，被截断的 token 不会反映在"最后一条助手消息的 usage"中（那是上一轮的值）。若不传 `snipTokensFreed`，autocompact 会基于"未减去 snip 贡献"的旧 token 数判断阈值，导致 snip 刚把我们拉到阈值以下却仍被 autocompact 触发——浪费一次全量压缩。减去 `snipTokensFreed` 让阈值判断反映 snip 的真实贡献。

**Q4：`StreamingToolExecutor` 是什么？它如何在流式响应过程中并行执行工具？**

A：`StreamingToolExecutor` 在流式响应到达时立即开始执行工具，不等全部流结束。当 API 流中出现 `tool_use` 块时，`addTool()` 被调用，工具执行在后台异步启动；随后每次循环 `getCompletedResults()` 检查并收割已完成的工具结果，立即 yield 给上游。若在流过程中触发了 fallback（模型切换），`streamingToolExecutor.discard()` 放弃所有进行中的工具执行，创建新的 executor 重新开始——旧的 `tool_use_id` 将无法匹配任何结果，若不丢弃会产生"孤儿工具结果"导致 API 报错。

**Q5：`task_budget.remaining` 是如何在多次压缩后保持正确的？**

A：`taskBudgetRemaining` 是循环局部变量（非 `State` 的一部分），在每次 autocompact 触发时更新：`taskBudgetRemaining = max(0, (taskBudgetRemaining ?? total) - preCompactContext)`。`preCompactContext` 是压缩前的最终上下文窗口大小（从最后一条 API 响应的 usage 读取）。多次压缩时，每次都从当前 remaining 中扣除该轮的最终上下文，累计追踪整个会话消耗。不放在 `State` 中的原因：State 有 7 个 continue 站点，每个都需要传递该字段，代码噪声过大；局部变量在循环体内是隐式共享的，更简洁。

### 权衡与优化题

**Q6：autocompact、snip、microcompact、contextCollapse 四种压缩机制的触发优先级是什么？**

A：按执行顺序（每轮循环）：① snip（片段截断，最轻量，先于 autocompact 运行）→ ② microcompact（单工具结果摘要）→ ③ contextCollapse（折叠旧消息，比 autocompact 粒度细）→ ④ autocompact（整体压缩，最重，阈值触发）。优先级设计的原则是"最轻量的先尝试"：若 snip/collapse 已将 token 数降至阈值以下，autocompact 就不触发，保留更多历史细节。autocompact 是最后的手段，完全替换历史，信息损失最大。

**Q7：为什么 `pendingMemoryPrefetch` 使用 `using` 关键字（ES2023 显式资源管理）？**

A：`using` 保证 `pendingMemoryPrefetch.dispose()` 在**所有生成器退出路径**上都被调用——包括正常 `return`、`throw` 异常、以及调用者 `.return()` 提前终止。若改用 `try/finally`，在生成器被外部 `.return()` 调用时（如用户按 Ctrl+C），`finally` 块不一定执行（取决于 JS 引擎实现）。`using` 通过 `Symbol.dispose` 协议提供更可靠的清理语义，并在代码中清晰表达"这是一个需要在退出时清理的资源"的设计意图。

### 实战应用题

**Q8：用户报告某个工具每次执行都返回超大文本，导致上下文快速耗尽，应如何解决？**

A：有两个层次的解决方案：1）**工具层面**：在工具实现中设置 `maxResultSizeChars` 属性（`applyToolResultBudget` 会对有此属性的工具执行截断）；2）**系统层面**：`applyToolResultBudget()` 在每轮循环开始时截断工具结果，但默认只对没有 `maxResultSizeChars` 限制的工具的结果做预算分配。若工具确实需要返回大量数据，应让工具将结果写入文件并返回路径，而非直接嵌入消息内容——这是提示词中明确建议的模式（"use disk output"）。

**Q9：如何为 `queryLoop` 中的某个特定压缩路径添加指标监控？**

A：最小侵入方案：在 `deps` 对象中添加可选的 `onTransition?: (transition: Continue) => void` 回调，在每个 `continue` 站点调用 `deps.onTransition?.(next.transition)`。生产的 `productionDeps()` 可注入统计上报回调（如 `logEvent('tengu_query_transition', {...})`），测试中则注入收集 transition 历史的函数。`transition` 字段已经携带了精确的恢复路径类型，无需额外解析消息内容。这种设计保持了 `queryLoop` 对监控系统的无知（zero knowledge），符合依赖反转原则。

---

> **版权声明**：源码版权归 [Anthropic](https://www.anthropic.com) 所有，本文档基于 Claude Code v2.1.88 source map 还原版本分析，仅供学习研究使用。文档内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议。
