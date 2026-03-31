# 技能系统（Skill System）— Claude Code 源码分析

> 模块路径：`src/skills/`
> 核心职责：管理和加载可复用的提示词驱动工作流（技能），统一为 Command 对象注入命令系统
> 源码版本：v2.1.88

## 一、模块概述

技能（Skill）是 Claude Code 中一种可复用的提示词工作流，用户或系统可以通过 `/skill-name [args]` 的形式触发。技能在概念上是"用户可定义的命令模板"，在实现上统一被转化为 `Command` 对象，与内置斜杠命令共享同一套执行管道。

`src/skills/` 目录包含四个核心文件：

| 文件 | 职责 |
|------|------|
| `bundledSkills.ts` | 编译进 CLI 的内置技能注册表及安全提取机制 |
| `loadSkillsDir.ts` | 从文件系统（`.claude/skills/`）加载用户自定义技能 |
| `mcpSkillBuilders.ts` | 解决 MCP 技能加载与 loadSkillsDir 之间的循环依赖 |
| `bundled/index.ts` | 所有内置技能的初始化入口 |

### 技能 vs 命令的关系

技能是命令的一种实现形式。所有技能最终都被转换为 `Command` 对象，区分只在 `source` 字段：

| source 值 | 含义 |
|-----------|------|
| `'builtin'` | 硬编码的斜杠命令（`/help`, `/clear`） |
| `'bundled'` | 随 CLI 发布的内置技能 |
| `'skills'` | 用户在 `.claude/skills/` 中定义的技能 |
| `'plugin'` | 通过插件加载的技能 |
| `'mcp'` | MCP 服务器提供的技能 |
| `'managed'` | 企业策略管理的技能 |

## 二、架构设计

### 2.1 核心类 / 接口 / 函数

**`BundledSkillDefinition`**（`src/skills/bundledSkills.ts`）
内置技能的声明类型，关键字段：
- `name` / `description`：技能标识和描述
- `allowedTools?: string[]`：此技能被调用时允许使用的工具列表
- `files?: Record<string, string>`：技能所需的参考文件（路径→内容映射），首次调用时惰性提取到磁盘
- `context?: 'inline' | 'fork'`：执行上下文，`fork` 表示在独立子 Agent 中运行
- `disableModelInvocation?: boolean`：禁用模型调用（用于纯提示词传递的技能）
- `getPromptForCommand: (args, context) => Promise<ContentBlockParam[]>`：核心方法，返回技能的提示词内容块

**`registerBundledSkill`**（`src/skills/bundledSkills.ts`）
将 `BundledSkillDefinition` 转换为 `Command` 并推入内部注册表。若技能包含 `files`，会在原始 `getPromptForCommand` 外包裹一层惰性提取逻辑，并在提示词前自动追加 `"Base directory for this skill: <dir>"` 前缀，让模型知道从哪里读取参考文件。

**`getBundledSkills`**（`src/skills/bundledSkills.ts`）
返回内部注册表的浅拷贝（防止外部修改），供命令系统在运行时查询。

**`parseSkillFrontmatterFields`**（`src/skills/loadSkillsDir.ts`）
解析 Markdown 技能文件头部的 YAML frontmatter，提取 `description`、`allowed-tools`、`argument-hint`、`when-to-use`、`model`、`effort`、`user-invocable`、`hooks` 等字段。这是文件系统技能和 MCP 技能共用的解析核心。

**`MCPSkillBuilders`** + **`registerMCPSkillBuilders`**（`src/skills/mcpSkillBuilders.ts`）
一个"写一次"的依赖注入容器，存储 `createSkillCommand` 和 `parseSkillFrontmatterFields` 两个函数引用。之所以单独抽出这个模块，是为了打破 `client.ts → mcpSkills.ts → loadSkillsDir.ts → ... → client.ts` 的循环依赖，同时避免动态 import 在 Bun 打包产物中的路径解析问题。

### 2.2 模块依赖关系图

```
CLI 启动
    │
    ▼
initBundledSkills()                    ← bundled/index.ts
    │
    ├── registerUpdateConfigSkill()
    ├── registerKeybindingsSkill()
    ├── registerVerifySkill()
    ├── registerBatchSkill()
    ├── registerSkillifySkill()         ← 仅 USER_TYPE=ant
    ├── registerRememberSkill()
    ├── registerSimplifySkill()
    ├── registerStuckSkill()
    └── feature flag 控制的技能（dream/hunter/loop/...）
            │
            ▼
    registerBundledSkill(def)          ← bundledSkills.ts
            │
            ├── files 处理（惰性提取）
            └── bundledSkills[] ──────► getBundledSkills() → Command[]

用户技能（文件系统）                   ← loadSkillsDir.ts
    .claude/skills/*.md
    ~/.claude/skills/*.md
    插件 skills 目录
            │
            ▼
    parseSkillFrontmatterFields()
    createSkillCommand()
            │
            └──────────────────────── → Command { source: 'skills' | 'plugin' }

MCP 服务器技能                         ← mcpSkillBuilders.ts（注入桥）
    MCP Tool → Skill
            │
            └──────────────────────── → Command { source: 'mcp' }
```

### 2.3 关键数据流

**技能调用数据流**
```
用户输入 "/verify fix the null pointer bug"
    │
    ▼
命令系统匹配 Command { name: 'verify', source: 'bundled' }
    │
    ▼
command.getPromptForCommand(args="fix the null pointer bug", context)
    │
    ├── [若有 files] extractionPromise ??= extractBundledSkillFiles(...)
    │       └── 惰性提取参考文件到 ~/.claude/bundled-skills/verify/
    │
    ▼
返回 ContentBlockParam[]（提示词内容块）
    │
    ▼
注入 Agent 上下文，模型执行技能逻辑
```

**文件安全提取流**
```
safeWriteFile(path, content)
    │
    ├── open(p, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)
    │       ← 防止竞争条件和符号链接攻击
    │
    └── fh.writeFile(content)
```

## 三、核心实现走读

### 3.1 关键流程

1. **注册**：`initBundledSkills()` 在 CLI 启动时调用，按顺序调用每个内置技能的 `register*Skill()` 函数。
2. **技能文件提取（惰性）**：若技能定义了 `files` 字段，`registerBundledSkill()` 会用闭包包装原始的 `getPromptForCommand`，首次调用时触发 `extractBundledSkillFiles()` 将内嵌文件写入磁盘，后续调用复用同一个 `extractionPromise`（Promise 记忆化，防止并发写入竞争）。
3. **路径安全**：`resolveSkillFilePath()` 检查相对路径中是否包含 `..` 或绝对路径，防止目录遍历攻击；`safeWriteFile()` 使用 `O_EXCL|O_NOFOLLOW` 标志防止符号链接攻击和重复写入。
4. **提示词前缀注入**：技能提示词首个文本块前会自动追加 `"Base directory for this skill: <dir>\n\n"`，模型据此知道参考文件的磁盘位置，可直接用 `Read`/`Grep` 工具查阅。
5. **Feature Flag 控制**：部分内置技能（`dream`、`hunter`、`loop` 等）由 Bun 的 `feature()` 函数控制，只在特定功能标志开启时注册，使用动态 `require()` 而非静态 `import` 以保持 tree-shaking 效果。
6. **MCP 技能桥接**：`mcpSkillBuilders.ts` 在模块初始化时（loadSkillsDir.ts 加载时）调用 `registerMCPSkillBuilders()`，将两个核心函数的引用写入单例，MCP 技能加载器通过 `getMCPSkillBuilders()` 取用，无需直接 import loadSkillsDir。

### 3.2 重要源码片段

**片段一：Promise 记忆化防止并发写入竞争**（`src/skills/bundledSkills.ts`）
```typescript
// 进程内单次提取的 Promise 记忆化：
// 并发调用方 await 同一个 Promise，而非各自竞争写入
let extractionPromise: Promise<string | null> | undefined
getPromptForCommand = async (args, ctx) => {
  extractionPromise ??= extractBundledSkillFiles(definition.name, files)
  const extractedDir = await extractionPromise
  const blocks = await inner(args, ctx)
  if (extractedDir === null) return blocks
  return prependBaseDir(blocks, extractedDir)
}
```

**片段二：安全文件写入（防符号链接攻击）**（`src/skills/bundledSkills.ts`）
```typescript
// O_EXCL：文件已存在则报错（不覆盖）
// O_NOFOLLOW：最终路径组件为符号链接则报错
const SAFE_WRITE_FLAGS =
  process.platform === 'win32'
    ? 'wx'
    : fsConstants.O_WRONLY | fsConstants.O_CREAT |
      fsConstants.O_EXCL | O_NOFOLLOW
async function safeWriteFile(p: string, content: string): Promise<void> {
  const fh = await open(p, SAFE_WRITE_FLAGS, 0o600)
  try { await fh.writeFile(content, 'utf8') }
  finally { await fh.close() }
}
```

**片段三：依赖注入桥（打破循环依赖）**（`src/skills/mcpSkillBuilders.ts`）
```typescript
// 写一次的注册表，避免形成循环依赖
// loadSkillsDir.ts 模块初始化时注册，MCP 加载器通过此接口取用
let builders: MCPSkillBuilders | null = null
export function registerMCPSkillBuilders(b: MCPSkillBuilders): void {
  builders = b
}
export function getMCPSkillBuilders(): MCPSkillBuilders {
  if (!builders) throw new Error('MCP skill builders not registered')
  return builders
}
```

**片段四：Frontmatter 技能字段解析**（`src/skills/loadSkillsDir.ts`）
```typescript
// 从 Markdown frontmatter 提取技能元数据
// 缺失 description 时自动从 Markdown 内容首段提取
export function parseSkillFrontmatterFields(
  frontmatter: FrontmatterData,
  markdownContent: string,
  resolvedName: string,
): { description: string; allowedTools: string[]; ... } {
  const description = validatedDescription ??
    extractDescriptionFromMarkdown(markdownContent, 'Skill')
  // ...
}
```

### 3.3 设计模式分析

**工厂模式（Factory）**：`registerBundledSkill()` 和 `createSkillCommand()`（在 loadSkillsDir.ts 中）都是工厂函数，将技能定义（`BundledSkillDefinition` 或 frontmatter 解析结果）转换为统一的 `Command` 对象，调用方无需了解 `Command` 的构造细节。

**模板方法（Template Method）**：`getPromptForCommand` 是技能的核心钩子，每个技能提供自己的实现，但框架负责在调用前后注入文件提取、路径前缀等横切关注点。

**依赖注入（Dependency Injection）**：`mcpSkillBuilders.ts` 是一个极简的 DI 容器，解决了 Bun 打包环境下动态 import 不可靠的问题，同时避免静态 import 造成的循环依赖。这是针对特定打包工具限制的务实解法。

**惰性初始化（Lazy Initialization）**：技能的参考文件不在注册时提取，而是在首次实际调用时才写入磁盘，避免启动时不必要的 I/O 开销，且通过 Promise 记忆化保证幂等性。

## 四、高频面试 Q&A

### 设计决策题

**Q1：技能（Skill）和命令（Command）是什么关系？为什么不分开设计两套数据结构？**

技能是命令的超集的一种实现方式——所有技能最终都被转化为 `Command` 对象，`source` 字段区分来源。统一为 `Command` 的好处在于：命令系统（包括 Skill 工具、前缀匹配、分析日志、提示词截断豁免等）的所有逻辑无需感知"这是哪种来源的命令"，降低了下游系统的复杂度。代价是 `Command` 类型中有些字段对内置斜杠命令有意义、对技能无意义（如 `contentLength`），但通过文档约定可以接受。

**Q2：为什么 `mcpSkillBuilders.ts` 不直接用动态 import？**

注释中明确说明：Bun 打包产物（`/$bunfs/root/...`）中，非字面量的动态 import specifier 会被解析为打包 chunk 内部的路径，导致"Cannot find module"错误。字面量动态 import 虽然在 bunfs 中可用，但 dependency-cruiser 会追踪静态分析到的循环依赖，一条边会在 diff 检查中产生大量循环违规。因此采用写一次注册表的方式，既规避了打包器限制，又不引入新的循环依赖边。

### 原理分析题

**Q3：技能的参考文件（files 字段）是如何安全提取到磁盘的？**

提取路径由 `getBundledSkillsRoot()` 返回的基础目录加上技能名称组成，基础目录包含一个进程级 nonce（随机数），防止攻击者预先创建符号链接。实际写入使用 `O_EXCL|O_NOFOLLOW` 标志：`O_EXCL` 保证文件不存在时才创建，`O_NOFOLLOW` 保证最终路径组件不为符号链接。路径本身经过 `resolveSkillFilePath()` 验证，拒绝包含 `..` 或绝对路径的输入（防目录遍历）。文件权限设为 `0o600`（仅所有者读写）。

**Q4：用户自定义技能（文件系统技能）是如何加载的？**

`loadSkillsDir.ts` 扫描多个目录（`policySettings`、`userSettings`、`projectSettings`、插件目录），读取每个 `.md` 文件，解析 YAML frontmatter（`parseFrontmatter()`），调用 `parseSkillFrontmatterFields()` 提取元数据，再通过 `createSkillCommand()` 构造 `Command` 对象。去重逻辑通过 `realpath()` 解析符号链接获取规范路径，避免通过不同路径加载同一文件。

**Q5：`context: 'fork'` 的技能和 `context: 'inline'` 的技能有什么区别？**

`fork` 表示技能在独立的子 Agent 上下文中运行，拥有自己的消息历史，不会污染主对话上下文，适合自包含的自动化任务（如 `verify`）；`inline` 则在当前对话上下文中执行，模型可以直接参考之前的消息历史，适合需要用户实时干预的工作流（如 `skillify` 的多轮问答流程）。

### 权衡与优化题

**Q6：内置技能的 `getPromptForCommand` 设计为返回 `ContentBlockParam[]` 而非字符串，有什么好处？**

`ContentBlockParam[]` 是 Anthropic SDK 的原生类型，支持文本块（`text`）和图像块（`image`）的混合输入。这使得技能可以直接拼接多个 ContentBlock——例如 `verify` 技能在技能主体后追加用户参数 block，而不需要字符串拼接，避免了转义问题和格式错误。同时 `prependBaseDir()` 可以精确地在首个文本块前插入路径前缀，而不破坏其他类型的块。

**Q7：为什么 `skillify` 和 `verify` 技能只对 `USER_TYPE === 'ant'`（Anthropic 员工）开放？**

这是一种功能门控（feature gate）的"人肉灰度"方式。这些技能可能依赖内部服务、行为尚未充分验证、或者需要额外权限配置，在向外部用户开放前先在内部验证稳定性。使用环境变量 `USER_TYPE` 而非 feature flag 是因为这类策略是进程启动时就确定的静态配置，不需要动态的 GrowthBook 查询。

### 实战应用题

**Q8：如何编写一个带参考文件的内置技能？**

```typescript
registerBundledSkill({
  name: 'my-skill',
  description: '我的技能',
  files: {
    'guide.md': '# 操作指南\n...',         // 相对路径 → 内容
    'examples/sample.ts': 'const x = 1',
  },
  async getPromptForCommand(args) {
    // 框架自动在此 prompt 前追加：
    // "Base directory for this skill: ~/.claude/bundled-skills/my-skill"
    return [{ type: 'text', text: `请参考 guide.md 完成：${args}` }]
  },
})
```

首次调用时，`guide.md` 和 `examples/sample.ts` 会被安全提取到磁盘，模型可以用 `Read` 工具读取。

**Q9：如何为技能实现基于上下文的动态提示词？**

`getPromptForCommand` 的第二个参数 `context: ToolUseContext` 包含当前会话的完整消息历史（`context.messages`）。以 `skillify` 为例，它通过 `getMessagesAfterCompactBoundary(context.messages)` 提取会话中的用户消息，将其作为"会话记录"注入提示词，让技能能够基于实际发生的对话内容生成定制化输出。

---
> **版权声明**：源码版权归 [Anthropic](https://www.anthropic.com) 所有，本文档基于 Claude Code v2.1.88 source map 还原版本分析，仅供学习研究使用。文档内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议。
