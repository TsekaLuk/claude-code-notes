# 插件系统（Plugin System）— Claude Code 源码分析

> 模块路径：`src/plugins/`
> 核心职责：管理可用户启用/禁用的内置插件，并将插件的技能、钩子、MCP 服务器组合注入运行时
> 源码版本：v2.1.88

## 一、模块概述

Claude Code 的插件系统分为两个层次：

1. **内置插件（Built-in Plugins）**：随 CLI 发布、出现在 `/plugin` UI 中，用户可手动启用或禁用，状态持久化到用户设置文件。ID 格式为 `{name}@builtin`。
2. **市场插件（Marketplace Plugins）**：通过 Git 仓库或市场安装，ID 格式为 `{name}@{marketplace}`，由独立的 `pluginLoader.ts` 管理（不在本模块范围内）。

`src/plugins/builtinPlugins.ts` 是内置插件的注册中心；`src/plugins/bundled/index.ts` 是启动时初始化的入口，目前为"脚手架"状态（尚无注册任何插件），留待后续将 Bundled Skills 逐步迁移进来。

插件与"捆绑技能（Bundled Skills）"的关键区别：捆绑技能直接编译进 CLI 且总是启用，插件则是用户可选的功能单元。

## 二、架构设计

### 2.1 核心类 / 接口 / 函数

**`BuiltinPluginDefinition`**（`src/types/plugin.ts`）
插件的静态元数据声明，包含：
- `name` / `description` / `version`：展示信息
- `skills?: BundledSkillDefinition[]`：该插件提供的技能列表
- `hooks?: HooksSettings`：该插件注册的钩子
- `mcpServers?: Record<string, McpServerConfig>`：插件提供的 MCP 服务器
- `isAvailable?: () => boolean`：可用性判断（如依赖系统特性时返回 false 则整体隐藏）
- `defaultEnabled?: boolean`：默认启用状态（缺省为 true）

**`LoadedPlugin`**（`src/types/plugin.ts`）
运行时的插件实例，在 `BuiltinPluginDefinition` 基础上增加：
- `path`：文件系统路径（内置插件固定为字符串 `'builtin'`）
- `source` / `repository`：格式 `{name}@builtin`
- `enabled`：当前启用状态
- `isBuiltin`：标识为内置插件

**`PluginError`**（`src/types/plugin.ts`）
17 种类型的可辨识联合错误类型，涵盖从文件路径缺失、Git 认证失败到 MCP 配置无效等所有加载失败场景。当前生产中实际使用的只有 `generic-error` 和 `plugin-not-found`，其余为规划中的错误细化路线图。

**`registerBuiltinPlugin`**（`src/plugins/builtinPlugins.ts`）
将 `BuiltinPluginDefinition` 注册到进程级 `BUILTIN_PLUGINS: Map<string, BuiltinPluginDefinition>` 中。Map 以 `name` 为键，保证名称唯一。

**`getBuiltinPluginSkillCommands`**（`src/plugins/builtinPlugins.ts`）
读取所有已启用插件的技能定义，通过 `skillDefinitionToCommand()` 转换为 `Command` 对象，注入到命令系统中供 `/skill` 工具调用。

### 2.2 模块依赖关系图

```mermaid
graph TD
    A[CLI 启动] --> B[initBuiltinPlugins\nsrc/plugins/bundled/index.ts\n目前为空，脚手架]
    B --> C[BUILTIN_PLUGINS: Map\nsrc/plugins/builtinPlugins.ts]
    C --> D[getBuiltinPlugins\n读取 getSettings_DEPRECATED 用户偏好\n检查 isAvailable 可用性过滤\n返回 enabled / disabled]
    C --> E[getBuiltinPluginSkillCommands\nskillDefinitionToCommand 技能转命令\n注入 Command[] → commands.ts / Skill 工具]

    subgraph types/plugin.ts
        F[BuiltinPluginDefinition]
        G[LoadedPlugin]
        H[PluginError 17 种]
        I[PluginLoadResult\nenabled: LoadedPlugin\ndisabled: LoadedPlugin\nerrors: PluginError]
    end
```

### 2.3 关键数据流

**启动阶段**
```
initBuiltinPlugins()
    → registerBuiltinPlugin(def)
    → BUILTIN_PLUGINS.set(def.name, def)
```

**命令注入阶段**
```
getBuiltinPluginSkillCommands()
    → getBuiltinPlugins().enabled
    → 对每个 enabled plugin 取其 definition.skills
    → skillDefinitionToCommand(skill) → Command { source: 'bundled' }
    → 推入全局命令列表
```

**启用状态判定（三级优先级）**
```
用户设置 settings.enabledPlugins[pluginId]
    有值 → 直接使用（true/false）
    无值 → definition.defaultEnabled ?? true
```

## 三、核心实现走读

### 3.1 关键流程

1. **注册**：启动时调用 `initBuiltinPlugins()`，内部通过 `registerBuiltinPlugin(def)` 将每个插件写入 `BUILTIN_PLUGINS` Map。
2. **可用性过滤**：`getBuiltinPlugins()` 遍历 Map，先调用 `definition.isAvailable?.()` —— 返回 false 的插件完全不暴露给 UI。
3. **启用状态合并**：读取 `settings.enabledPlugins[pluginId]` 中的用户偏好，缺省回退到 `defaultEnabled`，再缺省到 `true`。
4. **技能转命令**：`skillDefinitionToCommand()` 将 `BundledSkillDefinition` 映射为 `Command` 对象，`source` 字段强制设为 `'bundled'`（区别于内置命令 `/help` 的 `'builtin'`），以便：
   - 保留在 Skill 工具的技能列表中
   - 分析日志使用正确名称前缀
   - 在提示词截断时获得豁免
5. **错误建模**：`PluginError` 使用可辨识联合类型，每种错误携带专属上下文字段，`getPluginErrorMessage()` 通过 `switch` 穷举所有分支生成人类可读信息。

### 3.2 重要源码片段

**片段一：插件启用状态判定**（`src/plugins/builtinPlugins.ts`）
```typescript
// 三级优先级：用户设置 > 插件默认 > true
const userSetting = settings?.enabledPlugins?.[pluginId]
const isEnabled =
  userSetting !== undefined
    ? userSetting === true
    : (definition.defaultEnabled ?? true)
```

**片段二：技能转命令（source 字段注释）**（`src/plugins/builtinPlugins.ts`）
```typescript
// 'bundled' 而非 'builtin' —— 'builtin' 在 Command.source 中
// 表示硬编码斜杠命令（/help, /clear）。使用 'bundled' 保证：
// 1. Skill 工具能列出这些技能
// 2. 分析日志使用正确名称
// 3. 提示词截断时享受豁免
source: 'bundled',
loadedFrom: 'bundled',
```

**片段三：isAvailable 过滤**（`src/plugins/builtinPlugins.ts`）
```typescript
for (const [name, definition] of BUILTIN_PLUGINS) {
  // 不可用的插件（如系统不满足条件）直接跳过，不出现在 UI 中
  if (definition.isAvailable && !definition.isAvailable()) {
    continue
  }
  // ... 后续启用状态计算
}
```

**片段四：PluginError 可辨识联合类型（节选）**（`src/types/plugin.ts`）
```typescript
export type PluginError =
  | { type: 'path-not-found'; source: string; path: string; component: PluginComponent }
  | { type: 'git-auth-failed'; source: string; gitUrl: string; authType: 'ssh' | 'https' }
  | { type: 'plugin-not-found'; source: string; pluginId: string; marketplace: string }
  | { type: 'generic-error'; source: string; error: string }
  // ... 共 17 种
```

### 3.3 设计模式分析

**注册表模式（Registry Pattern）**：`BUILTIN_PLUGINS` 是一个进程级单例 Map，通过 `registerBuiltinPlugin()` 集中注册、`getBuiltinPlugins()` 统一读取。测试时提供 `clearBuiltinPlugins()` 重置状态，避免测试间污染。

**可辨识联合（Discriminated Union）**：`PluginError` 的 17 种错误类型通过 `type` 字段区分，`getPluginErrorMessage()` 利用 TypeScript 穷举检查（switch）保证所有分支都被处理，新增错误类型时编译器会强制要求补全。

**三层优先级合并**：用户设置 > 插件默认值 > 系统默认值（true），与 VS Code 的设置覆盖机制同构，用户体验直观。

**惰性脚手架（Lazy Scaffold）**：`initBuiltinPlugins()` 当前是空函数，但架构已完整，注释明确说明这是为"将 bundled skills 逐步迁移到用户可切换插件"预留的扩展点。

## 四、高频面试 Q&A

### 设计决策题

**Q1：内置插件（Built-in Plugin）和捆绑技能（Bundled Skill）有什么本质区别？为什么要设计两套机制？**

捆绑技能编译进 CLI 二进制，始终启用，不出现在 `/plugin` UI 中；内置插件同样随 CLI 发布，但用户可在 UI 中切换启用状态，并且插件可以打包多个组件（技能 + 钩子 + MCP 服务器）。设计两套机制的原因是：并非所有功能都需要用户控制——系统级工具如 `verify`、`batch` 适合总是可用，而需要额外配置或可能影响性能的功能（如 Chrome 集成）适合做成可选插件。

**Q2：为什么 `skillDefinitionToCommand()` 将 source 设为 `'bundled'` 而非 `'builtin'`？**

`Command.source` 中的 `'builtin'` 专指硬编码的斜杠命令（`/help`、`/clear`），它们不走 Skill 工具路径。如果插件技能也标记为 `'builtin'`，会导致：Skill 工具的技能列表中找不到它们、分析日志命名错误、提示词截断时被错误处理。使用 `'bundled'` 则复用了 Bundled Skills 的全部下游逻辑，只需在 `LoadedPlugin.isBuiltin` 上记录"来自内置插件"这一事实。

### 原理分析题

**Q3：插件启用状态是如何持久化和读取的？**

启用状态存储在用户设置文件（JSON）的 `enabledPlugins` 字段中，键为 `{name}@builtin` 格式的插件 ID。`getBuiltinPlugins()` 在每次调用时通过 `getSettings_DEPRECATED()` 读取最新设置，再与 `definition.defaultEnabled` 合并，保证每次调用都反映最新的用户偏好。

**Q4：`PluginError` 为什么使用可辨识联合而不是继承体系或错误码字符串？**

可辨识联合有三个优势：1) TypeScript 编译器在 `switch` 穷举时能检测未处理的分支，新增错误类型时不会漏掉；2) 每种错误类型携带专属字段（如 `git-auth-failed` 有 `authType`），比字符串错误码更类型安全；3) 比继承体系更轻量，无需类实例化，序列化也更简单。注释中明确说明当前只有 2 种类型在生产中使用，其余 15 种是"已规划的未来路线图"。

**Q5：`isAvailable()` 回调的典型使用场景是什么？**

以 Claude in Chrome 插件为例：该功能依赖浏览器扩展通信，只在特定环境下有意义。`isAvailable()` 会检测系统是否满足条件（如是否安装了扩展、是否在支持的 OS 上），不满足时整个插件从 UI 中消失，避免用户看到无法使用的选项。

### 权衡与优化题

**Q6：`BUILTIN_PLUGINS` 使用进程级单例 Map 有什么优缺点？**

优点：查找 O(1)，无额外序列化开销，注册即可用。缺点：全局状态难以在并发测试中隔离（因此提供了 `clearBuiltinPlugins()` 测试工具）；进程重启才能感知新注册的插件（不支持热加载）。对于 CLI 工具这种单进程短生命周期场景，单例 Map 是合理的取舍。

**Q7：当前 `initBuiltinPlugins()` 是空函数，这会有性能影响吗？**

不会。空函数调用开销可忽略不计，且架构设计允许在不改变调用方的情况下逐步填充内容。这是"为扩展开放、为修改关闭"（OCP）的典型应用——调用方代码不需要改变，只需在 `initBuiltinPlugins()` 中增加 `registerBuiltinPlugin(...)` 调用即可上线新插件。

### 实战应用题

**Q8：如何添加一个新的内置插件？**

按照 `src/plugins/bundled/index.ts` 的注释，步骤为：
1. 在 `src/plugins/bundled/` 中创建插件模块文件（如 `myPlugin.ts`）
2. 在文件中调用 `registerBuiltinPlugin({ name: 'my-plugin', description: '...', skills: [...] })`
3. 在 `initBuiltinPlugins()` 中导入并调用注册函数
4. 如需条件可用，实现 `isAvailable()` 回调

**Q9：如何为插件实现"企业策略禁止"逻辑？**

`PluginError` 中已预定义 `marketplace-blocked-by-policy` 类型，包含 `blockedByBlocklist`（是否在黑名单中）和 `allowedSources`（允许的来源列表）字段。在加载器层面，检测企业策略配置后返回此错误即可；UI 层通过 `getPluginErrorMessage()` 将其格式化为用户友好的说明。

---
> **版权声明**：源码版权归 [Anthropic](https://www.anthropic.com) 所有，本文档基于 Claude Code v2.1.88 source map 还原版本分析，仅供学习研究使用。文档内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议。
