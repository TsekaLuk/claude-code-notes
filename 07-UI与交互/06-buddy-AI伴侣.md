# Buddy AI 伴侣 — Claude Code 源码分析

> 模块路径：`src/buddy/`
> 核心职责：实现一个基于用户 ID 确定性生成的像素风格虚拟伴侣，在终端输入框旁显示动画精灵和对话气泡
> 源码版本：v2.1.88

## 一、模块概述

`src/buddy/` 是 Claude Code 中一个独特的"彩蛋式"功能模块，实现了一个叫做 **Buddy**（官方功能代号 `BUDDY`）的 AI 伴侣系统。这个伴侣以 ASCII/Unicode 像素艺术精灵的形式显示在输入框右侧，具有以下特征：

- **确定性生成**：伴侣的物种、眼睛、帽子、稀有度等外观特征由用户 ID 的哈希值确定性生成（相同账号永远得到相同伴侣）
- **精灵动画**：在终端中显示多帧 ASCII 动画（空闲/摆动/眨眼），每 500ms 切换帧
- **对话气泡**：当用户在输入框中输入 `/buddy` 时触发对话气泡，或在特定 AI 回复后响应
- **RPG 属性**：伴侣有稀有度（common 到 legendary）和 5 项属性（DEBUGGING/PATIENCE/CHAOS/WISDOM/SNARK）

该功能在 2026 年 4 月 1 日前为内测预告窗口期，之后全面开放。

---

## 二、架构设计

### 2.1 核心类/接口/函数

| 名称 | 文件 | 职责 |
|------|------|------|
| `Companion` 类型 | `types.ts` | 完整伴侣对象（CompanionBones + CompanionSoul + hatchedAt） |
| `roll(userId)` | `companion.ts` | 基于 userId 哈希确定性生成伴侣外观（Mulberry32 PRNG） |
| `CompanionSprite` | `CompanionSprite.tsx` | 主渲染组件，管理帧动画、对话气泡、爱心漂浮效果 |
| `BODIES` | `sprites.ts` | 每个物种 3 帧的 ASCII 精灵定义，含帽子插槽 |
| `getCompanionIntroAttachment` | `prompt.ts` | 生成伴侣介绍附件，注入对话上下文告知 Claude 伴侣存在 |

### 2.2 模块依赖关系图

```
┌──────────────────────────────────────────────────────────┐
│                     PromptInput.tsx                       │
│  （输入框右侧渲染 CompanionSprite，预留 columns 空间）    │
└──────────────────────────┬───────────────────────────────┘
                           │
              ┌────────────▼────────────┐
              │   CompanionSprite.tsx    │
              │   帧动画 / 气泡 / 爱心   │
              └──────┬──────────────────┘
          ┌──────────┼──────────────────┐
          │          │                  │
  ┌───────▼────┐ ┌───▼──────┐ ┌────────▼──────┐
  │sprites.ts  │ │companion │ │useBuddyNoti-  │
  │（ASCII精灵）│ │.ts       │ │fication.tsx   │
  └───────┬────┘ │（骨骼生成）│ │（彩虹预告）    │
          │      └─────┬────┘ └───────────────┘
          │            │
   ┌──────▼────────────▼───────┐
   │         types.ts           │
   │  Companion / SPECIES / RARITIES│
   └───────────────────────────┘
```

### 2.3 关键数据流

```
用户首次运行 /buddy hatch
    │
    ▼
roll(userId) → mulberry32(hash(userId + SALT))
    │ → 确定性 Companion Bones（物种/眼睛/帽子/稀有度/属性）
    ▼
Claude API 生成 CompanionSoul（name + personality）
    │
    ▼
saveGlobalConfig({ companion: { name, personality, hatchedAt } })
    │
    ▼ 后续每次启动
getCompanion() → roll(userId).bones + stored.soul
    │
    ▼
CompanionSprite 渲染（每 500ms 切换 IDLE_SEQUENCE 帧）
    │
    ▼
用户输入 "/buddy" → 触发 AI 生成对话气泡文字
    │ SpeechBubble 组件显示 ~10s 后渐隐消失
```

---

## 三、核心实现走读

### 3.1 关键流程

1. **确定性骨骼生成**：`roll(userId)` 使用 **Mulberry32**（32 位乘法同余伪随机数生成器，用户 ID + `SALT = 'friend-2026-401'` 的哈希值作为种子）依次抽取：稀有度（加权随机）、物种、眼睛类型、帽子（common 无帽）、是否 shiny（1% 概率），以及 5 项属性（峰值属性 +50~80、弱项属性 −10~5、其余随机）。结果被 `rollCache` 缓存，避免三条热路径（500ms 动画 tick、每次按键 PromptInput、每轮 AI 响应观察器）重复计算。
2. **骨骼与灵魂分离存储**：`CompanionBones`（外观特征）每次从哈希重新生成，永不持久化；`CompanionSoul`（名字和性格描述，由 Claude 生成）存储在 `config.companion`。这样：重命名物种不会破坏已存储的伴侣，用户无法通过修改配置文件伪造稀有度。
3. **精灵渲染**：`sprites.ts` 中每个物种有 3 帧 ASCII 图形，高 5 行、宽 12 字符，行 0 为帽子槽（帧 0/1 留空，帧 2 可使用）。`{E}` 占位符在渲染时替换为当前伴侣的眼睛字符。`IDLE_SEQUENCE = [0,0,0,0,1,0,0,0,-1,0,0,2,0,0,0]` 定义空闲动画序列，`-1` 表示在帧 0 上叠加"眨眼"效果。
4. **对话气泡生命周期**：气泡显示 `BUBBLE_SHOW = 20` ticks（~10s），最后 `FADE_WINDOW = 6` ticks（~3s）进入渐隐状态（文字变 dimColor），提示用户即将消失。`/buddy pet` 命令触发 5 帧爱心上浮动画（持续 ~2.5s）。
5. **Claude 上下文注入**：`getCompanionIntroAttachment()` 在每次新对话开始时向消息历史追加一个 `type: 'companion_intro'` 附件，内容为 `companionIntroText(name, species)` —— 告知 Claude "有个叫 X 的 Y 坐在输入框旁，你不是它，当用户叫它名字时只回复一行"。
6. **时间窗口控制**：`isBuddyTeaserWindow()` 检查本地时间是否在 2026 年 4 月 1-7 日（预告期），`isBuddyLive()` 检查是否已过 2026 年 4 月（功能完全开放后）。

### 3.2 重要源码片段

**片段一：Mulberry32 伪随机数生成器（`companion.ts`）**
```typescript
// 极简 32-bit PRNG，用于确定性生成伴侣特征
// userId + SALT 的哈希值作为种子，保证相同账号永远得到相同伴侣
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296  // 返回 [0,1) 浮点数
  }
}
```

**片段二：稀有度加权抽取（`companion.ts`）**
```typescript
// 加权随机：common=60%, uncommon=25%, rare=10%, epic=4%, legendary=1%
function rollRarity(rng: () => number): Rarity {
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0)  // 100
  let roll = rng() * total
  for (const rarity of RARITIES) {  // 按序遍历
    roll -= RARITY_WEIGHTS[rarity]
    if (roll < 0) return rarity     // 第一个使 roll 变负的就是结果
  }
  return 'common'
}
```

**片段三：伴侣介绍注入提示（`prompt.ts`）**
```typescript
// 告知 Claude 伴侣的存在和交互规则
// Claude 不需要扮演伴侣，只需在用户呼叫时保持克制
export function companionIntroText(name: string, species: string): string {
  return `# Companion
A small ${species} named ${name} sits beside the user's input box
and occasionally comments in a speech bubble. You're not ${name}.
When the user addresses ${name} directly, respond in ONE line or less.
Don't explain that you're not ${name} — they know.`
}
```

### 3.3 设计模式分析

- **确定性生成（Deterministic Generation）**：以用户 ID 为种子的 PRNG 保证同一用户的伴侣是固定的，即使重装应用也能恢复相同外观，无需服务端存储伴侣"外观数据"。
- **数据分离（Bones/Soul Separation）**：将外观（可重新计算）与个性（AI 生成，持久化）分离，允许游戏数据的灵活演化（外观枚举可以修改，已持久化的灵魂数据不受影响）。
- **混入模式（Mixin）**：`getCompanion()` 通过 `{ ...stored, ...bones }` 合并存储数据和实时骨骼，后者覆盖前者确保旧格式的配置文件中的骨骼字段被最新算法生成的值替代。
- **时间窗口门控（Time Gate）**：通过本地时间判断功能可见性，实现跨时区的"滚动波"预热效果，而非 UTC 午夜的单点冲击。
- **非侵入性上下文注入**：伴侣系统通过附件机制（`companion_intro` 消息类型）向 Claude 注入上下文，而不是修改系统提示，保持主提示的纯净性。

---

## 四、高频面试 Q&A

### 设计决策题

**Q1：为什么伴侣外观（骨骼）不持久化到配置文件，而是每次从哈希重新生成？**

骨骼数据（物种/眼睛/帽子/稀有度）是 `hash(userId + SALT)` 的确定性输出，任何时候重新计算都会得到相同结果，存储它没有意义且浪费空间。更重要的是：
1. **防止作弊**：若骨骼持久化，用户可以直接修改配置文件将自己的 `rarity` 改为 `legendary`。
2. **允许游戏数据演化**：若未来新增物种或调整稀有度权重，已存储的骨骼字段（旧格式）会被新计算覆盖，无需数据迁移。
3. **灾难恢复**：用户删除配置文件后，只要账号 ID 不变，重新 `/buddy hatch` 会得到相同外观的伴侣（只有 Claude 生成的名字/性格需要重新生成）。

**Q2：`isBuddyTeaserWindow()` 使用本地时间而非 UTC，这是刻意的设计选择吗？**

是的，注释明确说明："本地时间而非 UTC，24 小时滚动波跨时区。持续的 Twitter 热度而非单次 UTC 午夜峰值，对 soul 生成服务器的压力更温和。"即 UTC 午夜时区边界内的所有用户同时触发功能会导致 Claude API 的 soul 生成请求在数分钟内集中爆发。使用本地时间将这个流量分散到 4 月 1 日的全球 24 小时窗口内，是一种简单有效的流量平滑策略。

---

### 原理分析题

**Q3：IDLE_SEQUENCE 的 `-1` 帧是什么含义？精灵系统如何实现"眨眼"效果？**

`IDLE_SEQUENCE = [0,0,0,0,1,0,0,0,-1,0,0,2,0,0,0]` 中的 `-1` 是一个特殊标记，意为"在帧 0 的基础上显示眨眼状态"。精灵渲染时检测到 `-1`，会将当前帧的眼睛字符（`{E}` 占位符）替换为 `-`（横线，表示闭眼），而不是渲染一个完整的独立帧。这样只需 3 帧精灵数据就能表达 4 种视觉状态（帧0休息、帧1摆动、帧2轻摆、帧0+眨眼），减少了精灵定义的冗余。每 500ms 执行一次 `IDLE_SEQUENCE` 步进，完整循环约 7.5 秒。

**Q4：多条热路径（500ms tick / 按键 / AI 响应）都调用 `roll(userId)`，如何避免重复计算？**

`rollCache` 是模块级变量（`let rollCache: { key: string; value: Roll } | undefined`），存储最近一次的调用参数（`key = userId + SALT`）和结果。任何调用 `roll(userId)` 时，若 `rollCache?.key === key`，直接返回缓存值，跳过 Mulberry32 迭代和所有随机抽取。由于 Claude Code 整个进程只有一个用户 ID 且不会变化，这个缓存实际上在整个会话期间都是命中状态，将三条热路径的伴侣外观计算开销降至 O(1) 字符串比较。

**Q5：`SpeechBubble` 的渐隐机制是如何实现的？**

`CompanionSprite` 维护一个 `bubbleTick` 计数器，每 500ms 递增。当 `bubbleTick > BUBBLE_SHOW - FADE_WINDOW`（即超过 14 ticks，约 7s 后），将 `fading` prop 设为 `true`，传给 `SpeechBubble`。`SpeechBubble` 在 `fading = true` 时：
- 边框颜色切换为 `inactive`（灰色）
- 文字加上 `dimColor`
- 这给用户约 3 秒的视觉提示（气泡开始变灰）预示气泡将消失。当 `bubbleTick >= BUBBLE_SHOW` 时，清除气泡状态，停止渲染 `SpeechBubble`。

---

### 权衡与优化题

**Q6：物种名称使用 `String.fromCharCode()` 编码而不是直接写字符串，这是为什么？**

注释解释了原因：一个物种名与某个模型代号（model-codename canary）存在字符串碰撞，而构建流程中有一个"excluded-strings.txt"扫描，会检查构建产物中是否出现被禁止的字面量（用于防止意外泄露内部代号）。如果直接写字符串，即使是非敏感用途也会触发扫描警告。通过 `String.fromCharCode()` 在运行时构造字符串，字面量不出现在构建产物中，绕过了扫描检查，同时 `as 'duckname'` 的类型断言确保 TypeScript 类型系统知道实际值。这是一个在"正确性"（通过编译检查）和"工具兼容性"（不触发 canary 扫描）之间的务实权衡。

**Q7：Buddy 系统的 `companionMuted` 配置选项说明了什么用户体验考量？**

提供静音选项反映了"功能要有退出路径"的设计原则。终端旁边的动画精灵对不需要它的用户可能是视觉干扰，尤其在生产环境使用或截图分享代码时。`companionMuted = true` 在 `getCompanionIntroAttachment()` 和 `CompanionSprite` 渲染中都有检查，静音后完全隐藏精灵（不仅仅是隐藏动画），同时不向 Claude 的上下文注入伴侣介绍，保持对话的纯净性。

---

### 实战应用题

**Q8：如果要为 Buddy 增加"心情系统"（根据用户今日对话轮次改变精灵表情），应该在哪里实现？**

1. **状态来源**：在 `AppState` 中维护 `sessionTurnCount` 计数器，每次 AI 响应后递增。
2. **心情映射**：在 `companion.ts` 中添加 `getMood(turnCount): MoodType` 函数，将轮次映射到心情（0-5 轮：energetic，5-20 轮：focused，20+ 轮：tired）。
3. **精灵扩展**：在 `sprites.ts` 中为每个物种添加"情绪覆盖帧"（在现有帧基础上修改嘴型字符），避免为每种心情完整复制精灵定义。
4. **渲染传递**：`CompanionSprite` 接收 `mood` prop，传递给 `renderFace()` 函数，在 `{E}` 替换时同时替换嘴型占位符。
5. **气泡触发**：心情变化时（如从 focused 进入 tired）可以触发一次对话气泡（"需要休息了..."），通过 `addNotification` 系统实现。

**Q9：Buddy 功能的 `feature('BUDDY')` 开关在构建期是如何工作的？**

`feature('BUDDY')` 是 Bun 构建系统提供的编译时宏（`bun:bundle` 模块的特性）。在构建配置中，功能开关被设为 `true` 或 `false`，构建器在打包时将所有 `feature('BUDDY')` 表达式替换为字面量布尔值。若为 `false`，所有 `if (!feature('BUDDY')) return []` 的分支变成 `if (!false) return []`，即 `if (true) return []`，dead-code-elimination 步骤会识别出 `if (!false)` 后的其他分支永远不会执行，从而移除整个 Buddy 功能模块的代码，包括精灵定义（约 2KB 字符数据）、AI 提示、API 调用等。这确保外部分发版本（面向普通用户）的包体积不包含未启用功能的代码。

---

> **版权声明**：源码版权归 [Anthropic](https://www.anthropic.com) 所有，本文档基于 Claude Code v2.1.88 source map 还原版本分析，仅供学习研究使用。文档内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议。
