# Git 类命令 — Claude Code 源码分析

> 模块路径：`src/commands/commit.ts`、`src/commands/commit-push-pr.ts`、`src/commands/branch/`、`src/commands/diff/`、`src/commands/autofix-pr/`
> 核心职责：将 Git 操作封装为 AI 驱动的提示词命令，涵盖提交、PR 创建、分支管理与差异查看
> 源码版本：v2.1.88

## 一、模块概述

Git 类命令是 Claude Code 中使用频率最高的一类命令，将繁琐的 Git 工作流自动化。其中 `/commit` 和 `/commit-push-pr` 属于 `PromptCommand` 类型——它们将当前 Git 状态作为上下文注入提示词，由 AI 模型生成提交信息并执行 Git 操作；`/branch` 和 `/diff` 属于 `LocalJSXCommand`，渲染 Ink UI 界面；`/autofix-pr` 是内部专用的 PR 自动修复命令。

## 二、架构设计

### 2.1 核心类/接口/函数

**`commit`（`src/commands/commit.ts`）**
类型：`PromptCommand`。通过 `ALLOWED_TOOLS`（仅 `git add`/`git status`/`git commit`）限制模型可调用的工具，防止越权操作。`getPromptForCommand` 调用 `executeShellCommandsInPrompt` 将 `!\`cmd\`` 语法的 Shell 命令结果内联到提示词中。

**`commitPushPr`（`src/commands/commit-push-pr.ts`）**
类型：`PromptCommand`。相比 `commit` 权限更广，额外允许 `gh pr create/edit/view/merge`，并在初始化时通过 `getDefaultBranch()` 和 `getEnhancedPRAttribution()` 并发获取默认分支名和 PR 归因文本。

**`branch`（`src/commands/branch/index.ts`）**
类型：`LocalJSXCommand`。使用 `feature('FORK_SUBAGENT')` 判断是否提供 `fork` 别名。实现在 `branch.ts` 中，核心是 `createFork()` 函数——复制当前 transcript 文件，生成新的 `sessionId`，写入 `forkedFrom` 追踪字段。

**`diff`（`src/commands/diff/index.ts`）**
类型：`LocalJSXCommand`。实现极简，仅渲染 `DiffDialog` 组件，传入 `context.messages`。这是"UI 命令作为薄壳"的典型示例——命令本身不含逻辑，仅桥接组件层。

**`autofixPr`（`src/commands/autofix-pr/`）**
内部专用（列在 `INTERNAL_ONLY_COMMANDS`）。用于 CI 失败后自动分析错误并推送修复。

### 2.2 模块依赖关系图

```
commit.ts (PromptCommand)
├── utils/attribution.js         # 生成 "Co-Authored-By" 等归因文本
├── utils/promptShellExecution.js # 执行 !\`cmd\` 语法，内联 Shell 输出
├── utils/undercover.js          # ANT 内部用：隐藏真实身份的特殊指令
└── ALLOWED_TOOLS                # 工具白名单: git add/status/commit

commit-push-pr.ts (PromptCommand)
├── utils/attribution.js         # commit 归因 + PR 归因
├── utils/git.js → getDefaultBranch()  # 异步获取 git default branch
├── utils/promptShellExecution.js
└── ALLOWED_TOOLS                # 包含 gh CLI 命令

branch/ (LocalJSXCommand)
├── branch.ts → createFork()    # 核心：复制 transcript 创建分支
├── utils/sessionStorage.js     # getTranscriptPath/getProjectDir
└── services/analytics          # logEvent 追踪 branch 行为

diff/ (LocalJSXCommand)
└── components/diff/DiffDialog.js  # Ink UI 差异对话框组件
```

### 2.3 关键数据流

```
用户执行 /commit
    ↓
commit.getPromptForCommand(args, context)
    ↓
getPromptContent()                     → 构建 Markdown 格式提示词模板
    ↓
executeShellCommandsInPrompt(content)  → 展开 !\`git status\`、!\`git diff HEAD\` 等
    ↓
返回 [{ type: 'text', text: finalContent }]
    ↓
REPL 将提示词注入对话 → 模型生成 git commit 命令 → Bash 工具执行
```

## 三、核心实现走读

### 3.1 关键流程

**`/commit` 执行流程：**
1. 用户输入 `/commit`，REPL 匹配到 `commit` 命令（type: 'prompt'）
2. 调用 `getPromptForCommand(args, context)`
3. `getPromptContent()` 构建包含 Git Safety Protocol 的提示词，其中 `!\`git status\`` 等是占位符
4. `executeShellCommandsInPrompt` 扫描 `!\`...\`` 模式，逐一执行 Shell 命令并将输出替换进模板
5. 返回最终提示词，注入 LLM 上下文，模型据此生成 `git add + git commit` 命令
6. Bash 工具执行模型生成的命令（受 `ALLOWED_TOOLS` 白名单限制）

**`/branch` 创建会话分支流程：**
1. 用户输入 `/branch [name]`，触发 `LocalJSXCommand`
2. 惰性加载 `branch.ts`，调用 `createFork(customTitle)`
3. 读取当前 `transcript` 文件（JSONL 格式）
4. 生成新 `sessionId`（UUID），复制 transcript 内容，添加 `forkedFrom` 元数据
5. 写入新的 transcript 文件路径，保存 `customTitle`
6. UI 展示新分支信息，用户可通过 `/resume` 切换分支

### 3.2 重要源码片段

**`/commit` 安全工具白名单（`src/commands/commit.ts`）**
```typescript
// 严格限制模型只能调用这三个 git 命令，防止越权
const ALLOWED_TOOLS = [
  'Bash(git add:*)',
  'Bash(git status:*)',
  'Bash(git commit:*)',
]
```

**提示词中的 Shell 命令内联（`src/commands/commit.ts`）**
```typescript
// !\`cmd\` 语法：executeShellCommandsInPrompt 负责展开
return `## Context
- Current git status: !\`git status\`
- Current git diff: !\`git diff HEAD\`
- Current branch: !\`git branch --show-current\`
- Recent commits: !\`git log --oneline -10\``
```

**`/commit-push-pr` 并发初始化（`src/commands/commit-push-pr.ts`）**
```typescript
// getDefaultBranch 和 getEnhancedPRAttribution 独立异步，并发执行
const [defaultBranch, prAttribution] = await Promise.all([
  getDefaultBranch(),
  getEnhancedPRAttribution(context.getAppState),
])
```

**`/branch` 创建分支核心逻辑（`src/commands/branch/branch.ts`）**
```typescript
// 为分叉会话生成新 UUID，保留 forkedFrom 追踪链路
const forkSessionId = randomUUID() as UUID
const originalSessionId = getSessionId()
// forkedFrom 字段在 transcript 中建立父子追踪关系
```

**`/diff` 命令薄壳实现（`src/commands/diff/diff.tsx`）**
```typescript
// 极简实现：命令层不含逻辑，仅转发给 UI 组件
export const call: LocalJSXCommandCall = async (onDone, context) => {
  const { DiffDialog } = await import('../../components/diff/DiffDialog.js')
  return <DiffDialog messages={context.messages} onDone={onDone} />
}
```

### 3.3 设计模式分析

**模板方法模式（Template Method）**：`/commit` 和 `/commit-push-pr` 都使用 `getPromptContent()` 函数构建提示词模板，通过参数化（`defaultBranch`、`commitAttribution`、`prAttribution`）定制具体内容。Git Safety Protocol 作为固定安全约束内嵌在模板中，不可被用户覆盖（仅在末尾追加 Additional instructions）。

**命令模式 + 工具调用委托（Command + Tool Delegation）**：`PromptCommand` 本身不执行 Git 操作，而是将意图编码进提示词，委托 AI 模型生成具体命令，再由 Bash 工具执行。权限控制在 `ALLOWED_TOOLS` 层，而非在命令层。

**组合模式（Composition over inheritance）**：`commit-push-pr` 不继承 `commit`，而是重新组合了更宽的工具权限和更丰富的提示词模板。两者共享 `getAttributionTexts()` 等工具函数。

## 四、高频面试 Q&A

### 设计决策题

**Q1：为什么 `/commit` 和 `/commit-push-pr` 使用 `PromptCommand` 而非 `LocalCommand` 直接调用 Git？**

A：使用 `PromptCommand` 的核心优势是自适应性。Git 提交信息需要理解代码语义、遵循项目惯例（通过 `git log` 学习已有风格）、判断变更类型（feat/fix/refactor 等）。这些都是 LLM 的强项而非规则引擎的强项。同时，提示词模板中的 Git Safety Protocol 是对 AI 行为的约束（不跳过 hooks、不 force push、不提交 secrets），而非硬编码的命令序列。当用户追加 `args`（如 `/commit fix typo`），提示词在末尾追加用户指令，AI 自然融合两者，无需代码层面的指令解析。

**Q2：`ALLOWED_TOOLS` 工具白名单为何在 `PromptCommand` 而非全局层面控制？**

A：工具权限应与命令语义绑定，而非用户级别控制。`/commit` 只需要读取 Git 状态并执行提交，不需要 `Read`、`Write`、`WebFetch` 等工具——允许这些工具会使模型有机会在"写提交信息"过程中意外修改文件。`ALLOWED_TOOLS` 通过覆盖 `alwaysAllowRules` 实现，白名单之外的工具仍受正常权限控制。这是最小权限原则的命令级实现。

### 原理分析题

**Q3：`executeShellCommandsInPrompt` 中的 `!\`...\`` 语法是如何工作的？**

A：这是 Claude Code 自定义的"Shell 内联"语法，不是标准 Markdown。`executeShellCommandsInPrompt` 扫描提示词中所有 `!\`...\`` 模式，在命令执行前使用 `child_process`（或 Bun 的等价 API）逐一运行这些 Shell 命令，将输出替换原始占位符。这样最终发送给模型的提示词已包含实时的 `git status`、`git diff` 输出，模型看到的是真实数据而非模板占位符。权衡：每次调用 `/commit` 都会执行多次 Git 查询，但 Git 读操作开销极低，换来的是提示词内容的实时性。

**Q4：`/branch` 命令的 `forkedFrom` 字段如何实现会话追踪？**

A：每条 transcript 条目（`TranscriptEntry`）会记录 `forkedFrom: { sessionId, messageUuid }`，建立从子会话到父会话的引用链。这使得 `/resume` 可以显示会话树而非扁平列表，用户可以看到分支点。同时，`deriveFirstPrompt()` 从父会话的第一条用户消息中提取标题（截断到 100 字符，折叠空白），用于分支的默认命名，避免标题中出现换行（代码、错误堆栈）破坏会话索引。

**Q5：`commit-push-pr` 中 `contentLength` 为何使用 `'main'` 作为 `getPromptContent` 的估算参数？**

A：`contentLength` 用于 REPL 在注入命令前估算 token 消耗，判断是否超过上下文窗口。`getDefaultBranch()` 是异步操作，而 `contentLength` 是同步的 getter 属性。用 `'main'` 作为占位符的长度与真实分支名（如 `master`、`develop`）差异极小（几个字节），对 token 估算影响可忽略不计，这是"实用主义优先于精确性"的合理权衡。

### 权衡与优化题

**Q6：`/commit-push-pr` 同时提交、推送和创建 PR，如何处理用户中途取消的情况？**

A：该命令将整个流程编码进单条提示词，由模型按步骤执行。用户在模型执行过程中按 `Ctrl+C` 会触发 `abortController.signal`，中断当前模型推理和工具调用链。已执行的 Git 操作（如 `git push`）无法回滚（Git 操作本身无事务性），但 PR 创建是最后一步，若中断发生在 `push` 之后、`gh pr create` 之前，用户可手动运行 `gh pr create`。提示词中的"check if PR already exists"逻辑（`gh pr view --json number`）支持幂等重试——已有 PR 的情况下会 `gh pr edit` 而非重复创建。

**Q7：为什么 `diff` 命令的实现只有 3 行？这种设计有什么优缺点？**

A：`diff` 是典型的"命令作为路由器"设计，所有逻辑下沉到 `DiffDialog` 组件。优点：命令层零逻辑，`DiffDialog` 可被其他 UI 直接复用；懒加载减少启动开销。缺点：命令的功能全部依赖外部组件，若 `DiffDialog` 需要重构，命令层无法提供任何缓冲。但对于纯展示型命令（无需参数解析、无复杂逻辑），这是最简洁的正确实现。

### 实战应用题

**Q8：如何为团队定制 `/commit` 的提交信息格式？**

A：Claude Code 有多个扩展点：
1. `CLAUDE.md` 中声明提交信息规范，会被 AI 系统提示读取
2. 用 `/skills` 创建自定义技能覆盖 `/commit` 的行为
3. 通过 `attribution` 工具函数（`getAttributionTexts`）可在构建时注入归因文本
4. 在 `/commit` 末尾追加参数（如 `/commit use conventional commits format`）可一次性调整

**Q9：`/branch` 创建的分支和 Git branch 有什么关系？**

A：没有直接关系。`/branch` 创建的是**会话分支（conversation branch）**，而非 Git 分支。它复制的是 Claude Code 的对话历史 transcript 文件，赋予新的 `sessionId`，通过 `forkedFrom` 追踪父子关系，存储在 `~/.claude/projects/<hash>/` 目录下。用户在会话分支中的操作（包括 Git 操作）仍然作用于同一个文件系统和 Git 仓库，只是对话上下文独立。若想同时创建 Git 分支，需要在分支会话中额外执行 `git checkout -b`。

---
> **版权声明**：源码版权归 [Anthropic](https://www.anthropic.com) 所有，本文档基于 Claude Code v2.1.88 source map 还原版本分析，仅供学习研究使用。文档内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议。
