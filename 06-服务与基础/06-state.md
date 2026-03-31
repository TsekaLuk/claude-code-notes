# 全局状态管理 — Claude Code 源码分析

> 模块路径：`src/state/`
> 核心职责：维护 Claude Code 运行时全局状态，提供不可变更新模式与持久化机制
> 源码版本：v2.1.88

## 一、模块概述

`src/state/` 目录是 Claude Code 的状态管理核心，包含以下文件：

| 文件 | 职责 |
|---|---|
| `store.ts` | 通用 Store 工厂函数（类似 Zustand 的微型实现） |
| `AppStateStore.ts` | `AppState` 类型定义与初始状态工厂 |
| `AppState.tsx` | React `AppStateProvider` + Context，提供 `useSyncExternalStore` 集成 |
| `onChangeAppState.ts` | AppState 变更的副作用处理器（持久化、CCR 同步、缓存清除） |
| `selectors.ts` | 从 AppState 派生数据的选择器函数 |
| `hooks.ts` | 状态相关的自定义钩子 |

设计哲学：AppState 是**不可变数据树**，所有更新通过 `setState(prev => ({ ...prev, ... }))` 形式的函数映射产生新对象，而非直接 mutation。

## 二、架构设计

### 2.1 核心类/接口/函数

| 名称 | 位置 | 类型 | 说明 |
|---|---|---|---|
| `createStore<T>` | `store.ts` | 工厂函数 | 创建带订阅/通知能力的状态容器 |
| `AppState` | `AppStateStore.ts` | 类型 | 全局状态的完整形状（DeepImmutable） |
| `AppStateProvider` | `AppState.tsx` | React 组件 | Context 提供器，提供全局 store 实例 |
| `onChangeAppState` | `onChangeAppState.ts` | 回调函数 | 状态变更后的副作用执行器 |
| `getDefaultAppState` | `AppStateStore.ts` | 工厂函数 | 生成含初始值的默认 AppState 对象 |

### 2.2 模块依赖关系图

```
main.tsx / replLauncher.tsx
        │
        ▼
AppStateProvider (AppState.tsx)
        │  createStore(initialState, onChangeAppState)
        ▼
store.ts: Store<AppState>
        │  getState() / setState() / subscribe()
        ├─► React: useSyncExternalStore → 触发重渲染
        │
        └─► onChangeAppState (副作用)
                │
                ├─► utils/config.ts (saveGlobalConfig → 磁盘持久化)
                ├─► utils/settings/settings.ts (updateSettingsForSource)
                ├─► bootstrap/state.ts (setMainLoopModelOverride)
                ├─► utils/sessionState.ts (notifySessionMetadataChanged → CCR)
                └─► utils/auth.ts (clearApiKeyHelperCache / 凭证缓存清除)
```

### 2.3 关键数据流

**状态更新与副作用**：
```
组件/命令调用 store.setState(prev => ({ ...prev, mainLoopModel: 'sonnet' }))
        │
        ▼
store.ts: setState
        │  Object.is(next, prev) 相等性检查
        │  若不等 → 更新 state
        │
        ├─► onChange({ newState, oldState }) ── onChangeAppState
        │           │
        │           ├─► mainLoopModel 变更 → updateSettingsForSource + setMainLoopModelOverride
        │           ├─► expandedView 变更 → saveGlobalConfig (持久化 UI 偏好)
        │           ├─► verbose 变更 → saveGlobalConfig
        │           ├─► permission_mode 变更 → notifySessionMetadataChanged (CCR 同步)
        │           └─► settings 变更 → clearApiKeyHelperCache + 凭证缓存清除
        │
        └─► 通知所有 listeners → useSyncExternalStore 触发 React 重渲染
```

**持久化写入路径**：
```
AppState.expandedView 变更
    │
    ▼
onChangeAppState → saveGlobalConfig(current => ({
    ...current,
    showExpandedTodos: newState.expandedView === 'tasks',
    showSpinnerTree: newState.expandedView === 'teammates'
}))
    │
    ▼
utils/config.ts → 写入 ~/.claude/globalConfig.json（磁盘）
```

## 三、核心实现走读

### 3.1 关键流程

1. **Store 的极简实现**：`createStore` 仅 34 行，实现了 `getState`/`setState`/`subscribe` 三个方法。`setState` 用 `Object.is` 检测引用相等性，相等时跳过（防止不必要的重渲染）；不等时依次触发 `onChange` 回调和所有订阅者。

2. **DeepImmutable 类型约束**：`AppState` 被 `DeepImmutable<{...}>` 包裹，使所有嵌套字段在 TypeScript 层面变为 `readonly`，从类型系统阻止直接 mutation。调用 `setState(prev => ({ ...prev, x: newVal }))` 是唯一合法的更新路径。

3. **React Compiler 优化**：`AppState.tsx` 中可见 `_c`（`react/compiler-runtime` 的缓存原语），React Compiler 自动将组件树的渲染函数记忆化，`AppStateProvider` 的子树只在依赖的 state 切片变化时重渲染。

4. **设置变更的副作用链**：`onChangeAppState` 检测 7 种以上的 state 差异并分别处理：模型变更、UI 偏好变更、权限模式变更、verbose 变更、tungstenPanelVisible（ant 专属）变更、settings 整体变更。每种变更对应不同的持久化或同步动作，形成可扩展的副作用注册表。

5. **CCR 权限模式同步**：`toolPermissionContext.mode` 变更时，`onChangeAppState` 通过 `toExternalPermissionMode` 过滤掉内部模式名（`bubble`、`auto`），仅将外部可见模式变更通知 CCR，避免噪音。`notifyPermissionModeChanged` 则通知 SDK 状态流（所有客户端订阅者）。

### 3.2 重要源码片段

**`store.ts` — 极简 Store 实现**
```typescript
// src/state/store.ts
export function createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,

    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return  // 引用相等则跳过，防止无效重渲染
      state = next
      onChange?.({ newState: next, oldState: prev })  // 副作用优先于订阅者
      for (const listener of listeners) listener()    // 通知 React / 其他订阅者
    },

    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)  // 返回取消订阅函数
    },
  }
}
```

**`AppStateStore.ts` — AppState 类型结构（部分）**
```typescript
// src/state/AppStateStore.ts
export type AppState = DeepImmutable<{
  settings: SettingsJson              // 当前合并后的配置
  mainLoopModel: ModelSetting         // 主循环使用的模型
  toolPermissionContext: ToolPermissionContext  // 权限规则 + 模式
  verbose: boolean                    // 是否显示详细输出
  expandedView: 'none' | 'tasks' | 'teammates'  // 展开视图状态
  isUltraplanMode: boolean            // Ultraplan 模式标志
  kairosEnabled: boolean              // 助手模式开关
  // ... 20+ 字段
}>
```

**`onChangeAppState.ts` — 权限模式变更的 CCR 同步**
```typescript
// src/state/onChangeAppState.ts
const prevMode = oldState.toolPermissionContext.mode
const newMode = newState.toolPermissionContext.mode
if (prevMode !== newMode) {
  const prevExternal = toExternalPermissionMode(prevMode)
  const newExternal = toExternalPermissionMode(newMode)
  if (prevExternal !== newExternal) {
    // 仅外部可见模式变化时才通知 CCR（过滤 bubble/auto 等内部模式）
    const isUltraplan = newExternal === 'plan' && newState.isUltraplanMode ? true : null
    notifySessionMetadataChanged({ permission_mode: newExternal, is_ultraplan_mode: isUltraplan })
  }
  notifyPermissionModeChanged(newMode)  // SDK 状态流（包含内部模式名）
}
```

**`onChangeAppState.ts` — settings 变更触发凭证缓存清除**
```typescript
// src/state/onChangeAppState.ts
if (newState.settings !== oldState.settings) {
  try {
    clearApiKeyHelperCache()   // API key helper 缓存
    clearAwsCredentialsCache() // AWS STS 凭证缓存
    clearGcpCredentialsCache() // GCP ADC 凭证缓存

    if (newState.settings.env !== oldState.settings.env) {
      applyConfigEnvironmentVariables()  // 将 settings.env 写入 process.env
    }
  } catch (error) {
    logError(toError(error))
  }
}
```

### 3.3 设计模式分析

- **Flux/Redux 精简版**：Store 实现了 Flux 单向数据流，`setState` 对应 `dispatch`，`updater` 函数对应 `reducer`，`onChange` 对应 middleware/effect。
- **观察者模式**：`subscribe` 实现经典发布-订阅，`useSyncExternalStore` 将 React 渲染函数注册为订阅者，状态变更自动触发重渲染。
- **命令模式（副作用注册）**：`onChangeAppState` 将各类副作用集中注册，代替之前分散在多个 `setAppState` 调用处的临时处理，形成单一可审计的副作用入口。
- **不可变模式**：`DeepImmutable` 类型 + spread 更新的组合，确保每次状态变更产生全新对象树，`Object.is` 比较可以精确检测变更而无需深比较。

## 四、高频面试 Q&A

### 设计决策题

**Q1：Claude Code 为什么自己实现一个 Store 而不使用 Zustand / Jotai / Redux？**

> Claude Code 使用 Ink（终端 UI 框架），对 React 生态的依赖是刻意最小化的，避免引入过重的客户端状态管理库。自实现的 `createStore` 仅 34 行，完全满足需求：不可变更新、订阅通知、`useSyncExternalStore` 集成。没有选择器、时间旅行、中间件等复杂功能，符合 YAGNI 原则。Zustand 的核心实现也非常相似（同样基于 `Object.is`），但引入额外依赖会增加 bundle 体积并在终端环境中引入 DOM 相关类型。

**Q2：`onChangeAppState` 为什么必须在 `store.ts` 的 `onChange` 回调中调用，而不能在 React 的 `useEffect` 中处理这些副作用？**

> Claude Code 有大量非 React 的调用路径（headless 模式、SDK 调用、CLI 命令），这些路径中没有 React 渲染循环，`useEffect` 不会触发。如果副作用只在 `useEffect` 中处理，那么通过 `store.setState` 更改权限模式就不会触发 CCR 同步，`settings` 变更也不会清除凭证缓存。将副作用注册在 `onChange` 确保无论是 React 组件、CLI 命令还是 SDK 调用触发的状态变更，副作用都能可靠执行。

### 原理分析题

**Q3：`Object.is(next, prev)` 如何保证不可变更新的性能？**

> 通过 spread 操作符（`{ ...prev, field: newVal }`）更新时，只要至少有一个字段不同，产生的对象与原对象引用不等（`Object.is` 返回 false），触发副作用和重渲染。反之，如果 `setState(prev => prev)`（无变化），返回相同引用，`Object.is` 返回 true，完全跳过渲染。这比深比较（deep equal）效率高几个数量级，代价是调用方必须遵守「不直接 mutation」规则——这由 `DeepImmutable` 类型在编译期强制。

**Q4：`externalMetadataToAppState` 函数的用途是什么？**

> 当 CCR（Claude Code Remote）worker 重启时（网络中断后重连），服务端发送 `session_external_metadata`（包含 `permission_mode`、`is_ultraplan_mode` 等字段）来恢复会话状态。`externalMetadataToAppState` 将这些外部格式的元数据转换为 AppState 更新函数，这是 `onChangeAppState` 推送方向的逆操作：CCR push → worker 恢复，形成双向同步。

**Q5：`AppStateProvider` 为什么不允许嵌套（抛出错误）？**

> `HasAppStateContext` 是一个布尔 Context，`AppStateProvider` 挂载时通过 `useContext(HasAppStateContext)` 检测自己是否已被包裹在另一个 `AppStateProvider` 中。嵌套的 Provider 会创建两个独立的 Store 实例，子树组件读取内层 store，父树组件读取外层 store，权限模式、模型配置等全局状态会出现不一致。禁止嵌套确保「全局状态唯一性」。

### 权衡与优化题

**Q6：状态树中有 20+ 个字段，每次更新都生成新对象，GC 压力如何？**

> 由于 `Object.is` 引用比较，只有实际发生变更的字段才会触发 React 重渲染。AppState 是一个浅对象（非深层嵌套），spread 操作仅复制顶层属性的引用（O(n) 字段数），不递归复制。对于高频更新的字段（如 `spinnerTip`），React Compiler 的自动记忆化确保只有依赖该字段的组件重渲染。整体上，状态更新的 GC 开销与传统 React 状态管理相当，且 Node.js/V8 的 GC 对短存活对象（年轻代）优化良好。

**Q7：`onChangeAppState` 中的持久化操作（`saveGlobalConfig`）如果失败会怎样？**

> 当前实现中，`onChangeAppState` 的 settings 变更分支有 try-catch 处理（`clearApiKeyHelperCache` 等可能抛出），但 `saveGlobalConfig`（写入磁盘）的调用（`expandedView`、`verbose` 等分支）没有 try-catch，写入失败会静默丢失（没有 `logError`）。这是一个轻微的健壮性问题：磁盘满或权限问题时，用户偏好可能不被保存。实际影响有限，因为这些是 UI 偏好（展开状态、verbose 模式），不影响功能。

### 实战应用题

**Q8：如何在不破坏不可变性原则的情况下向 AppState 添加新字段？**

> 1. 在 `AppStateStore.ts` 的 `AppState` 类型定义中添加新字段（TypeScript 会强制所有创建点更新）；2. 在 `getDefaultAppState()` 工厂函数中添加初始值；3. 如果新字段需要持久化，在 `onChangeAppState` 中添加相应的 diff 检测和 `saveGlobalConfig` 调用；4. 所有状态更新都通过 `store.setState(prev => ({ ...prev, newField: value }))` 进行，无需修改 store 本身；5. 若有 CCR 同步需求，在 `notifySessionMetadataChanged` 调用处添加对应字段。

**Q9：如何在 headless 模式（无 React）下使用 AppState？**

> `store.ts` 的 `createStore` 完全不依赖 React，可在非 React 环境中直接使用：`const store = createStore(getDefaultAppState(), onChangeAppState)`，然后通过 `store.getState()` 读取、`store.setState(prev => ...)` 更新。这正是 CLI 模式（`print.ts`/`headless mode`）的工作方式——`onChangeAppState` 中的 `notifyPermissionModeChanged` 在 headless 模式下也能正常工作，因为注册的监听器不依赖 React 渲染。

---
> **版权声明**：源码版权归 [Anthropic](https://www.anthropic.com) 所有，本文档基于 Claude Code v2.1.88 source map 还原版本分析，仅供学习研究使用。文档内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议。
