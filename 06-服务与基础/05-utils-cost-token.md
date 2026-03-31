# 成本与Token管理 — Claude Code 源码分析

> 模块路径：`src/utils/tokens.ts`、`src/utils/modelCost.ts`、`src/cost-tracker.ts`
> 核心职责：追踪 token 消费量、计算 USD 成本、感知上下文窗口使用率
> 源码版本：v2.1.88

## 一、模块概述

Claude Code 在每次 API 响应后更新 token 使用统计，并对用户实时展示累计成本。这一能力涉及三个层次：

1. **`utils/tokens.ts`**：从 API 响应的 `usage` 字段提取 token 数，支持 `iterations`（服务端工具循环）多轮场景，提供上下文窗口占用比计算
2. **`utils/modelCost.ts`**：将 token 数量乘以对应模型的每百万 token 单价，转换为 USD 金额
3. **`src/cost-tracker.ts`**（主循环层）：会话级累计成本追踪，实时更新 UI 的 Cost 显示

三者通过 API 响应的 `BetaUsage` 对象串联：响应携带 `input_tokens`、`output_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens`、`server_tool_use.web_search_requests` 等字段。

## 二、架构设计

### 2.1 核心类/接口/函数

| 名称 | 位置 | 类型 | 说明 |
|---|---|---|---|
| `getTokenCountFromUsage` | `tokens.ts` | 纯函数 | 将 usage 对象转换为总 token 数（含缓存） |
| `finalContextTokensFromLastResponse` | `tokens.ts` | 函数 | 从最后一个 API 响应提取最终上下文窗口大小 |
| `calculateUSDCost` | `modelCost.ts` | 函数 | 计算一次 API 调用的 USD 成本 |
| `getModelCosts` | `modelCost.ts` | 函数 | 获取指定模型的成本配置（含 Fast Mode 动态定价） |
| `MODEL_COSTS` | `modelCost.ts` | 常量映射 | 所有支持模型的定价表（按 ModelShortName 索引） |

### 2.2 模块依赖关系图

```
QueryEngine (API 响应处理)
        │  BetaUsage 对象
        ▼
utils/tokens.ts
        │  token 数量
        ▼
utils/modelCost.ts ──► utils/model/configs.ts (定价常量)
        │                      │
        │              COST_TIER_3_15 等价格层
        │
        ▼  USD 金额
cost-tracker.ts
        │  累计成本
        ▼
UI 组件 (spinner / footer 成本显示)

services/tokenEstimation.ts ──► 离线 token 估算（无 API 响应时）
        │
        └─► 字符数 / 4 ≈ token 数（近似算法）
```

### 2.3 关键数据流

**单次 API 调用成本计算**：
```
API 响应 → BetaUsage {
    input_tokens: 5000,
    output_tokens: 800,
    cache_creation_input_tokens: 10000,
    cache_read_input_tokens: 50000,
    server_tool_use: { web_search_requests: 2 }
}
    │
    ▼
getModelCosts(model, usage)
    │  model = "claude-sonnet-4-6-20251101"
    │  → getCanonicalName() → "sonnet4-6"
    │  → MODEL_COSTS["sonnet4-6"] = COST_TIER_3_15
    │
    ▼
tokensToUSDCost(COST_TIER_3_15, usage)
    = (5000/1M × $3)           // 输入
    + (800/1M × $15)           // 输出
    + (10000/1M × $3.75)       // 缓存写入
    + (50000/1M × $0.30)       // 缓存读取
    + (2 × $0.01)              // web 搜索
    = $0.015 + $0.012 + $0.0375 + $0.015 + $0.02
    ≈ $0.10 美元
```

**上下文窗口占用追踪**：
```
messages: Message[]
    │
    ▼
finalContextTokensFromLastResponse(messages)
    │  找最后一个有 usage 的 assistant 消息
    │
    ├─[有 iterations 字段]─► iterations[-1].input + output（最后一轮服务端循环）
    │
    └─[无 iterations]─► usage.input_tokens + output_tokens（顶层 usage）
```

## 三、核心实现走读

### 3.1 关键流程

1. **多层 token 计数**：`getTokenCountFromUsage` 将 `input_tokens + cache_creation + cache_read + output_tokens` 全部加总，代表该次 API 调用消耗的完整上下文大小（用于阈值比较和压缩触发）。

2. **最终窗口大小与计费 token 的区别**：`finalContextTokensFromLastResponse` 专门计算「任务预算剩余」，故意排除缓存 token（`input_tokens + output_tokens`，无缓存），因为服务端的 `renderer.py` 也是这样计算剩余预算的。注释引用了内部代码 `#304930` 和 `renderer.py:292`，说明这是与服务端对齐的精确计算。

3. **Fast Mode 动态定价**：`getOpus46CostTier` 在 Fast Mode 开启时返回 `COST_TIER_30_150`（$30/$150），否则返回 `COST_TIER_5_25`（$5/$25）。判断依据是 `usage.speed === 'fast'`，而非客户端配置，确保成本与实际服务端处理模式对齐。

4. **未知模型成本的降级处理**：`getModelCosts` 遇到未知模型短名称时，触发 `logEvent('tengu_unknown_model_cost', ...)` 并调用 `setHasUnknownModelCost()` 标记全局状态（用于 UI 警告），然后回退到默认模型（或 `COST_TIER_5_25`）的成本，而不是报错。

5. **合成消息过滤**：`getTokenUsage` 在提取 usage 前检查消息内容是否为 `SYNTHETIC_MESSAGES` 之一（系统内部合成的消息，无实际 token 计费），以及模型是否为 `SYNTHETIC_MODEL`，避免将内部消息的 token 计入成本。

### 3.2 重要源码片段

**`tokens.ts` — 总 token 数计算（含所有缓存类型）**
```typescript
// src/utils/tokens.ts
export function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +  // 首次写入缓存的 token
    (usage.cache_read_input_tokens ?? 0) +       // 从缓存命中的 token
    usage.output_tokens
  )
}
```

**`tokens.ts` — 服务端工具循环的最终上下文大小**
```typescript
// src/utils/tokens.ts
export function finalContextTokensFromLastResponse(messages: Message[]): number {
  // 找最后一个有效 usage 的 assistant 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getTokenUsage(messages[i])
    if (usage) {
      // 服务端工具循环场景：有多轮迭代，取最后一轮的 input + output
      const iterations = (usage as any).iterations
      if (iterations?.length > 0) {
        const last = iterations.at(-1)!
        return last.input_tokens + last.output_tokens  // 不含缓存
      }
      // 无工具循环：顶层 usage 就是最终窗口
      return usage.input_tokens + usage.output_tokens  // 不含缓存
    }
  }
  return 0
}
```

**`modelCost.ts` — 定价表（部分）与 Fast Mode 动态定价**
```typescript
// src/utils/modelCost.ts
export const COST_TIER_3_15 = {  // Sonnet 系列标准定价
  inputTokens: 3,              // $3/M input tokens
  outputTokens: 15,            // $15/M output tokens
  promptCacheWriteTokens: 3.75,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,     // $0.01/次 web 搜索
} as const satisfies ModelCosts

export function getOpus46CostTier(fastMode: boolean): ModelCosts {
  // Fast Mode 开启：高吞吐量模式，价格为标准的 6 倍
  return isFastModeEnabled() && fastMode ? COST_TIER_30_150 : COST_TIER_5_25
}
```

**`modelCost.ts` — 核心成本计算**
```typescript
// src/utils/modelCost.ts
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * modelCosts.promptCacheWriteTokens +
    // web 搜索按次计费（不是按 token）
    (usage.server_tool_use?.web_search_requests ?? 0) * modelCosts.webSearchRequests
  )
}
```

### 3.3 设计模式分析

- **值对象模式**：`ModelCosts` 是纯数据类型（`as const satisfies ModelCosts`），无行为，仅存储定价常量，通过 TypeScript 的 `satisfies` 操作符在编译期确保类型完整性。
- **空值安全模式**：所有可选字段（`cache_creation_input_tokens ?? 0`）在计算前用 `?? 0` 安全处理，避免 NaN 传播导致成本计算错误。
- **单一职责**：`tokensToUSDCost` 仅做数学计算，不涉及模型查找；`getModelCosts` 仅做模型到成本的映射；`calculateUSDCost` 组合两者。职责边界清晰。
- **开放/封闭原则**：`MODEL_COSTS` 映射表对扩展开放（添加新模型条目）、对修改封闭（现有条目不需要改动），源码注释 `// @[MODEL LAUNCH]: Add a pricing entry for the new model below.` 显示这是刻意设计的扩展点。

## 四、高频面试 Q&A

### 设计决策题

**Q1：`finalContextTokensFromLastResponse` 为什么排除缓存 token，而 `getTokenCountFromUsage` 包含它？**

> 两个函数服务于不同目的：`getTokenCountFromUsage` 计算「这次 API 调用消耗了多少上下文空间」，用于触发自动压缩（autocompact），需要包含缓存来准确评估窗口占用；`finalContextTokensFromLastResponse` 计算「任务预算剩余」，其算法来自服务端 `renderer.py:292` 的 `calculate_context_tokens` 函数——服务端也是用 `input + output`（无缓存）来扣减预算，客户端必须使用相同算法才能与服务端的预算倒计时保持一致。

**Q2：为什么成本计算要专门处理 `server_tool_use.web_search_requests` 而不是把 web 搜索当作普通 token？**

> web 搜索是按「请求次数」计费（$0.01/次），与 token 定价体系无关。API 的 `usage` 对象在 `server_tool_use` 字段下单独报告搜索次数，与 token 字段平行。如果把搜索折算成 token 会失去精度，而且定价可能单独变动。独立处理也让成本分解更透明（用户可以看到「X 次 web 搜索 = $Y」）。

### 原理分析题

**Q3：`iterations` 字段是什么？为什么只取最后一次迭代？**

> 在服务端工具循环（server-side tool loop）场景下，模型在一次 API 响应内部可能多次调用工具并处理结果，每次工具调用都是一次「迭代」。`iterations` 数组记录每次迭代的 `input_tokens` 和 `output_tokens`（不含缓存）。最终上下文窗口大小应该是最后一次迭代结束时的状态，因为此时上下文包含了所有工具调用结果——这是模型实际看到的「最终输入」，与任务预算的消耗量一致。

**Q4：`doesMostRecentAssistantMessageExceed200k` 的 200k 阈值有何意义？**

> 200k token 是 Claude 3.5/4 系列的基础上下文窗口大小。当最近一次 assistant 消息的总 token 数超过 200k 时，说明对话已填满标准上下文窗口，后续 API 调用可能需要 `extended-context-window` beta 功能或触发自动压缩。这个函数是上下文感知压缩逻辑的触发条件之一，超过阈值时 UI 会显示上下文窗口警告。

**Q5：`SYNTHETIC_MESSAGES` 和 `SYNTHETIC_MODEL` 过滤的作用是什么？**

> Claude Code 内部会合成一些「虚拟」的 assistant 消息（如工具结果展示、错误通知），这些消息不来自真实的 API 调用，因此 `usage` 对象要么为空要么包含虚假数据。`getTokenUsage` 通过检查消息内容是否在 `SYNTHETIC_MESSAGES` 集合中、模型是否为 `SYNTHETIC_MODEL` 来过滤这些消息，确保成本计算只统计真实 API 调用的 token，不因内部合成消息而虚增成本。

### 权衡与优化题

**Q6：离线 token 估算使用「字符数 / 4」的精度如何？有什么更准确的替代方案？**

> 「字符数 / 4」是一个历史经验近似值，对英文文本误差约 ±15%，对中文/日文等多字节字符误差可达 50% 以上（一个汉字约 1-2 个 token，但占 3 字节 UTF-8）。更准确的替代方案：1) 使用 `tiktoken` 或 Anthropic 官方的本地 tokenizer 库（计算开销 ~1ms/千字符）；2) 调用 `/tokens` API 端点（有网络延迟）。当前选择「字符 / 4」的原因是：估算仅用于进度 spinner 显示，精度要求低，不影响实际计费，本地计算无延迟。

**Q7：快速模式（Fast Mode）的 $30/$150 定价与标准模式 $5/$25 相差 6 倍，用户如何感知成本差异？**

> `getOpus46CostTier` 使用 `usage.speed === 'fast'` 字段区分两种模式，该字段来自 API 响应（服务端决定），客户端不能自行声明。成本追踪层（`cost-tracker.ts`）使用这个函数计算每次响应的成本，累计到会话总成本中展示在 footer。当 Fast Mode 被降级（冷却期）时，`usage.speed` 会是标准值，成本自动切换到低价档。这确保成本展示始终与实际计费一致，用户可以直观看到 Fast Mode 的成本影响。

### 实战应用题

**Q8：如何为新上线的模型（如假设的 claude-haiku-5）添加成本支持？**

> 按照源码注释 `// @[MODEL LAUNCH]: Add a pricing entry for the new model below.` 指示：1) 在 `model/configs.ts` 添加 `CLAUDE_HAIKU_5_CONFIG`（含 `firstParty` 名称字符串）；2) 在 `modelCost.ts` 添加对应的价格常量（或复用已有 tier）；3) 在 `MODEL_COSTS` 映射中添加 `[firstPartyNameToCanonical(CLAUDE_HAIKU_5_CONFIG.firstParty)]: COST_HAIKU_5`；4) 若需要 Fast Mode 动态定价，参照 `getOpus46CostTier` 添加条件分支；5) 更新 `model/model.ts` 中的短名称别名（如 `'haiku5'`）。

**Q9：如何在测试环境中模拟高成本使用场景以验证成本展示逻辑？**

> 可以直接构造 `BetaUsage` 对象传入 `calculateUSDCost`：`calculateUSDCost('claude-sonnet-4-6-20251101', { input_tokens: 1_000_000, output_tokens: 200_000, cache_creation_input_tokens: 500_000, cache_read_input_tokens: 2_000_000, server_tool_use: { web_search_requests: 100 } })`。对于集成测试，可以通过 VCR（`services/vcr.ts`）录制真实 API 响应，提取其中的 `usage` 字段，使用固定数据验证成本计算的数学正确性和边界条件（如未知模型回退、Fast Mode 切换）。

---
> **版权声明**：源码版权归 [Anthropic](https://www.anthropic.com) 所有，本文档基于 Claude Code v2.1.88 source map 还原版本分析，仅供学习研究使用。文档内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议。
