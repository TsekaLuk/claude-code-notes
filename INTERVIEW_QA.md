# Claude Code v2.1.88 面试题大全

> 汇集全部源码分析文章中的高频面试题。
> 按题型分类，每题标注来源文档，方便针对性复习。
>
> **所属项目**：[claude-code-notes](https://github.com/TsekaLuk/claude-code-notes)

---

## 使用指南

- **备考面试**：重点攻读"设计决策题"和"原理分析题"
- **做项目参考**：重点看"实战应用题"
- **架构评审**：重点看"权衡与优化题"

---

## 一、设计决策题（共 104 题）

### 核心入口（01-核心入口/）

> **Q**: 为什么在 `import` 语句之前执行副作用（`startMdmRawRead`、`startKeychainPrefetch`）？这不违反最佳实践吗？
>
> **A**: 这是有意为之的性能优化。ES Modules 的顶层副作用在模块求值时同步执行，但 `import` 语句本身会触发约 135ms 的模块加载（依赖图解析、JIT 编译）。通过在第一个 `import` 之前调用这两个函数，子进程派生（`plutil`、`reg query`、keychain 读取）与整个导入阶段并行执行。在 `preAction` 钩子处 `await` 时，子进程早已完成，几乎不产生额外等待。代码注释中明确标注了 `eslint-disable custom-rules/no-top-level-side-effects` 并说明了原因，这是一种明确记录、有意接受的权衡。
>
> 来源：`01-main.md`

> **Q**: 为什么选择在 `preAction` 钩子中执行 `init()` 而不是在 `run()` 函数顶部？
>
> **A**: `run()` 函数在注册 Commander 对象后立即被调用，此时用户可能只是执行 `claude --help`。在 `preAction` 钩子中执行初始化可以确保：只有在真正执行命令时才触发 `init()`（约 200-400ms），`--help` 输出即时返回。同时，所有子命令（`mcp`、`plugin`、`auth`）共享同一个 `preAction` 钩子，避免在每个子命令 handler 内重复初始化逻辑。
>
> 来源：`01-main.md`

> **Q**: 子命令处理器（`handlers/mcp.tsx` 等）为什么从 `main.tsx` 中提取出来？为什么不直接在 `main.tsx` 中内联？
>
> **A**: 原因是惰性加载和职责分离。`main.tsx` 约 4683 行，如果内联所有子命令处理器，会进一步膨胀。更重要的是，`claude mcp list` 这类简单子命令在快速路径下不需要加载完整的 CLI（`main.tsx` 约 200 个导入语句）。通过动态 `import()` 延迟加载，子命令只在执行时付出模块加载代价，而非进程启动时。Bun 的 `feature()` 宏还可以在编译时将整个处理器从外部发布版本中消除。
>
> 来源：`02-cli.md`

> **Q**: `StructuredIO` 为何使用 `outbound` 流（`Stream<StdoutMessage>`）而非直接写出 stdout？
>
> **A**: 直接写出 stdout 会产生竞态问题：`sendRequest()`（发送权限请求）和 `print.ts` 的流事件输出（发送模型输出块）会同时尝试写出，可能产生交错的 NDJSON 行。`outbound` 流作为单一写入点，由 drain 循环按序输出，确保消息不会相互穿插，同时保证 `control_request` 不会"超车"已排队的 `stream_event` 消息，维护了 NDJSON 协议的有序性。
>
> 来源：`02-cli.md`

> **Q**: `cli.tsx` 中为什么对 `--version` 实现「零模块加载」的快速路径，而不是在 Commander 中注册 `-V` 选项？
>
> **A**: Commander 的 `-V/--version` 选项需要加载 Commander 本身（~50KB），而 Commander 加载又会触发 `main.tsx` 的模块图（约 200 个导入，总计 ~135ms）。用户运行 `claude --version` 期望的是类似 `echo` 的即时响应。通过在任何 `import` 之前拦截 argv，这个版本查询可以在 <1ms 内完成。这是典型的「快速路径优先」设计哲学：首先排除最频繁但最简单的情况。
>
> 来源：`03-entrypoints.md`

> **Q**: `init()` 为什么不在 `cli.tsx` 的所有快速路径中调用，而只在 Commander 的 `preAction` 钩子中调用？
>
> **A**: 快速路径（`--version`、`--daemon-worker`、`remote-control` 等）有各自定制的初始化需求，且大多不需要完整的 `init()` 流程（配置系统、mTLS、代理配置、Anthropic API 预连接等）。例如 `--version` 什么都不需要，`remote-control` 只需要 `enableConfigs()` 和 OAuth 检查。完整的 `init()` 在每个快速路径中都调用会增加不必要的延迟和副作用。`preAction` 钩子确保只有进入完整 CLI 流程时才执行完整初始化。
>
> 来源：`03-entrypoints.md`

> **Q**: `bootstrap/state.ts` 为什么被设计为「叶节点」（不依赖任何其他内部业务模块）？
>
> **A**: 这是为了防止循环依赖（circular dependency）。`state.ts` 被几乎所有内部模块引用（工具、命令、服务、分析等）。如果 `state.ts` 反过来导入任何业务模块，就会产生循环依赖，导致模块在求值时依赖尚未完成求值的另一个模块，产生 `undefined` 导入错误。通过强制 `state.ts` 只依赖极少数基础工具（`randomUUID`、类型定义、信号工具），整个导入图保持有向无环。`bootstrap-isolation` ESLint 规则自动检测并阻止任何破坏这个约束的改动。
>
> 来源：`04-bootstrap.md`

> **Q**: 为什么 `originalCwd` 和 `cwd` 是两个独立字段？
>
> **A**: `originalCwd`（以及 `projectRoot`）在启动时设置一次，后续不变，用于：会话文件路径（`.claude/projects/<originalCwd>/<sessionId>.jsonl`）、`CLAUDE.md` 文件查找、技能发现等「项目身份」相关操作。`cwd` 则跟随用户的 `cd` 操作（由 `setCwd()` 更新），用于工具的实际文件系统操作。分离两者可以正确处理「用户在会话中切换目录」的场景：会话仍属于原始项目，但 Bash 工具在当前目录下执行命令。
>
> 来源：`04-bootstrap.md`

### 工具系统（02-工具系统/）

> **Q**: 为什么工具接口使用 `ToolDef` + `buildTool()` 工厂，而不是类继承？
>
> **A**: A：有三个关键原因。首先，TypeScript 的结构类型系统使接口比类继承更灵活，工具可以是纯对象字面量，不需要 `extends` 语法；其次，`satisfies ToolDef<I, O>` 关键字在编译期验证实现完整性，同时保留字面量类型推断（若用 `as ToolDef` 则会丢失具体类型）；最后，工厂函数可在不侵入具体工具代码的情况下附加横切关注点（如日志、默认值填充），符合开闭原则。
>
> 来源：`00-工具系统总览.md`

> **Q**: `validateInput()` 和 `checkPermissions()` 都能拒绝工具调用，为什么要分开？
>
> **A**: A：两者有本质区别。`validateInput()` 是**无副作用的语义验证**，检查输入是否在逻辑上合理（文件是否存在、字符串是否找到、参数格式是否合法），只访问状态不修改状态。`checkPermissions()` 是**有副作用的授权决策**，可能触发权限规则查询、用户对话框，并记录权限决定到 `toolPermissionContext`。分离允许主循环在不同阶段应用不同策略（比如在权限检查前先做验证，失败则跳过权限询问）。
>
> 来源：`00-工具系统总览.md`

> **Q**: 为什么 GrepTool 使用 ripgrep 而不是 Node.js 原生的文件搜索？
>
> **A**: A：有三个主要原因。性能方面，ripgrep 是用 Rust 编写的，采用 SIMD 指令加速正则匹配，比 Node.js 的 JavaScript 正则快 3-10 倍，对大型代码库尤为重要；功能方面，ripgrep 内置了 `.gitignore` 支持、Unicode 感知、多种文件类型识别（`--type`）等开发者友好功能；可维护性方面，ripgrep 是成熟的工具，边界条件处理经过充分验证，减少了 Claude Code 需要自己维护的代码量。
>
> 来源：`01-文件类工具-读取与搜索.md`

> **Q**: FileReadTool 为什么要记录 `readFileState` 时间戳？
>
> **A**: A：这是 FileEditTool 脏写检测机制的基础。FileEditTool 在执行编辑前会检查文件的最后修改时间是否晚于最近一次读取时间；若是，则拒绝写入并提示"文件已被修改，请重新读取"。这防止了 AI 在文件被外部工具（如 linter、格式化器）修改后写入过时的内容，避免意外覆盖变更。`readFileState` 不仅记录时间戳，还记录部分读取的 `offset`/`limit` 参数，标记为"局部视图"——局部读取不满足 FileEditTool 的完整读取要求。
>
> 来源：`01-文件类工具-读取与搜索.md`

> **Q**: FileEditTool 为什么不允许在"未读取文件"的情况下编辑？
>
> **A**: A：这是核心安全约束，防止 AI 在没有完整上下文的情况下修改文件。如果 AI 没有读取文件，它可能：提供错误的 `old_string`（文件内容不符合预期）；在不了解文件结构的情况下破坏格式；对文件内容做出错误假设。强制先读取确保了 AI 有充分信息做出正确的编辑决策。`readFileState` Map 作为"读取凭证"，未读取的文件没有凭证，直接拒绝编辑（errorCode: 6）。
>
> 来源：`02-文件类工具-写入与编辑.md`

> **Q**: 为什么 FileEditTool 在 `validateInput()` 和 `call()` 中都做时间戳检查？
>
> **A**: A：防御性分层设计，两次检查的目的不同。`validateInput()` 检查：给用户提供早期失败的友好提示，此时还未产生副作用（文件备份等），可以安全地终止并建议"请重新读取文件"；`call()` 检查：最后防线，处理 `validateInput()` 通过后、`call()` 执行前的时间窗口内文件被修改的情况（如：用户在 AI 等待确认时手动编辑了文件）。
>
> 来源：`02-文件类工具-写入与编辑.md`

> **Q**: AgentTool 为什么提供 worktree 隔离模式？
>
> **A**: A：worktree 隔离解决了并发代理写入冲突问题。当主代理让多个子代理并行工作（如同时修改前端和后端代码）时，不隔离的情况下所有代理共享同一个工作目录，文件修改相互干扰，可能产生无法预期的合并冲突。worktree 模式为每个子代理创建独立的 git worktree（同一仓库的独立检出目录），子代理的修改只在自己的 worktree 中进行，完成后由主代理决定是否将修改合并回主分支。远程执行（`isolation: 'remote'`）则更进一步，在完全独立的 CCR 环境中运行，适合风险较高的操作。
>
> 来源：`04-Agent任务类工具.md`

> **Q**: TodoV2（Task 工具组）相比 TodoWriteTool 有什么优势？
>
> **A**: A：设计理念的根本差异。TodoWriteTool 是"全量替换"模式——每次更新必须传入完整的 todo 列表，无法做细粒度操作（如只更新单个任务的状态）。Task 工具组提供 CRUD 操作：`TaskCreate`（创建单个任务）、`TaskUpdate`（更新单个任务状态）、`TaskStop`（停止任务）、`TaskGet`（查询单个任务）、`TaskList`（列出所有任务），各操作原子独立。同时 Task 系统支持任务依赖关系（`blocks`/`blockedBy`），表达"A 完成前 B 不能开始"的约束，TodoWriteTool 无此能力。
>
> 来源：`04-Agent任务类工具.md`

> **Q**: 为什么 MCP 工具使用 passthrough 权限而不是标准权限检查？
>
> **A**: A：MCP 工具的权限由两层机制共同保障，不需要 `checkPermissions()` 做工具级权限检查。第一层是 `mcpClient.ts` 在调用 MCP 服务器前检查用户的 allowlist（`alwaysAllowRules`）和 denylist（`alwaysDenyRules`），根据服务器名和工具名决定是否需要用户确认；第二层是工具调用记录（`shouldDefer: true`）要求用户批准高风险操作。passthrough 策略意味着"我不检查，但上一层已经检查过"，避免了双重权限检查造成的用户体验摩擦。
>
> 来源：`05-MCP类工具.md`

> **Q**: 为什么 MCP 工具名采用 `mcp__{server}__{tool}` 格式而非其他格式？
>
> **A**: A：这个命名约定解决了命名空间冲突和来源追溯两个问题。`mcp__` 前缀使 ToolSearchTool 能快速识别 MCP 工具（`name.startsWith('mcp__')`），双下划线分隔符支持服务器名和工具名本身包含单下划线（如 `mcp__github__create_pull_request`），不与内置工具命名（如 `FileReadTool`、`BashTool`）冲突。模型和用户都能从工具名直观理解工具的来源（哪个 MCP 服务器）和功能。
>
> 来源：`05-MCP类工具.md`

> **Q**: WebFetchTool 为什么要做两阶段处理（先抓取再用 LLM 提炼）？
>
> **A**: A：直接返回原始 Markdown 存在两个问题。第一，原始 Markdown 可能很长（文档页面通常 5000-50000 字），大量 token 消耗在与任务无关的内容（导航、页脚、侧边栏、代码示例等）上。第二，模型在上下文中处理大量原始内容效率低于针对性 prompt 提炼。用小模型（如 Haiku）提炼的原因是：提炼任务（"从文档中提取 X"）相对简单，不需要最强的推理能力，Haiku 成本低 3 倍。代价是额外的 API 调用延迟（约 0.5-2 秒），但通常值得。
>
> 来源：`06-搜索与信息类工具.md`

> **Q**: LSPTool 支持 `find_references` 等操作，但 GrepTool 也能做类似搜索，两者的定位差异是什么？
>
> **A**: A：两者解决不同问题。GrepTool 是文本级搜索（基于正则）：快速但不理解代码语义，会返回注释中的字符串匹配、变量名子串匹配等假阳性。LSPTool 是语义级搜索：通过类型系统理解代码，`find_references` 只返回真正引用了特定符号的位置（考虑作用域、类型推断），不会误报。LSPTool 的代价是需要 LSP 服务器初始化（可能需要几秒）和较高的计算资源（类型检查）。最佳实践是：先用 GrepTool 快速定位候选文件，再用 LSPTool 获取精确语义信息。
>
> 来源：`06-搜索与信息类工具.md`

> **Q**: 为什么计划模式（plan mode）要以工具调用方式触发，而不是通过系统提示词直接控制？
>
> **A**: A：工具调用方式有三个关键优势。第一，可审计性——工具调用产生可见的 `tool_use` 记录，用户能在 UI 中看到 AI 何时进入了计划模式，形成透明的状态变化历史；第二，可撤销性——ExitPlanModeTool 作为对称的退出工具，配合用户审查和批准流程，防止 AI 在未经用户确认的情况下自主退出只读约束；第三，条件控制——`isEnabled()` 可根据运行模式（如 `--channels` 参数）动态禁用工具，若通过系统提示词控制则无法在提示词层做条件判断。
>
> 来源：`07-会话控制类工具.md`

> **Q**: EnterWorktreeTool 为什么要清除系统提示词缓存和记忆文件缓存？
>
> **A**: A：工作目录（cwd）的变化直接影响 CLAUDE.md 记忆文件的发现路径。Claude Code 在项目根目录、父目录和 `~/.claude/` 中寻找 CLAUDE.md 文件，将其内容注入系统提示词。切换到 worktree 后，新的工作目录可能有不同的 CLAUDE.md（或没有 CLAUDE.md），若不清除缓存，系统提示词会保留切换前的记忆内容，导致 AI 在 worktree 中使用了来自主分支的错误上下文。`clearSystemPromptSections()` 和 `clearMemoryFileCaches()` 强制下次使用时从新目录重新加载。
>
> 来源：`07-会话控制类工具.md`

> **Q**: SkillTool 为什么要用 fork 代理（`runAgent()`）而非直接执行技能提示词？
>
> **A**: A：技能（Skill）可能包含需要工具调用的复杂任务（如技能内部调用 BashTool、FileEditTool 等），不只是简单的文本生成。`runAgent()` 提供完整的工具调用循环，技能内可以有多轮 AI 推理 + 工具执行，技能作为一个独立的子代理完成复合任务后返回结果。同时，fork 代理有独立的上下文：技能的执行过程（中间步骤）不污染主会话的对话历史，主会话只看到技能的最终输出结果，保持会话整洁。
>
> 来源：`08-其他专用工具.md`

> **Q**: BriefTool 的 `attachments` 字段为什么注释要求"必须保持 optional"？
>
> **A**: A：会话恢复（session resume）时会重放旧消息，包括历史 BriefTool 调用。如果旧消息中的 BriefTool 调用没有 `attachments` 字段（该版本功能未添加 attachments），但当前版本的 Zod schema 要求 `attachments` 为必填，则重放时 schema 验证会失败，导致会话无法正确恢复。保持 `attachments` 为 `optional` 确保了向前兼容——新旧消息格式都能通过 schema 验证，旧会话依然可以正常恢复。这是 API 版本兼容性设计的重要原则：可以添加可选字段，不可以将字段改为必填。
>
> 来源：`08-其他专用工具.md`

### 命令系统（03-命令系统/）

> **Q**: 为什么命令系统使用三种 type（prompt/local/local-jsx）而非统一接口？
>
> **A**: A：三者代表完全不同的执行路径和运行时需求。`PromptCommand` 需要 token 预算（`contentLength`）、允许工具列表（`allowedTools`），最终进入 LLM 推理循环；`LocalCommand` 是纯 TypeScript 同步/异步函数，不经过模型；`LocalJSXCommand` 需要 React/Ink 渲染上下文和 `onDone` 回调机制。强行统一会导致每种类型都携带其他类型的冗余字段，破坏类型安全。TypeScript 联合类型 + 判别字段（discriminated union）的方式在编译期即可捕获错误。
>
> 来源：`00-命令系统总览.md`

> **Q**: `availability` 与 `isEnabled()` 的职责如何划分？为什么要拆开？
>
> **A**: A：`availability` 是静态声明，描述命令适用的认证/提供商环境（`claude-ai`、`console`），基于用户身份，在会话期间不变；`isEnabled()` 是动态函数，每次 `getCommands` 调用都重新计算，用于功能开关（GrowthBook feature flag）、环境变量、平台检测等运行时条件。注释中明确说明："auth changes（e.g. /login）take effect immediately"——`loadAllCommands` memoize 了慢路径，但 `isEnabled` 每次都新鲜执行，支持登录后立即刷新命令列表。
>
> 来源：`00-命令系统总览.md`

> **Q**: 为什么 `/commit` 和 `/commit-push-pr` 使用 `PromptCommand` 而非 `LocalCommand` 直接调用 Git？
>
> **A**: A：使用 `PromptCommand` 的核心优势是自适应性。Git 提交信息需要理解代码语义、遵循项目惯例（通过 `git log` 学习已有风格）、判断变更类型（feat/fix/refactor 等）。这些都是 LLM 的强项而非规则引擎的强项。同时，提示词模板中的 Git Safety Protocol 是对 AI 行为的约束（不跳过 hooks、不 force push、不提交 secrets），而非硬编码的命令序列。当用户追加 `args`（如 `/commit fix typo`），提示词在末尾追加用户指令，AI 自然融合两者，无需代码层面的指令解析。
>
> 来源：`01-git类命令.md`

> **Q**: `ALLOWED_TOOLS` 工具白名单为何在 `PromptCommand` 而非全局层面控制？
>
> **A**: A：工具权限应与命令语义绑定，而非用户级别控制。`/commit` 只需要读取 Git 状态并执行提交，不需要 `Read`、`Write`、`WebFetch` 等工具——允许这些工具会使模型有机会在"写提交信息"过程中意外修改文件。`ALLOWED_TOOLS` 通过覆盖 `alwaysAllowRules` 实现，白名单之外的工具仍受正常权限控制。这是最小权限原则的命令级实现。
>
> 来源：`01-git类命令.md`

> **Q**: `/compact` 为什么需要三条压缩路径，而非统一一套算法？
>
> **A**: A：三条路径代表不同的可用性和质量权衡。Session Memory 压缩是最新、最轻量的实现，直接利用持久化的会话摘要，不消耗额外 token；但它依赖于 Session Memory 服务可用且有有效摘要，且不支持自定义压缩指令。Reactive 压缩是专为"响应式"（按需触发）场景设计的路径，支持批量处理消息组，减少 LLM 调用次数。传统压缩是最古老、最保守的兜底方案，通过 `microcompact`（规则剔除冗余内容）+ LLM 摘要生成的两步走方式，兼容性最好。三者不互斥但有优先级，系统总能找到一条可用路径。
>
> 来源：`02-会话管理类命令.md`

> **Q**: `/clear` 中执行 SessionEnd 钩子为什么要设置 1.5s 超时？
>
> **A**: A：SessionEnd 钩子（`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`）是用户定义的外部脚本，可能含有不可控的延迟（网络请求、文件写入等）。如果不加超时，用户执行 `/clear` 后可能需要等待数秒才能看到清除完成。1.5s 是"足够大多数轻量钩子完成，同时不阻塞用户体验"的经验值。超时后钩子被强制终止（通过 `AbortSignal.timeout`），会话清除继续执行——这是可用性优先于钩子完整性的设计决策。
>
> 来源：`02-会话管理类命令.md`

> **Q**: `/context` 为什么必须模拟 `query.ts` 的消息处理步骤，而不是直接统计 `context.messages.length`？
>
> **A**: A：Claude Code 的 REPL 层（UI 层）保留的 `messages` 包含 snip 标记前的历史（用于 UI 滚动回放），以及 `CONTEXT_COLLAPSE` 功能折叠前的重复文件读取记录。如果直接统计 `context.messages`，计算结果会虚高——用户会看到"上下文已使用 180k token"，但模型实际只接收了 120k token（因为折叠了重复内容）。为了让 `/context` 显示"模型实际看到的数据"，必须执行相同的转换：`getMessagesAfterCompactBoundary` + `projectView` + `microcompact`。这是一致性原则的实践。
>
> 来源：`03-上下文类命令.md`

> **Q**: `/add-dir` 中 `session` 和 `localSettings` 两种持久化级别如何选择？
>
> **A**: A：`session` 级别仅在当前会话有效，Claude Code 重启后恢复到原始配置，适合临时需要访问某个目录的场景。`localSettings` 持久化到项目的本地配置文件（非全局），下次在同一项目目录启动 Claude Code 时仍然生效，适合项目级别的常规工作目录。不选择写入 `globalSettings` 是因为工作目录通常与项目绑定，全局持久化会污染其他项目。`remember=true` 参数（UI 中的"Remember for this project"选项）控制这个选择。
>
> 来源：`03-上下文类命令.md`

> **Q**: `/advisor` 为什么需要三层校验，而不是直接尝试设置并让 API 报错？
>
> **A**: A：提前校验的核心理由是用户体验和资源效率。第一层 `canUserConfigureAdvisor()` 是本地权限检查，若用户根本没有 advisor 功能权限，直接提示清晰的错误比等到 API 调用失败后再解析错误信息更直接。第二层 `isValidAdvisorModel()` 是模型兼容性检查——并非所有模型都能作为 advisor（advisor 需要具备元认知能力来监督另一个模型），这是语义层面的约束，API 层不一定会返回有意义的错误。第三层 `validateModel()` 确保模型 ID 存在，避免将无效模型写入持久化配置（配置文件保存了错误的模型名，下次启动会静默失败）。
>
> 来源：`04-AI辅助类命令.md`

> **Q**: `/brief` 的 `enable_slash_command` GrowthBook 配置与命令的 `isEnabled()` 有何关系？
>
> **A**: A：两者是分层的门控机制。`isEnabled()` 是代码层的可见性控制，决定命令是否出现在斜杠命令列表中——若为 `false`，用户甚至无法发现这个命令的存在。`enable_slash_command` 是运行时的动态配置，通过 GrowthBook 推送，可以在不发布新版本的情况下控制功能的滚动上线（A/B 测试、灰度发布）。前者是代码边界，后者是运营边界。注释中特别说明：这个配置"no TTL"（无过期时间），因为它控制命令的可见性（不是 kill switch），只有一次后台更新即可。
>
> 来源：`04-AI辅助类命令.md`

> **Q**: `/config` 和 `/doctor` 的实现都只有 1 行（渲染一个组件），为什么不把逻辑直接写在命令里？
>
> **A**: A：命令层与 UI 层的分离是为了复用性和可测试性。`Settings` 组件和 `Doctor` 屏幕可能在多个入口点被使用——例如首次安装向导可能直接渲染 `Settings`，SDK 模式下可能以不同方式嵌入诊断功能。如果逻辑写在命令里，这些复用场景就必须依赖"执行命令"这个中间层，增加耦合。将逻辑下沉至组件层，命令仅作为"用户触发的入口点"，组件层可被任意代码导入和使用。
>
> 来源：`05-配置类命令.md`

> **Q**: 为什么 `/color` 标记为 `immediate: true` 而 `/config` 没有？
>
> **A**: A：`/color` 只修改视觉属性（`promptBarColor`），对模型推理完全无影响——无论何时修改颜色，当前推理结果不受影响，视觉效果立即反映。`/config` 则可能修改影响模型行为的配置（如系统提示词自定义、模型选择），在推理进行中修改这些值可能导致不一致状态（本次推理用旧配置生成了一半，用户已改为新配置）。因此 `/config` 不标记为 `immediate`，等待推理停止点再打开。
>
> 来源：`05-配置类命令.md`

> **Q**: 为什么 `/cost` 对订阅用户隐藏，而不是显示实际 token 消耗数字？
>
> **A**: A：订阅用户支付固定月费，每次 API 调用的"成本"对他们没有直接的财务意义——看到"本次操作花费 $0.12"只会造成焦虑，因为他们的账单不随使用量变化（在限额内）。显示订阅状态（"正在使用订阅额度"）和超额状态（"正在消耗超额额度"）才是对订阅用户有意义的信息。ANT 内部用户例外，因为他们需要了解内部成本分摊，`[ANT-ONLY]` 标记也防止用户截图分享时造成混淆。
>
> 来源：`06-调试诊断类命令.md`

> **Q**: `ant-trace` 为什么使用 stub 文件而非直接从 `INTERNAL_ONLY_COMMANDS` 排除？
>
> **A**: A：`INTERNAL_ONLY_COMMANDS` 排除了命令在外部版本中的注册，但该方式只能在"不注册 = 不存在"的场景下工作。`ant-trace` 可能被其他内部代码路径直接导入（而非通过命令系统访问），若整体排除可能导致模块缺失错误。Stub 方案确保：1) 模块始终可导入（无运行时 ImportError）；2) 命令始终存在但不可用（`isEnabled: () => false`）；3) 不泄漏任何内部实现代码到外部产物。这是更安全的隔离方式，尤其适合有跨模块引用的内部工具。
>
> 来源：`06-调试诊断类命令.md`

> **Q**: `/remote-control` 使用 `immediate: true`，这在桥接场景中有何特殊意义？
>
> **A**: A：`immediate: true` 允许命令在 AI 推理进行中立即执行。对于远程控制桥接，这一点至关重要：用户可能在等待 AI 回复的过程中，希望让手机接管对话——若命令需要等待推理停止，会破坏"无缝接管"的体验。桥接激活本身（设置 `AppState.replBridgeEnabled = true`）是幂等且无副作用的，不会影响正在进行的推理。WebSocket 连接在推理完成后的合适时机由 `useReplBridge` 建立，时序安全。
>
> 来源：`07-发布与集成类命令.md`

> **Q**: 为什么 `bridge-kick` 使用注释块详细记录复合故障序列？
>
> **A**: A：桥接系统的故障是分布式异步的，真实世界的失败往往是链式的（BQ 数据中显示"ws_closed → register transient-blips → teardown"这类模式）。单个故障注入无法重现这些场景。`bridge-kick` 的注释提供了"可重现的测试脚本"——工程师可以按注释中的步骤精确重现 BQ 数据中观察到的故障序列，验证修复后的恢复路径是否正确。这是将运维知识（故障模式）内嵌到工具中的最佳实践，比 wiki 文档更容易保持更新。
>
> 来源：`07-发布与集成类命令.md`

> **Q**: `/btw` 为什么使用 `immediate: true`，且关闭时使用 `display: 'skip'`？
>
> **A**: A：`immediate: true` 让 `/btw` 在 AI 推理进行时也能立即打开——用户可能在等待 AI 完成一个长时间任务时，有一个快速的侧边问题（如"这个函数的时间复杂度是多少？"），无需等待主推理完成再提问。`display: 'skip'` 确保 `/btw` 的提问和 AI 回答不出现在主对话历史中——侧边问题的本意是"不打断主对话"，若追加到消息历史，会干扰主线任务的上下文（后续 AI 看到对话历史时会看到这些无关提问）。两者共同实现了"零痕迹侧边问答"的用户体验目标。
>
> 来源：`08-其他命令.md`

> **Q**: 为什么 `/btw` 要追踪 `btwUseCount`？这些数据如何使用？
>
> **A**: A：`btwUseCount` 是本地使用频率计数器，保存在 `globalConfig`（`~/.claude/global_config.json`）中。可能的用途：产品团队通过分析这个指标了解功能使用频率（判断是否值得继续投资）；用于新功能发现机制（如首次使用后显示提示，或使用 N 次后解锁高级提示）；可能上报到遥测系统（若用户同意）帮助优化功能设计。与 `logEvent` 服务端事件不同，`btwUseCount` 即使在网络离线时也持续累计，体现了"本地优先"的数据策略。
>
> 来源：`08-其他命令.md`

### Agent 协调（04-Agent协调/）

> **Q**: 为什么 `matchSessionMode()` 选择原地修改 `process.env`，而非使用内存变量记录模式？
>
> **A**: A：`isCoordinatorMode()` 在整个系统多处被调用（QueryEngine、工具逻辑等），若只修改内存变量，所有调用点都需要持有对该变量的引用或经过单例访问。直接写 `process.env` 利用 Node/Bun 进程全局共享的特性，使 `isCoordinatorMode()` 保持"无参数、无缓存、即时读取"的简单签名，调用方无需任何改动。代价是对全局状态的副作用，但由于该函数只在会话恢复时触发一次，副作用范围可控。
>
> 来源：`01-coordinator.md`

> **Q**: `isScratchpadGateEnabled()` 为何在 `coordinatorMode.ts` 中重复实现，而不复用 `filesystem.ts` 中的同名函数？
>
> **A**: A：`filesystem.ts` 位于依赖链路 `filesystem → permissions → … → coordinatorMode`，若直接引用会形成循环依赖，导致模块无法加载。通过在本模块内直接调用底层 `checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_scratch')`，跳过 `filesystem.ts` 这一中间层，以少量代码重复换取依赖图的无环性。注释中明确标注了重复的原因，属于有意为之的权衡。
>
> 来源：`01-coordinator.md`

> **Q**: 为什么任务状态存储在 `AppState` 字典中而非任务对象本身的实例属性？
>
> **A**: A：Claude Code 的 UI 层（React/Ink 组件）基于 `AppState` 进行声明式渲染——任何状态变更必须通过 `setAppState()` 触发重渲染，才能在终端 UI 上反映。若状态存储在对象实例属性中，变更不会通知 React，UI 无法同步。此外，`AppState` 持久化到磁盘后可以恢复，实例属性则随进程退出丢失，无法实现 `/resume` 功能。
>
> 来源：`02-tasks.md`

> **Q**: `isBackgrounded` 字段与任务状态（`running`/`completed` 等）有什么区别，为何需要两套字段？
>
> **A**: A：`status` 反映任务的执行状态（是否在跑），`isBackgrounded` 反映任务的 UI 呈现模式（是否被用户移到后台）。一个任务可以是 `running` 且 `isBackgrounded: false`（前台运行，占据主界面）；也可以是 `running` 且 `isBackgrounded: true`（仍在运行但显示在后台 pill 里）。两套字段解耦了"执行状态"和"UI 位置"，使协调器面板与主 UI 可以独立决定如何呈现任务。
>
> 来源：`02-tasks.md`

> **Q**: 为什么 `query()` 只是一层薄包装，将真正逻辑放在私有的 `queryLoop()` 中？
>
> **A**: A：分离的目的是**命令生命周期通知的对称性**。`query()` 只在 `queryLoop()` **正常返回**时调用 `notifyCommandLifecycle(uuid, 'completed')`——若 `queryLoop` 抛出异常，异常穿越 `yield*` 传播，`notifyCommandLifecycle` 不会被调用（对应"started but not completed"语义）。若将通知放在 `queryLoop` 内部 `try/finally` 中，每次中途退出都会错误地触发 completed。外层 `query()` 通过 `yield*` 的 completion value 机制精确捕获正常返回路径。
>
> 来源：`03-query.md`

> **Q**: `State.transition` 字段的值只用于测试，为何要在生产代码中保留？
>
> **A**: A：注释明确说明"Lets tests assert recovery paths fired without inspecting message contents"——消息内容在不同版本间可能变化，基于内容的断言脆弱；而 `transition.reason` 是语义稳定的枚举字符串，断言它比匹配消息文本更健壮。在生产中该字段零成本（仅赋值，不额外计算），保留它使调试和可观测性受益（可在日志/trace 中记录恢复路径）。
>
> 来源：`03-query.md`

> **Q**: 为什么 AgentTool 使用统一入口而非多个工具（如 SpawnSubagent、SpawnTeammate、SpawnCoordinator）？
>
> **A**: A：统一入口有两个核心优势。第一是**LLM 认知负担最小化**：LLM 需要记忆的工具名称越少越好，更少的工具意味着更少的提示词 token 用于工具描述，也减少了模型选择工具时的歧义。第二是**向后兼容性**：新的协作模式（如 Fork、Remote）可以作为新参数追加到现有工具，而无需模型学习全新的工具语义。代价是 `AgentTool` 的参数组合复杂，但这种复杂性被封装在工具内部，不暴露给 LLM。
>
> 来源：`05-多Agent协作与Swarm.md`

> **Q**: Coordinator 为何要与 Fork 机制互斥？
>
> **A**: A：Fork 机制通过共享父 Agent 的已初始化上下文（对话历史、工具池快照）来加速子 Agent 启动，子 Agent 可以"看到"父 Agent 的对话历史。但 Coordinator 的核心安全假设是"Worker 上下文完全独立，无法看到 Coordinator 的历史"。若两者结合，Forked Worker 将看到 Coordinator 的完整历史，包括其他所有 Worker 的结果汇总，这会：1）破坏隔离边界（Worker 可能根据其他 Worker 的结果做出不一致的决策）；2）将大量不相关上下文注入每个 Worker，token 浪费严重；3）在 Coordinator 历史包含敏感中间结果时，可能导致信息泄露（如一个 Worker 的凭证被另一个 Worker 看到）。
>
> 来源：`05-多Agent协作与Swarm.md`

> **Q**: Fork Subagent 为什么要保留父 Agent 的完整对话历史，而不是只给任务指令？
>
> **A**: A：这是缓存优化与信息传递的联合设计，两者缺一不可。
>
> 从**缓存角度**：父 Agent 的完整对话历史（工具调用记录、代码读取结果、分析过程）构成了所有 fork 子 Agent 共享的缓存前缀主体。历史越长，缓存命中节约的 token 越多。若只传任务指令，并行的 N 个子 Agent 各自只有一行"新增消息"，没有共享前缀，缓存优化完全失效。
>
> 从**信息角度**：任务指令通常是高度依赖上下文的（"修复刚才分析出的那个 off-by-one 错误"），子 Agent 需要父 Agent 的历史才能理解"刚才分析出的"是什么。若只传抽象指令而不传上下文，任务指令必须变得冗长（把所有必要背景显式写入），反而增加了 per-child 差异部分的 token 数，缓存优势进一步缩小。
>
> 完整历史的保留，使任务指令可以极度精简——per-child 差异文本块的 token 数降到最低，前缀命中率最高。
>
> 来源：`06-Fork与提示词缓存优化.md`

> **Q**: 为什么 `DANGEROUS_uncachedSystemPromptSection` 要把"危险"写进函数名？
>
> **A**: A：这是一种"代码即政策"（policy as code）的工程文化实践，而非单纯的命名风格选择。
>
> 在 Claude Code 这类 API 成本敏感的产品中，任何一处不必要的 uncached system prompt section 都会在大规模用户调用下累积显著费用。传统的做法（代码注释、wiki 文档）对于大型团队的约束力有限——注释可以不读，文档可以过时。将"危险"硬编码进函数名，产生三种约束效果：
>
> 1. **代码审查可见**：PR 中任何新增的 `DANGEROUS_uncachedSystemPromptSection` 调用都会被 reviewer 立即注意到，形成强制讨论。
> 2. **搜索可追踪**：`grep DANGEROUS_uncachedSystemPromptSection` 可以在整个代码库中快速定位所有"故意放弃缓存"的位置，方便成本审计。
> 3. **`_reason` 强制留档**：所有调用点都留有决策理由，未来维护者可以判断理由是否仍然成立，决定是否可以迁移为缓存版本。
>
> 来源：`06-Fork与提示词缓存优化.md`

### 扩展系统（05-扩展系统/）

> **Q**: 内置插件（Built-in Plugin）和捆绑技能（Bundled Skill）有什么本质区别？为什么要设计两套机制？
>
> **A**: 捆绑技能编译进 CLI 二进制，始终启用，不出现在 `/plugin` UI 中；内置插件同样随 CLI 发布，但用户可在 UI 中切换启用状态，并且插件可以打包多个组件（技能 + 钩子 + MCP 服务器）。设计两套机制的原因是：并非所有功能都需要用户控制——系统级工具如 `verify`、`batch` 适合总是可用，而需要额外配置或可能影响性能的功能（如 Chrome 集成）适合做成可选插件。
>
> 来源：`01-plugins.md`

> **Q**: 为什么 `skillDefinitionToCommand()` 将 source 设为 `'bundled'` 而非 `'builtin'`？
>
> **A**: `Command.source` 中的 `'builtin'` 专指硬编码的斜杠命令（`/help`、`/clear`），它们不走 Skill 工具路径。如果插件技能也标记为 `'builtin'`，会导致：Skill 工具的技能列表中找不到它们、分析日志命名错误、提示词截断时被错误处理。使用 `'bundled'` 则复用了 Bundled Skills 的全部下游逻辑，只需在 `LoadedPlugin.isBuiltin` 上记录"来自内置插件"这一事实。
>
> 来源：`01-plugins.md`

> **Q**: 技能（Skill）和命令（Command）是什么关系？为什么不分开设计两套数据结构？
>
> **A**: 技能是命令的超集的一种实现方式——所有技能最终都被转化为 `Command` 对象，`source` 字段区分来源。统一为 `Command` 的好处在于：命令系统（包括 Skill 工具、前缀匹配、分析日志、提示词截断豁免等）的所有逻辑无需感知"这是哪种来源的命令"，降低了下游系统的复杂度。代价是 `Command` 类型中有些字段对内置斜杠命令有意义、对技能无意义（如 `contentLength`），但通过文档约定可以接受。
>
> 来源：`02-skills.md`

> **Q**: 为什么 `mcpSkillBuilders.ts` 不直接用动态 import？
>
> **A**: 注释中明确说明：Bun 打包产物（`/$bunfs/root/...`）中，非字面量的动态 import specifier 会被解析为打包 chunk 内部的路径，导致"Cannot find module"错误。字面量动态 import 虽然在 bunfs 中可用，但 dependency-cruiser 会追踪静态分析到的循环依赖，一条边会在 diff 检查中产生大量循环违规。因此采用写一次注册表的方式，既规避了打包器限制，又不引入新的循环依赖边。
>
> 来源：`02-skills.md`

> **Q**: 为什么键位绑定使用"最后一条覆盖（last-wins）"而非"第一条获胜（first-wins）"的合并策略？
>
> **A**: 默认绑定在数组前部，用户绑定在后部。`last-wins` 策略自然地实现了"用户配置覆盖默认值"：不需要特殊的优先级字段，也不需要区分哪些来自默认、哪些来自用户。同时，用户配置文件内部若有两个相同按键的绑定，也会取最后一个——这是 JSON 对象字段名重复的同等行为，用户可预期。相应地，`checkDuplicateKeysInJson()` 会发出警告提示用户注意。
>
> 来源：`03-keybindings.md`

> **Q**: `action: null` 解绑机制的设计意图是什么？`unbound` 和 `none` 的区别是什么？
>
> **A**: `action: null` 允许用户显式解绑默认快捷键（如不想让 `ctrl+o` 打开 Transcript）。`resolver.ts` 返回 `{ type: 'unbound' }` 表示"我找到了绑定，但它被设为 null"，此时 `useKeybinding` 会调用 `stopImmediatePropagation()` 阻止其他处理器。`{ type: 'none' }` 则表示"根本没有绑定"，事件会继续传播到其他 `useInput` 处理器。这个区别保证了解绑的语义：解绑不是"没有绑定"，而是"被明确禁用"。
>
> 来源：`03-keybindings.md`

### 服务与基础（06-服务与基础/）

> **Q**: 为什么 `withRetry` 设计为 `AsyncGenerator` 而不是普通 Promise？
>
> **A**: > 重试等待期间（最长 32 秒）若函数静默 await，用户界面会冻结无反馈。通过 `yield createSystemAPIErrorMessage(error, delayMs, ...)` 可在等待时向 UI 推送进度信息（当前重试次数、剩余等待时间），而不需要额外的回调机制。持久重试模式（`UNATTENDED_RETRY`）更进一步，每 30 秒 yield 一次心跳，防止主机进程因无 stdout 输出而被标记为空闲。
>
> 来源：`01-services-api.md`

> **Q**: 多云客户端为什么使用动态 `import()` 而非顶层静态导入？
>
> **A**: > 各云 SDK（Bedrock、Vertex、Foundry）体积较大，且用户通常只使用其中一种。静态导入会让所有 SDK 进入 bundle，即使从未被调用。动态 import 配合 bun 的 tree-shaking，使外部构建（非 ant 用户）的包体积最小化。注释中明确说明 "we have always been lying about the return type — this doesn't support batching or models"，表明这是有意识的类型妥协以换取架构一致性。
>
> 来源：`01-services-api.md`

> **Q**: 分析事件为什么不直接同步写入 Datadog，而要引入队列和汇聚器？
>
> **A**: > 分析模块在模块图最顶层（叶节点），若直接依赖 Datadog SDK 或网络客户端，会引入循环依赖。队列+汇聚器模式让 `analytics/index.ts` 做到零依赖，任何模块（包括工具、服务）都可以安全 import 并调用 `logEvent`，而汇聚器的具体实现（Datadog/1P）在应用启动后异步注册。注释明确写道："This module has NO dependencies to avoid import cycles."
>
> 来源：`02-services-others.md`

> **Q**: DiagnosticTrackingService 为什么在 `getNewDiagnostics` 中同时处理 `file://` 和 `_claude_fs_right:` 两种协议的诊断？
>
> **A**: > IDE diff 视图会同时打开修改前（左侧 `_claude_fs_left:`）和修改后（右侧 `_claude_fs_right:`）的虚拟文件。语言服务可能会对右侧文件单独生成诊断（反映编辑后的实际错误），比 `file://` 的磁盘快照更及时。服务优先选用右侧诊断，且仅在右侧诊断发生变化时才切换，避免重复上报相同错误。
>
> 来源：`02-services-others.md`

> **Q**: 为什么 `findGitRoot` 使用同步 `statSync` 而不是异步 `stat`？
>
> **A**: > `findGitRoot` 被权限检查、系统提示构建等多个同步路径调用，强制使用异步会导致整个调用链变成异步，破坏现有架构。通过 LRU 缓存（50条）将昂贵的 `statSync` 调用降频到首次查询，后续调用命中缓存无 I/O 开销。在实践中，Claude Code 通常在固定的几个目录下工作，50 条容量足以覆盖正常使用场景（编辑多个目录的文件）。
>
> 来源：`03-utils-git.md`

> **Q**: `findGitRoot` 和 `findCanonicalGitRoot` 的使用场景分别是什么？
>
> **A**: > `findGitRoot` 返回包含 `.git` 文件/目录的实际目录（可能是 worktree 目录）；`findCanonicalGitRoot` 穿透 worktree 指向主仓库工作目录。使用场景：
> > - 权限检查（文件是否在仓库内）→ 用 `findGitRoot`（就近原则）
> > - 项目标识（auto-memory、项目配置）→ 用 `findCanonicalGitRoot`（同一仓库的所有 worktree 共享同一个内存目录）
> > - 提交归因、代理内存 → 用 `findCanonicalGitRoot`（保证跨 worktree 数据一致性）
>
> 来源：`03-utils-git.md`

> **Q**: 为什么 CCR（Claude Code Remote）场景下需要屏蔽用户本地的 API key 配置？
>
> **A**: > 在 `claude ssh` 远程场景下，API 调用通过本地的 `ANTHROPIC_UNIX_SOCKET` 代理隧道，代理负责注入正确的认证头。如果允许远程子进程读取 `~/.claude/settings.json` 中的 API key，就会产生头部冲突：代理注入的 OAuth 头 + 本地读取的 API key 头会同时存在，导致 API 返回「invalid x-api-key」错误。注释说明："The launcher sets CLAUDE_CODE_OAUTH_TOKEN as a placeholder iff the local side is a subscriber so the remote includes the oauth-2025 beta header to match what the proxy will inject." `isManagedOAuthContext()` 正是为了防止这个问题。
>
> 来源：`04-utils-model-auth.md`

> **Q**: `getApiKeyFromApiKeyHelper` 使用 TTL 缓存而非永久缓存的原因是什么？
>
> **A**: > `apiKeyHelper` 是用户在 `settings.json` 中配置的可执行脚本（如 `aws secretsmanager get-secret-value ...`），每次执行都有时间开销（可能几百毫秒）。永久缓存会让密钥轮换（rotation）不生效；不缓存则每次 API 调用都要执行脚本。5 分钟 TTL 是折中方案：对应 AWS Secrets Manager 等短期凭证的最小轮换周期，既支持轮换又不频繁执行。
>
> 来源：`04-utils-model-auth.md`

> **Q**: `finalContextTokensFromLastResponse` 为什么排除缓存 token，而 `getTokenCountFromUsage` 包含它？
>
> **A**: > 两个函数服务于不同目的：`getTokenCountFromUsage` 计算「这次 API 调用消耗了多少上下文空间」，用于触发自动压缩（autocompact），需要包含缓存来准确评估窗口占用；`finalContextTokensFromLastResponse` 计算「任务预算剩余」，其算法来自服务端 `renderer.py:292` 的 `calculate_context_tokens` 函数——服务端也是用 `input + output`（无缓存）来扣减预算，客户端必须使用相同算法才能与服务端的预算倒计时保持一致。
>
> 来源：`05-utils-cost-token.md`

> **Q**: 为什么成本计算要专门处理 `server_tool_use.web_search_requests` 而不是把 web 搜索当作普通 token？
>
> **A**: > web 搜索是按「请求次数」计费（$0.01/次），与 token 定价体系无关。API 的 `usage` 对象在 `server_tool_use` 字段下单独报告搜索次数，与 token 字段平行。如果把搜索折算成 token 会失去精度，而且定价可能单独变动。独立处理也让成本分解更透明（用户可以看到「X 次 web 搜索 = $Y」）。
>
> 来源：`05-utils-cost-token.md`

> **Q**: Claude Code 为什么自己实现一个 Store 而不使用 Zustand / Jotai / Redux？
>
> **A**: > Claude Code 使用 Ink（终端 UI 框架），对 React 生态的依赖是刻意最小化的，避免引入过重的客户端状态管理库。自实现的 `createStore` 仅 34 行，完全满足需求：不可变更新、订阅通知、`useSyncExternalStore` 集成。没有选择器、时间旅行、中间件等复杂功能，符合 YAGNI 原则。Zustand 的核心实现也非常相似（同样基于 `Object.is`），但引入额外依赖会增加 bundle 体积并在终端环境中引入 DOM 相关类型。
>
> 来源：`06-state.md`

> **Q**: `onChangeAppState` 为什么必须在 `store.ts` 的 `onChange` 回调中调用，而不能在 React 的 `useEffect` 中处理这些副作用？
>
> **A**: > Claude Code 有大量非 React 的调用路径（headless 模式、SDK 调用、CLI 命令），这些路径中没有 React 渲染循环，`useEffect` 不会触发。如果副作用只在 `useEffect` 中处理，那么通过 `store.setState` 更改权限模式就不会触发 CCR 同步，`settings` 变更也不会清除凭证缓存。将副作用注册在 `onChange` 确保无论是 React 组件、CLI 命令还是 SDK 调用触发的状态变更，副作用都能可靠执行。
>
> 来源：`06-state.md`

> **Q**: 为什么使用 `lazySchema` 包装而不是直接定义 Zod 模式常量？
>
> **A**: > 两个原因：**性能**——Zod 模式对象在创建时会做一定的初始化工作，用 `lazySchema` 推迟到第一次 `HookCommandSchema()` 调用，避免在 settings 不含钩子时白白初始化；**循环引用**——`HookMatcherSchema` 依赖 `HookCommandSchema`，`HooksSchema` 依赖 `HookMatcherSchema`，三者形成引用链。若用 `const` 立即执行，JavaScript 模块加载时可能因顺序问题遇到 `undefined`。`lazySchema` 本质上是闭包延迟，调用时再从已完全加载的模块中读取依赖。
>
> 来源：`07-schemas.md`

> **Q**: `z.partialRecord` 相比 `z.record` 有什么区别？为什么 `HooksSchema` 要用它？
>
> **A**: > `z.record(K, V)` 要求所有可能的 key 都必须存在（或在 output 中存在）；`z.partialRecord(K, V)` 允许 key 缺失（等价于 `Partial<Record<K, V>>`）。`HooksSchema` 使用 `partialRecord(HOOK_EVENTS, ...)` 是因为用户的 settings.json 通常只配置几个钩子事件（如只有 `PreToolUse`），不应要求所有事件类型都存在。若用 `z.record`，未配置的事件类型会触发解析错误。
>
> 来源：`07-schemas.md`

> **Q**: 为什么将类型定义单独放到 `src/types/` 而不是与实现代码放在一起？
>
> **A**: > 核心原因是打破循环依赖。`types/permissions.ts` 定义了 `PermissionMode`、`ToolPermissionContext` 等类型，被 `utils/permissions/`（实现层）、`state/AppStateStore.ts`（状态层）、`Tool.ts`（工具基类）同时引用。如果类型定义放在 `utils/permissions/` 下，`state/` 需要从 `utils/permissions/` import，而 `utils/permissions/` 的实现可能又需要从 `state/` 读取状态，形成循环。独立的 `types/` 目录是无依赖的叶节点，任何层都可以安全引用，打断循环。
>
> 来源：`08-constants-types-migrations.md`

> **Q**: 迁移函数为什么不使用版本号控制（如「已运行过迁移 v3」），而是每次都检查数据状态？
>
> **A**: > 版本号方案需要维护已执行迁移的持久化列表，增加了状态管理的复杂性（哪个文件存储？如何处理损坏？）。数据状态检查方案更健壮：即使用户手动修改了配置，或在不同机器间同步了 settings 文件，迁移函数依然能正确判断是否需要执行。幂等设计使得多次运行安全无害，不依赖历史执行记录。
>
> 来源：`08-constants-types-migrations.md`

> **Q**: 为什么系统提示是 `string[]` 数组而不是单个字符串？
>
> **A**: > Anthropic API 的 `system` 参数接受对象数组，每个对象可以独立设置 `cache_control`。如果用单字符串，就无法对"边界前"和"边界后"分别设置不同的缓存策略。数组格式让每个段落成为独立的缓存单元：静态段落带 `scope: 'global'` 共享全局缓存，动态段落不带 `cache_control` 以确保每次都带最新内容。这是一种 Prompt 级别的 Memoization，与函数级别的 Memoization 逻辑相同，只是作用域是 API 调用的前缀。
>
> 来源：`09-system-prompt工程.md`

> **Q**: 内部用户和外部用户看到不同 prompt 的设计，从工程角度有什么风险？它是如何被管理的？
>
> **A**: > 主要风险是"内部评估的模型行为与外部部署的模型行为不一致"——如果内部 prompt 使模型表现更好（更诚实、更谨慎），而外部 prompt 没有这些约束，那么内部的质量指标就无法代表用户实际体验。风险管理方式：内部额外指令通过 `feature('INTERNAL_PROMPTS')` 编译时门控，在外部发布包中完全不存在（tree-shake 掉），而非运行时分支判断，避免外部用户通过某种手段启用内部模式。内部评估时明确标记为「内部条件」，不与外部基准混用。
>
> 来源：`09-system-prompt工程.md`

> **Q**: 为什么采用"四层渐进"而不是直接在接近上限时 AutoCompact？
>
> **A**: > 直接 AutoCompact 的问题：AutoCompact 需要一次完整的 API 调用（成本等同于正常查询），且生成的摘要是有损的（即使保留了 9 类信息，也无法还原精确的代码行）。四层渐进从最低破坏性开始：工具结果截断只影响单条结果，几乎无感；图片替换用描述文字保留语义；Context Collapse 保留消息结构；只有在前三层无法充分释放空间时，才用 AutoCompact 的高成本"大手术"。这是典型的**成本-效益递进设计**——在满足约束（不超限）的前提下，优先选择副作用最小的方案。
>
> 来源：`10-上下文压缩.md`

> **Q**: AutoCompact 的摘要是由谁生成的？用的是哪个模型？
>
> **A**: > AutoCompact 触发一次独立的 API 调用，使用的是**同一个主模型**（当前会话配置的模型）。原因：用于压缩的模型需要对对话内容有充分理解，才能生成高质量摘要；使用更弱的模型（如 Haiku）可能节省成本，但摘要质量下降（遗漏重要细节）会在后续对话中产生更大的隐性成本（模型因上下文不足犯错需要重新解释）。实际上，AutoCompact API 调用有专用的 token budget（不算入任务预算），以避免压缩操作消耗用户的任务限额。
>
> 来源：`10-上下文压缩.md`

### UI 与交互（07-UI与交互/）

> **Q**: Claude Code 为什么选择 React + Ink 而不是直接用 `process.stdout.write` 操控终端？
>
> **A**: 直接操作终端需要手动管理状态：哪些行已输出、光标位置、ANSI 转义序列的开关顺序。随着 UI 复杂度增长，这类命令式代码极难维护。React 的声明式模型让 UI = f(state)，引擎自动计算最小差量更新，开发者只需描述"界面应该长什么样"。具体收益包括：
> - **组件复用**：`PromptInput`、`Spinner`、`PermissionRequest` 等都是标准 React 组件，可独立测试。
> - **状态管理**：`useState` / `useReducer` / Context 管理 REPL 状态，无需自建观察者机制。
> - **差量渲染**：Ink 的双缓冲 + blit 机制自动处理增量更新，避免整屏闪烁。
> - **生态复用**：React DevTools、React 19 并发特性、自定义钩子体系均可直接复用。
>
> 来源：`01-ink渲染引擎.md`

> **Q**: Yoga 布局引擎为什么能在 CLI 中实现 Flexbox？它与浏览器 Flexbox 的本质区别是什么？
>
> **A**: Yoga 是 Meta 开源的跨平台 Flexbox 实现（C++，编译为 WASM），Claude Code 通过 `src/native-ts/yoga-layout/` 调用。它实现了 CSS Flexbox 规范的子集，在终端中的主要差异在于：
> - **离散坐标**：浏览器使用浮点像素，终端使用整数字符格（列/行），Yoga 计算结果经 `Math.floor` 取整。
> - **等宽字体假设**：每个字符格固定为 1 列（CJK 字符为 2 列），没有 CSS `letter-spacing` 等概念。
> - **无滚动原语**：滚动逻辑由 `scrollTop` / `pendingScrollDelta` 手动实现，而非浏览器原生滚动。
> - **测量回调**：文本节点通过 `setMeasureFunc` 注册测量回调，Yoga 在布局计算时调用，动态确定文本行数/宽度。
>
> ---
>
> 来源：`01-ink渲染引擎.md`

> **Q**: PromptInput 为什么设计为单一巨型组件而不拆分为多个小组件？
>
> **A**: PromptInput 的 80+ 个 `import` 语句和 20+ 个 `useXxx` 钩子初看违反"小组件"原则，但这一设计有充分的工程理由：
>
> 1. **状态耦合**：历史搜索、Vim 模式、语音输入、AI 补全等功能都需要访问相同的 `value` / `cursorOffset` 状态，任何拆分都会导致状态提升或复杂的上下文传递。
> 2. **键盘事件竞争**：所有输入处理必须在同一个 `useInput` 处理函数中统一协调优先级（如 Vim 模式下 `i` 进入插入模式不能被历史搜索拦截），多组件分散处理难以保证正确的事件消费顺序。
> 3. **Dead Code Elimination**：通过 `feature('VOICE_MODE')` 等条件引入，构建时按功能开关裁剪，大型单文件便于构建工具分析依赖边界。
>
> 来源：`02-核心组件.md`

> **Q**: ThemeProvider 的 `auto` 模式是如何知道终端明暗主题的？
>
> **A**: 通过 **OSC 11** 终端查询协议（`ESC]11;?BEL`），向终端查询当前背景色。终端返回颜色值后，`systemThemeWatcher.js` 解析 RGB 亮度判断明/暗，更新 `systemTheme` 状态，`ThemeProvider` 据此将 `auto` 解析为 `dark` 或 `light`。这一过程异步进行：初始时从 `$COLORFGBG` 环境变量快速读取（约 0ms），OSC 11 响应到达后校正（约 50ms）。
>
> ---
>
> 来源：`02-核心组件.md`

> **Q**: Claude Code 为什么只有 3 个 Screen，而不是像 Web 应用那样有完整的路由系统？
>
> **A**: Claude Code 是单任务 CLI 工具，用户一次只做一件事：或是对话（REPL），或是恢复会话（Resume），或是查看诊断（Doctor）。Web 路由系统的"前进/后退"、URL 状态等概念在 CLI 场景下无意义。更重要的是，CLI 工具的"路由切换"发生在进程启动时（由命令行参数决定），而非运行时的用户导航。三个 Screen 的设计将不同入口点的代码完全隔离，`REPL` 不需要了解 `Doctor` 的存在，代码边界清晰。
>
> 来源：`03-screens路由.md`

> **Q**: REPL.tsx 的 200+ 行 import 是反模式吗？为什么没有进一步拆分？
>
> **A**: 这是有意为之的"单一状态中心"设计。REPL 是整个应用的状态协调中心，所有涉及对话上下文的操作（消息流、工具权限、API 查询、会话存储、成本跟踪、Agent 协调等）都需要访问共享状态。过度拆分会导致：
> 1. 状态提升到更高层（传参地狱），或
> 2. 引入更多 Context（订阅竞争，性能退化）。
>
> 当前模式将所有状态和副作用集中在一处，配合 React Compiler 自动记忆化，实际渲染性能良好。`feature()` 条件导入确保生产包体积不会因为 import 数量线性增长。
>
> ---
>
> 来源：`03-screens路由.md`

> **Q**: useVimInput 为什么将 Vim 状态存储在 `useRef` 而不是 `useState` 中？
>
> **A**: Vim 的命令状态机（`vimStateRef.current`）在每次击键时都会更新，但只有模式切换（INSERT ↔ NORMAL）才需要更新 UI（显示模式指示器）。如果使用 `useState`，每次击键（包括 `3d`、`f` 等中间状态）都会触发 React 重渲染 + Ink 帧渲染，产生大量无效渲染。使用 `useRef` 存储中间命令状态，仅调用一次 `setMode()` 来触发 UI 更新，将渲染频率从"每次击键"降至"每次模式切换"（通常是 2-3 次击键一次）。
>
> 来源：`04-hooks.md`

> **Q**: useVirtualScroll 的 `useSyncExternalStore` 为什么比 `useEffect + useState` 更适合订阅 scrollTop？
>
> **A**: `useEffect + setState` 在 React 并发模式下存在"撕裂"（tearing）风险：React 可能在同一帧内读取两个不一致的 scrollTop 快照（渲染阶段和提交阶段之间 scrollTop 已改变）。`useSyncExternalStore` 保证：
> 1. **快照一致性**：提供 `getSnapshot` 函数，React 在整个渲染过程中使用相同快照。
> 2. **无撕裂**：在并发渲染被中断并重新开始时，React 会重新调用 `getSnapshot` 验证快照一致性。
> 3. **同步订阅**：存储变化时同步触发重渲染，不依赖 effect 的异步调度。
>
> ---
>
> 来源：`04-hooks.md`

> **Q**: 为什么输出样式通过"系统提示注入"而不是通过后处理（如 Markdown 渲染层）实现？
>
> **A**: 后处理方式（在渲染时格式化输出）只能控制视觉呈现，无法改变 AI 的推理过程和内容生成逻辑。`Explanatory` 模式要求 Claude "在编写代码之前先分析为什么选择这种实现"，`Learning` 模式要求 Claude "在关键决策点暂停并请求用户实现"——这些都是 AI 的行为逻辑，必须在提示层面告知模型。系统提示注入的好处是：不需要任何后处理解析器，利用 Claude 的指令遵循能力来保证格式，并且可以通过调整提示文本来精细控制行为，无需修改前端渲染代码。
>
> 来源：`05-outputStyles.md`

> **Q**: `keepCodingInstructions` 标志的存在说明什么设计权衡？
>
> **A**: 默认系统提示中包含一批"代码质量指令"（如"保持代码简洁"、"优先使用现有依赖"等），这些指令对 `Explanatory` 和 `Learning` 模式依然有价值（用户仍然需要 Claude 写好代码）。但某些未来可能添加的输出样式（如"只回答问题，不写代码"）可能需要覆盖或移除代码指令。`keepCodingInstructions` 为每个样式提供声明式控制，避免在系统提示构建逻辑中硬编码"哪些样式需要代码指令"的判断。
>
> ---
>
> 来源：`05-outputStyles.md`

> **Q**: 为什么伴侣外观（骨骼）不持久化到配置文件，而是每次从哈希重新生成？
>
> **A**: 骨骼数据（物种/眼睛/帽子/稀有度）是 `hash(userId + SALT)` 的确定性输出，任何时候重新计算都会得到相同结果，存储它没有意义且浪费空间。更重要的是：
> 1. **防止作弊**：若骨骼持久化，用户可以直接修改配置文件将自己的 `rarity` 改为 `legendary`。
> 2. **允许游戏数据演化**：若未来新增物种或调整稀有度权重，已存储的骨骼字段（旧格式）会被新计算覆盖，无需数据迁移。
> 3. **灾难恢复**：用户删除配置文件后，只要账号 ID 不变，重新 `/buddy hatch` 会得到相同外观的伴侣（只有 Claude 生成的名字/性格需要重新生成）。
>
> 来源：`06-buddy-AI伴侣.md`

> **Q**: `isBuddyTeaserWindow()` 使用本地时间而非 UTC，这是刻意的设计选择吗？
>
> **A**: 是的，注释明确说明："本地时间而非 UTC，24 小时滚动波跨时区。持续的 Twitter 热度而非单次 UTC 午夜峰值，对 soul 生成服务器的压力更温和。"即 UTC 午夜时区边界内的所有用户同时触发功能会导致 Claude API 的 soul 生成请求在数分钟内集中爆发。使用本地时间将这个流量分散到 4 月 1 日的全球 24 小时窗口内，是一种简单有效的流量平滑策略。
>
> ---
>
> 来源：`06-buddy-AI伴侣.md`

> **Q**: 语音输入为什么需要 Anthropic OAuth 而不支持 API Key 鉴权？
>
> **A**: 语音功能使用 `voice_stream` 端点，该端点托管在 `claude.ai`（Anthropic 的消费者产品），不在 API 网关中。API Key 是面向 Anthropic API（`api.anthropic.com`）的凭证，无法访问 `claude.ai` 的服务端点。Bedrock 和 Vertex 用户使用云厂商的身份体系，同样无法访问 Anthropic 自有服务。因此，语音功能仅对通过 `claude.ai` OAuth 登录的用户开放，这是架构约束而非主动限制。
>
> 来源：`07-voice-vim.md`

> **Q**: Vim 状态机为什么使用纯函数设计（`transition(state, input) → TransitionResult`）而不是有副作用的事件处理器？
>
> **A**: 纯函数状态机的优势：
> 1. **可测试性**：只需提供 `(state, input)` 就能预测输出，无需 mock 任何副作用。测试用例就是状态转换表的文档。
> 2. **可组合性**：`useVimInput` 可以在 `transition` 返回结果后选择何时执行 `execute()`，例如在执行前先应用 `inputFilter`。
> 3. **调试友好**：状态快照（`vimStateRef.current`）是完整的当前解析进度，可以直接打印/记录，不依赖闭包捕获的外部变量。
> 4. **TypeScript 穷举**：`switch(state.type)` + TypeScript 联合类型确保新增状态时编译器提醒开发者添加对应的处理分支。
>
> ---
>
> 来源：`07-voice-vim.md`

### 网络与远程（08-网络与远程/）

> **Q**: 为什么用户消息通过 HTTP POST 而非 WebSocket 发送？
>
> **A**: WebSocket 在 CCR 架构中是单向订阅通道（server-push），服务端将会话的 SDK 消息流推送给客户端。用户输入走独立的 HTTP POST（`sendEventToRemoteSession`）是因为：① POST 语义更清晰，支持重试和幂等性校验；② WebSocket 连接可能因断线重连处于临时不可用状态，而 HTTP POST 可独立重试；③ 与 CCR 后端的 REST API 设计一致，避免一个 WS 通道承载双向业务逻辑。
>
> 来源：`01-remote.md`

> **Q**: 为什么 `viewerOnly` 模式下不发送中断信号？
>
> **A**: `viewerOnly` 用于 `claude assistant` 命令的纯观察场景（只看会话内容）。此模式下发 Ctrl+C 中断会意外打断正在运行的远程任务，而用户只是想退出观察。此外，纯观察者无操作权，向服务端发送 interrupt 可能引发权限错误。
>
> 来源：`01-remote.md`

> **Q**: Direct Connect 模式与 CCR 远程模式有何本质区别？
>
> **A**: CCR 远程模式下，Claude Code 的实际执行发生在 Anthropic 云端容器中，本地 CLI 是纯展示/控制端，通过 claude.ai OAuth 鉴权；Direct Connect 模式下，Claude Code 在本地机器（或 CI 容器）中实际运行，Direct Connect 服务器只是将其包装成 HTTP+WebSocket API 供外部客户端消费（如 IDE 插件）。前者是"远程执行+本地显示"，后者是"本地执行+远程访问"。
>
> 来源：`02-server.md`

> **Q**: 服务端为什么用 NDJSON 而不是纯 JSON 或 MessagePack 格式推送消息？
>
> **A**: NDJSON（换行分隔 JSON）在流式场景中易于解析，每行独立是一条完整消息，无需实现帧边界检测（WebSocket 本身有帧，但 NDJSON 允许服务端在一个 WebSocket 帧中批量发送多条消息）。纯 JSON 需要完整缓冲后才能解析，MessagePack 在工具生态上不如 JSON 通用。
>
> 来源：`02-server.md`

> **Q**: 为什么对入站 `control_request` 必须在 10-14 秒内响应？
>
> **A**: 这是 CCR 平台的服务端超时机制：若 REPL 不响应 `initialize` 等控制请求，服务端认为客户端已断线并强制关闭 WebSocket。这是一种健康检查设计——确保连接的 REPL 实例是活跃可交互的，而不仅仅是网络层连通。`outboundOnly` 模式仍然对 `initialize` 响应成功（其他操作返回错误），正是因为不响应会导致连接被断开，从而失去消息接收能力。
>
> 来源：`03-bridge.md`

> **Q**: `recentPostedUUIDs` 和 `recentInboundUUIDs` 分别解决什么问题？
>
> **A**: - `recentPostedUUIDs`：存储本地发出消息的 UUID。服务端将所有消息广播给同一会话的所有订阅者（包括发送者自己），防止 REPL 将自己发出的消息作为"新消息"重复处理（echo 回声）。
> - `recentInboundUUIDs`：存储已成功处理的入站消息 UUID。在 transport swap（切换传输层）时服务端会重放历史消息，通过记录已处理 UUID 防止同一条用户消息被重复执行（如重复调用工具）。
>
> 来源：`03-bridge.md`

> **Q**: 为什么不直接用 HTTP CONNECT 代理，而要额外封装一层 WebSocket 隧道？
>
> **A**: CCR 容器运行在 GKE（Google Kubernetes Engine）集群中，通过 L7 HTTP 负载均衡（Envoy/Istio）路由流量。L7 代理以 HTTP 请求为粒度处理流量，HTTP CONNECT 请求在 L7 层会被拦截或拒绝（L7 负载均衡不支持 CONNECT 方法的透明透传，需要 L4 TCP 代理）。WebSocket 升级（`Upgrade: websocket`）则是 L7 代理普遍支持的协议，因此将隧道包装在 WebSocket 连接中是最小改动的兼容方案。
>
> 来源：`04-upstreamproxy-moreright.md`

> **Q**: 为什么选择手工编码 Protobuf 而不使用 `protobufjs` 库？
>
> **A**: `UpstreamProxyChunk` 只有一个字段 `bytes data = 1`，是最简单的 Protobuf 消息。手工编码的实现只需约 15 行，避免引入一个重量级运行时依赖（`protobufjs` 完整包约 500KB）。该模块是热路径（每次网络请求都会调用），手工编码也消除了库的 object allocation 和 schema 查找开销。代码注释中明确说明了 Protobuf wire format，可读性和可维护性均可接受。
>
> 来源：`04-upstreamproxy-moreright.md`

> **Q**: 为什么 KAIROS 助手模式需要 `worker_type: 'claude_code_assistant'`，不能复用普通 `claude_code` 类型？
>
> **A**: worker_type 是 claude.ai 前端用于过滤会话选择器的元数据。`claude_code_assistant` 标记使助手会话只出现在 claude.ai 的"助手"标签页中，而不与用户手动发起的普通 Remote Control 会话混在一起。此外，后端可基于 worker_type 应用不同的路由规则、超时策略和 SLA——助手守护进程通常需要更长的超时（因为它在等待来自用户交互的任务），普通 Remote Control 会话则可能被更激进地回收。
>
> 来源：`05-assistant-KAIROS.md`

> **Q**: 为什么 `initializeAssistantTeam()` 需要在 `setup()` 捕获 `teammateMode` 快照之前调用？
>
> **A**: `initializeAssistantTeam()` 内部调用 `setCliTeammateModeOverride()`，修改全局的 `teammateMode` 状态。`setup()` 在其执行过程中读取并"快照"这个值到本地变量供后续使用。若 `initializeAssistantTeam()` 在 `setup()` 之后执行，`setup()` 捕获的是旧值，导致 Agent 在生成子进程时使用错误的团队模式——子 Agent 可能不知道自己处于 KAIROS 团队上下文中，无法正确协调。
>
> 来源：`05-assistant-KAIROS.md`

> **Q**: `getSystemContext()` 和 `getUserContext()` 为什么分成两个函数而不合并？
>
> **A**: 两者的缓存失效策略不同。`getSystemContext()` 在 `setSystemPromptInjection()` 时失效（调试用，低频）；`getUserContext()` 在 CLAUDE.md 文件变化时可独立失效（用户编辑了 CLAUDE.md 后重新加载）。分离也使两者可独立并发调用，避免一方的慢操作（如大型 git 仓库的 `git log`）阻塞另一方（快速的日期获取）。此外，分离清晰地表达了语义——"系统环境"（git 状态）与"用户配置"（CLAUDE.md）是不同关注点。
>
> 来源：`06-context-native-ts.md`

> **Q**: 为什么 `ModalContext` 需要暴露 `scrollRef` 而不是让 Modal 自己管理滚动？
>
> **A**: 这是 Tabs 组件的特殊需求：Tabs 在 Modal 内部时，切换 Tab 需要重置滚动位置到顶部。但 ScrollBox 由 FullscreenLayout 的 Modal 槽位持有，Tabs 并不在 FullscreenLayout 的直接子树中。通过 `ModalContext.scrollRef`，任何深层嵌套的子组件都能访问 Modal 的 ScrollBox 引用，而不需要 prop drilling（逐层传递 ref）。
>
> 来源：`06-context-native-ts.md`

---

## 二、原理分析题（共 157 题）

### 核心入口（01-核心入口/）

> **Q**: `main.tsx` 如何处理交互式与非交互式（`-p` 模式）的分流？
>
> **A**: 判断依据有四个条件之一成立即为非交互式：`-p`/`--print` 标志、`--init-only` 标志、`--sdk-url` 标志、或 `!process.stdout.isTTY`。判断结果通过 `setIsInteractive()` 写入 `bootstrap/state.ts` 全局状态。后续在 action handler 内，非交互式路径构建 `headlessInitialState` + `headlessStore`，然后调用 `runHeadless()`（`cli/print.ts`）；交互式路径则创建 Ink `root` 对象并调用 `launchRepl()`。
>
> 来源：`01-main.md`

> **Q**: `runMigrations()` 的版本迁移系统如何保证幂等性？
>
> **A**: 每次迁移函数（如 `migrateSonnet45ToSonnet46`）内部检查当前配置值是否已是目标值，若已迁移则直接返回。外层通过比较 `getGlobalConfig().migrationVersion` 与 `CURRENT_MIGRATION_VERSION`（当前为 11），只有版本不匹配时才运行全套迁移。迁移完成后使用不可变的展开运算符更新配置：`{ ...prev, migrationVersion: CURRENT_MIGRATION_VERSION }`，保证写入安全。
>
> 来源：`01-main.md`

> **Q**: MCP 服务器配置是如何被加载和过滤的？
>
> **A**: 配置来源有多层：CLI `--mcp-config` 标志 → 项目 `.claude/settings.json` → 用户 `~/.claude/settings.json` → 企业 MDM 策略。加载后经过 `filterMcpServersByPolicy()` 过滤企业策略中的 `allowedMcpServers`/`deniedMcpServers`。特殊场景下 `doesEnterpriseMcpConfigExist()` 会拒绝 CLI 动态配置。最终合并为 `allMcpConfigs`，在交互式模式下调用 `prefetchAllMcpResources()` 并行连接所有服务器，服务器连接不阻塞 REPL 首屏渲染。
>
> 来源：`01-main.md`

> **Q**: `RemoteIO` 与 `StructuredIO` 的继承关系是如何工作的？
>
> **A**: `RemoteIO` 继承 `StructuredIO`，核心差异是构造函数参数：`StructuredIO` 接受 `AsyncIterable<string>`（stdin），而 `RemoteIO` 创建一个 `PassThrough` 流作为 stdin 替代，并通过 WebSocket/SSE 传输层将接收到的消息写入该流。上层 `StructuredIO` 的 `read()` AsyncGenerator 完全不感知底层是 stdin 还是网络流，实现了干净的协议/传输分离。
>
> 来源：`02-cli.md`

> **Q**: `WebSocketTransport` 的睡眠检测机制是如何工作的，为什么需要它？
>
> **A**: 系统睡眠时 JavaScript 定时器被挂起，`setTimeout` 在系统唤醒后立即触发（而非定时器设定的时间点后触发）。这导致重连尝试之间的实际时间间隔远超 `DEFAULT_MAX_RECONNECT_DELAY`（30s）。若不检测这种情况，重连预算（600s）在睡眠期间就会被「用完」，导致系统唤醒后立即放弃重连。通过检测两次重连之间的实际时间差是否超过 `SLEEP_DETECTION_THRESHOLD_MS`（60s），传输层能识别睡眠-唤醒场景并重置预算，让用户唤醒电脑后仍能重连到 CCR 会话。
>
> 来源：`02-cli.md`

> **Q**: `SSETransport` 为何需要维护 POST 重试逻辑？
>
> **A**: SSE（Server-Sent Events）是单向流：服务器 → 客户端。客户端向服务器发送消息需要单独的 HTTP POST 请求。SSE 传输层维护了 `POST_MAX_RETRIES = 10` 的指数退避重试机制（基础 500ms，上限 8s），以处理短暂的网络抖动。与重连逻辑分开实现，是因为 GET 连接（SSE 流）和 POST 请求（命令发送）有不同的失败模式和恢复策略。
>
> 来源：`02-cli.md`

> **Q**: `cli.tsx` 中对 `remote-control` 的鉴权顺序（先检查 OAuth → 再检查 GrowthBook → 再检查策略限制）的依赖关系是什么？
>
> **A**: 三个检查存在严格依赖链：
> - GrowthBook 的特性标志查询需要用户 identity（通过 OAuth header 传递），没有 OAuth token 的 GrowthBook 查询返回匿名用户的默认值，可能不准确。
> - 策略限制（`isPolicyAllowed`）依赖 `waitForPolicyLimitsToLoad()`，而 Policy Limits 的加载本身依赖 OAuth 认证（需要用户组织信息）。
> - 因此，先验证 OAuth token 是否存在是一种快速失败优化（避免向 GrowthBook 发送无意义请求），同时也是逻辑上的必要前提。
>
> 来源：`03-entrypoints.md`

> **Q**: `startMCPServer()` 中 `getEmptyToolPermissionContext()` 的作用是什么？MCP 模式下工具权限如何处理？
>
> **A**: `getEmptyToolPermissionContext()` 创建一个「空」权限上下文，意味着所有工具调用都需要经过用户明确确认（或者在 MCP 客户端侧配置了授权规则）。MCP 服务器模式下，工具调用的权限决策被移交给 MCP 客户端（如 Claude Desktop 或其他 MCP 宿主），而非 Claude Code 自身的权限系统。`ListToolsRequestSchema` 使用同一上下文确保工具列表与实际可调用工具保持一致。
>
> 来源：`03-entrypoints.md`

> **Q**: `agentSdkTypes.ts` 为什么使用 `export *` 而非命名导出？有什么权衡？
>
> **A**: 使用 `export *` 的好处是：SDK 内部可以重组子文件（如将 `coreTypes.ts` 拆分为 `messageTypes.ts` + `configTypes.ts`）而无需修改 `agentSdkTypes.ts`。缺点是：`export *` 可能导致命名冲突（若两个子模块导出同名符号），且 tree-shaking 工具难以确定哪些符号真正被使用。代码中通过注释（`// Re-export core types`）明确标注了每个 `export *` 的来源，是一种文档化补偿。
>
> 来源：`03-entrypoints.md`

> **Q**: `STATE.allowedSettingSources` 的作用是什么？`--setting-sources` 标志如何影响它？
>
> **A**: 该字段控制哪些配置来源对当前会话有效，这是企业安全策略的核心机制之一。默认包含全部五个来源。`--setting-sources` 标志（由 `setAllowedSettingSources()` 写入）可以限制为子集，例如 `--setting-sources flagSettings` 只使用 `--settings` 标志提供的配置，忽略所有磁盘上的配置文件。`getSettingsForSource()` 等配置读取函数在返回数据前会检查当前来源是否在允许列表中。这允许 SDK 调用者完全控制 Claude Code 看到的配置，防止宿主机的用户配置干扰 SDK 的预期行为。
>
> 来源：`04-bootstrap.md`

> **Q**: `promptId` 和 `sessionId` 的区别是什么？各自用于什么目的？
>
> **A**: `sessionId` 是整个对话的 UUID，对应一个 `.jsonl` 文件，会话恢复（`--resume`）基于它。`promptId` 是每次用户输入时生成的 UUID，生命周期是「一次轮次」（一个 user message → N 个 assistant message + tool calls）。`sessionId` 用于会话管理（存储、恢复、遥测聚合）；`promptId` 用于诊断（在 OTel 追踪中将一次用户请求的所有 API 调用、工具调用、钩子执行关联在一起），适合按单次提示维度调试性能问题。
>
> 来源：`04-bootstrap.md`

> **Q**: `lastMainRequestId` 和 `lastApiCompletionTimestamp` 存储在 state 中，在进程退出时有什么用？
>
> **A**: `lastMainRequestId` 在进程退出时发送「缓存驱逐提示」（cache eviction hint）给 Anthropic 推理服务。由于 prompt cache 的 TTL 约为 5 分钟，而用户可能短时间内重新启动 Claude Code，提前通知推理服务这个会话结束了，可以让服务更主动地释放缓存内存。`lastApiCompletionTimestamp` 配合 `tengu_api_success` 事件中的 `timeSinceLastApiCallMs` 字段，帮助区分「由缓存 TTL 到期导致的 cache miss」与「仅因重试退避导致的延迟」，精确归因 cache miss 的原因。
>
> 来源：`04-bootstrap.md`

### 工具系统（02-工具系统/）

> **Q**: `lazySchema()` 解决了什么实际问题？
>
> **A**: A：工具模式（Zod schema）构建会产生内存分配和计算开销。若在模块顶层立即构建，所有工具的模式在程序启动时就会全部初始化，形成不必要的启动开销。特别是 Claude Code 作为 CLI 工具，快速启动很重要。`lazySchema()` 包装 getter 属性，使模式只在第一次被访问时才构建，实现按需加载。
>
> 来源：`00-工具系统总览.md`

> **Q**: 工具的 `maxResultSizeChars` 属性有什么作用？
>
> **A**: A：控制工具输出的最大字符数，超过此限制的结果会被持久化到磁盘（`toolResultStorage`），并在 API 请求中用引用替代完整内容。这解决了两个问题：防止超大输出填满 Claude 的上下文窗口，以及避免重复传输相同的大型内容（如大文件内容）。不同工具根据典型输出大小设置不同阈值：GrepTool 为 20,000（内容搜索结果通常较大），其余多数为 100,000。
>
> 来源：`00-工具系统总览.md`

> **Q**: `backfillObservableInput()` 在工具生命周期中的作用是什么？
>
> **A**: A：在权限检查和钩子（hooks）调用之前规范化用户输入，使后续处理基于一致的格式。主要做路径展开（`expandPath()`），将 `~`、相对路径转换为绝对路径，防止通过路径变体绕过 allowlist 白名单规则。例如 `~/secret` 和 `/home/user/secret` 在白名单匹配时是等价的，必须在检查前统一。
>
> 来源：`00-工具系统总览.md`

> **Q**: GrepTool 默认为什么按文件修改时间排序而非按路径排序？
>
> **A**: A：在探索性编程场景中，最近修改的文件通常是最相关的——开发者最近工作的文件往往就是当前任务相关的文件。按修改时间降序排序使模型优先看到最相关的文件，减少了在旧文件中搜索的无效探索。测试环境改为按路径排序是为了确保快照测试的确定性（文件修改时间在 CI 环境中不稳定）。
>
> 来源：`01-文件类工具-读取与搜索.md`

> **Q**: GlobTool 和 GrepTool 都有 `isSearchOrReadCommand()` 返回 `{ isSearch: true }`，这有什么作用？
>
> **A**: A：该标志用于 UI 层的可折叠显示控制。BashTool 也实现了 `isSearchOrReadBashCommand()` 检测命令类型。当工具被标记为搜索命令时，主循环的 UI 渲染层会将这些工具调用归类为"搜索操作"，在界面上使用折叠展示（collapsed display），减少视觉噪音。同时，这个分类也影响工具使用摘要（"搜索了 N 个文件" vs "读取了 N 个文件"）。
>
> 来源：`01-文件类工具-读取与搜索.md`

> **Q**: FileReadTool 的图像处理包含哪些步骤？
>
> **A**: A：图像处理包含检测 → 压缩 → 编码三步。首先通过 `detectImageFormatFromBuffer()` 从文件头字节检测图像格式（PNG/JPEG/GIF/WebP）；然后调用 `maybeResizeAndDownsampleImageBuffer()` 根据 token 限制缩放分辨率，避免超大图像消耗过多 token；若压缩失败（`ImageResizeError`），调用 `compressImageBufferWithTokenLimit()` 进行质量压缩；最终编码为 Base64 格式，包装成 Anthropic API 支持的 `Base64ImageSource` 格式（`{ type: 'base64', media_type, data }`）传递给模型。
>
> 来源：`01-文件类工具-读取与搜索.md`

> **Q**: `findActualString()` 如何解决引号不匹配问题？
>
> **A**: A：AI 生成的代码中经常出现弯引号（`"`/`"`/`'`/`'`）和直引号（`"`/`'`）的混用问题，这是因为 AI 训练数据包含大量使用弯引号的自然语言文档。`findActualString()` 在查找 `old_string` 时，会尝试多种引号等价替换：将 `old_string` 中的直引号替换为弯引号版本，以及反向替换，在文件中分别查找。若找到等价匹配，返回文件中实际存在的字符串（保持原始引号风格），避免引号差异导致的"字符串未找到"错误。
>
> 来源：`02-文件类工具-写入与编辑.md`

> **Q**: `readFileForEdit()` 为什么使用同步读取而不是异步？
>
> **A**: A：在 `call()` 的原子操作段内，使用异步读取（`await fs.readFile()`）会在等待期间将控制权交回事件循环，允许其他 I/O 操作（包括其他工具调用）插入。若两次 `await` 之间有并发的文件写入，原子性就被破坏了。同步读取（`readFileSyncWithMetadata()`）不会让出控制权，"读取-比较-写入"序列作为一个不可分割的单元执行。这是刻意在注释中提醒的设计决策。
>
> 来源：`02-文件类工具-写入与编辑.md`

> **Q**: FileEditTool 如何处理 `replace_all` 模式？
>
> **A**: A：`replace_all: true` 时，验证阶段允许多处匹配（跳过歧义检查），执行阶段调用 `String.replaceAll(actualOldString, actualNewString)` 替换所有出现。差异在结果消息上也有体现：`mapToolResultToToolResultBlockParam()` 对 `replace_all` 返回"All occurrences were successfully replaced"。注意：`replace_all` 仍然要求 `old_string` 至少存在一处匹配，完全找不到时仍然返回错误。
>
> 来源：`02-文件类工具-写入与编辑.md`

> **Q**: AgentTool 的 `run_in_background` 如何实现异步通知？
>
> **A**: A：后台代理通过 `registerAsyncAgent()` 注册，立即返回 `{ status: 'async_launched', agentId, outputFile }`，`outputFile` 是代理输出写入的磁盘路径。代理在独立任务（`LocalAgentTask`）中运行，完成时调用 `completeAsyncAgent()` 或 `failAsyncAgent()` 更新任务状态，并通过 `enqueueAgentNotification()` 将完成通知加入主循环的消息队列。主循环在下一次迭代中看到通知，将其作为新的用户消息注入对话，触发模型继续处理。
>
> 来源：`04-Agent任务类工具.md`

> **Q**: SendMessageTool 的邮箱目录在哪里？如何防止消息丢失？
>
> **A**: A：邮箱目录在 `~/.claude/mailboxes/{agentId}/inbox/`，每条消息是一个带时间戳的 JSON 文件。写入使用原子操作（写临时文件 → rename），避免读取端看到半写状态。Agent 轮询邮箱时按文件名（时间戳）顺序处理，处理后删除文件。若 Agent 崩溃，未处理的消息文件留在磁盘，重启后可以继续处理（持久性）。接收端会检查消息中的 `request_id` 进行关联，避免重复处理相同请求（幂等性）。
>
> 来源：`04-Agent任务类工具.md`

> **Q**: `subagent_type` 如何路由到不同的代理定义？
>
> **A**: A：`subagent_type` 对应 `loadAgentsDir.ts` 中加载的代理定义（`AgentDefinition`），包括内置代理（`GENERAL_PURPOSE_AGENT` 等）和用户自定义代理（从 `~/.claude/agents/` 目录加载）。路由逻辑：先检查是否匹配 `ONE_SHOT_BUILTIN_AGENT_TYPES`（一次性内置代理）；再通过 `filterAgentsByMcpRequirements()` 过滤出满足 MCP 需求的代理；若为自定义代理，解析 frontmatter 获取模型、系统提示等配置。特性标志 `isForkSubagentEnabled()` 开启时，`subagent_type` 会通过 fork 机制启动，而非完整的 Agent 对话循环。
>
> 来源：`04-Agent任务类工具.md`

> **Q**: 延迟加载（Deferred Tools）机制是如何工作的？
>
> **A**: A：延迟工具在工具池中以轻量形式存在——只有名称（`name`），没有完整的 `description`、`inputSchema`、`call` 等实现。`isDeferredTool(tool)` 检查工具是否处于延迟状态（`tool.isDeferred === true`）。当模型需要使用特定工具时，先调用 `ToolSearchTool`（使用 `select:toolName` 或关键词搜索），ToolSearchTool 在 `mapToolResultToToolResultBlockParam()` 中返回 `tool_reference` 内容块；API 服务器端看到 `tool_reference` 后，将对应工具的完整定义注入到模型的可用工具上下文中，模型随后可以正常调用该工具。整个过程对模型透明，降低了大型 MCP 集成场景的 token 消耗。
>
> 来源：`05-MCP类工具.md`

> **Q**: ReadMcpResourceTool 和 FileReadTool 的读取有什么本质区别？
>
> **A**: A：两者的读取对象和协议完全不同。FileReadTool 通过文件系统 API 读取本地磁盘文件，操作同步（或异步文件 I/O），资源是本地的。ReadMcpResourceTool 通过 MCP 协议向远程服务器请求资源，资源由 MCP 服务器管理（可能是数据库记录、API 响应、内存中的数据结构等），通过 URI 寻址（格式如 `github://repos/owner/repo/issues`）。MCP 资源的语义由服务器定义，Claude Code 对资源内容格式无预设，只负责转发请求和显示响应。
>
> 来源：`05-MCP类工具.md`

> **Q**: McpAuthTool 的 OAuth 流程如何在命令行环境中工作？
>
> **A**: A：Claude Code 作为 CLI 工具，通过 "Device Authorization Grant" 或 "Authorization Code with PKCE" 等适合命令行的 OAuth 流程：显示授权 URL → 用户在浏览器中打开 → 完成授权 → 服务器重定向到本地 callback（`http://localhost:{port}`）→ McpAuthTool 在本地启动临时 HTTP 服务器监听 callback → 提取 authorization code → 通过 MCP 服务器换取 access token → 存储 token 供后续调用使用。整个流程通过 `McpAuthTool` 的 `call()` 实现，对用户显示进度提示，失败时给出明确错误信息。
>
> 来源：`05-MCP类工具.md`

> **Q**: WebSearchTool 如何通过"委托给小模型"实现搜索？
>
> **A**: A：WebSearchTool 的 `call()` 方法调用 `queryModelWithStreaming()`，向小模型（`getSmallFastModel()`，通常是 Haiku）发送一个对话请求，工具列表只包含 `BetaWebSearchTool20250305`（Anthropic SDK 提供的内置搜索工具）。对话内容是用户的搜索查询加上域名过滤指令。小模型收到请求后自动使用 `web_search_20250305` 工具执行搜索，将结果作为 `tool_result` 返回。WebSearchTool 解析模型响应，从 `web_search_results` 内容块中提取 `{ title, url }` 列表返回给主模型。整个过程对主模型透明，它只看到搜索结果列表。
>
> 来源：`06-搜索与信息类工具.md`

> **Q**: LSPTool 的 8 种操作中，`prepare_call_hierarchy` + `incoming_calls` + `outgoing_calls` 的组合用法是什么？
>
> **A**: A：这是调用图分析的三步流程。`prepare_call_hierarchy` 首先获取指定位置符号的 `CallHierarchyItem`（包含符号名、文件路径、范围）；然后 `incoming_calls` 返回调用此符号的所有上层调用者（谁调用了这个函数？）；`outgoing_calls` 返回此符号调用的所有下层被调用者（这个函数调用了哪些其他函数？）。组合使用可以构建完整的调用链分析：追踪某个关键函数的调用路径，理解代码流程，定位性能瓶颈或安全漏洞的传播路径。
>
> 来源：`06-搜索与信息类工具.md`

> **Q**: ToolSearchTool 的 `select:` 前缀语法有什么特殊处理？
>
> **A**: A：`select:` 前缀是精确选择模式，比关键词搜索更可靠。支持逗号分隔的多工具选择（`select:ToolA,ToolB,ToolC`）。查找逻辑：先在延迟工具列表（deferred tools）中查找，若找到则直接返回；若在延迟列表中找不到，再在完整工具池（包括已激活工具）中查找——若工具已经激活，"选择"它是幂等的无操作，让模型继续而不需要重试。若工具完全不存在，返回空结果并记录调试日志。这种"延迟优先，完整工具兜底"的策略减少了重试链。
>
> 来源：`06-搜索与信息类工具.md`

> **Q**: AskUserQuestionTool 的 `preview` 字段如何在终端中渲染？
>
> **A**: A：`preview` 是选项聚焦时显示的预览内容（代码片段、设计稿、配置示例等）。`getQuestionPreviewFormat()` 从 bootstrap 状态读取当前渲染格式（可能是 Markdown 渲染或原始文本）。Ink 组件（React TUI 库）在终端中使用键盘导航，当用户选中某选项时，组件通过 `Box` 和 `Text` 在选项描述下方展开渲染 preview 内容。若 preview 包含代码块，使用语法高亮；若包含 ASCII 表格，保持格式。这为用户提供了在做决策前的可视化参考，特别适用于"展示两种 UI 布局方案让用户选择"的场景。
>
> 来源：`07-会话控制类工具.md`

> **Q**: ExitPlanModeTool 的用户批准流程是如何实现的？
>
> **A**: A：ExitPlanModeTool 的 `shouldDefer: true` 标志触发权限对话框（permission dialog），用户在对话框中看到 AI 提交的计划内容，可以选择"批准"或"拒绝"。批准时，主循环调用 `call()`，工具将权限上下文从 `plan` 模式恢复为 `auto`；拒绝时，工具结果包含拒绝信息，AI 收到后了解需要修改计划，继续在 plan mode 中工作。注意：在 `isPlanModeInterviewPhaseEnabled()` 时，Exit 流程还包含计划文件的审查，AI 需要将计划写入指定文件，用户审查文件内容后再批准。
>
> 来源：`07-会话控制类工具.md`

> **Q**: `SleepTool` 在实际工作流中有哪些应用场景？
>
> **A**: A：三类主要场景。第一，轮询等待：当 AI 触发了一个需要时间完成的操作（如 CI 构建），可用 Sleep 间隔固定时间后再检查状态，模拟轮询模式而非暴力循环（防止快速连续 API 调用）；第二，速率限制遵守：某些 API 有速率限制（如 GitHub API），连续调用多个接口时 Sleep 可以分散请求，避免 429 错误；第三，等待 external 变化生效：如 DNS 传播、缓存过期、数据库事务提交等需要等待时间的操作后使用。Sleep 的等待时间是 AI 根据场景判断的，不需要用户介入。
>
> 来源：`07-会话控制类工具.md`

> **Q**: SyntheticOutputTool 的 AJV 动态验证是如何工作的？
>
> **A**: A：AJV（Another JSON Validator）是一个 JSON Schema 编译器，可以将 JSON Schema 编译为高性能的验证函数。`SyntheticOutputTool` 在 `call()` 中接收调用者传入的 `output` 内容（通过 passthrough schema），同时从工具定义（由 main.tsx 创建时传入的 schema 参数）获取预期的 JSON Schema。AJV 编译该 schema，生成验证函数，对 `output` 进行验证。若验证失败，返回包含详细错误路径的 `TelemetrySafeError`，告知调用者哪个字段格式不符合要求。这使 Claude Code 能够作为有类型约束的 headless API 工具使用。
>
> 来源：`08-其他专用工具.md`

> **Q**: TeamCreateTool 的颜色分配如何工作？
>
> **A**: A：`assignTeammateColor()` 从预定义的颜色池中为新 Teammate 分配颜色，颜色用于在 tmux 多窗格布局中区分不同的 Teammate。颜色分配策略是"尽量避免重复"——维护已使用颜色的集合，新成员从未用颜色中选择；若所有颜色都已使用，则循环使用。颜色信息写入团队文件（`~/.claude/teams/{teamName}.json`），Teammate 启动时读取自己的颜色配置，通过 tmux 的 `tmux set-option pane-border-status` 命令设置边框颜色，实现可视化区分。
>
> 来源：`08-其他专用工具.md`

> **Q**: TodoWriteTool 中的 `verificationNudgeNeeded` 是什么机制？
>
> **A**: A：这是一个自动质量保障机制。当 `feature('VERIFICATION_AGENT')` 启用且 `tengu_hive_evidence` 特性标志为 true 时，TodoWriteTool 检测"关闭 3+ 项任务的关闭操作，且其中没有验证步骤"的情况。若检测到，在工具结果中注入提示："建议你在标记任务完成前添加一个验证步骤"。这个"结构性推拨"（structural nudge）不强制 AI 执行，但在 todo 列表关闭时机主动提醒 AI 验证工作质量，减少"完成但未测试"的情况。
>
> 来源：`08-其他专用工具.md`

### 命令系统（03-命令系统/）

> **Q**: `loadAllCommands` 为什么用 `memoize` 而不是模块级变量？
>
> **A**: A：命令加载依赖 `cwd`（当前工作目录），不同目录可能有不同的技能目录命令和工作流。模块级变量无法区分不同 cwd；`memoize` 以参数为键，允许按 cwd 缓存。同时，`clearCommandsCache()` 可按需清除缓存（插件安装、`/reload-plugins` 等场景），而模块级变量只能整体重置。
>
> 来源：`00-命令系统总览.md`

> **Q**: `feature()` 函数与 `require()` 配合实现了什么？
>
> **A**: A：这是 Bun 打包器的死代码消除（Dead Code Elimination）机制。`feature('BRIDGE_MODE')` 在编译期求值，若为 `false`，整个 `require(...)` 分支连同目标模块都被剔除出产物。这使得同一份源码可生成"内部版"和"外部发布版"两种不同的产物——外部版不含 ANT-ONLY 功能，减小体积并避免泄漏内部实现。
>
> 来源：`00-命令系统总览.md`

> **Q**: `INTERNAL_ONLY_COMMANDS` 数组的作用是什么？
>
> **A**: A：标记仅在内部构建中保留的命令（如 `commit`、`bughunter`、`antTrace`、`backfillSessions` 等）。构建脚本使用该列表在生成外部发布版时将这些命令从打包结果中排除。这比在每个命令内用 `isEnabled: () => false` 更彻底——后者仍会打包代码，前者在模块图中直接断开连接。
>
> 来源：`00-命令系统总览.md`

> **Q**: `executeShellCommandsInPrompt` 中的 `!\`...\`` 语法是如何工作的？
>
> **A**: A：这是 Claude Code 自定义的"Shell 内联"语法，不是标准 Markdown。`executeShellCommandsInPrompt` 扫描提示词中所有 `!\`...\`` 模式，在命令执行前使用 `child_process`（或 Bun 的等价 API）逐一运行这些 Shell 命令，将输出替换原始占位符。这样最终发送给模型的提示词已包含实时的 `git status`、`git diff` 输出，模型看到的是真实数据而非模板占位符。权衡：每次调用 `/commit` 都会执行多次 Git 查询，但 Git 读操作开销极低，换来的是提示词内容的实时性。
>
> 来源：`01-git类命令.md`

> **Q**: `/branch` 命令的 `forkedFrom` 字段如何实现会话追踪？
>
> **A**: A：每条 transcript 条目（`TranscriptEntry`）会记录 `forkedFrom: { sessionId, messageUuid }`，建立从子会话到父会话的引用链。这使得 `/resume` 可以显示会话树而非扁平列表，用户可以看到分支点。同时，`deriveFirstPrompt()` 从父会话的第一条用户消息中提取标题（截断到 100 字符，折叠空白），用于分支的默认命名，避免标题中出现换行（代码、错误堆栈）破坏会话索引。
>
> 来源：`01-git类命令.md`

> **Q**: `commit-push-pr` 中 `contentLength` 为何使用 `'main'` 作为 `getPromptContent` 的估算参数？
>
> **A**: A：`contentLength` 用于 REPL 在注入命令前估算 token 消耗，判断是否超过上下文窗口。`getDefaultBranch()` 是异步操作，而 `contentLength` 是同步的 getter 属性。用 `'main'` 作为占位符的长度与真实分支名（如 `master`、`develop`）差异极小（几个字节），对 token 估算影响可忽略不计，这是"实用主义优先于精确性"的合理权衡。
>
> 来源：`01-git类命令.md`

> **Q**: `/compact` 后为什么需要清除 `getUserContext.cache`？
>
> **A**: A：`getUserContext()` 返回用户上下文（如内存文件、技能信息），这些信息被 memoize 缓存以避免重复读取。压缩后，系统提示词（system prompt）会重新构建，其中包含的上下文也需要刷新。若不清除缓存，新会话使用的系统提示词可能包含过时的用户上下文（如已更新的 `CLAUDE.md` 内容）。`runPostCompactCleanup()` 处理其他缓存，`getUserContext.cache.clear()` 专门处理用户上下文缓存——两者都在压缩成功的所有路径中执行。
>
> 来源：`02-会话管理类命令.md`

> **Q**: `getMessagesAfterCompactBoundary` 的作用是什么？
>
> **A**: A：Claude Code 的 REPL 保留所有消息（包括已被 snip 标记的旧消息）用于 UI 滚动回放，但这些 snip 前的消息不应再次被 LLM 摘要——它们已经是"死"历史。`getMessagesAfterCompactBoundary` 通过查找 snip 边界标记，只返回边界之后的"活"消息，确保压缩引擎只处理有效上下文，避免重复压缩已压缩内容。
>
> 来源：`02-会话管理类命令.md`

> **Q**: `/session` 命令为什么只在远程模式下可见？
>
> **A**: A：`/session` 的作用是生成当前终端会话的远程访问 URL 和 QR 码，供移动设备或其他终端接入。这个命令仅在 `--remote` 标志启动（`getIsRemoteMode() === true`）时有意义——非远程模式下，终端就是全部，不需要远程接入 URL。`isHidden: !getIsRemoteMode()` 和 `isEnabled: () => getIsRemoteMode()` 双重控制确保命令在命令补全列表中不出现（`isHidden`），且即使直接调用也会被拒绝（`isEnabled`）。
>
> 来源：`02-会话管理类命令.md`

> **Q**: `ContextVisualization` 使用 `renderToAnsiString` 的原因是什么？
>
> **A**: A：`LocalJSXCommand` 的执行结果通常是返回 `ReactNode`，由 Ink 运行时渲染到终端。但 `/context` 的实现选择了 `renderToAnsiString`（将 React 组件渲染为带 ANSI 颜色码的字符串）并通过 `onDone` 输出，而不是直接返回 `ReactNode`。原因是 `/context` 需要同时支持交互模式和非交互模式——非交互模式下没有 Ink 运行时，无法渲染 `ReactNode`；使用 ANSI 字符串可以统一输出格式。这也使得 `/context` 的输出可以被管道捕获（`claude /context | grep "system prompt"`）。
>
> 来源：`03-上下文类命令.md`

> **Q**: `validateDirectoryForWorkspace` 在 `add-dir` 中做哪些验证？
>
> **A**: A：基于文件系统安全性考虑，通常包含：路径存在性检查（目录必须存在）、路径解析（展开 `~`、相对路径到绝对路径）、权限检查（用户对该目录是否有读权限）、沙箱合规性检查（若启用沙箱模式，路径需在允许范围内）。`addDirHelpMessage` 在验证失败时提供友好的错误提示和使用示例，帮助用户理解正确的使用方式。
>
> 来源：`03-上下文类命令.md`

> **Q**: `ctx_viz` 与 `/context` 的区别是什么？
>
> **A**: A：`ctx_viz` 是内部专用（`INTERNAL_ONLY_COMMANDS`）的调试命令，通过 JavaScript 索引文件（`index.js`，源码不完整）实现，主要用于 Anthropic 内部工程师调试上下文折叠和 token 计算逻辑，输出可能包含更详细的内部数据结构。`/context` 是面向用户的稳定命令，提供用户友好的可视化界面（彩色网格 + 百分比）。两者都基于 `analyzeContextUsage` 的核心计算，但展示层不同。
>
> 来源：`03-上下文类命令.md`

> **Q**: `/effort` 的 `immediate: true` 是什么含义？
>
> **A**: A：`immediate: true` 表示该命令可以立即执行，无需等待当前正在进行的模型推理停止。大多数命令需要在模型推理"停止点"（stop point）才能执行，以避免状态竞争（修改配置时模型可能正在使用旧配置）。配置命令（effort、color 等）通常被标记为 `immediate`，因为它们的影响是幂等的——设置 effort 值不影响当前正在进行的 API 调用，只影响下一次调用。`shouldInferenceConfigCommandBeImmediate()` 可能基于当前模型状态动态决定是否立即执行。
>
> 来源：`04-AI辅助类命令.md`

> **Q**: `toPersistableEffort` 为什么对某些值返回 `undefined`？
>
> **A**: A：`EffortValue` 类型包含一些会话级别（session-only）的 effort 值，这些值仅在当前会话有意义（如某些动态计算的值），无法写入配置文件。当用户设置了这类值时，`toPersistableEffort` 返回 `undefined`，跳过 `updateSettingsForSource` 的调用（避免写入 `undefined` 到配置文件），但 `logEvent` 和状态更新仍然执行——设置在当前会话生效，但下次启动不会记住。用户会收到 "(this session only)" 的后缀提示。
>
> 来源：`04-AI辅助类命令.md`

> **Q**: `/agents` 通过 `getTools(permissionContext)` 获取工具列表有何意义？
>
> **A**: A：`getTools` 依据当前的权限上下文（`toolPermissionContext`）返回过滤后的工具列表，而非全部工具。不同用户、不同权限配置、不同 Feature Flag 下，可用工具集不同。将 `permissionContext` 传入 `AgentsMenu` 确保 UI 展示的工具与实际可用的工具一致，避免展示用户根本无法使用的工具（如受沙箱限制的工具、需要特定权限的 MCP 工具等）。这是最小惊讶原则的实践。
>
> 来源：`04-AI辅助类命令.md`

> **Q**: `isKeybindingCustomizationEnabled()` 的"预览"状态意味着什么？
>
> **A**: A：该函数通常检查 Feature Flag（GrowthBook）或特定环境变量来判断功能是否开放。"预览"状态意味着：功能代码已经合入主分支，但不向所有用户开放——可能通过 GrowthBook 灰度（如仅对 5% 用户开放），或通过环境变量 `CLAUDE_CODE_ENABLE_KEYBINDINGS=1` 手动激活。命令注册时 `isEnabled: () => isKeybindingCustomizationEnabled()` 确保预览用户能看到命令，非预览用户的命令列表中则不出现该命令。这是功能灰度发布的标准模式。
>
> 来源：`05-配置类命令.md`

> **Q**: `generateKeybindingsTemplate()` 生成的模板有什么作用？
>
> **A**: A：键绑定配置文件是 JSON 格式的用户可编辑文件，`generateKeybindingsTemplate()` 生成一个包含所有可配置键绑定的注释示例。模板的作用是"文档即配置"——用户打开文件时能直观看到有哪些可配置项及其默认值/示例，无需查阅文档。使用 `'wx'` 标志确保模板只在文件不存在时写入，不覆盖用户已有的自定义配置——这是"首次创建模板，后续使用用户文件"的正确语义。
>
> 来源：`05-配置类命令.md`

> **Q**: `editFileInEditor` 如何确定使用哪个编辑器？
>
> **A**: A：`editFileInEditor` 遵循标准 Unix 惯例：优先读取 `$VISUAL` 环境变量（GUI 编辑器，如 `code`、`nvim -g`），其次 `$EDITOR`（终端编辑器，如 `vim`、`nano`），最后回退到系统默认（macOS 的 TextEdit、Linux 的 xdg-open 等）。若所有方式都失败，返回 `{ error: '...' }` 并在命令结果中提示用户文件路径，让用户自行打开。这是尊重用户编辑器偏好的 Unix 哲学实践。
>
> 来源：`05-配置类命令.md`

> **Q**: `formatTotalCost()` 需要跨多个 API 调用累计费用，如何做到不丢失数据？
>
> **A**: A：`cost-tracker.js` 维护一个会话级别的累计器，在每次 API 响应处理后更新（通过 `response.usage` 字段获取 input/output token 数量，再乘以对应模型的 token 价格）。这个累计器存在于内存中（进程生命周期内）。重要的是：跨会话的累计通常**不持久化**——关闭 Claude Code 后重新打开，费用从 0 开始计算。这是合理的设计：用户关注的是"这次工作花了多少"，而非"有史以来总花了多少"（后者由 Anthropic 的账单系统追踪）。
>
> 来源：`06-调试诊断类命令.md`

> **Q**: `currentLimits.isUsingOverage` 的数据来源是什么？
>
> **A**: A：`claudeAiLimits.js` 维护的 `currentLimits` 对象来源于 Anthropic API 响应头或专用的限额 API。claude.ai 订阅计划有每月的请求数和 token 限额，当超过限额进入超额（overage）计费模式时，API 响应会携带相应标志。`claudeAiLimits` 服务监听这些标志并更新 `currentLimits.isUsingOverage`。这使得 `/cost` 可以实时反映用户的计费状态，而无需主动查询 API。
>
> 来源：`06-调试诊断类命令.md`

> **Q**: `/stats` 和 `/usage` 的数据来源有何不同？
>
> **A**: A：`/stats` 读取**本地**会话存储（`~/.claude/projects/*/transcript.jsonl` 文件），统计的是本设备的使用情况（会话数、活跃天数、各类命令使用频率）；`/usage` 读取的是**服务端**的计划限额数据（通过 API 获取，反映账号级别的使用情况）。两者互补：`/stats` 反映个人使用习惯（本地），`/usage` 反映计划消耗情况（账号级别，跨设备）。
>
> 来源：`06-调试诊断类命令.md`

> **Q**: `/chrome` 通过 MCP 服务器检测扩展连接状态（而非直接查询 Chrome API）的原因？
>
> **A**: A：Chrome 扩展与 Claude Code CLI 之间的通信通过 MCP（Model Context Protocol）服务器桥接——Chrome 扩展作为 MCP 服务器，CLI 作为 MCP 客户端连接。因此"扩展是否安装且已连接"等价于"名为 `CLAUDE_IN_CHROME_MCP_SERVER_NAME` 的 MCP 客户端是否处于 `connected` 状态"。直接通过 `mcpClients.find(...)` 检查 MCP 连接状态比调用浏览器 API 更简单，也避免了跨进程通信的复杂性。
>
> 来源：`07-发布与集成类命令.md`

> **Q**: `/desktop` 的会话迁移如何保证 CLI 上已有的对话历史在 Desktop 中可见？
>
> **A**: A：通过深度链接（deep link）传递会话 ID。`DesktopHandoff` 组件构建包含当前 `sessionId` 的 URL scheme（如 `claude://resume?session=<uuid>`），Claude Desktop 应用接收到这个 URL 后，通过读取相同的本地 transcript 文件（`~/.claude/projects/<hash>/<sessionId>.jsonl`）重建对话历史。CLI 和 Desktop 共享同一套本地存储格式，这是迁移无缝的关键。没有网络传输，完全基于本地文件系统的共享。
>
> 来源：`07-发布与集成类命令.md`

> **Q**: `BRIDGE_SAFE_COMMANDS`（在 `commands.ts` 中定义）与 `/remote-control` 的关系是什么？
>
> **A**: A：`BRIDGE_SAFE_COMMANDS` 是桥接安全白名单——定义哪些命令可以从移动端/Web 客户端通过桥接触发执行。`/remote-control` 命令本身是连接的**入口**（建立桥接），而 `BRIDGE_SAFE_COMMANDS` 控制**桥接建立后**哪些命令可以远程执行。例如 `/compact`（在线瘦身）、`/clear`、`/cost`、`/summary`、`/files` 被列为桥接安全命令，可以从手机触发。`local-jsx` 命令（渲染 Ink UI）被显式阻止，因为 Ink 界面无法传输到远程客户端。
>
> 来源：`07-发布与集成类命令.md`

> **Q**: `/plan` 的计划模式如何影响 AI 的执行方式？
>
> **A**: A：计划模式（plan mode）通过修改 `AppState.planMode` 标志，改变主推理循环的行为：启用后，AI 在开始执行任何操作（写文件、运行命令）之前，先输出结构化的执行计划（通常是编号步骤列表），并等待用户通过特殊 UI 确认。用户可以修改计划或跳过某些步骤。这本质上是在 AI 和用户之间引入了一个"审批节点"，适合高风险操作（大规模重构、删除文件等）。技术实现上，`planMode` 标志通过系统提示词注入（或工具调用前置检查）传递给模型，引导模型改变输出格式。
>
> 来源：`08-其他命令.md`

> **Q**: `/memory` 编辑的记忆文件与系统提示词的关系是什么？
>
> **A**: A：`~/.claude/memory.md`（全局记忆）和项目级 `CLAUDE.md` 在每次对话开始时被读取，内容注入系统提示词的特定区段（`getUserContext()` 收集这些内容）。`/memory` 提供了一个方便的 UI 来编辑这些文件，而不必手动打开文件系统。重要的是：编辑后的内容在**当前会话中不会立即生效**（系统提示词已经构建完成）；需要执行 `/clear` 重置会话或等待下次启动，`getUserContext.cache.clear()` 才会读取新内容。`/compact` 后也会刷新（`compact` 流程会清除 `getUserContext.cache`）。
>
> 来源：`08-其他命令.md`

> **Q**: `/mcp` 和 `/plugin` 在扩展性架构中扮演什么角色？
>
> **A**: A：Claude Code 的扩展架构分两层：MCP（Model Context Protocol）层和插件（Plugin）层。
> - MCP 是外部协议标准，允许第三方服务器提供工具、资源和提示词，`/mcp` 管理这些外部服务器的连接和配置
> - 插件是 Claude Code 特有的扩展格式，包含完整的命令、技能和钩子定义，`/plugin` 管理本地安装的插件包
> 两者共同构成 Claude Code 的"应用商店"，MCP 面向服务端集成（数据库、API、工具链），插件面向 CLI 功能扩展（新命令、新工作流）。`/reload-plugins` 在两层都触发刷新，`clearCommandsCache()` 清除所有已加载的插件和 MCP 命令缓存。
>
> 来源：`08-其他命令.md`

### Agent 协调（04-Agent协调/）

> **Q**: 协调器如何保证工作者"看不到"主会话的对话历史？
>
> **A**: A：`getCoordinatorSystemPrompt()` 明确指出"Workers can't see your conversation"，并要求每个工作者提示词必须"self-contained"。在实现层面，`AgentTool` 以独立的上下文启动子 Agent 查询（独立的 `query()` 调用链），工作者的消息历史与主会话相互隔离。主协调器必须在工作者提示词中显式注入所需的文件路径、行号、错误信息等，而不能依赖共享记忆。
>
> 来源：`01-coordinator.md`

> **Q**: `INTERNAL_WORKER_TOOLS` 集合包含哪些工具，设计动机是什么？
>
> **A**: A：集合包含 `team_create`、`team_delete`、`send_message`、`synthetic_output` 四个工具。这些工具属于协调器"控制平面"：`send_message` 用于主协调器向工作者发送后续消息；`team_create/delete` 管理工作者团队；`synthetic_output` 生成结构化输出。若工作者也能调用这些工具，将打破协调拓扑（工作者向另一工作者发消息，形成自组织网络），导致协调语义失控。过滤该集合实现了工作者工具权限的最小化。
>
> 来源：`01-coordinator.md`

> **Q**: 系统提示词中的并发策略规则是什么？
>
> **A**: A：提示词将任务分为三类：只读任务（研究类）可无限并行；写密集任务（实现类）同一文件集同时只能一个工作者操作；验证任务在不同文件区域时可与实现并行。并发的核心机制是"单次消息多工具调用"——协调器在同一 LLM 输出中发起多个 `AgentTool` 调用，每个工具调用异步启动一个工作者，所有工作者并行执行，结果通过 `<task-notification>` 逐一回流。
>
> 来源：`01-coordinator.md`

> **Q**: `ProgressTracker` 中 `input_tokens` 只保留最新值而 `output_tokens` 累加，这背后的 API 行为是什么？
>
> **A**: A：Anthropic API 对 `input_tokens` 的计算包含本轮所有历史上下文（prompt caching 也反映在此字段的子字段中），因此在同一个多轮 Agent 会话中，每次返回的 `input_tokens` 是**单调递增的累计值**。若将每轮都相加，token 数会被严重高估。而 `output_tokens` 是当前轮次新生成的 token 数，不含历史，需要手动累加才能得到会话总输出量。`ProgressTracker` 的 `latestInputTokens + cumulativeOutputTokens` 设计精确体现了这一差异。
>
> 来源：`02-tasks.md`

> **Q**: `PANEL_GRACE_MS` 是什么？为什么已完成的任务不立即从 `AppState` 中删除？
>
> **A**: A：`PANEL_GRACE_MS` 是任务完成后的面板保留时间（毫秒）。任务结束时，`evictAfter` 被设为 `Date.now() + PANEL_GRACE_MS`，后台 GC 定时任务在超过该时间后才将任务从 `AppState.tasks` 中移除。保留窗口是为了让用户有机会查看任务最终输出——若任务一结束立即清除，协调器面板会闪烁消失，用户来不及阅读结果。`retain: true` 的任务（用户正在查看其转录记录）不设 `evictAfter`，永久保留直到用户离开视图。
>
> 来源：`02-tasks.md`

> **Q**: `pendingMessages` 队列的设计目的是什么？
>
> **A**: A：协调器在工作者执行期间（工作者的 `query()` 循环还在运行）可能通过 `SendMessageTool` 发送后续消息（修正指令、追加信息等）。此时工作者处于某个工具执行的中间轮次，无法立即处理新消息。`pendingMessages` 将这些消息排队，在每个工具执行轮次结束时由 `drainPendingMessages()` 取出，注入到下一轮的上下文中。这实现了协调器和工作者之间的**异步通信**，而不需要中断工作者当前的工具调用。
>
> 来源：`02-tasks.md`

> **Q**: `snipTokensFreed` 为何要传递给 `autocompact()`？两者不是独立的压缩机制吗？
>
> **A**: A：`calculateTokenWarningState()` 用来判断是否触发 autocompact，它读取消息历史中**最后一条助手消息**的 `usage.input_tokens`（API 报告的累计值）作为当前 token 数估算。但 `snipCompact` 在 API 调用前截断了消息，被截断的 token 不会反映在"最后一条助手消息的 usage"中（那是上一轮的值）。若不传 `snipTokensFreed`，autocompact 会基于"未减去 snip 贡献"的旧 token 数判断阈值，导致 snip 刚把我们拉到阈值以下却仍被 autocompact 触发——浪费一次全量压缩。减去 `snipTokensFreed` 让阈值判断反映 snip 的真实贡献。
>
> 来源：`03-query.md`

> **Q**: `StreamingToolExecutor` 是什么？它如何在流式响应过程中并行执行工具？
>
> **A**: A：`StreamingToolExecutor` 在流式响应到达时立即开始执行工具，不等全部流结束。当 API 流中出现 `tool_use` 块时，`addTool()` 被调用，工具执行在后台异步启动；随后每次循环 `getCompletedResults()` 检查并收割已完成的工具结果，立即 yield 给上游。若在流过程中触发了 fallback（模型切换），`streamingToolExecutor.discard()` 放弃所有进行中的工具执行，创建新的 executor 重新开始——旧的 `tool_use_id` 将无法匹配任何结果，若不丢弃会产生"孤儿工具结果"导致 API 报错。
>
> 来源：`03-query.md`

> **Q**: `task_budget.remaining` 是如何在多次压缩后保持正确的？
>
> **A**: A：`taskBudgetRemaining` 是循环局部变量（非 `State` 的一部分），在每次 autocompact 触发时更新：`taskBudgetRemaining = max(0, (taskBudgetRemaining ?? total) - preCompactContext)`。`preCompactContext` 是压缩前的最终上下文窗口大小（从最后一条 API 响应的 usage 读取）。多次压缩时，每次都从当前 remaining 中扣除该轮的最终上下文，累计追踪整个会话消耗。不放在 `State` 中的原因：State 有 7 个 continue 站点，每个都需要传递该字段，代码噪声过大；局部变量在循环体内是隐式共享的，更简洁。
>
> 来源：`03-query.md`

> **Q**: 进程内 Teammate 如何实现"权限请求转发给 leader"？这中间经历了哪些步骤？
>
> **A**: A：完整路径有四级降级：1）`hasPermissionsToUseTool()` 标准检查，若工具在 Teammate 的权限模式下本就允许，直接执行，无需转发；2）bash 命令模式匹配（`classifier` 自动审批），对已知安全的命令模式（如只读的 `ls`、`cat` 等）自动批准，无需用户介入；3）`leaderPermissionBridge.requestApproval()` 触发 leader REPL 注册的 `setToolUseConfirmQueue` 回调，在 leader 的终端 UI 中弹出带有 worker badge（显示来源 Teammate 名称）的确认对话框，等待用户点击 Allow/Deny；4）若 leader REPL 不可用（如 headless SDK 模式），降级为通过文件系统邮箱发送 `plan_approval_request` 消息，Teammate 轮询等待 `plan_approval_response`。
>
> 来源：`05-多Agent协作与Swarm.md`

> **Q**: 文件系统邮箱如何保证消息不丢失？其原子性是如何实现的？
>
> **A**: A：原子性通过写临时文件 + rename 实现。发送方先将消息序列化写入同目录的 `.tmp` 临时文件，再通过 `fs.rename()` 重命名为最终文件名（时间戳命名的 `.json`）。rename 在同一文件系统内是原子操作（POSIX 保证），接收方要么看到完整的消息文件，要么看不到该文件，不会看到半写状态。消息文件在接收方处理后删除，若 Agent 崩溃重启，未删除的消息文件会在重启后继续被处理，保证了 at-least-once 投递语义。接收方通过 `request_id` 字段实现幂等性检查。
>
> 来源：`05-多Agent协作与Swarm.md`

> **Q**: verification Agent 的系统提示词为什么要专门对抗"LLM 验证逃避模式"？这些逃避模式是什么？
>
> **A**: A：LLM 在验证自己或他人生成的代码时，存在系统性的"确认偏误"——倾向于认为代码是正确的，因为代码在语法和表面逻辑上看起来合理。典型的逃避模式包括：1）**外观正确性陷阱**：代码结构合理、命名规范，但存在偏差一的边界错误；2）**测试覆盖幻觉**：测试用例存在且通过，但未覆盖关键边界条件（如空指针、溢出、并发竞态）；3）**改动量最小化偏见**：认为"改动少 = 风险低"，忽视了小改动也可能破坏全局不变量；4）**成功路径偏见**：只验证正常路径，忽略错误处理和回滚路径。verification Agent 的系统提示词通过结构化检查清单，强制模型逐项验证这些易被忽略的维度，而非依赖整体直觉判断。
>
> 来源：`05-多Agent协作与Swarm.md`

> **Q**: Task 系统中 InProcessTeammateTask 持有两个 AbortController，分别在什么场景下使用？
>
> **A**: A：`killController` 和 `roundController` 对应两种不同的中止语义。`kill()` 调用 `killController.abort()`，终止整个 Teammate 的生命周期：停止当前轮次的 API 调用、取消所有挂起的工具执行、触发清理钩子并从 `AppState.tasks` 中移除。这是不可恢复的终止。`cancelCurrentRound()` 调用 `roundController.abort()`，仅中止当前对话轮次：终止当前 API 流和工具执行，但 Teammate 本身不退出，而是回到 idle 状态，等待下一条消息。典型场景：用户修改了对 Teammate 的任务描述，需要取消正在执行的过时任务，但不想销毁 Teammate 进程（避免重启开销）。
>
> 来源：`05-多Agent协作与Swarm.md`

> **Q**: 多个 fork 并行启动时，prompt cache 的命中率为什么更高？
>
> **A**: A：这需要理解 Anthropic API 缓存的工作方式与 fork 消息结构的联动。
>
> 当第一个 fork 子 Agent 的 API 请求到达服务端时，服务端发现这段前缀（父 Agent 历史 + 占位 tool_result）未被缓存，执行 cache write（按 125% 标准价格计费，写入缓存）。
>
> 从第二个 fork 子 Agent 的 API 请求开始，服务端检测到相同的前缀已经在缓存中，直接读取，支付 cache read 费用（约 10% 标准价格）。
>
> 假设父 Agent 历史有 50,000 tokens，每个 fork 子 Agent 各自的任务指令只有 100 tokens。N 个并行 fork 子 Agent 的总 token 成本为：
> - **无缓存**：N × 50,100 tokens × 标准价格
> - **有 fork 缓存**：50,100 tokens × 125%（cache write，只写一次）+ (N-1) × 50,000 tokens × 10%（cache read）+ N × 100 tokens × 标准价格（per-child 差异部分）
>
> N 越大，cache read 节约的绝对量越大。这就是 fork 并行数量越多，缓存收益越高的原因。
>
> 来源：`06-Fork与提示词缓存优化.md`

> **Q**: 描述 fork 的防递归机制，为什么需要两层检查？
>
> **A**: A：两层检查针对两种不同的"失效场景"，不能用其中任何一层单独替代另一层。
>
> **第一层（querySource 检查）** 在查询上下文级别工作：`query()` 函数接受 `querySource` 参数，fork 子 Agent 的 `query()` 调用传入 `querySource: 'fork'`，子 Agent 在 `call()` 入口检查这一字段，若为 `'fork'` 则直接拒绝。
>
> 这层检查的优势是 compaction-resistant：Compaction 是 Claude Code 的上下文压缩机制，会截断旧消息历史，但它不会影响 `querySource` 这个 `query()` 参数——参数在函数调用栈中传递，不存在于消息历史里，compaction 无法触及。
>
> 然而，`querySource` 依赖于 fork 调用时的初始化逻辑正确传递该字段。在某些极端情况下（比如代码 refactor 遗漏了该参数传递），第一层可能静默失效。
>
> **第二层（`<fork-boilerplate>` 标签扫描）** 作为 fallback，直接从消息历史中查找 `<fork-boilerplate>` 标签。只要子 Agent 是通过 fork 机制启动的，其消息历史中必然包含该标签（fork 指令块的 wrapper）。这层检查完全独立于函数参数传递链路，即使第一层因任何原因失效，第二层仍能阻断递归。
>
> 代价是第二层需要扫描消息历史（O(n) 文本查找），而第一层只是一次字段比较（O(1)）。双层设计以可忽略的扫描开销换取递归防护的可靠性。
>
> 来源：`06-Fork与提示词缓存优化.md`

> **Q**: 解释工具集分区排序如何影响 prompt cache 命中率
>
> **A**: A：Anthropic 服务端的缓存断点（cache breakpoint）机制与工具定义列表的结构密切相关。
>
> 服务端在处理工具定义时，会识别内建工具（Claude Code 定义的原生工具）与 MCP 工具（外部服务器注册的工具）的边界。当找到"最后一个内建工具定义"之后，服务端在该位置插入缓存断点：断点之前的内容（包括 system prompt + 内建工具定义）进入可缓存区，断点之后的内容（MCP 工具定义）不进入缓存。
>
> 这一机制的设计逻辑在于：内建工具定义是稳定的（Claude Code 版本不变则工具集不变），适合缓存；MCP 工具定义是用户可配置的，随 MCP 服务器的增删频繁变化，不适合缓存（否则每次 MCP 配置变更就需要 cache write，成本反而更高）。
>
> 如果 MCP 工具被混入内建工具列表中间（例如按字母序 `AgentTool → bash-mcp-server → BashTool`），"最后一个内建工具"的位置被提前，缓存断点也随之提前。原本属于内建工具的后半段定义被推入非缓存区，每次请求都需要全量计费。
>
> 分区排序（`内建工具全部在前，MCP 工具全部在后`）确保断点始终紧贴最后一个内建工具，MCP 工具的变动不影响断点位置，内建工具定义的缓存命中率保持稳定。
>
> 来源：`06-Fork与提示词缓存优化.md`

### 扩展系统（05-扩展系统/）

> **Q**: 插件启用状态是如何持久化和读取的？
>
> **A**: 启用状态存储在用户设置文件（JSON）的 `enabledPlugins` 字段中，键为 `{name}@builtin` 格式的插件 ID。`getBuiltinPlugins()` 在每次调用时通过 `getSettings_DEPRECATED()` 读取最新设置，再与 `definition.defaultEnabled` 合并，保证每次调用都反映最新的用户偏好。
>
> 来源：`01-plugins.md`

> **Q**: `PluginError` 为什么使用可辨识联合而不是继承体系或错误码字符串？
>
> **A**: 可辨识联合有三个优势：1) TypeScript 编译器在 `switch` 穷举时能检测未处理的分支，新增错误类型时不会漏掉；2) 每种错误类型携带专属字段（如 `git-auth-failed` 有 `authType`），比字符串错误码更类型安全；3) 比继承体系更轻量，无需类实例化，序列化也更简单。注释中明确说明当前只有 2 种类型在生产中使用，其余 15 种是"已规划的未来路线图"。
>
> 来源：`01-plugins.md`

> **Q**: `isAvailable()` 回调的典型使用场景是什么？
>
> **A**: 以 Claude in Chrome 插件为例：该功能依赖浏览器扩展通信，只在特定环境下有意义。`isAvailable()` 会检测系统是否满足条件（如是否安装了扩展、是否在支持的 OS 上），不满足时整个插件从 UI 中消失，避免用户看到无法使用的选项。
>
> 来源：`01-plugins.md`

> **Q**: 技能的参考文件（files 字段）是如何安全提取到磁盘的？
>
> **A**: 提取路径由 `getBundledSkillsRoot()` 返回的基础目录加上技能名称组成，基础目录包含一个进程级 nonce（随机数），防止攻击者预先创建符号链接。实际写入使用 `O_EXCL|O_NOFOLLOW` 标志：`O_EXCL` 保证文件不存在时才创建，`O_NOFOLLOW` 保证最终路径组件不为符号链接。路径本身经过 `resolveSkillFilePath()` 验证，拒绝包含 `..` 或绝对路径的输入（防目录遍历）。文件权限设为 `0o600`（仅所有者读写）。
>
> 来源：`02-skills.md`

> **Q**: 用户自定义技能（文件系统技能）是如何加载的？
>
> **A**: `loadSkillsDir.ts` 扫描多个目录（`policySettings`、`userSettings`、`projectSettings`、插件目录），读取每个 `.md` 文件，解析 YAML frontmatter（`parseFrontmatter()`），调用 `parseSkillFrontmatterFields()` 提取元数据，再通过 `createSkillCommand()` 构造 `Command` 对象。去重逻辑通过 `realpath()` 解析符号链接获取规范路径，避免通过不同路径加载同一文件。
>
> 来源：`02-skills.md`

> **Q**: `context: 'fork'` 的技能和 `context: 'inline'` 的技能有什么区别？
>
> **A**: `fork` 表示技能在独立的子 Agent 上下文中运行，拥有自己的消息历史，不会污染主对话上下文，适合自包含的自动化任务（如 `verify`）；`inline` 则在当前对话上下文中执行，模型可以直接参考之前的消息历史，适合需要用户实时干预的工作流（如 `skillify` 的多轮问答流程）。
>
> 来源：`02-skills.md`

> **Q**: 和弦序列（如 `ctrl+x ctrl+k`）是如何实现的？状态机如何管理？
>
> **A**: `resolveKeyWithChordState` 接受 `pending: ParsedKeystroke[] | null`，null 表示没有进行中的和弦。收到按键时：
> 1. 构建 `testChord = pending ? [...pending, current] : [current]`
> 2. 查找所有以 `testChord` 为前缀且长度更长的绑定（通过 `chordWinners` Map 并过滤 null 解绑）
> 3. 若存在，返回 `chord_started`，UI 层更新 `pendingChord` 状态
> 4. 若不存在，查找精确匹配；若有则返回 `match`，否则返回 `chord_cancelled`
> 5. 按下 Escape 直接取消当前和弦
>
> `pendingChordRef`（`useRef`）用于在 Ink 的 `useInput` 回调中即时读取状态（避免 React 闭包陈旧值），`pendingChord`（`useState`）用于触发 React 重渲染（如显示"等待下一个按键"的 UI 提示）。
>
> 来源：`03-keybindings.md`

> **Q**: 为什么 Escape 按键在终端中会触发 `key.meta = true`？match.ts 如何处理这个历史遗留问题？
>
> **A**: 在 VT100/ANSI 终端协议中，Alt 键通过发送 ESC 前缀字节实现（如 `Alt+k` 发送 `ESC k`）。Ink 的 input-event.ts 解析按键序列时，对 ESC 本身会设置 `key.meta = true`（历史实现）。若不处理这个 quirk，以 `"escape"` 为目标的绑定（不含 meta 修饰符）将永远匹配失败。`matchesKeystroke()` 的处理方式是：若 `key.escape` 为 true，在比对修饰符时将 `inkMods.meta` 强制为 false，即"忽略 escape 键上的假 meta 修饰符"。`resolver.ts` 中的 `buildKeystroke()` 也做了同样处理。
>
> 来源：`03-keybindings.md`

> **Q**: 文件热重载是如何实现的？为什么不直接监听文件而要用 `awaitWriteFinish`？
>
> **A**: 使用 `chokidar` 库监听 `~/.claude/keybindings.json`，配置了 `awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 }`。原因在于：编辑器（如 VS Code）保存文件时可能分多次写入（先截断再写入），如果在写入未完成时就触发 `change` 事件，读取到的是不完整的 JSON，导致解析失败。`awaitWriteFinish` 会等到文件大小在 500ms 内不再变化才触发事件，保证读取到完整文件。同时，`atomic: true` 支持原子替换（编辑器写入临时文件再 rename），`ignoreInitial: true` 避免启动时误触发。
>
> 来源：`03-keybindings.md`

### 服务与基础（06-服务与基础/）

> **Q**: 529 错误与 429 错误在重试策略上有何区别？
>
> **A**: > - **429（Rate Limit）**：通常来自用量配额，携带 `Retry-After` 头和 `anthropic-ratelimit-unified-reset` 重置时间戳。对 Claude.ai 订阅用户（非 Enterprise）不重试。
> > - **529（Overloaded）**：服务器过载，不携带精确重置时间。连续 3 次 529 时（`MAX_529_RETRIES`）触发模型降级（`FallbackTriggeredError`）。部分场景（非前台请求，如标题生成、建议）立即放弃重试以避免容量级联放大（"retry amplification"）。
>
> 来源：`01-services-api.md`

> **Q**: OAuth token 过期与 API key 失效分别如何处理？
>
> **A**: > - **OAuth 过期（401）**：`withRetry` 捕获 401 错误，提取当前 `accessToken`，调用 `handleOAuth401Error` 强制刷新，然后 `await getClient()` 重建客户端（携带新 token）再重试。
> > - **OAuth 撤销（403 "token revoked"）**：通过 `isOAuthTokenRevokedError` 检测，走相同刷新路径。
> > - **API key 失效（401）**：调用 `clearApiKeyHelperCache()` 清除缓存，SDK 在下次请求时重新拉取。
>
> 来源：`01-services-api.md`

> **Q**: `parseMaxTokensContextOverflowError` 的作用是什么？何时会触发？
>
> **A**: > 当请求的 `input_tokens + max_tokens > context_limit` 时，API 返回 HTTP 400 并携带错误消息如 `"input length and max_tokens exceed context limit: 188059 + 20000 > 200000"`。该函数用正则解析三个数字，计算可用上下文（`contextLimit - inputTokens - 1000`缓冲），更新 `retryContext.maxTokensOverride`，并 `continue` 重试。注释指出：开启 `extended-context-window` beta 后，API 改为返回 `model_context_window_exceeded` 停止原因而非 400，此函数为向后兼容保留。
>
> 来源：`01-services-api.md`

> **Q**: `stripProtoFields` 在无 PII 字段时为何返回原引用而非副本？
>
> **A**: > 这是一个零拷贝优化。绝大多数事件不含 PII 字段，若每次都 `{ ...metadata }` 创建副本，会产生大量短暂对象，加重 GC 压力。通过延迟创建副本（`if (result === undefined) result = { ...metadata }`），只有存在 `_PROTO_*` 键时才复制，正常路径返回原引用，引用相等性成立。
>
> 来源：`02-services-others.md`

> **Q**: 分析事件中为什么使用 `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 类型而不是普通 `string`？
>
> **A**: > 该类型在 TypeScript 中定义为 `never`（永远无法赋值），通过 `as` 强制转换作为"类型契约声明"——开发者必须显式用 `as AnalyticsMetadata_...` 转换，这是一个强迫审查的编译时机制：只有开发者确认该字符串不包含代码片段或文件路径（可能是用户隐私数据）时，才会进行这个转换。直接传入 `string` 类型会编译报错，防止误记录敏感信息到 Datadog。
>
> 来源：`02-services-others.md`

> **Q**: `diagnosticTracker.handleQueryStart` 什么时候重置状态，什么时候初始化？
>
> **A**: > 首次调用时（`!this.initialized`），从 MCP 客户端列表中寻找已连接的 IDE 客户端并调用 `initialize`。后续每次新查询调用时（已初始化），调用 `reset` 清空基线和时间戳记录，确保每个查询周期都有干净的起点，不会把上一个查询的诊断基线带入新查询。
>
> 来源：`02-services-others.md`

> **Q**: `git --no-optional-locks` 参数的作用是什么？Claude Code 为什么需要它？
>
> **A**: > 正常 git 操作会创建 `.git/index.lock` 等锁文件来防止并发写入。Claude Code 频繁调用 `git diff`、`git status` 等只读命令，如果用户同时在运行 IDE 的 git 集成，多个进程争抢锁会导致一方失败。`--no-optional-locks` 告知 git 跳过非必要的锁创建（只读操作本就不需要），允许并发读取，避免误报锁文件错误。
>
> 来源：`03-utils-git.md`

> **Q**: `fetchGitDiff` 为什么要排除 `isInTransientGitState` 状态？
>
> **A**: > 在 `git merge`、`git rebase`、`git cherry-pick`、`git revert` 等操作进行中，工作区同时包含「用户有意修改」和「merge 操作带入的变更」，`diff HEAD` 会把两者混在一起。若将这种混合状态的 diff 注入上下文，模型可能会将 merge 冲突标记当作需要修复的代码错误，或将即将废弃的文件当作当前文件处理，产生错误建议。返回 `null` 让上层逻辑以「无差异」状态处理，更安全。
>
> 来源：`03-utils-git.md`

> **Q**: `normalizeGitRemoteUrl` 的规范化逻辑有什么业务用途？
>
> **A**: > 规范化输出用于 URL 的哈希（`createHash` + 规范化 URL），生成稳定的项目唯一标识符。同一个仓库可能有多种访问方式（`git@github.com:org/repo.git`、`https://github.com/org/repo`、SSH tunnel URL），若不规范化，相同仓库会产生不同哈希，导致项目配置、auto-memory、agent 记忆等跨会话无法共享。规范化消除协议差异、大小写差异和 `.git` 后缀，确保同一物理仓库始终映射到同一标识符。
>
> 来源：`03-utils-git.md`

> **Q**: `shouldUseClaudeAIAuth(scopes)` 中的 `scopes` 参数如何决定是否启用 Claude.ai 认证？
>
> **A**: > OAuth token 在 `scopes` 字段中携带授权范围（如 `claude.ai.profile`）。`CLAUDE_AI_PROFILE_SCOPE` 常量是判断依据——只有当 scopes 中包含这个特定范围时，才认为该 token 是有效的 Claude.ai 订阅 token。这个检查防止将第三方 OAuth token 或过期作用域的 token 错误地当作 Claude.ai 订阅使用。
>
> 来源：`04-utils-model-auth.md`

> **Q**: Vertex AI 的 `GoogleAuth` 实例为什么每次 `getAnthropicClient` 都重新创建，而不缓存？
>
> **A**: > 源码注释明确指出这是一个 TODO："TODO: Cache either GoogleAuth instance or AuthClient to improve performance"，并列出了不缓存的理由：凭证刷新/过期、`GOOGLE_APPLICATION_CREDENTIALS` 等环境变量可能在两次调用之间变化、跨请求 auth 状态管理复杂。当前选择是「正确性优先」——每次重新创建 GoogleAuth 实例保证凭证始终是最新的，即使有轻微性能开销。
>
> 来源：`04-utils-model-auth.md`

> **Q**: `--bare` 模式与普通模式的认证差异是什么？
>
> **A**: > `--bare` 模式（`isBareMode()`）是 API-key-only 模式，设计给无 UI 的服务器部署：完全禁用 OAuth（不从 keychain 读取，不刷新 token），只接受 `apiKeyHelper` 配置或直接环境变量。这确保 bare 模式下的认证行为完全可预测、无交互提示，适合 CI/CD 环境和无人值守批处理。
>
> 来源：`04-utils-model-auth.md`

> **Q**: `iterations` 字段是什么？为什么只取最后一次迭代？
>
> **A**: > 在服务端工具循环（server-side tool loop）场景下，模型在一次 API 响应内部可能多次调用工具并处理结果，每次工具调用都是一次「迭代」。`iterations` 数组记录每次迭代的 `input_tokens` 和 `output_tokens`（不含缓存）。最终上下文窗口大小应该是最后一次迭代结束时的状态，因为此时上下文包含了所有工具调用结果——这是模型实际看到的「最终输入」，与任务预算的消耗量一致。
>
> 来源：`05-utils-cost-token.md`

> **Q**: `doesMostRecentAssistantMessageExceed200k` 的 200k 阈值有何意义？
>
> **A**: > 200k token 是 Claude 3.5/4 系列的基础上下文窗口大小。当最近一次 assistant 消息的总 token 数超过 200k 时，说明对话已填满标准上下文窗口，后续 API 调用可能需要 `extended-context-window` beta 功能或触发自动压缩。这个函数是上下文感知压缩逻辑的触发条件之一，超过阈值时 UI 会显示上下文窗口警告。
>
> 来源：`05-utils-cost-token.md`

> **Q**: `SYNTHETIC_MESSAGES` 和 `SYNTHETIC_MODEL` 过滤的作用是什么？
>
> **A**: > Claude Code 内部会合成一些「虚拟」的 assistant 消息（如工具结果展示、错误通知），这些消息不来自真实的 API 调用，因此 `usage` 对象要么为空要么包含虚假数据。`getTokenUsage` 通过检查消息内容是否在 `SYNTHETIC_MESSAGES` 集合中、模型是否为 `SYNTHETIC_MODEL` 来过滤这些消息，确保成本计算只统计真实 API 调用的 token，不因内部合成消息而虚增成本。
>
> 来源：`05-utils-cost-token.md`

> **Q**: `Object.is(next, prev)` 如何保证不可变更新的性能？
>
> **A**: > 通过 spread 操作符（`{ ...prev, field: newVal }`）更新时，只要至少有一个字段不同，产生的对象与原对象引用不等（`Object.is` 返回 false），触发副作用和重渲染。反之，如果 `setState(prev => prev)`（无变化），返回相同引用，`Object.is` 返回 true，完全跳过渲染。这比深比较（deep equal）效率高几个数量级，代价是调用方必须遵守「不直接 mutation」规则——这由 `DeepImmutable` 类型在编译期强制。
>
> 来源：`06-state.md`

> **Q**: `externalMetadataToAppState` 函数的用途是什么？
>
> **A**: > 当 CCR（Claude Code Remote）worker 重启时（网络中断后重连），服务端发送 `session_external_metadata`（包含 `permission_mode`、`is_ultraplan_mode` 等字段）来恢复会话状态。`externalMetadataToAppState` 将这些外部格式的元数据转换为 AppState 更新函数，这是 `onChangeAppState` 推送方向的逆操作：CCR push → worker 恢复，形成双向同步。
>
> 来源：`06-state.md`

> **Q**: `AppStateProvider` 为什么不允许嵌套（抛出错误）？
>
> **A**: > `HasAppStateContext` 是一个布尔 Context，`AppStateProvider` 挂载时通过 `useContext(HasAppStateContext)` 检测自己是否已被包裹在另一个 `AppStateProvider` 中。嵌套的 Provider 会创建两个独立的 Store 实例，子树组件读取内层 store，父树组件读取外层 store，权限模式、模型配置等全局状态会出现不一致。禁止嵌套确保「全局状态唯一性」。
>
> 来源：`06-state.md`

> **Q**: `z.discriminatedUnion('type', [...])` 相比 `z.union([...])` 在性能上的优势是什么？
>
> **A**: > `z.union` 逐个尝试每个子模式直到找到匹配的（O(n)）；`z.discriminatedUnion` 先读取判别字段（`type`）的值，通过 Map 直接定位对应子模式（O(1)）。对于 4 种钩子类型，`discriminatedUnion` 比 `union` 快约 4 倍。更重要的是错误信息：`union` 失败时会报告所有子模式的错误（难以阅读）；`discriminatedUnion` 只报告匹配到的子模式的错误，明确指向问题字段。
>
> 来源：`07-schemas.md`

> **Q**: `once: true` 钩子的执行语义是什么？在 schema 层如何体现？
>
> **A**: > `once: true` 是字段级声明，schema 层仅做类型验证（`z.boolean().optional()`），实际的「执行后移除」逻辑在钩子执行引擎（`utils/hooks/`）中实现：执行完后从内存中的钩子列表移除该条目。schema 保证这个字段被正确解析为布尔值，但不定义行为语义——这是 schema（数据契约）与执行逻辑（行为）分离的体现。
>
> 来源：`07-schemas.md`

> **Q**: `IfConditionSchema` 使用「权限规则语法」，这意味着什么？
>
> **A**: > 权限规则语法如 `"Bash(git *)"` 表示「工具名为 Bash，且命令参数匹配 `git *` 通配符」。`IfConditionSchema` 在 schema 层只验证字段是 string 类型（不做语法检查），实际的模式匹配（glob 展开、工具名比较）在钩子执行前的过滤步骤中进行。这样 schema 保持简单，运行时的模式匹配逻辑可以独立演进而无需改变 schema。
>
> 来源：`07-schemas.md`

> **Q**: `feature('KAIROS')` 和 `feature('TEAMMEM')` 的门控如何影响最终包的体积？
>
> **A**: > `bun:bundle` 的 `feature()` 是编译期宏，Bun 构建系统在打包时将未启用的功能替换为 `false`（类似 `#ifdef`），随后死代码消除（DCE）移除永远不执行的分支。外部用户构建中 `feature('TEAMMEM')` 为 false，团队记忆的所有代码（`teamMemPaths.ts`、`teamMemPrompts.ts`）被 tree-shake，不出现在发布包中，既减小体积又确保内部功能不泄漏。
>
> 来源：`08-constants-types-migrations.md`

> **Q**: `MAX_ENTRYPOINT_LINES = 200` 和 `MAX_ENTRYPOINT_BYTES = 25_000` 这两个上限是如何确定的？
>
> **A**: > 注释说明：200 行 × ~125 字节/行 ≈ 25KB，这是「p97」用户的内存文件大小——97% 的用户内存文件不超过这个大小，因此截断不影响大多数用户。字节限制（25KB）是作为对行限制的补充，专门处理极长行的情况（观测到的 p100 是 197KB，均在 200 行以内，意味着有些行特别长）。两个上限的组合确保无论哪种异常情况（行太多 or 行太长），都能有效限制注入系统提示的内容大小，避免挤占 Claude 处理实际问题的上下文空间。
>
> 来源：`08-constants-types-migrations.md`

> **Q**: `migrateAutoUpdatesToSettings` 中为什么要同时设置 `process.env.DISABLE_AUTOUPDATER = '1'`？
>
> **A**: > 设置环境变量是为了「立即生效」。`updateSettingsForSource` 将配置写入 `settings.json`，但在当前会话中，`process.env` 已经被应用启动时的配置快照填充。如果只写文件，本次会话的自动更新检查逻辑仍会读取旧的 `process.env.DISABLE_AUTOUPDATER`（未设置），导致本次启动仍然触发更新检查。通过同时设置 `process.env`，迁移立即对当前进程生效，下次启动则从 `settings.json` 中读取。
>
> 来源：`08-constants-types-migrations.md`

> **Q**: `scope: 'global'` 缓存在 Anthropic API 中具体如何工作？它为什么能降低首次响应延迟？
>
> **A**: > Anthropic 的 prompt caching 基于**最长公共前缀**：API 服务器在接收到请求后，将 system prompt 的字节序列与缓存中存储的前缀进行比较。带 `scope: 'global'` 且 `cache_control: { type: 'ephemeral' }` 的段落，其缓存 key 是内容的哈希，与具体用户无关——所有用户的请求如果包含相同的静态前缀，都命中同一份 KV 缓存。这意味着模型无需重新处理静态区域（角色定义、规则集等，可能占 prompt 总 token 的 70% 以上），只处理动态区域（会话特定上下文）。首次响应延迟降低，是因为缓存命中后，静态区域对应的 prefill 计算被跳过，直接从缓存的 KV state 开始续算。
>
> 来源：`09-system-prompt工程.md`

> **Q**: Git 状态截断的 2000 字符阈值，如果设置得太小或太大各有什么影响？
>
> **A**: > 太小（如 500 字符）：中型项目（30+ 文件修改）的 git status 会大量截断，模型看到的文件列表不完整，可能错误判断「哪些文件已被修改」，导致重复修改或遗漏。太大（如 20,000 字符）：大型仓库 monorepo 中的暂存区可能有数千个文件，全量注入会消耗 5,000-10,000 token，挤压模型处理用户实际问题的有效上下文。2000 字符覆盖了大多数单项目工作（通常 10-20 个文件的修改），对超出情况则通过提示文本告知模型使用 BashTool 获取完整信息，这是"降级优雅"设计——功能不消失，只是换了获取方式。
>
> 来源：`09-system-prompt工程.md`

> **Q**: CLAUDE.md 层级发现时，父目录 vs 子目录的内容谁优先级更高？为什么？
>
> **A**: > 子目录（更靠近代码）的 CLAUDE.md 优先级更高，在 prompt 中排在后面（后面的内容会覆盖前面的指令）。原因：层级越深，配置越具体，具体配置应该覆盖通用配置。例如，全局 `~/.claude/CLAUDE.md` 说「使用 4 空格缩进」，项目根 `CLAUDE.md` 说「使用 2 空格缩进」，组件目录 `CLAUDE.md` 说「使用 Tailwind CSS」——模型应该遵循最具体的配置。这与大多数配置系统（ESLint、tsconfig）的覆盖方向一致。
>
> 来源：`09-system-prompt工程.md`

> **Q**: `有效上下文 = 模型上下文 - max(max_output_tokens, 20,000)` 中，20,000 这个最小保留量是如何确定的？
>
> **A**: > 20,000 来自对典型 Claude Code 响应长度的观测。代码生成任务中，单次响应可能包含：完整的多文件实现（3,000-8,000 tokens）、工具调用链（500-2,000 tokens per tool call）、解释文本（500-2,000 tokens）。即使用户将 `max_output_tokens` 设置为 4,096（Claude API 的较小值），实际上 Claude Code 的助手响应（包含工具调用往返）可能消耗远超这个限制。20,000 作为硬下限确保即使配置最保守的设置，也有足够空间完成复杂的多步工具调用序列。这个值是通过 p95 响应长度的历史数据确定的。
>
> 来源：`10-上下文压缩.md`

> **Q**: 断路器在「连续失败」定义上有什么微妙之处？为什么是「连续」而不是「总计」？
>
> **A**: > 「连续」失败反映的是**当前状态**，「总计」失败反映的是**历史累积**。AutoCompact 失败的原因可能是瞬时的（网络抖动、限流），也可能是持久的（模型配置错误）。如果用总计：第 1 次失败（瞬时网络问题）→ 第 100 次成功（正常）→ 第 101 次失败（另一个瞬时问题），用总计的断路器可能已经打开（2 次总计失败），但实际情况是系统运行正常。连续失败的语义是「现在这个时刻的连续错误」，成功一次就重置，能准确反映当前系统健康状态。源码数据中提到"高达 3,272 次连续失败"——这正是持久性配置错误（如缺少权限的 API key）导致的，连续失败断路器能在 3 次后停止无谓重试。
>
> 来源：`10-上下文压缩.md`

> **Q**: Context Collapse 中「按消息重要性折叠」的「重要性」是如何量化的？
>
> **A**: > 重要性评分基于多个维度的启发式规则（非 AI 评分，避免引入额外 API 调用）：
> > - **角色权重**：用户消息 > 助手消息（用户的意图不可压缩）
> > - **时间衰减**：越近期的消息越重要（近 5 轮权重系数 1.0，之前线性衰减至 0.3）
> > - **内容类型**：代码修改结果 > 工具过程输出 > 解释文本
> > - **引用计数**：被后续消息引用的内容（如「刚才修改的函数」）重要性提升
> > - **长度惩罚**：超长的单条工具输出（如 `find` 结果）重要性折扣
> > 这些规则组合成评分函数，折叠时优先移除低评分消息的详细内容，保留高评分消息的完整内容。整个过程是纯本地计算，无网络请求。
>
> 来源：`10-上下文压缩.md`

### UI 与交互（07-UI与交互/）

> **Q**: `DOMElement` 的 `dirty` 标记与 Yoga 的 `markDirty()` 有什么区别？为什么需要两套机制？
>
> **A**: 两者针对不同的失效域：
> - `DOMElement.dirty`：Ink 渲染层的脏标记，告知 `render-node-to-output` 该节点需要重新绘制字符。
> - `yogaNode.markDirty()`：布局层的脏标记，告知 Yoga 该文本节点的测量缓存失效，下次 `calculateLayout()` 时需重新调用 `measureFunc`。
>
> 只有 `ink-text` 和 `ink-raw-ansi` 节点才会触发 Yoga 的 `markDirty()`，因为只有这两类节点有动态测量函数。普通 `ink-box` 的尺寸完全由子节点和 flex 属性决定，无需单独标记。
>
> 来源：`01-ink渲染引擎.md`

> **Q**: `resetAfterCommit` 在渲染管线中扮演什么角色？
>
> **A**: `resetAfterCommit` 是 react-reconciler 协调器接口的核心回调，在 React 完成所有 DOM 变更（创建/更新/删除节点）后同步调用。Claude Code 在此处执行两步操作：
> 1. `rootNode.onComputeLayout()` —— 调用 Yoga 的 `calculateLayout()`，基于脏标记重新计算受影响子树的位置和尺寸。
> 2. `rootNode.onRender()` —— 触发帧渲染，将布局结果转换为字符并写入终端。
>
> 这一时序保证了每次 React 状态更新后，布局与渲染严格按顺序完成，不会出现布局未计算就渲染的中间态。
>
> 来源：`01-ink渲染引擎.md`

> **Q**: Ink 的 `charCache` 是如何提升渲染性能的？
>
> **A**: `Output` 类内部维护 `charCache`，以文本行字符串为键，缓存已解析的 `ClusteredChar[]`（含字符值、终端宽度、样式 ID、超链接）。每帧渲染时，未变化的行直接从缓存读取预处理结果，跳过 ANSI tokenize、grapheme clustering 和 `stringWidth` 计算。`Output` 实例在帧间复用（不随每帧重建），因此缓存在整个会话中持续有效。对于稳态帧（如用户输入时只有光标行变化），绝大多数行均命中缓存，渲染开销接近 O(1)。
>
> ---
>
> 来源：`01-ink渲染引擎.md`

> **Q**: React Compiler 生成的 `_c()` 缓存机制与手写 `useMemo` 有什么本质区别？
>
> **A**: `_c(n)` 分配 n 个"记忆化槽"（memoization slots），每个槽存储上一次的输入值和输出值。React Compiler 通过静态分析自动确定每个子表达式的依赖集合，生成精确的槽比较代码（`$[i] !== dep`）。与手写 `useMemo` 的区别在于：
> - **粒度更细**：Compiler 可以对组件内任意子表达式记忆化，而 `useMemo` 只能对开发者显式标注的值记忆化。
> - **无 Hook 规则限制**：槽比较是普通 JS 条件判断，不受 Hook 调用规则约束，可以在循环和条件分支中使用。
> - **零运行时开销**：不需要维护依赖数组对象，槽比较是最小化的引用相等检查。
>
> 来源：`02-核心组件.md`

> **Q**: `useInputBuffer` 的防抖机制为什么使用"延迟推入"而不是"延迟提交"？
>
> **A**: `useInputBuffer` 实现的是撤销历史（undo buffer），不是表单提交防抖。它对快速连续的击键进行防抖，将短时间内的多次 `onChange` 合并为一条历史记录，避免撤销时需要逐字回退。实现上采用"延迟推入"：当两次 `pushToBuffer` 调用间隔小于 `debounceMs` 时，清除之前的延迟定时器并重新计时，直到停顿超过阈值才真正写入缓冲区。这样用户一次连续输入（单词）只占一条历史记录。
>
> 来源：`02-核心组件.md`

> **Q**: `useDeclaredCursor` 钩子为什么需要存在？Ink 不是已经有光标位置概念了吗？
>
> **A**: 终端只有一个物理光标，但 Ink 组件树中可能同时存在多个"希望控制光标"的输入框（例如权限确认对话框叠加在 PromptInput 上方）。`useDeclaredCursor` 通过 Context 向上级协调器声明"我是当前活跃的光标"，协调器在帧渲染时只将最顶层的活跃光标声明转换为终端光标移动序列，其他非活跃输入框的光标声明被忽略，解决了多组件的光标竞争问题。
>
> ---
>
> 来源：`02-核心组件.md`

> **Q**: ResumeConversation 的渐进式加载是如何防止界面冻结的？
>
> **A**: `loadAllProjectsMessageLogsProgressive` 返回一个异步生成器（`AsyncGenerator`），每次 `yield` 一批会话记录。组件在 `useEffect` 中使用 `for await...of` 循环消费，每收到一批就调用 `setSessions(prev => [...prev, ...batch])`，触发 React 重渲染。这样，即使项目中有数百个历史会话，界面也能在第一批数据到达后立即显示（通常 < 50ms），用户无需等待全量加载。`AbortController` 确保组件卸载时停止加载，避免内存泄漏和 setState-on-unmounted-component 警告。
>
> 来源：`03-screens路由.md`

> **Q**: Doctor Screen 中 `use(promise)` 是什么 React API？有什么优势？
>
> **A**: `use()` 是 React 19 引入的新 Hook，可以在组件渲染中"等待"一个 Promise。当 Promise 尚未完成时，`use()` 会抛出 Promise 对象，触发最近的 `Suspense` 边界显示 fallback。Promise 解析后，React 自动恢复渲染。相比传统的 `useEffect + useState` 模式，`use()` 消除了中间的 `loading` 状态管理样板代码，并与 React 并发特性（Transitions、Suspense）无缝集成，使异步数据加载的代码与同步代码书写方式一致。
>
> 来源：`03-screens路由.md`

> **Q**: REPL 的 `permissionRequest` 状态是如何与工具执行流程解耦的？
>
> **A**: 工具执行路径（`query.ts` → 工具处理器）通过回调机制请求权限：工具在需要用户确认时，调用注入的 `onPermissionRequest(toolUseConfirm)` 回调，挂起工具执行并等待用户响应。REPL 收到回调后更新 `permissionRequest` 状态，渲染 `PermissionRequest` 组件，用户确认/拒绝后通过 `ToolUseConfirm.resolve(allowed)` 恢复工具执行。整个流程类似 Promise 的 resolve/reject，工具代码不需要了解 UI 层的存在。
>
> ---
>
> 来源：`03-screens路由.md`

> **Q**: useArrowKeyHistory 的并发请求合并机制是怎么工作的？
>
> **A**: 模块级的 `pendingLoad` 变量（而非 React 状态）作为全局锁：当用户快速连续按多次上箭头时，第一次调用 `loadHistoryEntries(minCount)` 启动 Promise 并赋值给 `pendingLoad`；后续调用发现 `pendingLoad` 存在且目标 `target` 足够大，直接返回同一个 Promise。若新请求需要更多条目（`target` 更大），则等待当前请求完成（`await pendingLoad`）后再启动新请求。结果：多次快速按键最多产生 2 次磁盘读取（当前进行中的 + 一次后续扩展），而不是每次按键各一次。
>
> 来源：`04-hooks.md`

> **Q**: `useVirtualScroll` 的 `SLIDE_STEP = 25` 是怎么防止界面卡顿的？
>
> **A**: 当用户快速滚动到消息列表底部时，若直接计算出需要挂载 194 个新 `MessageRow`（`OVERSCAN_ROWS * 2 + viewportHeight`），React 会在单次 commit 中同步创建 194 个组件实例（含 Yoga 节点分配、marked 词法器、formatToken 等），耗时约 290ms，导致明显卡顿。`SLIDE_STEP = 25` 限制每次 commit 最多新挂载 25 项，将 194 项分散到 8 次 commit 中。每次 commit 间 React 有机会处理其他优先级更高的任务（如键盘输入响应）。`scrollClampMin/Max` 字段保证在追赶期间视口不出现空白。
>
> 来源：`04-hooks.md`

> **Q**: `useInputBuffer` 的撤销历史如何与 Vim 模式的 `u` 撤销协同工作？
>
> **A**: 两者处理不同层次的撤销：
> - `useInputBuffer`：REPL 层面的撤销（恢复到之前提交的输入状态），对应 Ctrl-Z 或 `useInputBuffer.undo()`。
> - Vim 的 `u`：在 `useVimInput` 中通过 `onUndo` 回调实现，恢复到上一次 Vim 操作前的文本状态，使用 `PersistentState.lastChange` 记录最近的变更。
>
> 两套机制并行存在：Vim 用户通过 `u` 撤销单次操作，通过 REPL 的 Ctrl-Z 恢复到整条历史消息。`useVimInput` 在 `onUndo` 中调用 `textInput.setOffset` 和 `onChange`，这些操作也会触发 `useInputBuffer.pushToBuffer`，保持两套历史的同步。
>
> ---
>
> 来源：`04-hooks.md`

> **Q**: 自定义输出样式的 `prompt` 内容是如何被注入到与 Claude 的对话中的？
>
> **A**: `buildEffectiveSystemPrompt()`（`src/utils/systemPrompt.ts`）在每次 API 请求前调用 `getOutputStyleConfig()`。若返回非 null 的样式配置，将 `style.prompt` 追加到系统提示的末尾。Claude API 的 `system` 参数接收这个完整的系统提示字符串，Claude 在处理每条消息时都会考虑其中的指令。对话中后续的消息不会重复注入（系统提示只在请求的 `system` 字段中出现一次），但 Claude 在整个对话上下文中都会维持该样式的行为。
>
> 来源：`05-outputStyles.md`

> **Q**: 多个插件同时设置 `forceForPlugin: true` 时系统是怎么处理的？
>
> **A**: `getOutputStyleConfig()` 过滤出所有 `forceForPlugin === true` 的插件样式，取 `forcedStyles[0]`（按数组顺序，即插件加载顺序）。若 `forcedStyles.length > 1`，调用 `logForDebugging(警告信息, { level: 'warn' })`，记录哪些插件在竞争但不会抛出错误（降级处理）。最终使用第一个强制样式。这是一个"第一个赢"的简单策略，实际上强制样式通常只应由一个专用插件设置，多插件竞争是配置错误，日志警告是给插件开发者的调试信息。
>
> 来源：`05-outputStyles.md`

> **Q**: `getOutputStyleDirStyles` 使用 `memoize(cwd)` 缓存，这在什么情况下会导致问题？
>
> **A**: 缓存的键是 `cwd`（当前工作目录），同一目录在同一进程中只扫描一次。问题场景：
> 1. 用户在 REPL 会话中修改了 `output-styles/*.md` 文件，新文件不会被自动感知，直到调用 `clearOutputStyleCaches()` 清除缓存。
> 2. 用户使用 `/reload` 命令刷新配置时，系统正确调用 `clearAllOutputStylesCache()`，缓存被清除。
> 3. 若用户通过外部工具（如文本编辑器）修改样式文件，只有重启 Claude Code 或执行 `/reload` 才能生效——这是设计上的 trade-off，用确定性换取性能。
>
> ---
>
> 来源：`05-outputStyles.md`

> **Q**: IDLE_SEQUENCE 的 `-1` 帧是什么含义？精灵系统如何实现"眨眼"效果？
>
> **A**: `IDLE_SEQUENCE = [0,0,0,0,1,0,0,0,-1,0,0,2,0,0,0]` 中的 `-1` 是一个特殊标记，意为"在帧 0 的基础上显示眨眼状态"。精灵渲染时检测到 `-1`，会将当前帧的眼睛字符（`{E}` 占位符）替换为 `-`（横线，表示闭眼），而不是渲染一个完整的独立帧。这样只需 3 帧精灵数据就能表达 4 种视觉状态（帧0休息、帧1摆动、帧2轻摆、帧0+眨眼），减少了精灵定义的冗余。每 500ms 执行一次 `IDLE_SEQUENCE` 步进，完整循环约 7.5 秒。
>
> 来源：`06-buddy-AI伴侣.md`

> **Q**: 多条热路径（500ms tick / 按键 / AI 响应）都调用 `roll(userId)`，如何避免重复计算？
>
> **A**: `rollCache` 是模块级变量（`let rollCache: { key: string; value: Roll } | undefined`），存储最近一次的调用参数（`key = userId + SALT`）和结果。任何调用 `roll(userId)` 时，若 `rollCache?.key === key`，直接返回缓存值，跳过 Mulberry32 迭代和所有随机抽取。由于 Claude Code 整个进程只有一个用户 ID 且不会变化，这个缓存实际上在整个会话期间都是命中状态，将三条热路径的伴侣外观计算开销降至 O(1) 字符串比较。
>
> 来源：`06-buddy-AI伴侣.md`

> **Q**: `SpeechBubble` 的渐隐机制是如何实现的？
>
> **A**: `CompanionSprite` 维护一个 `bubbleTick` 计数器，每 500ms 递增。当 `bubbleTick > BUBBLE_SHOW - FADE_WINDOW`（即超过 14 ticks，约 7s 后），将 `fading` prop 设为 `true`，传给 `SpeechBubble`。`SpeechBubble` 在 `fading = true` 时：
> - 边框颜色切换为 `inactive`（灰色）
> - 文字加上 `dimColor`
> - 这给用户约 3 秒的视觉提示（气泡开始变灰）预示气泡将消失。当 `bubbleTick >= BUBBLE_SHOW` 时，清除气泡状态，停止渲染 `SpeechBubble`。
>
> ---
>
> 来源：`06-buddy-AI伴侣.md`

> **Q**: `HOLD_THRESHOLD = 5` 次按键事件才激活语音，这是为了解决什么问题？
>
> **A**: 对于裸字符键绑定（如 Space、`v` 等），单次按键可能是用户的正常输入（输入空格或字母 v），不应立即触发录音。`HOLD_THRESHOLD = 5` 要求在 `RAPID_KEY_GAP_MS = 120ms` 内连续接收到 5 次自动重复事件后才激活录音，这需要用户持续按住键约 350ms（5 × 70ms 自动重复间隔）。普通字符输入（打一个字母后手指抬起）不会产生 5 次自动重复。对于修饰键组合（Ctrl+S 等），第一次按下就激活（`HOLD_THRESHOLD = 1`），因为这类组合键不会被误触发为普通输入。`WARMUP_THRESHOLD = 2` 在达到 `HOLD_THRESHOLD` 之前显示预热反馈（UI 上显示"准备录音中"），给用户视觉确认。
>
> 来源：`07-voice-vim.md`

> **Q**: Vim 的 `count-operator-motion` 语法（如 `3d2w` = 删除 6 个词）是如何通过状态机实现的？
>
> **A**: `3d2w` 的解析步骤：
> 1. `3` → `fromIdle`: 进入 `{ type: 'count', digits: '3' }` 状态
> 2. `d` → `fromCount`: 识别为操作符，进入 `{ type: 'operator', op: 'delete', count: 3 }` 状态
> 3. `2` → `fromOperator`: 识别为数字，进入 `{ type: 'operatorCount', op: 'delete', count: 3, digits: '2' }` 状态
> 4. `w` → `fromOperatorCount`: `motionCount = parseInt('2') = 2`，`effectiveCount = count * motionCount = 3 * 2 = 6`，执行 `executeOperatorMotion('delete', 'w', 6, ctx)`
>
> `operatorCount` 状态的设计使操作符前的计数（重复整个命令）和动作前的计数（重复动作范围）能够相乘，实现 Vim 的标准 `[count]operator[count]motion` 语法。
>
> 来源：`07-voice-vim.md`

> **Q**: 语音转录的中间结果（partial transcript）和最终结果如何区分处理？
>
> **A**: `connectVoiceStream` 返回的 WebSocket 流会推送两种事件：
> - **中间结果**（`is_final: false`）：Deepgram 的实时推测性识别，随时可能被更新。Claude Code 在录音进行中将这些结果显示为幽灵文字（ghost text），不实际写入输入框。
> - **最终结果**（`is_final: true` 或流关闭时）：稳定的识别结果，通过 `onTranscript(text)` 回调写入 `PromptInput` 的 value。
>
> `FinalizeSource` 类型区分了"用户主动停止录音"和"流超时结束"，前者立即使用最后一个最终结果，后者等待 WebSocket 推送完整的 final 结果后再关闭连接。
>
> ---
>
> 来源：`07-voice-vim.md`

### 网络与远程（08-网络与远程/）

> **Q**: 4001 关闭码为什么只重试 3 次而不是永久重试？
>
> **A**: 4001（session not found）通常发生在 CCR 容器进行对话压缩（compaction）期间，服务端暂时认为该会话已过期。重试 3 次（间隔依次 2s/4s/6s 共约 12s）足以覆盖压缩窗口。若无限重试，反而会在会话真正结束后持续尝试，浪费资源且延迟错误上报。
>
> 来源：`01-remote.md`

> **Q**: 心跳 ping 间隔为什么是 30 秒？
>
> **A**: CCR 的 WebSocket 网关通常配置 60 秒空闲超时。30 秒 ping 确保在超时一半时保活，留出一次 ping 失败的容错空间。同时避免过于频繁（如 10 秒）造成不必要的网络流量。
>
> 来源：`01-remote.md`

> **Q**: `isSessionsMessage()` 为何采用宽松的类型校验（只验证 `type` 字段为字符串）？
>
> **A**: 硬编码允许的 `type` 枚举会在后端新增消息类型时静默丢弃，导致难以诊断的功能缺失。宽松校验将未知类型转发给下游（`sdkMessageAdapter`），由其记录日志并返回 `{ type: 'ignored' }`，既保持向前兼容，又不丢失调试信息。
>
> 来源：`01-remote.md`

> **Q**: `connectResponseSchema` 使用 `lazySchema` 的原因是什么？
>
> **A**: Zod schema 的构造函数会在模块加载时执行，若 schema 较复杂则产生不必要的启动开销。`lazySchema` 用 `memoize` 包装，首次调用时才真正构造 Zod 对象，后续复用缓存。对于 CLI 这种启动延迟敏感的程序，延迟初始化是优化手段之一。
>
> 来源：`02-server.md`

> **Q**: `SessionIndex` 持久化到 `~/.claude/server-sessions.json` 的目的是什么？
>
> **A**: 在服务器重启后（如 `claude server` 崩溃恢复），通过 `SessionIndexEntry.transcriptSessionId` 可向子进程传递 `--resume` 参数，恢复之前的对话上下文。`lastActiveAt` 字段支持按最近活跃时间清理过期会话，避免索引文件无限增长。
>
> 来源：`02-server.md`

> **Q**: `dangerously_skip_permissions` 通过 POST body 而非 Header 传递，为什么？
>
> **A**: 该标志是会话级配置，属于创建会话时的初始化参数，与其他会话属性（`cwd`）一起构成会话的构造参数，语义上属于请求体。作为 Header 则意味着该行为是请求级别的认证/路由策略，语义不准确。同时请求体参数可被服务端日志、监控记录为会话属性，便于审计哪些会话跳过了权限检查。
>
> 来源：`02-server.md`

> **Q**: `WorkSecret` 为什么采用 base64url JSON 而非直接在 API 响应中返回字段？
>
> **A**: `WorkSecret` 包含敏感信息（`session_ingress_token`、API 密钥等），通过 base64url 编码的字符串字段传递有两个好处：① 服务端可在不修改 API 字段定义的情况下向 secret 添加新字段（向后兼容）；② 日志、监控工具在记录 API 响应时难以直接读取其内容（增加了一层混淆）。
>
> 来源：`03-bridge.md`

> **Q**: 心跳（heartbeatWork）为什么用 SessionIngressAuth 而不是 EnvironmentSecretAuth？
>
> **A**: 心跳是高频操作（每 30 秒一次），`SessionIngressAuth` 使用 JWT 令牌（无 DB 查询）验证，延迟更低；`EnvironmentSecretAuth` 需要数据库查找环境记录，开销更大。`SESSION_INGRESS_TOKEN` 绑定到具体会话，粒度更细，也符合最小权限原则——心跳只需证明"我持有这个会话的令牌"。
>
> 来源：`03-bridge.md`

> **Q**: `BackoffConfig` 为什么分 `conn*` 和 `general*` 两组参数？
>
> **A**: 连接重建（WebSocket 断开后重连）和一般性错误重试的语义不同：连接重建通常需要更长的等待（避免 SYN flood），上限 2 分钟、放弃时间 10 分钟；一般性 API 错误（如 409 冲突）可以更快重试（初始 500ms、上限 30 秒）。分离配置使测试时可以单独调整两类退避行为，而不影响另一个。
>
> 来源：`03-bridge.md`

> **Q**: 为什么在启动中继前读取 token，启动成功后才删除 token 文件？
>
> **A**: 这是故障恢复设计：token 文件删除是不可逆操作。若 CA 证书下载失败或 TCP 监听器绑定失败，token 文件仍在磁盘上，容器重启后（supervisor 重试）可再次读取并重试初始化。若先删文件后启动监听器，一旦监听器失败就永久丢失 token，无法恢复。"成功后清理"（commit-then-cleanup）是分布式系统中确保幂等性的标准模式。
>
> 来源：`04-upstreamproxy-moreright.md`

> **Q**: `NO_PROXY_LIST` 为什么要以三种形式（`anthropic.com`、`.anthropic.com`、`*.anthropic.com`）列出同一域名？
>
> **A**: 不同运行时和工具对 NO_PROXY 的解析规则不同：
> - `*.anthropic.com`：Bun、curl、Go 的 glob 匹配
> - `.anthropic.com`：Python urllib/httpx 的前缀匹配（自动去掉前导点匹配子域）
> - `anthropic.com`：顶级域名兜底
>
> 三种形式确保 Anthropic API 请求在任何运行时都不经过代理，防止 MITM 截断对 Anthropic 的调用（Python 的 certifi 不信任 CCR 的伪造 CA）。
>
> 来源：`04-upstreamproxy-moreright.md`

> **Q**: `setNonDumpable()` 如何防止提示注入攻击窃取 session token？
>
> **A**: 攻击场景：提示注入的指令让 agent 执行 `gdb -p $PPID` 附加到父进程（Claude Code），然后在进程堆内存中搜索 `session_token` 字符串并读取其值。调用 `prctl(PR_SET_DUMPABLE, 0)` 后，Linux 内核拒绝同 UID 的进程对该进程发起 `ptrace`（即使是 root 也需要 `CAP_SYS_PTRACE`），`gdb` 无法附加。Token 文件被 `unlink` 后文件系统层面也不可读。双重防护使 token 在整个会话期间仅存在于受保护的堆内存中。
>
> 来源：`04-upstreamproxy-moreright.md`

> **Q**: 历史消息分页为什么使用 `anchor_to_latest=true` 而不是正常的时间倒序分页？
>
> **A**: `anchor_to_latest=true` 让服务端先定位到最新事件，然后向后返回 N 条（时间倒序），这等价于"获取最后 100 条"。若使用普通倒序分页（`after_id`），需要知道"最新事件的 ID"才能作为 cursor 起点，而在首次加载时这个 ID 未知。`anchor_to_latest=true` 是无需预知状态的"从末尾开始分页"语义，服务端处理最终一致性，客户端只需处理懒加载逻辑。
>
> 来源：`05-assistant-KAIROS.md`

> **Q**: 观察端 `viewerOnly` 模式为什么禁用 60 秒重连超时？
>
> **A**: 60 秒超时是为了防止普通远程模式下"幽灵 viewer"长期占用会话资源（用户实际已离开但 WS 未正常关闭）。助手观察模式是有意的长期连接（用户打开终端窗口观察守护 Agent 的工作），60 秒超时会频繁断开并重连，产生大量无意义的重连流量。`viewerOnly` 明确表达了"我知道自己会长时间挂在这里"的意图。
>
> 来源：`05-assistant-KAIROS.md`

> **Q**: `createHistoryAuthCtx()` 为什么只调用一次而不在每次分页时刷新 token？
>
> **A**: 每次 `prepareApiRequest()` 都会执行 OAuth token 检查，可能涉及网络请求（若 token 临近过期需刷新）。分页操作通常在短时间内连续发生（用户快速滚动），频繁刷新 token 会增加延迟。OAuth token 有效期约 4 小时，分页操作的时间窗口远小于此；若 token 在分页过程中过期，axios 请求会返回 401，上层的错误处理会触发重新鉴权。
>
> 来源：`05-assistant-KAIROS.md`

> **Q**: `native-ts/file-index` 的 `charBits` 位图如何实现 O(1) 过滤？
>
> **A**: 对每个路径，在索引构建时计算路径包含哪些字符，将其编码为 32 位整数位图（`charBits[i] = bitset`，每个字母对应一个 bit）。搜索时，先将查询字符串同样计算位图，然后用按位与（AND）检查路径位图是否是查询位图的超集（即路径包含所有查询字符）。若结果不等于查询位图，则该路径不可能匹配查询，O(1) 跳过，无需进入耗时的 Smith-Waterman 评分阶段。
>
> 来源：`06-context-native-ts.md`

> **Q**: `stats.tsx` 的蓄水池采样（Reservoir Sampling）相比普通采样有什么优势？
>
> **A**: 普通采样（如每 N 个取一个）会有周期性偏差，且需要预知总量。蓄水池采样（Algorithm R）在不知道流长度的情况下，对每个元素以等概率选取，保证最终蓄水池中的样本是均匀无偏的随机子集。对于运行时间不可预知的 CLI 工具（用户可以随时退出），蓄水池采样是理想选择——无论程序运行多久，蓄水池中的样本始终是迄今为止所有观测的无偏代表。
>
> 来源：`06-context-native-ts.md`

> **Q**: `color-diff/` 为什么用 `highlight.js` 而不是继续用 Rust 的 `syntect`？
>
> **A**: `syntect` 是通过 Rust NAPI 模块调用的（`vendor/color-diff-src`），在无法编译 NAPI 的环境（如某些 Windows 配置、Alpine Linux 容器）中不可用。TypeScript 替代需要一个纯 JS 的语法高亮库，`highlight.js` 已经是 Claude Code 的现有依赖（通过 `cli-highlight`），引入成本为零。代价是 `highlight.js` 的 token 分类与 syntect 不完全对齐（普通标识符和操作符无 scope），颜色略有差异，但输出结构（行号、diff 标记）完全一致。
>
> 来源：`06-context-native-ts.md`

---

## 三、权衡与优化题（共 104 题）

### 核心入口（01-核心入口/）

> **Q**: `startDeferredPrefetches()` 推迟了哪些工作？为什么不在更早的时候执行？
>
> **A**: 推迟的工作包括：`initUser()`（HTTP 请求）、`getUserContext()`（文件系统 + 可能的 Git 操作）、`prefetchSystemContextIfSafe()`（Git 状态，可能触发 `core.fsmonitor` 等 hooks）、`countFilesRoundedRg()`（目录文件数统计）、`settingsChangeDetector.initialize()`（文件监听）。这些操作总计约 100-500ms，且在用户输入第一条消息之前完成即可（有足够的时间窗口）。如果在 `init()` 阶段执行，会延迟 REPL 首屏渲染；在首屏渲染后触发，用户看到界面时后台工作已同步进行，不影响感知延迟。`--bare` 模式（脚本化 `-p` 调用）完全跳过这些预取，因为脚本没有「用户正在打字」的时间窗口。
>
> 来源：`01-main.md`

> **Q**: `feature()` 宏与运行时特性标志（GrowthBook）的区别是什么？各自适用什么场景？
>
> **A**: `feature()` 是 Bun 的编译时宏，在打包时求值。`feature('COORDINATOR_MODE')` 为 `false` 时，整个代码块从产物中移除（DCE）。适用于：外部发布版本与内部 Ant 版本的功能差异、实验性代码的安全隔离、减少外部发布包体积。GrowthBook 特性标志（`getFeatureValue_CACHED_MAY_BE_STALE`）是运行时 A/B 测试，在已发布的同一二进制中按用户/百分比动态开关，适用于渐进式发布和灰度测试。两者可以叠加使用：先用 `feature()` 控制代码是否存在，再用 GrowthBook 控制是否激活。
>
> 来源：`01-main.md`

> **Q**: `cliError()` 和 `cliOk()` 为什么选择不同的输出方式（`console.error` vs `process.stdout.write`）？
>
> **A**: 这是一个可测试性设计。在 Bun 测试环境中，`console.log` 并不总是路由到被 spy 的 `process.stdout.write`，而 `console.error` 可以被直接 spy。`cliOk` 使用 `process.stdout.write` 确保输出可以在测试中被捕获并断言，不依赖 console 重定向。同时，`return undefined as never` 让调用点可以写 `return cliError(msg)` 满足 TypeScript 的控制流分析，避免之后的代码中的「可能为 undefined」警告。
>
> 来源：`02-cli.md`

> **Q**: 传输层如何处理 `PERMANENT_HTTP_CODES`（401、403、404）与普通网络错误的区别？
>
> **A**: 收到永久 HTTP 状态码时，`SSETransport` 立即将状态机切换为 `closed`，不进入重试循环。这一设计避免了在服务端已明确拒绝请求（认证失败、会话不存在）时进行毫无意义的重试，既节省网络资源，又能更快地向用户反馈错误。相比之下，网络超时或 5xx 错误属于瞬时故障，会触发指数退避重试。
>
> 来源：`02-cli.md`

> **Q**: `cli.tsx` 中 `startCapturingEarlyInput()` 为什么只在默认路径（加载 `main.tsx`）前调用，而不在快速路径中调用？
>
> **A**: `startCapturingEarlyInput()` 的作用是在 CLI 初始化期间（约 200ms）捕获用户提前输入的字符，待 REPL 渲染完成后重放到输入框，改善感知延迟。快速路径（`--version`、`remote-control` 等）要么立即退出，要么启动非 TUI 模式，没有「输入框」概念，捕获 stdin 反而可能干扰这些模式的 stdin 读取逻辑。
>
> 来源：`03-entrypoints.md`

> **Q**: `initializeTelemetryAfterTrust()` 中为什么企业用户路径（等待远程设置）还需要在快速模式（SDK + beta tracing）下提前初始化一次？
>
> **A**: SDK 的 beta 追踪（`isBetaTracingEnabled()`）需要追踪器在第一个 `query()` 调用之前就绪，而 `query()` 在会话开始时立即发送 API 请求。对于企业用户，远程设置的加载是异步的（可能有网络延迟），如果只走「等待远程设置」这一路径，tracker 可能在第一个 API 调用完成后才初始化，导致第一个 query 的追踪数据丢失。因此非交互式 + beta tracing 的组合触发一次「急切初始化」，后续的异步路径通过 `doInitializeTelemetry()` 内部的 `telemetryInitialized` 标志防止重复初始化。
>
> 来源：`03-entrypoints.md`

> **Q**: 遥测计数器（如 `sessionCounter`）为什么使用自定义的 `AttributedCounter` 包装类型，而不是直接存储 OpenTelemetry 的 `Counter` 对象？
>
> **A**: `AttributedCounter` 的 `add()` 方法每次调用都动态执行 `getTelemetryAttributes()` 获取当前遥测属性（包括 `sessionId`、`model`、`clientType` 等），而非在创建时捕获快照。这解决了一个问题：OTel 的 `Meter` 必须在 `init()` 阶段早期创建（以便工具调用时可用），但 `sessionId`、`model` 等属性在 `init()` 完成时还未确定（需要用户通过信任对话框或命令行参数指定）。动态查询确保了每个遥测事件都包含最新的属性值，避免了「用旧值初始化 counter，后续属性变更但事件仍带旧属性」的问题。
>
> 来源：`04-bootstrap.md`

> **Q**: `inMemoryErrorLog` 字段保存在内存中而不是写入磁盘，有什么优缺点？
>
> **A**: 优点：写入磁盘的错误日志可能包含敏感信息（文件路径、用户提示词、API 响应内容），持久化日志存在隐私风险。内存日志随进程退出而消失，更安全。此外，磁盘写入引入延迟和 I/O 风险，不应在错误处理路径中出现（防止因磁盘满而产生级联错误）。缺点：进程崩溃时内存日志丢失，无法诊断崩溃原因。设计取舍是：`inMemoryErrorLog` 主要为 `/share` bug report 功能服务（用户手动触发时将近期错误附在报告中），而非崩溃诊断。崩溃场景应通过 OTel traces（发送到 Anthropic 服务端）或系统级崩溃报告处理。
>
> 来源：`04-bootstrap.md`

### 工具系统（02-工具系统/）

> **Q**: 工具系统如何平衡安全性与灵活性？
>
> **A**: A：通过分层防御实现。第一层是 `validateInput()` 的语义验证，拒绝明显无意义的输入；第二层是 `checkPermissions()` 的权限决策，结合用户配置的 allowlist/denylist 规则；第三层是工具内部的安全检查（如 FileEditTool 中 UNC 路径跳过、BashTool 中的 AST 解析安全检查）；第四层是沙箱（SandboxManager）进一步隔离命令执行。灵活性体现在：每层都可以被用户配置覆盖，`bypass` 权限模式下跳过大多数检查，适应自动化场景。
>
> 来源：`00-工具系统总览.md`

> **Q**: 为什么 Git 操作追踪（gitOperationTracking）放在 `shared/` 而不是 BashTool 内部？
>
> **A**: A：因为 PowerShellTool 也需要追踪 git 操作。`shared/` 目录存放跨工具共享的基础设施。Git 操作检测基于命令文本的正则匹配，与具体 Shell 无关（Bash 和 PowerShell 都以相同的 argv 语法调用 git/gh），因此可以复用同一套检测逻辑。
>
> 来源：`00-工具系统总览.md`

> **Q**: GrepTool 的 `DEFAULT_HEAD_LIMIT = 250` 如何权衡覆盖率与性能？
>
> **A**: A：250 是在"有足够信息决策"和"防止上下文溢出"之间的权衡点。grep 结果通常是文件路径或短行内容，250 条大约占 5-15K tokens，在模型 200K token 上下文中占 2.5-7.5%。设置过低（如 50）会导致模型经常需要分页，增加交互轮次；设置过高（如 1000）在搜索常见词时可能返回数千行，填满上下文。明确提供 `head_limit=0` 的 escape hatch 平衡了默认安全与特殊需求。
>
> 来源：`01-文件类工具-读取与搜索.md`

> **Q**: 三个工具中只有 GrepTool 设置了 `maxResultSizeChars: 20_000`，其他两个是 100_000，为什么？
>
> **A**: A：GrepTool 的 `content` 模式输出包含大量匹配行，内容密度高，20,000 字符的阈值更易触达，一旦超过就持久化到磁盘用引用替代，避免重复传输。FileReadTool 和 GlobTool 的输出相对可预测：前者是单个文件内容（通常有明确的行数限制），后者是文件路径列表（路径相对较短），100,000 的阈值更合适。设置过低的阈值会导致频繁磁盘 I/O 和引用解析，反而降低效率。
>
> 来源：`01-文件类工具-读取与搜索.md`

> **Q**: FileWriteTool 和 FileEditTool 在 token 效率上如何取舍？
>
> **A**: A：核心权衡是"上下文携带量"与"精确性"。FileWriteTool 需要在输入中携带完整文件内容（对大文件可能是几千 token），但对新建文件或完全重写而言是必要的。FileEditTool 只需携带修改片段（通常几十到几百 token），但需要更复杂的验证逻辑（脏写检测、字符串查找）。Claude Code 的最佳实践是：新文件用 FileWriteTool，已有文件的局部修改用 FileEditTool。对于超过 2000 行的大文件修改，FileEditTool 的 token 优势尤为显著。
>
> 来源：`02-文件类工具-写入与编辑.md`

> **Q**: LSP 通知失败会影响核心功能吗？
>
> **A**: A：不会。LSP 通知在 `.catch()` 中只记录日志，不会抛出异常或中断写入流程。LSP 集成是增强功能（IDE 内的实时诊断），不是核心依赖。即使 LSP 服务器未运行（`getLspServerManager()` 返回 null），写入依然正常完成。这体现了"核心路径不依赖可选组件"的设计原则。
>
> 来源：`02-文件类工具-写入与编辑.md`

> **Q**: Agent 蜂群（swarm）模式和异步后台代理有什么区别？
>
> **A**: A：两者面向不同协作场景。**蜂群模式**（`isAgentSwarmsEnabled()`）使用 tmux pane 或进程间通信（IPC），每个 Teammate 在独立的终端 pane 中运行，有独立的视觉标识（颜色），通过 SendMessageTool 通信，适合需要持续交互的长期并行任务（如多个 Agent 共同开发一个项目）。**异步后台代理**（`run_in_background`）是轻量的一次性并行任务，在主进程内以 `LocalAgentTask` 运行，完成后通知主代理，适合独立的短时并行子任务（如同时分析多个模块）。前者更重但更灵活，后者更轻量但功能受限。
>
> 来源：`04-Agent任务类工具.md`

> **Q**: worktree 创建和清理是否有异常安全保证？
>
> **A**: A：是的，通过 try-finally 保证。`call()` 中使用如下模式：`const worktreePath = await createAgentWorktree(...)；try { result = await runAgent(worktreePath) } finally { await removeAgentWorktree(worktreePath) }`。即使代理执行中抛出异常，worktree 也会被清理。`hasWorktreeChanges()` 函数在清理前检查 worktree 是否有未合并的修改，若有则先通知主代理是否保留修改。这确保了不会在系统中留下孤立的 worktree 目录。
>
> 来源：`04-Agent任务类工具.md`

> **Q**: ToolSearchTool 的评分算法如何权衡精确匹配和语义相关性？
>
> **A**: A：评分权重设计体现了对工具名称结构的信任优先级。工具名精确部分匹配得分最高（MCP 工具 12 分，内置工具 10 分），因为工具名是开发者有意设计的，高度信息密集；子字符串匹配次之（MCP 6 分，内置 5 分）；`searchHint`（策划的能力短语，信号质量高于提示词）得 4 分；工具完整名的子字符串匹配 3 分；提示词（描述）中的词边界匹配最低（2 分），因为描述文本可能包含噪声词。支持 `+term` 强制包含语法，确保特定服务器或功能词必须出现。这种加权设计在实际测试中对 `slack send` → `mcp__slack__send_message` 等典型查询表现良好。
>
> 来源：`05-MCP类工具.md`

> **Q**: MCP 服务器断开重连时，已注册的动态工具如何处理？
>
> **A**: A：通过 `AppState.mcp.clients` 中的客户端状态管理。断开的服务器状态变为 `pending`（重连中）或 `disconnected`（永久断开）。已注册的动态工具仍然存在于工具池中，但 `call()` 会先调用 `ensureConnectedClient()` 检查连接，失败时返回明确错误（"MCP server disconnected"），而非崩溃。ToolSearchTool 在搜索无结果时，会返回 `pending_mcp_servers` 字段提示哪些服务器正在重连，引导模型稍后重试。
>
> 来源：`05-MCP类工具.md`

> **Q**: ToolSearchTool 的描述缓存如何平衡命中率和新鲜度？
>
> **A**: A：缓存键是工具名称，通过 `memoize()` 对 `tool.prompt()` 结果缓存（`tool.prompt()` 是异步的，可能有延迟）。`maybeInvalidateCache()` 通过比较延迟工具集合的哈希值（所有工具名排序后 join）来检测集合变化，变化时全量清除缓存。这是"保守失效"策略——任何工具变化都清除所有缓存，而非精确失效单个工具。代价是集合变化后的首次搜索需要重新获取描述；收益是实现简单，不会出现陈旧缓存导致搜索结果不准确的问题。
>
> 来源：`06-搜索与信息类工具.md`

> **Q**: WebFetchTool 的 `MAX_MARKDOWN_LENGTH` 截断发生在什么阶段？
>
> **A**: A：截断在第一阶段（HTML → Markdown 转换后，LLM 提炼前）进行，避免向 LLM 传递超长内容。这是必要的：某些技术文档页面 Markdown 后可能有 100,000+ 字符，若全部传给 LLM（即使是 Haiku）会产生极高的 token 成本，且超过上下文窗口限制。截断策略是取前 `MAX_MARKDOWN_LENGTH` 字符（保留文档开头，因为通常最重要的内容在前面）。副作用是长文档的后半部分内容可能丢失，若 `prompt` 关心的信息在截断区域后，WebFetchTool 会给出不完整的答案。这是必要的性能权衡。
>
> 来源：`06-搜索与信息类工具.md`

> **Q**: EnterWorktreeTool 的 worktree 隔离与 AgentTool 的 worktree 隔离有何区别？
>
> **A**: A：两者隔离层次不同。`AgentTool` 的 `isolation: 'worktree'` 为**子代理**创建临时 worktree，子代理工作完成后 worktree 自动删除，主会话工作目录不变；`EnterWorktreeTool` 为**当前会话**切换 worktree，主循环后续的所有操作（文件读写、Bash 命令）都在 worktree 中执行，直到 `ExitWorktreeTool` 调用。前者是透明的子任务隔离，后者是主会话级别的环境切换，影响范围更大，需要显式退出。使用 `EnterWorktreeTool` 时，用户对当前会话状态变化有更强的感知需求，因此它是需要用户确认的 `shouldDefer` 工具。
>
> 来源：`07-会话控制类工具.md`

> **Q**: AskUserQuestionTool 限制每个问题最多 4 个选项，这个设计有什么依据？
>
> **A**: A：认知负荷研究（米勒定律的变体）表明：人类在决策时处理 2-4 个并列选项最高效，超过 5-7 个选项会导致"选择悖论"（paradox of choice），用户陷入犹豫，决策时间指数增长，满意度反而下降。4 个选项的上限还有实际的 UI 原因：终端宽度有限，选项描述文本需要在合理行数内显示清楚，选项过多会导致滚动或截断。系统会自动在选项末尾添加"Other（其他）"选项，让用户可以输入自由文本，补充了有限选项无法覆盖的边界情况。
>
> 来源：`07-会话控制类工具.md`

> **Q**: ConfigTool 的白名单设计对可扩展性有什么影响？
>
> **A**: A：白名单带来安全性，但增加了维护成本。每次 Claude Code 新增可配置项时，开发者需要主动将其添加到 `supportedSettings.ts` 白名单，否则 AI 无法通过 ConfigTool 访问该配置。这避免了"遗忘地将敏感配置暴露给 AI"的风险，但需要开发流程中有专门的步骤审查新配置项是否应该加入白名单。实践中，白名单应包含"对使用体验有直接影响但不影响安全性的配置"（如主题、模型），不包含"涉及认证、API 密钥或权限绕过"的配置。
>
> 来源：`08-其他专用工具.md`

> **Q**: CronCreateTool（`ScheduleCronTool`）的定时任务是如何持久化的？
>
> **A**: A：定时任务配置存储在磁盘上（`utils/cron/` 管理），包含任务 ID、cron 表达式、要执行的提示词/命令、触发条件等。Claude Code 进程启动时加载已存储的 cron 配置并注册定时器。`CronDeleteTool` 按任务 ID 删除配置文件并取消对应定时器。`CronListTool` 列出所有当前活跃的定时任务。定时任务通常用于"每小时检查 PR 状态"、"每天汇报进度"等周期性自动化场景，是 Claude Code 作为持久化 AI 代理（而非一次性工具）能力的体现。
>
> 来源：`08-其他专用工具.md`

### 命令系统（03-命令系统/）

> **Q**: 懒加载（`load: () => import('./xxx.js')`）带来了什么权衡？
>
> **A**: A：优点：启动时仅加载命令元数据（约几十字节的对象字面量），降低 TTFR（Time to First Response）；体积较大的模块（如 `insights.ts`，113KB/3200 行）不影响冷启动。缺点：首次调用命令时有额外的模块解析延迟；`local-jsx` 命令需要 React 运行时，若多个命令共用组件，重复引用反而会增加内存压力。权衡结果：Claude Code 作为 CLI 工具，启动速度优先于首次命令执行延迟，懒加载是合理选择。
>
> 来源：`00-命令系统总览.md`

> **Q**: `getSkillToolCommands` 和 `getSlashCommandToolSkills` 有何区别？
>
> **A**: A：前者面向模型（model-facing），过滤出所有可被 AI 调用的 `prompt` 类命令，包含所有来源（bundled/skills/commands_DEPRECATED），是"模型能看到的技能"；后者面向斜杠命令提示，过滤条件更严格，要求有 `hasUserSpecifiedDescription` 或 `whenToUse`，且来源为 skills/plugin/bundled，是"用户在打 `/` 时看到的技能"。两者独立 memoize，保持职责分离。
>
> 来源：`00-命令系统总览.md`

> **Q**: `/commit-push-pr` 同时提交、推送和创建 PR，如何处理用户中途取消的情况？
>
> **A**: A：该命令将整个流程编码进单条提示词，由模型按步骤执行。用户在模型执行过程中按 `Ctrl+C` 会触发 `abortController.signal`，中断当前模型推理和工具调用链。已执行的 Git 操作（如 `git push`）无法回滚（Git 操作本身无事务性），但 PR 创建是最后一步，若中断发生在 `push` 之后、`gh pr create` 之前，用户可手动运行 `gh pr create`。提示词中的"check if PR already exists"逻辑（`gh pr view --json number`）支持幂等重试——已有 PR 的情况下会 `gh pr edit` 而非重复创建。
>
> 来源：`01-git类命令.md`

> **Q**: 为什么 `diff` 命令的实现只有 3 行？这种设计有什么优缺点？
>
> **A**: A：`diff` 是典型的"命令作为路由器"设计，所有逻辑下沉到 `DiffDialog` 组件。优点：命令层零逻辑，`DiffDialog` 可被其他 UI 直接复用；懒加载减少启动开销。缺点：命令的功能全部依赖外部组件，若 `DiffDialog` 需要重构，命令层无法提供任何缓冲。但对于纯展示型命令（无需参数解析、无复杂逻辑），这是最简洁的正确实现。
>
> 来源：`01-git类命令.md`

> **Q**: `suppressCompactWarning()` 在压缩后调用的目的是什么？
>
> **A**: A：Claude Code 在上下文窗口使用率超过阈值时，会显示"Context left until auto-compact: X%"的警告。用户手动执行 `/compact` 后，上下文已经大幅缩减，立即再次显示警告会造成困惑（甚至在某些情况下警告会在压缩结果显示前短暂出现）。`suppressCompactWarning()` 设置一个短暂的抑制标志，防止这种视觉噪音。这是用户体验层面的细节优化，与压缩核心逻辑无关。
>
> 来源：`02-会话管理类命令.md`

> **Q**: `/compact` 和 `/clear` 在上下文管理上有何本质区别？
>
> **A**: A：`/compact` 是**有损压缩**——保留对话语义摘要，AI 仍记得之前讨论的内容，但细节可能丢失；它通过 LLM 生成摘要替换原始消息，消耗额外 token 但保持连续性。`/clear` 是**完全重置**——彻底删除所有对话历史，AI 从零开始，不保留任何上下文；不消耗额外 token，但代价是失去完整的历史记忆。选择哪个取决于场景：长时间开发会话中想"瘦身"用 compact；想完全切换话题或任务用 clear。
>
> 来源：`02-会话管理类命令.md`

> **Q**: `/context` 在每次调用时都执行 `microcompactMessages`，这不会影响性能吗？
>
> **A**: A：`microcompactMessages` 是规则式的 token 剔除（非 LLM 调用），速度较快，通常在毫秒级完成。`/context` 是诊断命令，用户主动调用，可以接受轻微延迟。关键是：**不执行 `microcompact` 会导致显示值与实际不符**——因为 API 调用前一定会执行 `microcompact`，跳过这步会导致显示虚高。宁愿稍慢但准确，也不快但误导用户。这是"数据准确性优先于响应速度"的权衡。
>
> 来源：`03-上下文类命令.md`

> **Q**: 为什么 `copy` 命令设计为支持 `/copy N` 格式？
>
> **A**: A：对话历史中 Claude 的多条回复有时语义上紧密相关，用户可能需要复制较早的某条完整回复（而非只复制最后一条）。`/copy N` 允许按"第 N 最新"的顺序索引，比绝对消息 ID 更直观。例如 `/copy 2` 复制倒数第二条 Claude 回复。这对于长时间开发会话中需要提取某个中间步骤的结果特别有用。
>
> 来源：`03-上下文类命令.md`

> **Q**: `getBriefConfig()` 使用 `CACHED_MAY_BE_STALE` 而非每次实时拉取 GrowthBook 配置，有何权衡？
>
> **A**: A：`CACHED_MAY_BE_STALE` 的语义是：值可能是上次后台更新的版本，不保证实时最新。注释中说明：第一次调用触发后台更新，第二次调用才能看到新值。这对于"命令可见性"控制是可接受的——若 Anthropic 通过 GrowthBook 关闭 `/brief`，下次检查（约几分钟内）即可生效，不需要毫秒级的实时响应。相比之下，如果 `isBriefEnabled`（工具可用性 kill switch）需要 5 分钟 TTL 确保快速关闭，命令可见性的更新要求则更宽松。这是延迟与频率的权衡：宽松的缓存策略减少 GrowthBook 查询次数，适合低频变更的配置。
>
> 来源：`04-AI辅助类命令.md`

> **Q**: `/effort` 的设计为什么选择环境变量 > 用户配置文件的优先级顺序？
>
> **A**: A：这符合 12-factor app 的配置原则：环境变量用于部署级别的覆盖，配置文件用于用户偏好。在 CI/CD 场景中，运维人员可以通过 `CLAUDE_CODE_EFFORT_LEVEL=low` 统一限制所有会话的推理强度（降低 API 成本），而无需修改用户的个人配置文件。个人配置文件则是用户的持久偏好。环境变量胜出确保了部署级别的策略可以覆盖个人偏好，但系统会主动告知冲突，不让用户困惑为何自己的设置不生效。
>
> 来源：`04-AI辅助类命令.md`

> **Q**: `/doctor` 通过 `DISABLE_DOCTOR_COMMAND` 环境变量可禁用，为什么需要这个开关？
>
> **A**: A：在某些托管/企业部署场景中，`/doctor` 执行的检查（运行 `git --version`、`gh auth status` 等 Shell 命令）可能触发安全策略警报或超时（若工具不在 PATH 中）。某些受控环境（如受限容器、沙箱）可能不希望用户执行任意诊断命令。`DISABLE_DOCTOR_COMMAND=1` 提供了退出机制，让部署方可以清洁地禁用该命令，而不是修改代码或通过权限系统的复杂配置来屏蔽。这是为运维管理员设计的逃生舱。
>
> 来源：`05-配置类命令.md`

> **Q**: `Settings` 组件使用 `defaultTab` 参数而非不同命令（如 `/settings-model`、`/settings-theme`）的设计权衡？
>
> **A**: A：单一 `Settings` 组件 + `defaultTab` 参数的设计避免了命令爆炸——如果每个设置页都有独立命令，命令数量会随功能增加线性增长，污染用户的命令列表。`/config` 作为总入口，用户可以在 UI 内自由导航标签页，符合用户心智模型（点进配置面板，然后找到想要的选项）。同时，其他命令（如 `/model`）仍然作为独立命令存在，提供快捷路径，不强制用户必须经过配置面板。两者互补而非替代。
>
> 来源：`05-配置类命令.md`

> **Q**: `/cost` 的 `supportsNonInteractive: true` 有什么实际应用？
>
> **A**: A：`supportsNonInteractive: true` 允许在 CLI 管道模式中调用，例如：
> ```bash
> claude --print "/cost"
> ```
> 这对于脚本集成（如定期记录 CI/CD 中的 AI 成本）有实用价值。非交互模式下 `cost.ts` 返回纯文本（`{ type: 'text', value: '...' }`），不依赖 Ink UI，因此可以安全地在管道中运行。注意 `/stats`（`LocalJSXCommand`）则不支持非交互模式，因为其 Ink 组件依赖 TTY。
>
> 来源：`06-调试诊断类命令.md`

> **Q**: 调试诊断类命令大量使用 `INTERNAL_ONLY_COMMANDS` 或 stub，这会不会增加代码维护负担？
>
> **A**: A：存在一定负担，但这是必要的工程权衡。外部用户不应接触内部调试工具（安全性、功能完整性未达标）。若使用 Feature Flag 方案（`feature('ANT_TRACE')`），外部产物中完全不含这些模块，最干净但模块完全隔离。若使用 stub 方案（`ant-trace`），外部产物包含少量 stub 代码，好处是保持模块图的一致性（其他模块可以直接 `import antTrace`，不需要处理可能是 null 的情况）。维护负担体现在：内部版本更新时需要同步保证 stub 不过时，但 stub 极简（5 字节），实际工作量可忽略。
>
> 来源：`06-调试诊断类命令.md`

> **Q**: `/desktop` 要求 claude.ai 订阅（`availability: ['claude-ai']`），为什么 API 用户无法使用会话迁移？
>
> **A**: A：Claude Desktop 应用目前是 claude.ai 的产品，其账号体系和订阅验证与 claude.ai 绑定。API 用户（直接使用 Anthropic API key）没有 claude.ai 账号，无法登录 Claude Desktop，因此会话迁移对他们无意义——即使技术上能传递 session ID，Desktop 应用也无法验证身份加载会话。`availability: ['claude-ai']` 反映了这一产品现实，而非技术限制。
>
> 来源：`07-发布与集成类命令.md`

> **Q**: `bridge-kick` 作为内部测试工具，为什么选择通过命令系统暴露，而非使用 REST API 或独立脚本？
>
> **A**: A：命令系统的优势在于：1) 零额外部署成本——工程师在正常使用 Claude Code 时就能访问调试工具，无需切换工具；2) 共享上下文——`bridge-kick` 可以直接访问 `getBridgeDebugHandle()`，获取当前桥接实例的完整状态；3) 日志集成——执行 `bridge-kick` 后可以直接用 `tail -f debug.log` 观察结果，与正常操作日志混合，真实反映实际行为。独立脚本或 REST API 需要额外的进程间通信，难以注入同一进程内的桥接状态。
>
> 来源：`07-发布与集成类命令.md`

> **Q**: `/btw` 的缓存命中策略有何局限性？
>
> **A**: A：`getLastCacheSafeParams()` 依赖于主线程在最后一次 API 调用后保存的参数（在 stop hooks 中捕获）。局限性：
> 1. **首次对话无缓存**：对话开始的第一轮，尚无 `saved` 参数，必须走回退路径重新构建
> 2. **特殊模式 miss 缓存**：若主线程使用了 `--agent`、`--system-prompt` 等特殊系统提示词扩展，回退路径重建的系统提示词可能与主线程不完全相同，导致缓存 miss
> 3. **并发请求冲突**：若用户在 AI 正在响应时立即调用 `/btw`，`lastCacheSafeParams` 可能是上一轮的，而非当前推理的参数
> 这些都是已知权衡，注释中已明确说明。在大多数场景下（非首轮、非特殊模式），缓存命中率很高。
>
> 来源：`08-其他命令.md`

> **Q**: 为什么 `/skills` 和 `/plugin` 需要独立命令，而不是通过 `/config` 的标签页访问？
>
> **A**: A：用户使用技能和插件的频率远高于修改配置设置。独立命令（`/skills`、`/plugin`）提供：
> 1. 快速直接访问，无需通过配置面板导航到对应标签页
> 2. 可以在 `CLAUDE.md` 中被 AI 系统引用（AI 可以建议用户执行 `/skills` 了解可用技能）
> 3. 可以被其他命令调用（如安装新插件后自动打开 `/skills` 展示新技能）
> `/config` 面板适合偶尔需要调整的深度设置，而 `/skills` 和 `/plugin` 是高频度的功能发现和管理工具，入口路径越短越好。
>
> 来源：`08-其他命令.md`

### Agent 协调（04-Agent协调/）

> **Q**: 协调器系统提示词非常长（数百行），这会带来什么性能影响？如何缓解？
>
> **A**: A：长系统提示词增加每次请求的输入 token 数，直接影响延迟和成本。Claude Code 通过 **Prompt Cache**（`skipCacheWrite` 等参数）将系统提示词缓存在 API 侧，后续请求只需支付 cache read 费用（约为全量输入的 1/10），大幅减轻重复开销。此外，提示词内容仅在协调器模式激活时注入，普通会话的调用路径完全跳过。
>
> 来源：`01-coordinator.md`

> **Q**: `feature('COORDINATOR_MODE')` 这种编译期标志如何影响发布策略？
>
> **A**: A：Bun Bundle 在打包时将 `feature()` 调用替换为布尔常量。内部版本（ant 构建）启用该标志，协调器相关代码被包含；外部发行版标志为 false，整个 `coordinator/` 模块被树摇消除，不出现在最终产物中。这使团队可以在生产内部测试新协调能力而不影响外部用户，同时保证二进制体积最小化。
>
> 来源：`01-coordinator.md`

> **Q**: 七种任务类型共用一个联合类型 `TaskState`，随着类型增加，这种设计有什么扩展性问题？
>
> **A**: A：主要问题是**扩展须修改多处**：每新增一种任务类型，需更新 `TaskState` 联合类型、`isBackgroundTask()` 的 `BackgroundTaskState`、`getPillLabel()` 的 switch 分支、`getTaskByType()` 的查找表。类型越多，这些集中式枚举越难维护，且每处修改都需要跨文件同步。更好的扩展方案是插件注册模式（每种任务类型注册 pill 渲染函数、终止函数等），但当前规模下判别联合的类型安全优势（编译期穷举检查）超过了维护成本。
>
> 来源：`02-tasks.md`

> **Q**: 如何权衡 Shell 任务的通知抑制策略（抑制 exit code 137 通知）？
>
> **A**: A：`exit code 137` = SIGKILL，由 `stopTask()` 主动发出，是**预期内的终止**，若向协调器上报"Shell 命令失败: 137"会产生误导性噪音，使协调器误以为工作者遇到了真实错误。抑制后，通过 `emitTaskTerminatedSdk()` 直接向 SDK 消费者发出 `terminated` 信号（不经过通知 XML），满足 SDK 层的监控需求而不干扰 LLM 的决策上下文。Agent 任务则不抑制，因为 AbortError 捕获层会携带 `extractPartialResult()` 的部分结果，是协调器判断下一步的重要信息。
>
> 来源：`02-tasks.md`

> **Q**: autocompact、snip、microcompact、contextCollapse 四种压缩机制的触发优先级是什么？
>
> **A**: A：按执行顺序（每轮循环）：① snip（片段截断，最轻量，先于 autocompact 运行）→ ② microcompact（单工具结果摘要）→ ③ contextCollapse（折叠旧消息，比 autocompact 粒度细）→ ④ autocompact（整体压缩，最重，阈值触发）。优先级设计的原则是"最轻量的先尝试"：若 snip/collapse 已将 token 数降至阈值以下，autocompact 就不触发，保留更多历史细节。autocompact 是最后的手段，完全替换历史，信息损失最大。
>
> 来源：`03-query.md`

> **Q**: 为什么 `pendingMemoryPrefetch` 使用 `using` 关键字（ES2023 显式资源管理）？
>
> **A**: A：`using` 保证 `pendingMemoryPrefetch.dispose()` 在**所有生成器退出路径**上都被调用——包括正常 `return`、`throw` 异常、以及调用者 `.return()` 提前终止。若改用 `try/finally`，在生成器被外部 `.return()` 调用时（如用户按 Ctrl+C），`finally` 块不一定执行（取决于 JS 引擎实现）。`using` 通过 `Symbol.dispose` 协议提供更可靠的清理语义，并在代码中清晰表达"这是一个需要在退出时清理的资源"的设计意图。
>
> 来源：`03-query.md`

> **Q**: Pane-based 和 In-process 两种 Swarm 后端的选择标准是什么？在什么场景下每种后端会成为瓶颈？
>
> **A**: A：选择标准由运行环境决定（SDK 模式强制 In-process，交互式终端按 tmux/iTerm2 可用性决定），但理解各自瓶颈有助于架构决策。**Pane-based 的瓶颈**：每个 Teammate 是独立的 Node.js 进程，持有独立的 V8 堆、事件循环和 Anthropic API 连接池。10 个 Teammate 意味着 10 个独立进程，内存开销约 10× 单进程，且文件系统邮箱的轮询延迟会随 Teammate 数量线性增长（每个 Teammate 独立轮询自己的邮箱）。**In-process 的瓶颈**：所有 Teammate 共享同一个 Node.js 事件循环。CPU 密集的工具执行（如大文件读写、正则匹配）会阻塞其他 Teammate 的 Promise 执行。极端情况（292 个 Agent，36.8GB 内存）说明 In-process 在 Teammate 数量爆炸时内存问题同样严峻，需要 `TEAMMATE_MESSAGES_UI_CAP` 等机制限制每个 Teammate 的内存上限。
>
> 来源：`05-多Agent协作与Swarm.md`

> **Q**: 如果要将多 Agent 系统扩展到支持跨机器的分布式协作，当前架构的哪些部分需要改造？
>
> **A**: A：当前架构有四个核心假设需要打破：1）**文件系统邮箱**（`~/.claude/teams/`）假设所有 Agent 在同一台机器上，跨机器需要将邮箱替换为网络消息队列（如 Redis Pub/Sub 或 NATS）；2）**AppState.tasks**（内存 Map）假设所有 Task 在同一进程内可见，跨机器需要持久化任务注册表（如 Redis 或 PostgreSQL）；3）**Leader Permission Bridge**（内存回调注册）假设 Teammate 和 Leader 在同一进程，跨机器需要通过网络协议转发权限请求（如 WebSocket）；4）**AbortController 级联中止**（内存引用传递）需要替换为分布式取消令牌（通过消息队列广播 abort 信号）。`TeammateExecutor` 接口的统一设计为这种替换提供了良好的抽象边界——上层调用方无需修改，只需替换后端实现。
>
> 来源：`05-多Agent协作与Swarm.md`

> **Q**: Fork 机制的缺点是什么？什么场景不适合用 fork？
>
> **A**: A：Fork 机制在以下场景中收益降低甚至产生负面效果：
>
> **父 Agent 历史极短时**：前缀太短，cache 节约的绝对 token 数有限，但 fork 带来的消息构建（占位 tool_result 生成）和防递归检查的开销变得相对显著。此时直接用独立的 `AgentTool` 子 Agent 可能更高效。
>
> **高度差异化的子任务**：如果各子 Agent 的任务需要大量 per-child 上下文（每个任务指令有数千 tokens 的背景说明），per-child 差异部分的 token 数接近前缀长度，cache 节约效果被稀释，而 fork 的消息构建复杂度仍然存在。
>
> **单一子任务（不并行）**：Fork 设计为并行 N 个子 Agent，N=1 时没有任何缓存收益（只有一次请求，前缀是否相同无意义），反而引入了占位 tool_result 的结构复杂度。
>
> **LLM 对占位 tool_result 产生混淆**：占位 tool_result 是"假的"执行结果，LLM 可能依据这些占位内容产生错误推断。精心设计的占位内容（如 `"[Task acknowledged, proceeding as instructed]"`）可以降低混淆概率，但无法完全消除。
>
> 来源：`06-Fork与提示词缓存优化.md`

> **Q**: 如果 MCP 工具插入到内建工具列表中间，会有什么后果？
>
> **A**: A：后果分为**直接成本影响**和**间接行为影响**两个层面。
>
> **直接成本影响**：假设内建工具定义共 8,000 tokens，MCP 工具插入在第 4,000 token 位置。缓存断点前移到该位置，原本可以缓存的后 4,000 tokens 内建工具定义变为每次请求全量计费。按 Claude 的 API 定价，对高频使用的系统（每天数万次请求），这可能导致每月数百至数千美元的额外成本。
>
> **间接行为影响**：每次 MCP 服务器配置变化（新增、删除、重排）都会改变工具列表中 MCP 工具的位置，导致原本命中缓存的"内建工具前半段"也失效（因为前缀发生了变化）。频繁的 MCP 配置变更在这种情况下会产生大量 cache write，原本应该稳定的系统 prompt 缓存持续失效，整体缓存命中率下降。
>
> 来源：`06-Fork与提示词缓存优化.md`

### 扩展系统（05-扩展系统/）

> **Q**: `BUILTIN_PLUGINS` 使用进程级单例 Map 有什么优缺点？
>
> **A**: 优点：查找 O(1)，无额外序列化开销，注册即可用。缺点：全局状态难以在并发测试中隔离（因此提供了 `clearBuiltinPlugins()` 测试工具）；进程重启才能感知新注册的插件（不支持热加载）。对于 CLI 工具这种单进程短生命周期场景，单例 Map 是合理的取舍。
>
> 来源：`01-plugins.md`

> **Q**: 当前 `initBuiltinPlugins()` 是空函数，这会有性能影响吗？
>
> **A**: 不会。空函数调用开销可忽略不计，且架构设计允许在不改变调用方的情况下逐步填充内容。这是"为扩展开放、为修改关闭"（OCP）的典型应用——调用方代码不需要改变，只需在 `initBuiltinPlugins()` 中增加 `registerBuiltinPlugin(...)` 调用即可上线新插件。
>
> 来源：`01-plugins.md`

> **Q**: 内置技能的 `getPromptForCommand` 设计为返回 `ContentBlockParam[]` 而非字符串，有什么好处？
>
> **A**: `ContentBlockParam[]` 是 Anthropic SDK 的原生类型，支持文本块（`text`）和图像块（`image`）的混合输入。这使得技能可以直接拼接多个 ContentBlock——例如 `verify` 技能在技能主体后追加用户参数 block，而不需要字符串拼接，避免了转义问题和格式错误。同时 `prependBaseDir()` 可以精确地在首个文本块前插入路径前缀，而不破坏其他类型的块。
>
> 来源：`02-skills.md`

> **Q**: 为什么 `skillify` 和 `verify` 技能只对 `USER_TYPE === 'ant'`（Anthropic 员工）开放？
>
> **A**: 这是一种功能门控（feature gate）的"人肉灰度"方式。这些技能可能依赖内部服务、行为尚未充分验证、或者需要额外权限配置，在向外部用户开放前先在内部验证稳定性。使用环境变量 `USER_TYPE` 而非 feature flag 是因为这类策略是进程启动时就确定的静态配置，不需要动态的 GrowthBook 查询。
>
> 来源：`02-skills.md`

> **Q**: 键位绑定自定义功能通过 GrowthBook 特征标志控制，而不是直接向所有用户开放，这个权衡合理吗？
>
> **A**: 合理。从注释来看这是"仅对 Anthropic 员工开放"的功能门控，理由可能包括：验证配置格式是否稳定、检测是否有用户遭遇终端兼容性问题、评估功能文档是否充分。缺点是外部用户无法体验，但文件加载路径（`loadKeybindings`）、验证（`validateBindings`）、热重载（`initializeKeybindingWatcher`）全部代码已就绪，解除门控只需翻转特征标志，工程风险极低。
>
> 来源：`03-keybindings.md`

> **Q**: 使用 `normalizeKeyForComparison()` 标准化按键字符串做比较，而不是直接比较 `ParsedKeystroke` 对象，有什么利弊？
>
> **A**: 利：可以在未解析阶段做字符串去重（如 `checkDuplicates()` 操作原始字符串），避免对所有按键做完整解析；支持 `"ctrl+k"` 和 `"control+k"` 被识别为同一键。弊：字符串标准化必须和解析器 `parseKeystroke()` 的别名映射保持同步，若两处别名列表不一致会产生误报。目前 `normalizeKeyForComparison()` 维护了自己的别名表（`control`→`ctrl`、`option/opt`→`alt`、`command/cmd`→`cmd`），与 `parser.ts` 中的 switch 分支是独立维护的，存在潜在的同步风险。
>
> 来源：`03-keybindings.md`

### 服务与基础（06-服务与基础/）

> **Q**: 指数退避的最大延迟为 32 秒，这个值如何取舍？
>
> **A**: > 32 秒（2^6 × 500ms）是用户体验与服务保护的平衡点：太短会在高负载时加剧服务器压力；太长则用户等待时间过长。持久模式（`UNATTENDED_RETRY`）上调为 5 分钟，且会等待 `anthropic-ratelimit-unified-reset` 时间戳以避免无效轮询。每次引入 25% 随机抖动（`jitter`）以分散多客户端同步重试。
>
> 来源：`01-services-api.md`

> **Q**: 后台任务（如标题生成）遇到 529 时立即放弃重试的原因是什么？
>
> **A**: > 代码注释写明："during a capacity cascade each retry is 3-10× gateway amplification"。后台任务失败用户无感知，但重试会以 3-10 倍放大服务器压力。`shouldRetry529` 通过 `FOREGROUND_529_RETRY_SOURCES` 白名单区分前台/后台，后台直接抛出 `CannotRetryError`，保护整体集群稳定性。
>
> 来源：`01-services-api.md`

> **Q**: `beforeFileEdited` 和 `getNewDiagnostics` 都通过 MCP RPC 调用 IDE，这会引入多少延迟？
>
> **A**: > 每次 MCP RPC 调用走本地 Unix socket（或 stdio pipe），延迟通常在 5-20ms 量级。`beforeFileEdited` 在文件编辑前调用，不在关键路径上。`getNewDiagnostics` 在工具执行结束后的提示构建阶段调用，即便延迟 30ms 也不影响用户感知。相比之下，诊断信息帮助模型立即感知编辑副作用，减少"修复循环"的轮次，整体是正收益。如果 IDE 不支持 `getDiagnostics`，`catch` 块静默失败，不影响正常流程。
>
> 来源：`02-services-others.md`

> **Q**: GrowthBook 功能开关（feature flags）与分析服务如何耦合？
>
> **A**: > `analytics/growthbook.ts` 提供 `getFeatureValue_CACHED_MAY_BE_STALE` 函数，名称刻意标注 `_CACHED_MAY_BE_STALE` 警告：功能开关值缓存在内存中，不保证实时更新。这是有意的性能权衡——每次功能判断若都走网络查询 GrowthBook，会引入数百毫秒延迟。缓存策略通过分析事件采集来补偿：实验分配结果会上报，离线可精确重建各用户在各时刻的功能状态。
>
> 来源：`02-services-others.md`

> **Q**: 差异获取中设置 `MAX_DIFF_SIZE_BYTES = 1MB` 和 `MAX_LINES_PER_FILE = 400` 的原因？
>
> **A**: > Claude 的上下文窗口有限，大型 diff 会挤占可用于真正问题分析的空间。400 行是 GitHub PR 界面自动折叠的阈值（注释中明确引用），超过这个限制时用户/模型都需要额外点击才能看到完整内容，说明这是一个普遍认可的「可读性边界」。1MB 字节限制防止加载二进制文件或大型生成文件的变更内容到内存（如 lock 文件变更数百 KB）。
>
> 来源：`03-utils-git.md`

> **Q**: LRU 缓存容量设为 50 的依据是什么？
>
> **A**: > 注释说明：`gitDiff` 以 `dirname(file)` 调用 `findGitRoot`，在大型代码库中编辑分散在不同目录的文件会积累大量不同路径的缓存条目。无上限的 `memoize` 会导致内存无限增长。50 条覆盖了「一个用户在一个会话里合理编辑的不同目录数量」，超过 50 时淘汰最近最少使用的条目。实践中大多数项目的源文件目录结构不超过 20-30 层深度，50 条绰绰有余。
>
> 来源：`03-utils-git.md`

> **Q**: 如何在不重启 Claude Code 会话的情况下更换 API Key？
>
> **A**: > 通过 `onChangeAppState` 监听到 settings 变更后调用 `clearApiKeyHelperCache()`，下次 API 调用时 `getApiKeyFromApiKeyHelper` 重新执行 helper 脚本获取新 key。如果是直接修改 `ANTHROPIC_API_KEY` 环境变量，则需要通过 `settings.json` 的 `env` 字段修改（`applyConfigEnvironmentVariables`）来触发 `onChangeAppState` 链路。`clearAwsCredentialsCache()` 和 `clearGcpCredentialsCache()` 同理，适用于需要轮换云凭证的场景。
>
> 来源：`04-utils-model-auth.md`

> **Q**: 模型别名系统（`sonnet` → `claude-sonnet-4-6-20251101`）的优势是什么？潜在问题是什么？
>
> **A**: > **优势**：迁移脚本（如 `migrateSonnet45ToSonnet46`）无需向每个用户推送变更——只需修改别名映射，所有使用 `sonnet` 别名的用户自动升级到新版本。成本计算（`getModelCosts`）、功能判断（`isNonCustomOpusModel`）等都基于规范化后的短名称，与具体版本解耦。**潜在问题**：别名解析不透明，用户可能不清楚 `sonnet` 当前指向哪个版本；在功能开关影响模型可用性时，别名与实际模型的映射需要与 GrowthBook 功能开关同步更新，否则会出现配置漂移。
>
> 来源：`04-utils-model-auth.md`

> **Q**: 离线 token 估算使用「字符数 / 4」的精度如何？有什么更准确的替代方案？
>
> **A**: > 「字符数 / 4」是一个历史经验近似值，对英文文本误差约 ±15%，对中文/日文等多字节字符误差可达 50% 以上（一个汉字约 1-2 个 token，但占 3 字节 UTF-8）。更准确的替代方案：1) 使用 `tiktoken` 或 Anthropic 官方的本地 tokenizer 库（计算开销 ~1ms/千字符）；2) 调用 `/tokens` API 端点（有网络延迟）。当前选择「字符 / 4」的原因是：估算仅用于进度 spinner 显示，精度要求低，不影响实际计费，本地计算无延迟。
>
> 来源：`05-utils-cost-token.md`

> **Q**: 快速模式（Fast Mode）的 $30/$150 定价与标准模式 $5/$25 相差 6 倍，用户如何感知成本差异？
>
> **A**: > `getOpus46CostTier` 使用 `usage.speed === 'fast'` 字段区分两种模式，该字段来自 API 响应（服务端决定），客户端不能自行声明。成本追踪层（`cost-tracker.ts`）使用这个函数计算每次响应的成本，累计到会话总成本中展示在 footer。当 Fast Mode 被降级（冷却期）时，`usage.speed` 会是标准值，成本自动切换到低价档。这确保成本展示始终与实际计费一致，用户可以直观看到 Fast Mode 的成本影响。
>
> 来源：`05-utils-cost-token.md`

> **Q**: 状态树中有 20+ 个字段，每次更新都生成新对象，GC 压力如何？
>
> **A**: > 由于 `Object.is` 引用比较，只有实际发生变更的字段才会触发 React 重渲染。AppState 是一个浅对象（非深层嵌套），spread 操作仅复制顶层属性的引用（O(n) 字段数），不递归复制。对于高频更新的字段（如 `spinnerTip`），React Compiler 的自动记忆化确保只有依赖该字段的组件重渲染。整体上，状态更新的 GC 开销与传统 React 状态管理相当，且 Node.js/V8 的 GC 对短存活对象（年轻代）优化良好。
>
> 来源：`06-state.md`

> **Q**: `onChangeAppState` 中的持久化操作（`saveGlobalConfig`）如果失败会怎样？
>
> **A**: > 当前实现中，`onChangeAppState` 的 settings 变更分支有 try-catch 处理（`clearApiKeyHelperCache` 等可能抛出），但 `saveGlobalConfig`（写入磁盘）的调用（`expandedView`、`verbose` 等分支）没有 try-catch，写入失败会静默丢失（没有 `logError`）。这是一个轻微的健壮性问题：磁盘满或权限问题时，用户偏好可能不被保存。实际影响有限，因为这些是 UI 偏好（展开状态、verbose 模式），不影响功能。
>
> 来源：`06-state.md`

> **Q**: Zod v4 相比 Zod v3 有哪些影响 Claude Code 使用方式的变化？
>
> **A**: > `src/schemas/hooks.ts` 使用 `from 'zod/v4'` 显式指定版本。Zod v4 的关键变化影响此处：`z.partialRecord` 是 v4 新增的 API（v3 需要 `z.record(K, z.optional(V))` 变通）；v4 的错误格式和 `describe()` 与 JSON Schema 生成的对接方式也有所改善。使用 `zod/v4` 子路径 import 表明这是有意识的版本锁定，避免 v3→v4 迁移时的 API 破坏。
>
> 来源：`07-schemas.md`

> **Q**: schema 中的 `describe()` 字符串有什么实际作用，不只是文档注释？
>
> **A**: > `describe()` 字符串在通过 `zodToJsonSchema` 转换时会变成 JSON Schema 的 `description` 字段。Claude Code 中工具的 `inputSchema` 是从 Zod 模式生成的 JSON Schema，`description` 字段被包含在发送给模型的工具定义中——模型据此理解每个参数的含义。例如 `statusMessage` 字段的描述 `"Custom status message to display in spinner while hook runs"` 会出现在工具描述中，帮助模型生成更准确的钩子配置。注释中也有 `// @[MODEL LAUNCH]: Update the example model ID in the .describe() strings below`，说明 `describe` 字符串在模型上线时需要同步更新。
>
> 来源：`07-schemas.md`

> **Q**: `MEMORY.md` 的截断是优先截断行还是字节？为什么这个顺序？
>
> **A**: > 先截断行（200 行），再截断字节（25KB）。行是 Markdown 文档的自然语义边界，行截断不会产生半行的损坏内容；字节截断是第二道防线，处理单行内容过长的情况（如一行包含超长 URL 列表）。如果先截字节，可能在某行中间截断，产生半行的 Markdown（如截断 `[Title](url`，破坏链接语法），增加模型理解难度。注释中 `cutAt = lastIndexOf('\n')` 也是在字节截断时寻找安全的换行位置。
>
> 来源：`08-constants-types-migrations.md`

> **Q**: `agentId` 的格式 `a(?:.+-)?[0-9a-f]{16}` 为什么有可选的标签部分？
>
> **A**: > 标签部分（`.+-` 匹配一个非空标签后跟连字符）是为了可读性调试。在 agent swarm 场景下，多个子代理同时运行，纯十六进制 ID 不易区分。带标签的 ID（如 `a-research-1a2b3c4d5e6f7890`）在日志中直观表明该代理的角色。`toAgentId` 同时接受有标签和无标签两种格式，向后兼容早期只生成 `a[16hex]` 的代码。
>
> 来源：`08-constants-types-migrations.md`

> **Q**: `DANGEROUS_uncachedSystemPromptSection` 函数名以 DANGEROUS 开头是什么设计哲学？
>
> **A**: > 这是"命名作为安全机制"的设计哲学，也称为 **Pit of Success**（成功陷阱的反面）——让正确的事情简单，让危险的事情有明显摩擦感。正常的 prompt 段落直接添加到静态区域即可，无需调用任何特殊函数；只有需要绕过缓存的情况才调用这个名字显眼的函数，并且必须提供 `_reason` 参数。`DANGEROUS` 前缀会在代码审查中立即引起注意，任何调用此函数的 PR 都会被质疑"是否真的有必要"。这比注释更有效，因为注释可以被忽视，但函数名在调用点始终可见。
>
> 来源：`09-system-prompt工程.md`

> **Q**: MCP 指令增量注入（`isMcpInstructionsDeltaEnabled`）的性能意义是什么？
>
> **A**: > MCP 指令通常包含每个 MCP 服务器的工具描述、使用说明，可能占 2,000-8,000 token。如果每次 API 调用都重新序列化这部分内容（即使服务器列表没有变化），动态区域的内容就会"变化"（即使实际内容相同，新字符串对象也会破坏某些缓存检查），导致动态区域的下游缓存失效。增量注入通过引用相等性检查（`mcpServersChanged`），在服务器列表未变化时复用同一字符串对象，保持动态区域内 MCP 段落的局部稳定性，减少不必要的 token 重传。
>
> 来源：`09-system-prompt工程.md`

> **Q**: 重建阶段注入最多 5 个关键文件，如果当前任务涉及超过 5 个文件怎么办？
>
> **A**: > 这是有意识的设计权衡，而不是 bug。未被预加载的文件仍然可以通过 Read 工具按需获取——这是「延迟加载」策略，与「预加载所有文件」对比：预加载所有文件可能消耗数万 token（违背压缩的目的），而延迟加载只在模型实际需要时才消耗空间。5 个文件的选择标准是「修改频率最高的文件」，统计方式是扫描原始消息中 Edit tool 和 Write tool 的 `file_path` 参数，出现次数最多的前 5 个文件是最可能在后续对话中继续修改的文件。6 个以上的边缘情况通过额外的 Read 调用处理，成本可接受。
>
> 来源：`10-上下文压缩.md`

> **Q**: AutoCompact 在 API 调用失败时，原始消息列表会保留还是丢失？
>
> **A**: > 原始消息**完整保留**，这是断路器之外的另一道安全保障。AutoCompact 的实现遵循「先读后写」原则：原始 `mutableMessages` 在 AutoCompact 成功返回压缩结果之前不会被修改。如果 API 调用失败（超时、限流、任何异常），函数捕获异常并返回原始消息列表，触发断路器的 `recordFailure()`，会话继续以原始上下文运行（可能很快因超限而失败，但至少不会因为压缩本身导致数据丢失）。这是「宁可失败不可丢数据」的安全原则。
>
> 来源：`10-上下文压缩.md`

### UI 与交互（07-UI与交互/）

> **Q**: blit 优化在什么情况下会被禁用？为什么这是必要的权衡？
>
> **A**: 以下情况禁用 blit，回退到全量重新渲染：
> 1. `prevFrameContaminated = true`：上一帧的 `Screen` 缓冲区被选区高亮等操作污染，直接复用会复制错误的反色字符。
> 2. `absoluteRemoved = true`：有绝对定位节点被移除。绝对定位元素可以覆盖任意其他节点，其移除可能导致被遮挡节点需要重新暴露，普通的兄弟节点脏检查无法处理跨子树的像素重叠问题。
> 3. 窗口大小变化 / SIGCONT 恢复：终端物理缓冲区已被操作系统清空，必须全量重绘。
>
> 禁用 blit 会导致一帧的渲染开销上升，但正确性优先于性能——错误的像素复用会产生视觉脏字符，比短暂的性能抖动更不可接受。
>
> 来源：`01-ink渲染引擎.md`

> **Q**: Claude Code 如何处理 Alt Screen（全屏模式）与普通滚动模式的差异？
>
> **A**: `renderer.ts` 通过 `options.altScreen` 标志分支处理：
> - **高度裁剪**：Alt Screen 的内容高度强制钳制为 `terminalRows`，防止 Yoga 超高内容导致虚拟/物理光标坐标失同步。
> - **视口高度 +1 hack**：Alt Screen 的 `viewport.height` 设为 `terminalRows + 1`，规避 log-update 把"内容恰好填满"误判为"需要滚动"。
> - **光标位置**：Alt Screen 中光标 Y 坐标钳制为 `terminalRows - 1`，避免最后一行触发终端自动换行（LF）把 alt buffer 内容滚出。
>
> ---
>
> 来源：`01-ink渲染引擎.md`

> **Q**: 组件树中为什么选择三个独立的 Provider（FpsMetrics / Stats / AppState）而不是一个统一的 GlobalProvider？
>
> **A**: 关注点分离与更新隔离。三个 Context 的更新频率截然不同：
> - `FpsMetrics`：每帧更新（~60Hz），只有依赖 FPS 数据的 DevBar 组件订阅。
> - `Stats`：统计事件触发时更新（低频），只有性能监控组件订阅。
> - `AppState`：用户交互时更新（中频），REPL 中大多数组件订阅。
>
> 合并为一个 Provider 会导致 `FpsMetrics` 每帧更新时触发所有订阅组件重渲染，即使它们不使用 FPS 数据。分离 Context 确保每次更新只传播到真正依赖该数据的组件子树。
>
> 来源：`02-核心组件.md`

> **Q**: PromptInput 中的 `useTypeahead` 补全建议是如何避免阻塞主输入响应的？
>
> **A**: 补全建议通过 `useDeferredValue` 延迟处理：用户每次击键后，主输入的 `value` 状态立即更新（保持输入响应性），补全请求则以低优先级调度。React 的并发特性允许在新的补全计算完成之前继续处理后续击键，旧补全结果会被丢弃。`abortSpeculation()` 在用户输入时立即取消未完成的推测性补全请求，避免过期结果覆盖用户的当前输入。
>
> ---
>
> 来源：`02-核心组件.md`

> **Q**: 如何评估将 ResumeConversation 的会话列表改为虚拟滚动的必要性？
>
> **A**: 当前实现一次性渲染所有会话列表项。对于大多数用户（< 100 个历史会话），这不是问题。需要虚拟滚动的临界点约在 500+ 项（终端渲染字符行数超过 Yoga 布局计算开销阈值）。可以通过测量 `useVirtualScroll`（已在 `src/hooks/` 中存在）的切入收益来决策：若会话列表的布局计算耗时超过 16ms（一帧预算），则值得引入虚拟滚动。`CLAUDE_CODE_COMMIT_LOG` 环境变量可以记录每帧的 Yoga 计算耗时，是评估此问题的直接工具。
>
> 来源：`03-screens路由.md`

> **Q**: Doctor Screen 的 `Suspense` fallback 显示 `<Spinner />`，但 CLI 环境中 Spinner 是动画组件，这会引发性能问题吗？
>
> **A**: Spinner 组件使用 `useInterval` 以固定帧率更新动画状态，每次更新触发 React 重渲染和 Ink 帧输出。在 Doctor Screen 中，Suspense 的 fallback 期间（通常 < 1 秒，取决于网络延迟），Spinner 持续运转是合理的。Ink 的差量渲染确保 Spinner 的每帧更新只输出变化的字符（通常 1-2 个字符），对终端输出带宽的影响可以忽略不计。
>
> ---
>
> 来源：`03-screens路由.md`

> **Q**: `useVirtualScroll` 的高度估算采用"故意低估"策略，这有什么代价？
>
> **A**: 低估（`DEFAULT_ESTIMATE = 3`）会导致多挂载几个 `MessageRow`（80 行 overscan / 3 行估算 = 27 项 vs 实际可能只需要 8 项）。代价是多创建了 ~19 个 React 组件实例和 Yoga 节点，增加 ~30ms 的首次渲染时间。但这远优于高估带来的空白问题：若估算为 20 行，则 80 行 overscan 只挂载 4 项，实际内容可能超过 4 项导致视口底部出现大片空白区。选择正确比选择高效更重要，`PESSIMISTIC_HEIGHT = 1` 的覆盖计算使用最小值确保物理覆盖到视口底部。
>
> 来源：`04-hooks.md`

> **Q**: 为什么 `useArrowKeyHistory` 不使用 React 状态缓存历史条目，而是每次都从文件读取？
>
> **A**: 历史记录存储在 `~/.claude/history` 文件中，其他进程（如另一个 Claude Code 实例）也可以同时写入。若缓存到 React 状态，新添加的历史条目在当前会话结束前不会被感知。更重要的是，历史文件可能包含数千条记录，全量加载到内存是浪费。分块懒加载（每次 10 条）配合请求合并，在保持文件实时性的同时控制了 I/O 开销。对于同一次连续的历史导航（快速按多次上键），请求合并确保不会产生多余的磁盘读取。
>
> ---
>
> 来源：`04-hooks.md`

> **Q**: 为什么 `Learning` 模式的提示词有数百行，而 `Explanatory` 模式只有几十行？
>
> **A**: `Learning` 模式的行为更复杂，需要更精细的指令来确保一致性：Claude 必须知道何时暂停、如何格式化"Learn by Doing"请求、如何在 TodoList 中追踪待人工实现的任务、如何处理用户提交后的反馈。每个细节点的模糊性都可能导致 Claude 在不同上下文中产生不一致的行为（有时暂停，有时不暂停）。`Explanatory` 模式只需要"插入教育性注释框"，行为本质上简单，少量指令足以约束。长提示词的代价是：每次 API 请求的 token 消耗增加（约 300 tokens），在频繁对话时会累积为可感知的成本。
>
> 来源：`05-outputStyles.md`

> **Q**: 如何评估一个新的内置输出样式的必要性？
>
> **A**: 评估标准应包括：
> 1. **系统提示层必要性**：行为变化是否必须在 AI 推理层实现，还是可以通过渲染层后处理解决？
> 2. **通用性**：是否适用于足够多的用户场景（特定行业/任务类型的需求更适合作为插件样式而非内置）？
> 3. **与现有样式的差异**：与 `Explanatory`/`Learning` 的功能重叠度如何？
> 4. **提示词稳定性**：能否编写出在不同编程语言、代码库规模下都能一致产生预期行为的提示词？
>
> ---
>
> 来源：`05-outputStyles.md`

> **Q**: 物种名称使用 `String.fromCharCode()` 编码而不是直接写字符串，这是为什么？
>
> **A**: 注释解释了原因：一个物种名与某个模型代号（model-codename canary）存在字符串碰撞，而构建流程中有一个"excluded-strings.txt"扫描，会检查构建产物中是否出现被禁止的字面量（用于防止意外泄露内部代号）。如果直接写字符串，即使是非敏感用途也会触发扫描警告。通过 `String.fromCharCode()` 在运行时构造字符串，字面量不出现在构建产物中，绕过了扫描检查，同时 `as 'duckname'` 的类型断言确保 TypeScript 类型系统知道实际值。这是一个在"正确性"（通过编译检查）和"工具兼容性"（不触发 canary 扫描）之间的务实权衡。
>
> 来源：`06-buddy-AI伴侣.md`

> **Q**: Buddy 系统的 `companionMuted` 配置选项说明了什么用户体验考量？
>
> **A**: 提供静音选项反映了"功能要有退出路径"的设计原则。终端旁边的动画精灵对不需要它的用户可能是视觉干扰，尤其在生产环境使用或截图分享代码时。`companionMuted = true` 在 `getCompanionIntroAttachment()` 和 `CompanionSprite` 渲染中都有检查，静音后完全隐藏精灵（不仅仅是隐藏动画），同时不向 Claude 的上下文注入伴侣介绍，保持对话的纯净性。
>
> ---
>
> 来源：`06-buddy-AI伴侣.md`

> **Q**: Vim 模式的 `vimStateRef.current` 用 `useRef` 而不是 `useState` 存储，这对用户体验有什么影响？
>
> **A**: `vimStateRef.current` 存储命令解析的中间状态（如 `{ type: 'operator', op: 'delete', count: 3 }`）。若用 `useState`，每次按键都触发 React 重渲染 + Ink 帧渲染。对于 `3d2w` 需要 4 次按键，每次按键触发一次重渲染，4 次渲染仅更新模式指示器（`d` 的模式指示仍为 NORMAL，不变）——纯属浪费。使用 `useRef` 将状态机变更完全隐藏在渲染循环外，只有 `setMode('INSERT')` 和 `setMode('NORMAL')` 才触发重渲染，将 Vim 操作的渲染成本降至最低。
>
> 来源：`07-voice-vim.md`

> **Q**: 语音的 `normalizeLanguageForSTT()` 采用多级回退策略而不是严格拒绝，这有什么用户体验考量？
>
> **A**: 严格拒绝（用户设置了不支持的语言就报错）会导致：用户可能在设置了母语（如泰语 `th`）后发现语音功能完全不可用，即使用英语也无法使用，体验极差。多级回退策略（不支持 → 尝试 BCP-47 基础码 → 回退英语 + 提供警告）确保功能总是可用的：用英语识别虽然对非英语用户是降级，但比完全不可用好。`fellBackFrom` 字段让调用者能够向用户显示"你的语言设置 X 不受支持，已切换到英语"的通知，保持透明度。
>
> ---
>
> 来源：`07-voice-vim.md`

### 网络与远程（08-网络与远程/）

> **Q**: `createToolStub()` 为什么不加载真实工具定义？
>
> **A**: 远程 CCR 容器可能运行 MCP 工具，本地 CLI 并不知道它们的 schema。加载真实定义会要求本地与远端的工具集完全同步，引入强耦合。工具桩（stub）仅实现权限渲染所需的最小接口（`name`、`renderToolUseMessage`、`needsPermissions`），路由到 `FallbackPermissionRequest` 组件显示原始输入，既不崩溃，又给用户足够信息做决策。
>
> 来源：`01-remote.md`

> **Q**: `BoundedUUIDSet` 的环形缓冲区设计有什么优势？
>
> **A**: （见 `bridgeMessaging.ts` 的 echo 去重机制）相比无限增长的 `Set`，容量固定的环形缓冲区确保内存恒为 O(capacity)。对于 UUID 去重场景，历史消息超出窗口后不再可能重复，淘汰最老条目不影响正确性。
>
> 来源：`01-remote.md`

> **Q**: Direct Connect 的 Bearer Token 鉴权与 CCR 的 OAuth 相比，有哪些安全权衡？
>
> **A**: Bearer Token 是服务端启动时生成的随机密钥，适合本地/内网场景，简单但有固定令牌被截获的风险。CCR OAuth 是基于 claude.ai 账号的短期访问令牌（约 4 小时有效），带有账号级别的权限控制，适合多租户云端场景。Direct Connect 适合本地受信网络（如 localhost、VPN 内网），CCR 模式适合公网访问需求。
>
> 来源：`02-server.md`

> **Q**: 为什么 `isStdoutMessage()` 只检查 `type` 是字符串而不做完整校验？
>
> **A**: 完整校验意味着需要为每种 `StdoutMessage` 的联合类型维护校验逻辑，而且会在后端新增类型时导致校验失败（需要同步更新客户端）。轻量守卫（只验 `type` 存在且为字符串）加上 `switch/if` 分支路由，在性能和向前兼容性之间取得平衡。
>
> 来源：`02-server.md`

> **Q**: `BoundedUUIDSet` 的容量如何选择？
>
> **A**: 容量必须大于在"窗口时间"内可能并发的消息数量。对于 bridge 场景，echo 去重需覆盖从发送到收到回声的 RTT（通常 < 1 秒），按 100 条/秒的消息速率，容量 128 即可。`recentInboundUUIDs` 需覆盖 transport swap 的窗口（通常 < 30 秒的历史），按低速率 10 条/分钟，容量 64 足够。选择 2 的幂次（64/128）使模运算高效。
>
> 来源：`03-bridge.md`

> **Q**: 为什么 `onInboundMessage` 使用 `void` 而不是 `await`？
>
> **A**: 入站消息处理可能含异步操作（如附件 URL 解析，需要 HTTP 请求），若 `await`，消息处理器会阻塞 WebSocket 的 message 事件循环，导致后续消息积压。使用 `void` 让处理函数异步执行，WebSocket 可立即处理下一条消息。错误处理由处理函数内部的 `try-catch` 负责，不影响主循环。
>
> 来源：`03-bridge.md`

> **Q**: 每次 HTTPS 请求都建立新的 WebSocket 连接，性能如何？
>
> **A**: 当前实现对每个 `CONNECT` 请求创建一个独立的 WebSocket 连接（`openTunnel()` 中的 `new WebSocket()`）。对于 Datadog metrics 上报（低频）等场景，这个开销可接受；对于高频 API 调用（如 npm install），每次请求都需要完整的 WebSocket 握手（TCP + TLS + HTTP Upgrade），增加约 50-100ms 延迟。可优化点：实现 WebSocket 连接池，但需处理目标地址复用的正确性和连接活跃度管理。
>
> 来源：`04-upstreamproxy-moreright.md`

> **Q**: upstreamproxy 对子进程"fail open"（失败不阻塞）的设计有什么代价？
>
> **A**: 优点：代理初始化失败（如 CA 证书下载超时）不会阻止 agent 会话启动，保证了服务可用性。代价：若代理静默失败，子进程发起的 HTTPS 请求会因 `HTTPS_PROXY` 指向不存在的地址而挂起（无法连接到本地代理端口），实际表现为工具调用超时，而非明确的错误消息，增加排查难度。
>
> 来源：`04-upstreamproxy-moreright.md`

> **Q**: KAIROS 信任检查在什么情况下可能产生误报（false negative）？
>
> **A**: `checkHasTrustDialogAccepted()` 检查的是**当前工作目录**是否已被信任。若用户在项目 A（已信任）中克隆了包含恶意 `settings.json` 的项目 B（子目录），然后在项目 B 的目录内运行 Claude Code，若 B 的父目录路径被信任，`checkHasTrustDialogAccepted()` 可能返回 true（因为 B 是已信任路径的子目录）。这是路径前缀信任模型的内在缺陷，最佳缓解是要求每个 git 仓库独立信任（基于 `git rev-parse --show-toplevel` 的精确匹配）。
>
> 来源：`05-assistant-KAIROS.md`

> **Q**: `isBriefOnly: true` 对 KAIROS 观察端 UI 有什么影响？
>
> **A**: Brief 模式下，REPL 使用紧凑布局渲染助手消息，减少每条消息占用的行数：① 工具使用详情默认折叠；② 冗长的中间状态（如"正在读取文件…"）不显示；③ 只展示关键输出和最终结果。这样用户在终端窗口中可以看到更多消息历史。`isBriefOnly` 同时禁用了主动向用户发送消息的 prompt 输入框（因为观察端以只读为主）。
>
> 来源：`05-assistant-KAIROS.md`

> **Q**: `getGitStatus()` 并发执行 5 个 git 命令，在大型 monorepo 中可能有什么问题？
>
> **A**: `git status --short` 在包含大量未跟踪文件或大型工作区的 monorepo 中可能执行数秒（扫描数十万个文件）。此外，5 个命令同时执行会给 git 进程池（和文件系统缓存）带来并发压力，可能相互竞争 git 的目录锁。缓解方案：① 增加 `--ignore-submodules` 减少递归扫描；② 在 CCR 远程模式下跳过（已实现）；③ 为 `getGitStatus` 增加全局超时（目前没有明确的超时，只有 `MAX_STATUS_CHARS` 截断输出）。
>
> 来源：`06-context-native-ts.md`

> **Q**: `FileIndex` 选择基于时间（4ms）而非计数（如每 5000 个路径）切片的原因是什么？
>
> **A**: 固定计数切片假设了每个路径的处理时间相同，而实际上路径长度、字符集、索引计算复杂度因路径而异。Windows 上处理含 Unicode 字符的路径明显慢于 ASCII 路径。时间切片（`Date.now()` 比较）确保每个切片的实际 CPU 占用接近恒定，无论路径特性如何，UI 帧间隔的卡顿都不超过 4ms。
>
> 来源：`06-context-native-ts.md`

---

## 四、实战应用题（共 119 题）

### 核心入口（01-核心入口/）

> **Q**: 如果你想为 Claude Code 添加一个新的 CLI 子命令（如 `claude analyze`），应该在 `main.tsx` 的哪些位置修改？
>
> **A**: 1. 在 `entrypoints/cli.tsx` 中添加快速路径检测（如果不需要完整初始化），用于提前拦截和处理简单命令。
> 2. 在 `run()` 函数内通过 `program.command('analyze')` 注册子命令，添加 `.action()` 处理器。
> 3. 子命令 handler 通过 `preAction` 钩子自动获得 `init()` 和 `initSinks()`，无需在 handler 内重复调用。
> 4. 若子命令需要写入会话状态，在 `bootstrap/state.ts` 添加相应状态字段并提供 setter。
> 5. 注意在 `logManagedSettings()` 或 `logSessionTelemetry()` 内添加相应的分析事件上报。
>
> 来源：`01-main.md`

> **Q**: `main.tsx` 如何处理调试模式检测，为什么要在检测到调试器时退出？
>
> **A**: `isBeingDebugged()` 函数（`src/main.tsx:232`）检查三个指标：`process.execArgv` 中的 `--inspect`/`--debug` 标志、`NODE_OPTIONS` 环境变量中的检测标志、以及 `inspector.url()` API 是否返回非空值。检测到调试器时立即 `process.exit(1)`。这是安全措施：Claude Code 的部分敏感操作（keychain 读取、权限检查）不应在未授权的调试会话中被检查。同时也防止通过调试器绕过信任对话框或权限验证流程。注意该检测仅在非 Ant（外部）构建中激活（`"external" !== 'ant'` 条件）。
>
> 来源：`01-main.md`

> **Q**: 如果你需要为 Claude Code 添加一种新的传输协议（如 UNIX socket），应该如何扩展传输层？
>
> **A**: 1. 在 `src/cli/transports/` 下新建 `UnixSocketTransport.ts`，实现 `Transport` 接口（`send(message: StdoutMessage): void`、`onMessage(callback)`、状态管理）。
> 2. 在 `transportUtils.ts` 的 `getTransportForUrl()` 工厂函数中添加对 `cc+unix://` URL scheme 的检测，返回 `new UnixSocketTransport(url)`。
> 3. 在 `RemoteIO` 构造函数中调整初始化逻辑（已有 `cc+unix://` 的 URL scheme 支持，见 `main.tsx` 的 URL 预处理）。
> 4. 无需修改 `StructuredIO`，它通过 `PassThrough` 流抽象屏蔽了传输层细节。
>
> 来源：`02-cli.md`

> **Q**: `runHeadless()`（`cli/print.ts`）与 `launchRepl()`（`replLauncher.tsx`）的核心区别是什么？
>
> **A**: `runHeadless()` 不初始化 Ink/React 渲染器，不监听键盘输入，直接将输入提示词传递给 `QueryEngine`，以流式或批量方式将输出写到 stdout。适用于脚本化调用、CI 环境和 SDK 集成。`launchRepl()` 则初始化完整的 React/Ink TUI 界面，支持键盘快捷键、历史导航、实时状态显示等交互功能。两者共享同一套 `QueryEngine`、工具系统和 MCP 客户端，差异仅在 I/O 层。这种设计使核心逻辑（模型调用、工具执行、权限检查）完全与界面解耦，可以独立测试。
>
> 来源：`02-cli.md`

> **Q**: 如果需要为 Claude Code 添加一个 `claude worker` 快速路径命令（无需完整 CLI 初始化），应该在哪里添加？
>
> **A**: 在 `src/entrypoints/cli.tsx` 的 `main()` 函数中，按照现有快速路径的模式添加：
> ```typescript
> if (feature('MY_WORKER') && args[0] === 'worker') {
>   profileCheckpoint('cli_worker_path');
>   const { workerMain } = await import('../myworker/main.js');
>   await workerMain(args.slice(1));
>   return;
> }
> ```
> 将该检查放在加载 `main.js` 之前，利用 `feature()` 宏在编译时消除外部版本的代码。若命令需要配置系统，在 `workerMain` 内部调用 `enableConfigs()`；若需要分析事件，在 `workerMain` 内部调用 `initSinks()`，不必调用完整的 `init()`。
>
> 来源：`03-entrypoints.md`

> **Q**: `mcp.ts` 中 MCP 服务器暴露的工具与 CLI 交互模式下可用的工具有何区别？
>
> **A**: MCP 模式使用 `getEmptyToolPermissionContext()` 创建权限上下文，意味着工具集基于「最宽松」的权限假设。CLI 交互模式的工具集由实际的 `toolPermissionContext`（从 `--permission-mode`、会话设置、Enterprise 策略等计算得出）决定，某些工具可能因权限不足而被过滤。另一个差异是：MCP 模式仅暴露内置工具（`getTools()` 的结果），而 CLI 模式还包括 MCP 客户端工具（来自其他 MCP 服务器的工具）。最后，`outputSchema` 在 MCP 模式下有额外限制（根类型必须为 `object`），CLI 模式无此限制。
>
> 来源：`03-entrypoints.md`

> **Q**: 如果你需要在 `State` 中添加一个跟踪「当前会话累计工具调用次数」的字段，你会如何设计？
>
> **A**: 根据 `state.ts` 顶部的「不要随意添加全局状态」原则，首先确认这是会话级统计（不同于 `AppStateStore` 的 UI 状态或工具级状态），适合放在 `State` 中。实现方式：
> ```typescript
> // 在 State 类型中添加（与其他计数字段放在一起）
> totalToolCallCount: number
>
> // 在 getInitialState() 中初始化
> totalToolCallCount: 0
>
> // 导出 getter/setter（保持封装）
> export function getTotalToolCallCount(): number {
>   return STATE.totalToolCallCount
> }
> export function incrementToolCallCount(): void {
>   STATE.totalToolCallCount++  // 简单自增，无需不可变更新
> }
> ```
> 注意：计数器使用直接自增而非不可变更新（`{ ...STATE, count: STATE.count + 1 }`），因为 `State` 是模块级单例，不需要 Redux 式的不可变性（没有订阅者监听 State 变化，不会触发重渲染）。
>
> 来源：`04-bootstrap.md`

> **Q**: 如何利用 `bootstrap/state.ts` 中的状态在多个模块之间共享会话信息，而不产生循环依赖？
>
> **A**: 正确的模式是：所有模块都「单向」依赖 `bootstrap/state.ts`（导入 getter/setter），而 `state.ts` 不导入任何业务模块。例如：
>
> - 工具执行后更新成本：`tools/BashTool.ts` 导入 `addCost()` from `state.ts`，调用 `addCost(response.cost)`
> - 分析模块读取当前成本：`services/analytics/` 导入 `getTotalCostUSD()` from `state.ts`
> - 两个模块之间没有直接依赖，通过 `state.ts` 中介共享数据
>
> 若需要模块间通知（如成本更新后更新 UI），不能通过 `state.ts` 引入回调（会产生依赖），而应使用 `createSignal()` 或 `AppStateStore` 的订阅机制（UI 层），或通过 `React` 的状态管理在组件树中传递变化。
>
> 来源：`04-bootstrap.md`

### 工具系统（02-工具系统/）

> **Q**: 如何给 Claude Code 添加一个自定义工具？
>
> **A**: A：按照 `ToolDef<I, O>` 接口实现工具定义，创建新目录（如 `src/tools/MyTool/`），在主文件中用 `buildTool({...}) satisfies ToolDef<InputSchema, OutputSchema>` 构建，然后在 `src/tools.js` 的 `assembleToolPool()` 中导入并添加到工具数组。关键实现点：定义 `inputSchema`（使用 `lazySchema()` 包装）、实现 `call()` 方法、实现 `checkPermissions()` 权限逻辑、实现 `renderToolUseMessage()` UI 渲染。
>
> 来源：`00-工具系统总览.md`

> **Q**: 工具执行失败时，系统如何向模型传递错误信息？
>
> **A**: A：有三种路径。第一，`validateInput()` 返回 `{ result: false, message: '...' }` 时，主循环将 `message` 格式化为 `tool_result` 块返回给模型，模型可据此调整输入重试；第二，`call()` 抛出异常时，框架捕获异常并调用 `renderToolUseErrorMessage()` 渲染错误 UI，同时构造包含错误信息的 `tool_result` 块；第三，工具返回 `{ data: ... }` 但结果表示失败（如 `exitCode: 1`），工具在 `mapToolResultToToolResultBlockParam()` 中将失败信息序列化，模型从结果内容中理解失败原因。
>
> 来源：`00-工具系统总览.md`

> **Q**: 如何在 Claude Code 中高效地在大型代码库中查找函数定义？
>
> **A**: A：推荐组合使用 GrepTool 和 FileReadTool。首先用 GrepTool 的 `files_with_matches` 模式定位含有函数名的文件（速度快、token 消耗少）；然后针对候选文件用 GrepTool 的 `content` 模式加 `-B`/`-A` 上下文参数获取函数前后代码；若需要完整函数体，用 FileReadTool 配合 `offset`/`limit` 读取特定行范围。避免一开始就用 FileReadTool 全量读取每个文件——GrepTool 的索引级别性能比逐文件读取快数百倍。
>
> 来源：`01-文件类工具-读取与搜索.md`

> **Q**: FileReadTool 对"局部读取"（带 offset/limit）的处理与完整读取有何不同？
>
> **A**: A：局部读取会在 `readFileState` 中设置 `{ isPartialView: true }`，这会导致 FileEditTool 在 `validateInput()` 阶段返回错误："文件尚未完整读取，请先完整读取再写入"（errorCode: 6）。这是一个重要的安全设计：部分读取意味着 AI 没有完整了解文件内容，若允许编辑可能造成上下文缺失导致的错误修改。若需要编辑文件，必须先进行无 `offset`/`limit` 的完整读取。
>
> 来源：`01-文件类工具-读取与搜索.md`

> **Q**: 在实际使用中，如何选择使用 FileWriteTool 还是 FileEditTool？
>
> **A**: A：选择依据：若修改面积超过文件的 60% 或需要新建文件，选 FileWriteTool；若修改是局部的（函数修改、变量重命名、代码块替换），选 FileEditTool。典型 FileEditTool 场景：修复一个函数中的 bug、修改配置文件中的某个值、在文件末尾追加代码（用 `old_string` 匹配文件最后几行）。典型 FileWriteTool 场景：生成新组件文件、重构后完全重写某个模块、根据模板生成配置文件。
>
> 来源：`02-文件类工具-写入与编辑.md`

> **Q**: 如果 FileEditTool 报错"File has been modified since read"，正确的处理流程是什么？
>
> **A**: A：这是脏写保护触发。正确流程：先调用 FileReadTool 重新读取该文件（获取最新内容），然后重新分析差异，构建新的 `old_string`/`new_string`，再次调用 FileEditTool。错误原因通常是：外部 linter（如 Prettier、ESLint）自动格式化了文件，或者多个并发的 Agent 工具在竞争写入同一文件。对于后者，应确保编辑同一文件的操作串行执行，避免并发冲突。
>
> 来源：`02-文件类工具-写入与编辑.md`

> **Q**: 如何使用 AgentTool 实现并行代码分析任务？
>
> **A**: A：对独立模块的分析任务，使用后台代理并行执行：同时调用多个 `AgentTool`（设 `run_in_background: true`），每个代理分析不同模块，主代理继续处理其他工作或等待通知。通知到达后，通过 `outputFile` 读取各代理的分析结果并汇总。关键点：各后台代理的 `description` 应简洁清晰（3-5 词），`prompt` 要明确分析范围和输出格式，避免各代理结果格式不统一导致汇总困难。若各分析涉及写入操作，使用 `isolation: 'worktree'` 避免文件冲突。
>
> 来源：`04-Agent任务类工具.md`

> **Q**: TaskCreate 和 TodoWriteTool 在实际使用中如何迁移？
>
> **A**: A：TodoWriteTool 使用全局 `todos` 数组（按 `sessionId` 或 `agentId` 分区），一次调用替换全部 todo 列表。TaskCreateTool 使用持久化的任务列表（`taskListId` 基于上下文），通过 CRUD 操作管理。迁移时：不再需要在每次更新时传递完整列表；可以通过 `TaskUpdate` 单独更新某个任务的状态而不影响其他任务；新增了任务间依赖表达能力。两个系统通过 `isTodoV2Enabled()` 特性标志互斥，系统内不会同时存在两个 todo 系统，迁移过程中用户体验无断层。
>
> 来源：`04-Agent任务类工具.md`

> **Q**: 如何在 Claude Code 中配置和使用自定义 MCP 服务器？
>
> **A**: A：在 Claude Code 配置文件（`~/.claude/settings.json` 或项目级 `.claude/settings.json`）中添加 MCP 服务器配置：`{ "mcpServers": { "my-server": { "command": "node", "args": ["path/to/server.js"] } } }`。Claude Code 启动时自动连接配置的 MCP 服务器，工具以 `mcp__my-server__tool-name` 形式出现在工具池中（延迟加载）。首次使用时，模型会自动调用 ToolSearchTool 激活所需工具。如果服务器需要认证，McpAuthTool 会引导完成 OAuth 流程。
>
> 来源：`05-MCP类工具.md`

> **Q**: 如何排查 MCP 工具调用失败的问题？
>
> **A**: A：诊断步骤：首先检查 MCP 服务器是否正常运行（Claude Code 启动日志中应有连接成功信息）；其次调用 `ListMcpResourcesTool` 验证服务器是否正确连接并暴露资源；再用 ToolSearchTool 的 `select:mcp__server__tool` 语法检查工具是否可发现；若工具可找到但调用失败，查看 stderr 中的 MCP 协议错误（通常是参数格式错误或服务器端业务逻辑错误）；若是认证问题，使用 McpAuthTool 重新完成认证流程。MCP 协议使用 JSON-RPC，错误响应有标准的 `code` 和 `message` 字段，便于定位问题根源。
>
> 来源：`05-MCP类工具.md`

> **Q**: 如何用 LSPTool 定位复杂 TypeScript 项目中某函数的所有调用者？
>
> **A**: A：标准流程：先用 GrepTool 在工作区中搜索函数名，找到一个定义位置（文件 + 行号）；然后调用 LSPTool 的 `prepare_call_hierarchy` 操作，传入文件路径和行列号，获取该符号的 `CallHierarchyItem`；再调用 `incoming_calls` 操作，传入上一步得到的 item，获取所有调用者列表；最后遍历调用者列表，若需要深层追踪，对每个调用者继续执行 `incoming_calls`，构建完整调用树。注意：LSP 分析需要项目已完成 TypeScript 初始化（`tsconfig.json` 存在），对大型项目可能需要等待 `waitForInitialization()` 超时。
>
> 来源：`06-搜索与信息类工具.md`

> **Q**: WebSearchTool 和 WebFetchTool 的协同使用模式是什么？
>
> **A**: A：两者互补：WebSearchTool 返回搜索结果列表（标题 + URL），不含内容摘要；WebFetchTool 抓取具体页面内容并提炼。典型协同工作流：先用 WebSearchTool 搜索"TypeScript 类型守卫最佳实践"，获取 5-10 个相关链接；从中选择最权威的 2-3 个（如官方文档、知名博客）；再用 WebFetchTool 分别抓取并提炼，prompt 指定"提取类型守卫语法示例和使用规则"；最后综合多源信息生成最终答案。这比直接用 WebFetchTool 盲目抓取更高效，也比只看标题列表更深入。
>
> 来源：`06-搜索与信息类工具.md`

> **Q**: 如何设计一个使用计划模式的完整工作流？
>
> **A**: A：最佳实践的双阶段工作流：第一阶段（探索与计划），AI 调用 EnterPlanModeTool 进入只读模式，使用 GrepTool/GlobTool/FileReadTool 深度理解代码库，调用 AskUserQuestionTool 确认关键设计决策（选择 A 方案还是 B 方案），综合信息生成详细实施计划，调用 ExitPlanModeTool 提交计划等待批准；第二阶段（执行），用户批准计划后，AI 在 `auto` 模式下逐步执行，使用 FileEditTool/FileWriteTool 实施变更，期间使用 BashTool 运行测试验证。若在执行过程中发现计划不可行，AI 可以再次调用 EnterPlanModeTool 回到计划模式修订方案。这种双阶段设计减少了"AI 一边修改一边犯错"的情况。
>
> 来源：`07-会话控制类工具.md`

> **Q**: EnterWorktreeTool 创建的 worktree 和主分支的代码如何合并？
>
> **A**: A：worktree 是 git worktree，内部是一个独立的 git 工作区（但共享同一个 `.git` 仓库）。AI 在 worktree 中的文件修改需要在 worktree 内 commit 才能保留（`BashTool` 执行 `git add && git commit`）。退出 worktree（`ExitWorktreeTool`）时，修改保留在 worktree 对应的分支上，不会自动合并到主分支。用户可以之后通过 `git merge` 或 `git rebase` 手动合并，或者 AI 在退出前就执行合并操作。`ExitWorktreeTool` 的 `call()` 会先通过 `hasWorktreeChanges()` 检查是否有未提交的修改，若有则在结果中警告用户，防止意外丢失工作。
>
> 来源：`07-会话控制类工具.md`

> **Q**: 如何使用 SkillTool 构建可复用的代码审查工作流？
>
> **A**: A：创建技能文件（如 `~/.claude/agents/code-review.md`）定义代码审查提示词：系统提示词描述审查标准和输出格式，必要时加 frontmatter 指定 `model: sonnet`（代码审查需要较强推理）。技能中可以引用其他工具（GrepTool 搜索问题模式、GlobTool 查找待审查文件等）。使用时，模型调用 `SkillTool({ skill: "code-review", args: "审查 src/auth/ 目录的安全性" })`，SkillTool 在独立代理中运行审查，返回结构化的审查报告。技能可以被不同项目、不同会话复用，形成组织级的标准化工作流。
>
> 来源：`08-其他专用工具.md`

> **Q**: 在自动化 CI/CD 场景中，SyntheticOutputTool 如何保证输出格式符合下游系统期望？
>
> **A**: A：在 headless 模式（`--output-format json` 等参数）下，调用者在启动 Claude Code 时通过系统提示词注入输出 schema 定义（JSON Schema 格式）。Claude Code 运行任务后，使用 `SyntheticOutputTool` 提交最终结果，AJV 验证结果是否满足 schema。若不满足（如缺少必填字段 `test_results`），工具返回详细错误，模型收到错误后重新生成符合 schema 的输出。这种方式确保了 CI/CD pipeline 的下游系统（如测试报告聚合器、部署决策器）能够可靠地解析 Claude Code 的输出，避免因输出格式不一致导致 pipeline 失败。
>
> 来源：`08-其他专用工具.md`

### 命令系统（03-命令系统/）

> **Q**: 如果我要添加一个新的内建命令，需要做哪些步骤？
>
> **A**: A：
> 1. 在 `src/commands/` 下创建新目录，编写 `index.ts`（命令元数据）和实现文件
> 2. 在 `src/commands.ts` 顶部 `import` 该命令
> 3. 将命令加入 `COMMANDS()` 函数的返回数组
> 4. 若是内部专用命令，同时加入 `INTERNAL_ONLY_COMMANDS` 数组
> 5. 若命令需要 Feature Flag 保护，使用 `feature()` + 条件 `require()` 模式
>
> 来源：`00-命令系统总览.md`

> **Q**: `clearCommandsCache()` 在什么场景下需要调用？应注意什么？
>
> **A**: A：需要调用的场景：安装/卸载插件后（`/reload-plugins`）；动态技能发现后；用户登录/登出后（改变 availability）。注意事项：该函数会清除 `loadAllCommands`、`getSkillToolCommands`、`getSlashCommandToolSkills` 的 memoize 缓存，以及插件和技能的专项缓存（`clearPluginCommandCache`/`clearSkillCaches`）；`clearSkillIndexCache` 需单独清除，因为技能搜索索引是建立在命令缓存之上的独立 memoize 层，不清除会导致"清了内层、外层仍返回旧结果"的陷阱。
>
> 来源：`00-命令系统总览.md`

> **Q**: 如何为团队定制 `/commit` 的提交信息格式？
>
> **A**: A：Claude Code 有多个扩展点：
> 1. `CLAUDE.md` 中声明提交信息规范，会被 AI 系统提示读取
> 2. 用 `/skills` 创建自定义技能覆盖 `/commit` 的行为
> 3. 通过 `attribution` 工具函数（`getAttributionTexts`）可在构建时注入归因文本
> 4. 在 `/commit` 末尾追加参数（如 `/commit use conventional commits format`）可一次性调整
>
> 来源：`01-git类命令.md`

> **Q**: `/branch` 创建的分支和 Git branch 有什么关系？
>
> **A**: A：没有直接关系。`/branch` 创建的是**会话分支（conversation branch）**，而非 Git 分支。它复制的是 Claude Code 的对话历史 transcript 文件，赋予新的 `sessionId`，通过 `forkedFrom` 追踪父子关系，存储在 `~/.claude/projects/<hash>/` 目录下。用户在会话分支中的操作（包括 Git 操作）仍然作用于同一个文件系统和 Git 仓库，只是对话上下文独立。若想同时创建 Git 分支，需要在分支会话中额外执行 `git checkout -b`。
>
> 来源：`01-git类命令.md`

> **Q**: Git Safety Protocol 中禁止的操作由谁来执行？是代码层强制还是 AI 自律？
>
> **A**: A：是 AI 自律（软约束），而非代码层强制。系统提示词将安全规则注入 LLM 上下文，使模型"理解并遵守"这些规则。但从技术上讲，`ALLOWED_TOOLS` 白名单提供了一层硬约束：即使 AI 生成了 `git push --force` 命令，Bash 工具也需要通过正则检查 `Bash(git push:*)` 是否在白名单中——而 `/commit` 命令的白名单不包含 `git push`，因此 force push 实际上无法执行。两层防护互补：提示词规则防止 AI"想要"执行危险操作；工具白名单在 AI"失控"时提供最后一道屏障。
>
> 来源：`01-git类命令.md`

> **Q**: `/autofix-pr` 是如何识别 CI 失败并生成修复方案的？
>
> **A**: A：`autofixPr` 是专为内部 ANT 构建管道设计的命令（`INTERNAL_ONLY_COMMANDS` 列表中）。其工作流程：1）读取 CI 系统传入的构建日志 URL 或错误文本（通过 `context.args` 注入）；2）将错误日志作为上下文注入提示词，请求 AI 分析失败原因；3）AI 生成修复 patch，通过 Bash 工具执行文件修改；4）调用 `git commit` 和 `git push` 将修复推送到同一 PR 分支。`ALLOWED_TOOLS` 包含比 `/commit` 更广的权限（允许读写文件），因为修复错误需要实际修改代码而非仅提交现有改动。
>
> 来源：`01-git类命令.md`

> **Q**: 为什么 `getDefaultBranch()` 在命令注册时就执行，而非等用户触发 `/commit-push-pr`？
>
> **A**: A：这是"预取（Prefetch）"优化。用户输入 `/commit-push-pr` 到 REPL 处理完命令注册之间有一定延迟，`getDefaultBranch()`（执行 `git symbolic-ref refs/remotes/origin/HEAD`）约需 50-100ms。在命令注册阶段异步预取并缓存结果，使 `getPromptForCommand()` 的同步路径无需等待 Git I/O，提升命令响应速度。代价是即使用户从未触发该命令，这次 Git 调用也已执行——但其成本可以忽略不计（本地 Git 读操作）。
>
> 来源：`01-git类命令.md`

> **Q**: 如何为团队定制 `/commit` 不追加 Co-Authored-By 行？
>
> **A**: A：有三个层次的控制：
> 1. **项目级**：在项目 `CLAUDE.md` 中写入 `Do not add Co-Authored-By attribution to commits`，AI 会遵守但非强制执行
> 2. **环境变量级**：设置 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`（或 ANT 内部的 `DISABLE_ATTRIBUTION=1`），`getAttributionTexts()` 返回空字符串，彻底禁用归因
> 3. **全局配置级**：在 `~/.claude/settings.json` 中设置 `"attribution": false`，通过 `getAppState` 传播到 `isAttributionDisabled()` 检查
>
> 方案 2 是最可靠的，因为它在代码层强制禁用，不依赖 AI 的提示词遵从性。
>
> 来源：`01-git类命令.md`

> **Q**: 如何利用 `/compact` 的自定义指令实现特定的摘要格式？
>
> **A**: A：`/compact [custom instructions]` 的参数直接传入 `compactConversation` 作为自定义摘要指令，例如：
> - `/compact Keep focus on the current bug and ignore UI discussions` — 专注于 bug 修复上下文
> - `/compact Summarize in Chinese, keep all code snippets` — 中文摘要但保留代码
> - `/compact Create a structured TODO list from the conversation` — 生成待办清单格式
> 注意：自定义指令会绕过 Session Memory 压缩路径（该路径不支持自定义指令），直接进入 LLM 摘要路径。
>
> 来源：`02-会话管理类命令.md`

> **Q**: `/rewind` 与 `/branch` 在会话管理上有何配合使用的场景？
>
> **A**: A：典型场景：
> 1. AI 走错了方向，用 `/rewind` 选择分叉点，回滚到正确的消息节点
> 2. 想同时探索多条解决路径，先用 `/branch` 创建分叉会话，在一条路走不通后 `/rewind` 回到分叉点再尝试另一路
> 3. `/rewind` 回滚后继续对话产生新历史，与原历史形成自然分叉（无需显式调用 `/branch`）
> 关键区别：`/rewind` 在当前会话内回滚（截断消息列表），`/branch` 创建独立的新会话副本，两者可以结合使用构成非线性的对话图。
>
> 来源：`02-会话管理类命令.md`

> **Q**: 如何在 CI/非交互环境中使用 `/context` 获取 token 使用情况？
>
> **A**: A：非交互模式下（`--print` 或环境检测为非 TTY），`contextNonInteractive` 命令自动激活（`supportsNonInteractive: true`）。可以通过：
> ```bash
> claude --print "/context"
> ```
> 获取纯文本格式的上下文使用报告，包含各分区（system prompt/messages/tools）的 token 数和百分比。也可通过 SDK API 的 `get_context_usage` 控制请求获取结构化数据（与 `collectContextData` 共用数据层）。
>
> 来源：`03-上下文类命令.md`

> **Q**: `/add-dir` 与直接修改 `CLAUDE.md` 中的目录配置有何区别？
>
> **A**: A：两者都能扩展 Claude 的工作目录访问权限，但有本质区别：
> - `/add-dir` 是运行时操作，立即生效，无需重启；支持 `session`（临时）和 `localSettings`（持久）两种粒度
> - 修改 `CLAUDE.md` 是静态配置，会话启动时加载，需要重启或 `/reload` 才生效
> - `/add-dir` 通过 `applyPermissionUpdate` 操作 `toolPermissionContext`，属于权限控制体系；`CLAUDE.md` 是指令文档，由 AI 解析
> - 沙箱模式下，`/add-dir` 会通过 `SandboxManager` 验证路径合法性，`CLAUDE.md` 修改则没有这层保障
>
> 来源：`03-上下文类命令.md`

> **Q**: 如何利用 `/advisor` 实现"双模型协作"提升代码质量？
>
> **A**: A：典型配置：`/advisor claude-opus-4-5`（或更高级模型作为 advisor）+ 主模型使用 Sonnet。Advisor 模型在后台监督主模型的输出，可以提供代码审查、安全检查、逻辑验证等元层面的反馈。使用场景：
> - 处理复杂架构决策时，Advisor 提供深度推理验证
> - 执行安全敏感操作时，Advisor 作为第二双眼睛
> - 需要更高代码质量但不想全程用 Opus 增加成本时（Sonnet 生成 + Opus 审查）
> 通过 `/advisor unset` 或 `/advisor off` 可随时关闭。
>
> 来源：`04-AI辅助类命令.md`

> **Q**: 在团队部署中，如何通过环境变量统一管理 effort 策略？
>
> **A**: A：在企业/团队部署中，可以通过以下方式：
> 1. 设置 `CLAUDE_CODE_EFFORT_LEVEL=medium` 作为团队默认值（通过 `.envrc` 或 CI 配置）
> 2. 个别工程师可以在 `~/.claude/settings.json` 中设置 `effortLevel: 'high'`，但环境变量会覆盖
> 3. 若需要允许用户覆盖团队策略，则不设置环境变量，仅通过 `CLAUDE.md` 的 guidance 建议合适的 effort 级别
> 4. `/effort` 命令在输出时会明确提示环境变量覆盖情况，团队成员不会困惑于为何自己的设置不生效
>
> 来源：`04-AI辅助类命令.md`

> **Q**: 如何通过 `/doctor` 排查 Claude Code 安装问题？
>
> **A**: A：`/doctor` 提供系统化的检查清单：
> 1. **git 检查**：确认 `git --version` 可用，是否在 PATH 中
> 2. **gh CLI 检查**：`gh auth status` 确认 GitHub CLI 已认证（影响 PR 创建功能）
> 3. **Node/Bun 版本检查**：确认运行时版本满足最低要求
> 4. **配置文件检查**：验证 `~/.claude/settings.json` 格式正确（JSON 解析无误）
> 5. **权限检查**：确认项目目录读写权限正常
> 若某项失败，`/doctor` 通常会提供具体修复命令，如 `brew install gh`、`gh auth login` 等。
>
> 来源：`05-配置类命令.md`

> **Q**: 如何通过 `/keybindings` 自定义快捷键，有哪些常见配置？
>
> **A**: A：执行 `/keybindings` 打开配置文件后，可以覆盖默认键绑定。配置文件是 JSON 格式的键绑定映射：
> - 重新绑定"接受 AI 建议"：默认 Tab 键，可改为 Ctrl+Space
> - 重新绑定"取消当前操作"：默认 Ctrl+C，某些用户偏好 Escape
> - 自定义"提交并推送"的快捷键
> - 禁用某些默认绑定（设置为 null）
> 修改后无需重启，Claude Code 会监听文件变化（或在下次操作时重新加载配置）。功能目前处于预览阶段，可通过 `CLAUDE_CODE_ENABLE_KEYBINDINGS=1` 环境变量或 GrowthBook 灰度激活。
>
> 来源：`05-配置类命令.md`

> **Q**: 在长时间开发会话中，如何有效利用 `/cost` 监控 API 花费？
>
> **A**: A：实用策略：
> 1. 在重要节点（开始新任务前后）执行 `/cost`，记录阶段性花费
> 2. 使用 `/compact` 后立即查看 `/cost`，验证压缩带来的 token 节省
> 3. 在启动大型操作（如全项目重构）前查看当前累计成本，评估预算
> 4. 结合 `/effort low` 降低非关键任务的 token 消耗
> 注意：`/cost` 显示的是当前会话内的成本，`/clear` 后重置为 0，可用于按任务区段追踪成本。
>
> 来源：`06-调试诊断类命令.md`

> **Q**: 当遇到 Claude Code 性能问题时，调试诊断命令的排查顺序是什么？
>
> **A**: A：建议的排查流程：
> 1. `/doctor` — 检查基础环境（工具版本、网络连通性、权限）
> 2. `/cost` — 确认是否超额使用导致限流
> 3. `/context` — 检查上下文窗口是否接近上限（影响响应速度和质量）
> 4. `/usage` — 查看是否触达计划限额（可能触发请求排队）
> 5. 若为内部用户，`ant-trace` 可提供详细的链路追踪信息定位瓶颈
> 6. `/perf-issue` — 提交性能问题报告（内部用户），包含自动采集的系统指标
>
> 来源：`06-调试诊断类命令.md`

> **Q**: 如何利用 `/remote-control` 从手机继续电脑上的开发会话？
>
> **A**: A：操作流程：
> 1. 在电脑终端执行 `/remote-control`（或 `/rc`）
> 2. Claude Code 生成会话 URL 和 QR 码（需要 `BRIDGE_MODE` Feature Flag 启用）
> 3. 用手机扫描 QR 码，在 claude.ai 的 Web 界面接入（需登录同一账号）
> 4. 手机界面可以发送消息、触发 `BRIDGE_SAFE_COMMANDS` 中的命令
> 5. 电脑终端同步显示操作结果（双向通信）
> 适用场景：在电脑上开始了一个需要长时间运行的任务，离开电脑后想通过手机查看进度或发送简单指令。
>
> 来源：`07-发布与集成类命令.md`

> **Q**: 如果 Chrome 扩展连接异常（已安装但 MCP 客户端状态不是 connected），如何排查？
>
> **A**: A：`/chrome` 菜单提供的"Reconnect"选项会打开 `https://clau.de/chrome/reconnect` 引导页，通常步骤：
> 1. 确认 Chrome 扩展未被浏览器禁用（`chrome://extensions/` 检查）
> 2. 执行"Reconnect"，按提示重新授权扩展与 Claude Code CLI 的连接
> 3. 若 MCP 服务器日志显示连接拒绝，检查扩展的权限设置（`/chrome` → "Manage Permissions"）
> 4. 检查 `~/.claude/settings.json` 中的 MCP 服务器配置是否包含 `CLAUDE_IN_CHROME_MCP_SERVER_NAME`
> 5. 必要时卸载并重新安装扩展，重新执行连接流程
>
> 来源：`07-发布与集成类命令.md`

> **Q**: 如何在复杂项目中高效利用 `/btw` 和 `/plan` 的组合？
>
> **A**: A：典型场景：
> 1. AI 正在执行大型重构任务时，用 `/btw "this approach looks risky, what are the alternatives?"` 在不中断任务的情况下咨询意见
> 2. 在启动复杂任务前用 `/plan` 让 AI 先展示执行计划，仔细审查后再确认执行
> 3. 计划执行中遇到疑问时用 `/btw` 快速查阅相关知识，不打断计划进度
> 4. `/plan` 确认后 AI 开始执行，用 `/btw` 实时跟踪某个子任务的进展
> 关键是 `/btw` 的"零痕迹"特性——它的提问不会影响 AI 对主任务的理解，可以频繁使用而不产生上下文污染。
>
> 来源：`08-其他命令.md`

> **Q**: 插件和 MCP 服务器的选择标准是什么？什么时候用插件，什么时候用 MCP？
>
> **A**: A：选择标准：
> - **MCP 服务器**：适合需要访问外部服务或数据库的工具（Slack、GitHub、数据库查询）；需要实时数据；多个 AI 工具/应用之间共享（MCP 是开放协议）；需要跨平台复用
> - **Claude Code 插件**：适合 Claude Code 专有功能扩展（新的斜杠命令、工作流脚本）；团队内部工作流标准化；与 Claude Code 特有功能深度集成（钩子、技能、命令系统）
> 简单判断：如果功能需要在多个 AI 工具中使用，选 MCP；如果功能只为 Claude Code CLI 设计，选插件。通过 `/mcp` 和 `/plugin` 可以动态管理两者，`/reload-plugins` 可热重载不需重启。
>
> 来源：`08-其他命令.md`

### Agent 协调（04-Agent协调/）

> **Q**: 如果要为协调器添加"预算控制"功能（限制所有工作者的总 token 用量），你会在哪里接入？
>
> **A**: A：最自然的接入点是 `getCoordinatorUserContext()`——在返回的 `workerToolsContext` 字符串中追加预算说明，告知模型当前剩余预算；同时在 `QueryEngine` 层面通过 `taskBudget` 参数传递给每个子 Agent 的 `query()` 调用。`coordinatorMode.ts` 不直接管理运行时状态，预算计数器应放在 `AppState` 中，由 `setAppState` 在每个工作者完成时更新。
>
> 来源：`01-coordinator.md`

> **Q**: 用户反馈"/resume 后协调器模式丢失"，如何排查？
>
> **A**: A：排查路径如下：1）确认会话存档中 `sessionMode` 字段是否为 `'coordinator'`（存档可能来自旧版本，缺少该字段）；2）检查 `matchSessionMode()` 是否被调用（QueryEngine 启动时应调用）；3）确认 `process.env.CLAUDE_CODE_COORDINATOR_MODE` 在 `matchSessionMode()` 返回后的值；4）检查是否有其他代码在之后清除了该环境变量。若 `sessionMode` 为 `undefined`（旧格式），`matchSessionMode()` 提前返回 `undefined`，模式不会被恢复，这是最常见原因。
>
> 来源：`01-coordinator.md`

> **Q**: `getCoordinatorSystemPrompt()` 中的并发策略规则对 LLM 有约束力吗？如果 LLM 违反了怎么办？
>
> **A**: A：系统提示词对 LLM 是"软约束"——语言模型无法被强制执行规则，只能通过提示词引导行为。若 LLM 违反并发规则（如将写密集任务并行分配到同一文件），`QueryLoop` 层面没有锁机制防止两个工作者同时写入同一文件，可能导致竞态条件（后完成的工作者覆盖前者的修改）。实践中的缓解手段：1）Bash 工具的文件写操作是原子 IO，最小粒度不会出现字节级交错；2）工作者任务描述中要求明确的文件所有权边界；3）协调器系统提示词强调"验证并发"而非"写并发"，降低冲突概率。根本解决需要在 `AgentTool` 层引入文件级别的分布式锁，但当前实现未包含此机制。
>
> 来源：`01-coordinator.md`

> **Q**: 协调器模式下，scratchpad（临时文件目录）的作用是什么？为何需要 Feature Gate？
>
> **A**: A：Scratchpad 是工作者之间共享中间结果的机制：工作者可以将分析报告、部分代码片段写入 scratchpad 目录，协调器（或其他工作者）通过读取该目录来聚合信息。`getCoordinatorUserContext()` 在 scratchpad 启用时，向 LLM 注入目录路径说明，使 LLM 能够在提示词中指示工作者"将结果写入 `$SCRATCHPAD/analysis.md`"。Feature Gate（`tengu_scratch`）的存在是因为 scratchpad 引入了工作者间的隐式依赖——若工作者 A 在工作者 B 开始前未完成写入，B 读到的数据可能不完整。该功能尚在 Statsig 灰度验证阶段，Gate 允许逐步扩量并在发现问题时快速回滚，而无需发布新版本。
>
> ### 权衡与优化题（补充）
>
> 来源：`01-coordinator.md`

> **Q**: 若协调器需要管理 100 个并发工作者，当前架构的瓶颈在哪里？
>
> **A**: A：当前架构存在三个主要瓶颈：
> 1. **LLM 单次输出的工具调用上限**：Anthropic API 对单次响应中 `tool_use` 块的数量有隐性限制（约 20-50 个），超出则需要多轮协调循环，失去真正的并发优势。
> 2. **进程资源消耗**：每个工作者运行独立的 `QueryLoop`，持有独立的 API 连接、消息历史缓冲区和 Node.js 事件循环。100 个工作者并行时，内存和文件描述符消耗显著。
> 3. **task-notification 消息合并**：100 个工作者的通知全部堆积在主协调器的下一轮 `tool_result` 中，单次 `messages` 追加的 token 数激增，可能触发上下文溢出。
> 优化方向：引入"工作者池"上限（通过系统提示词约束或 `AgentTool` 并发限制），以及分层协调结构（子协调器管理子工作者组）。
>
> 来源：`01-coordinator.md`

> **Q**: `isCoordinatorMode()` 每次调用都读取 `process.env`，在高频调用场景下会有性能影响吗？
>
> **A**: A：`process.env` 的读取在 Node.js/Bun 中是同步的原生调用，单次耗时约 0.01-0.1 微秒，远低于任何 I/O 操作。`isCoordinatorMode()` 在 `QueryLoop` 每次迭代时调用（约每秒数次），累计开销可以忽略不计。相比使用模块级缓存变量，不缓存的设计避免了"缓存失效"问题（`matchSessionMode()` 可能在任何时刻修改 `process.env`），换来的是代码简单性。若未来出现性能问题，可在 `matchSessionMode()` 调用处加入版本号，`isCoordinatorMode()` 只有在版本号变化时才读取环境变量。
>
> 来源：`01-coordinator.md`

> **Q**: 调试时发现协调器收到了两条相同任务的完成通知，如何排查原因？
>
> **A**: A：根源通常是 `notified` 标志的原子性问题。排查步骤：1）确认 `enqueueAgentNotification()` 中的 `updateTaskState` 原子检查是否正常工作（检查 `shouldEnqueue` 是否正确设为 `false`）；2）确认 `killAsyncAgent()` 和工作者自然完成路径是否存在竞争——两者都会触发通知构建；3）检查 `AbortController.abort()` 是否被调用两次，导致工作者的 catch 块和正常结束路径都尝试推送通知。核心原则：`notified` 标志必须在 `setAppState` 的不可变更新函数内原子设置，不能在外部先读后写。
>
> 来源：`02-tasks.md`

> **Q**: 如果要为 `local_agent` 任务添加"暂停/继续"功能（与"停止"不同），最小化改动方案是什么？
>
> **A**: A：最小改动：1）在 `LocalAgentTaskState` 增加 `status: 'paused'` 状态和 `pausedAt: number` 字段；2）添加 `pauseAsyncAgent()` 函数，向 `AbortController` 发送特定 `reason: 'pause'` 信号（而非默认的中断信号），保存工作者的 `messages` 快照；3）修改 `killAsyncAgent()` 中的 `if (task.status !== 'running')` 守卫，允许对 `paused` 任务调用 `kill()`；4）添加 `resumeAsyncAgent()` 函数，用保存的消息快照重新启动 `query()` 循环。关键挑战是 `query()` 的 `AsyncGenerator` 无法真正"暂停"，必须通过保存消息快照来模拟断点续传。
>
> 来源：`02-tasks.md`

> **Q**: 用户报告某个工具每次执行都返回超大文本，导致上下文快速耗尽，应如何解决？
>
> **A**: A：有两个层次的解决方案：1）**工具层面**：在工具实现中设置 `maxResultSizeChars` 属性（`applyToolResultBudget` 会对有此属性的工具执行截断）；2）**系统层面**：`applyToolResultBudget()` 在每轮循环开始时截断工具结果，但默认只对没有 `maxResultSizeChars` 限制的工具的结果做预算分配。若工具确实需要返回大量数据，应让工具将结果写入文件并返回路径，而非直接嵌入消息内容——这是提示词中明确建议的模式（"use disk output"）。
>
> 来源：`03-query.md`

> **Q**: 如何为 `queryLoop` 中的某个特定压缩路径添加指标监控？
>
> **A**: A：最小侵入方案：在 `deps` 对象中添加可选的 `onTransition?: (transition: Continue) => void` 回调，在每个 `continue` 站点调用 `deps.onTransition?.(next.transition)`。生产的 `productionDeps()` 可注入统计上报回调（如 `logEvent('tengu_query_transition', {...})`），测试中则注入收集 transition 历史的函数。`transition` 字段已经携带了精确的恢复路径类型，无需额外解析消息内容。这种设计保持了 `queryLoop` 对监控系统的无知（zero knowledge），符合依赖反转原则。
>
> 来源：`03-query.md`

> **Q**: 如何使用 Coordinator 模式正确实现一个并行代码审查任务？给出关键设计决策。
>
> **A**: A：关键在于遵循"永远不要委派理解"原则。设计流程：1）**Research 阶段**：并行派发只读 Agent 分别读取各模块的代码，每个 Agent 输出结构化分析报告（安全问题、性能问题、可维护性问题各一份）；2）**Synthesis 阶段**：Coordinator 自身分析所有报告，制定修复优先级列表和每个问题的精确定位（文件路径 + 行号 + 具体原因）；3）**Implementation 阶段**：为每个问题分别派发独立的 Worker，每个 Worker 的 prompt 必须包含：目标文件路径、具体行号、问题的完整描述、期望的修复方式。**绝不能**写"根据报告修复安全问题"。4）**Verification 阶段**：派发 verification Agent 对每个修复进行独立验证，不能由做修复的 Worker 自我验证。此外，同一文件的多个修复必须串行派发（避免并发写入冲突），不同文件的修复可以并行。
>
> 来源：`05-多Agent协作与Swarm.md`

> **Q**: 一个用户反馈"Swarm 任务中某个 Teammate 卡住不响应，但其他 Teammate 仍在正常工作"，如何诊断和恢复？
>
> **A**: A：诊断路径：1）检查 `AppState.tasks` 中该 Teammate 的状态（`isActive()` 是否为 true，最近工具调用时间戳是否更新）；2）检查该 Teammate 的邮箱目录（`~/.claude/teams/<team>/mailbox/<name>/inbox/`），看是否有积压的未处理消息（可能是消息处理逻辑崩溃但进程仍存活）；3）查看 Teammate 的消息日志，确认最后一次工具调用是什么（若是阻塞式 bash 命令则可能是命令本身卡住）。恢复选项：若 Teammate 可以 `cancelCurrentRound()`（取消当前轮次，保留 Teammate），则尝试发送新消息重置任务；若彻底无响应，调用 `kill()` 强制终止后由 leader 派发新 Teammate 接手剩余工作。根本修复：在 Bash 工具调用中设置合理的超时（`timeout` 参数），防止长时间阻塞。
>
> 来源：`05-多Agent协作与Swarm.md`

> **Q**: 如果你要实现一个类似 fork 的多 Agent 并行机制，核心挑战是什么？
>
> **A**: A：核心挑战有三个，难度依次递进：
>
> **第一，共享前缀的边界如何确定**：Fork 机制中，前缀边界是"父 Agent 最后一条 assistant message 的末尾"。但这个边界取决于父 Agent 的执行状态，不是静态可配置的。实现时需要在父 Agent 决定"发起 fork"的时刻快照当前消息历史，并确保这个快照在并行子任务全部完成之前不被修改（immutable snapshot 语义）。
>
> **第二，占位 tool_result 的内容设计**：占位内容必须满足两个相互约束的条件：（a）语法合法，使 API 接受该消息结构；（b）语义中性，不让 LLM 产生错误的前提假设。设计一个对各种任务类型都"中性"的占位文本比想象中困难，尤其是当 tool_use 的内容是代码执行结果时（LLM 可能根据占位内容推断"代码已成功执行"）。
>
> **第三，继承 system prompt 的干扰**：子 Agent 继承父 Agent 的 system prompt 是缓存优化的必要条件，但同时带来了行为控制问题。父 Agent 的 system prompt 可能包含特定于父 Agent 角色的指导（如"你是代码审查专家"），子 Agent 继承后可能错误地以该角色行事而非执行分配的具体任务。解决这一问题需要在指令格式上做细致的工程设计（类似 `fork.ts` 的"STOP. READ THIS FIRST."策略）。
>
> 来源：`06-Fork与提示词缓存优化.md`

> **Q**: 如何用 prompt cache 感知的设计降低自己项目的 API 成本？
>
> **A**: A：在自己的项目中应用 prompt cache 感知设计，核心是识别并稳定"高频请求中的共享前缀"：
>
> **识别共享前缀**：分析你的 API 调用，找出所有请求中"内容几乎不变的部分"（system prompt、工具定义、固定上下文文档），将它们集中到消息数组的最前面，并确保它们在不同请求间字节完全一致（避免动态时间戳、随机 ID 等）。
>
> **使用 `cache_control` 标记**：在 Anthropic API 中，对共享前缀的最后一条消息（或 system prompt 的最后一个静态段）添加 `cache_control: {type: "ephemeral"}` 标记，告知服务端在此处建立缓存断点。未标记的内容不会被缓存，即使内容相同。
>
> **动态内容后置**：任何随请求变化的内容（用户输入、会话 ID、当前时间）放到消息数组末尾，确保差异点尽量靠后，前缀命中范围最大化。
>
> **监控缓存命中率**：API 响应的 `usage` 字段包含 `cache_read_input_tokens` 和 `cache_creation_input_tokens`。持续监控这两个指标，若 `cache_read` 占比持续低于 50%，说明前缀稳定性不足，需要重新审查消息构建逻辑。
>
> 来源：`06-Fork与提示词缓存优化.md`

### 扩展系统（05-扩展系统/）

> **Q**: 如何添加一个新的内置插件？
>
> **A**: 按照 `src/plugins/bundled/index.ts` 的注释，步骤为：
> 1. 在 `src/plugins/bundled/` 中创建插件模块文件（如 `myPlugin.ts`）
> 2. 在文件中调用 `registerBuiltinPlugin({ name: 'my-plugin', description: '...', skills: [...] })`
> 3. 在 `initBuiltinPlugins()` 中导入并调用注册函数
> 4. 如需条件可用，实现 `isAvailable()` 回调
>
> 来源：`01-plugins.md`

> **Q**: 如何为插件实现"企业策略禁止"逻辑？
>
> **A**: `PluginError` 中已预定义 `marketplace-blocked-by-policy` 类型，包含 `blockedByBlocklist`（是否在黑名单中）和 `allowedSources`（允许的来源列表）字段。在加载器层面，检测企业策略配置后返回此错误即可；UI 层通过 `getPluginErrorMessage()` 将其格式化为用户友好的说明。
>
> 来源：`01-plugins.md`

> **Q**: 如何编写一个带参考文件的内置技能？
>
> **A**: ```typescript
> registerBundledSkill({
>   name: 'my-skill',
>   description: '我的技能',
>   files: {
>     'guide.md': '# 操作指南\n...',         // 相对路径 → 内容
>     'examples/sample.ts': 'const x = 1',
>   },
>   async getPromptForCommand(args) {
>     // 框架自动在此 prompt 前追加：
>     // "Base directory for this skill: ~/.claude/bundled-skills/my-skill"
>     return [{ type: 'text', text: `请参考 guide.md 完成：${args}` }]
>   },
> })
> ```
>
> 首次调用时，`guide.md` 和 `examples/sample.ts` 会被安全提取到磁盘，模型可以用 `Read` 工具读取。
>
> 来源：`02-skills.md`

> **Q**: 如何为技能实现基于上下文的动态提示词？
>
> **A**: `getPromptForCommand` 的第二个参数 `context: ToolUseContext` 包含当前会话的完整消息历史（`context.messages`）。以 `skillify` 为例，它通过 `getMessagesAfterCompactBoundary(context.messages)` 提取会话中的用户消息，将其作为"会话记录"注入提示词，让技能能够基于实际发生的对话内容生成定制化输出。
>
> 来源：`02-skills.md`

> **Q**: 用户想将 `ctrl+enter` 设为换行（newline）而非提交，应如何编写 `keybindings.json`？
>
> **A**: ```json
> {
>   "$schema": "...",
>   "bindings": [
>     {
>       "context": "Chat",
>       "bindings": {
>         "enter": "chat:submit",
>         "ctrl+enter": "chat:newline"
>       }
>     }
>   ]
> }
> ```
> 注意：`enter` 的原有绑定（`chat:submit`）可以保留，也可以通过 `"enter": null` 解绑，将提交改为其他按键。
>
> 来源：`03-keybindings.md`

> **Q**: 如何为新的 UI 组件添加专属的键位绑定上下文？
>
> **A**: 1. 在 `src/keybindings/schema.ts` 的 `KEYBINDING_CONTEXTS` 数组中添加新上下文名称（如 `'MyDialog'`）
> 2. 在 `KEYBINDING_CONTEXT_DESCRIPTIONS` 中添加描述文字
> 3. 在 `defaultBindings.ts` 中添加该上下文的默认绑定块
> 4. 在 `validate.ts` 的 `VALID_CONTEXTS` 数组中同步添加
> 5. 在组件中调用 `keybindingContext.registerActiveContext('MyDialog')` 注册为活跃上下文
> 6. 使用 `useKeybinding('action:name', handler, { context: 'MyDialog' })` 注册处理器
>
> 来源：`03-keybindings.md`

### 服务与基础（06-服务与基础/）

> **Q**: 如何为新增的第三方云提供器（如 IBM）扩展 `getAnthropicClient`？
>
> **A**: > 参照现有 Bedrock/Vertex 模式：1) 添加环境变量 `CLAUDE_CODE_USE_IBM`；2) 在 `client.ts` 新增 `if (isEnvTruthy(process.env.CLAUDE_CODE_USE_IBM))` 分支；3) 动态 import 对应 SDK；4) 在 `isBedrockAuthError`/`isVertexAuthError` 类似位置添加 `isIBMAuthError`；5) 在 `src/utils/model/providers.ts` 注册新提供器名称。关键约束：返回类型必须 cast 为 `Anthropic` 以维持统一接口。
>
> 来源：`01-services-api.md`

> **Q**: 如何复现和调试「连续 529 触发模型降级」这个行为？
>
> **A**: > 对于 `ant` 用户，可使用 `/mock-limits` 命令配合 `MOCK_RATE_LIMIT_ERROR` 环境变量注入模拟错误（`checkMockRateLimitError` 在重试循环开始处被调用）。设置 `FALLBACK_FOR_ALL_PRIMARY_MODELS=1` 可让任意模型（而非仅 Opus）触发降级逻辑。观察 `tengu_api_opus_fallback_triggered` 分析事件确认降级发生。
>
> 来源：`01-services-api.md`

> **Q**: SSE 流式响应在中途发生网络断开时，`messages` 数组是否会产生"残缺"的工具调用记录？
>
> **A**: A：这是一个实际存在的边界情况。当 SSE 流在 `content_block_delta`（工具输入分片）阶段断开时，`toolInputAccumulator` 中的分片不完整，无法解析为有效 JSON。`withRetry` 重试时，`QueryLoop` 不会将这个残缺的 `tool_use` 块追加到 `messages`——因为流未到达 `content_block_stop` 事件，工具调用从未被确认为"完整输出"。QueryLoop 的设计原则是：只有完整接收到 `message_stop` 或 `error` 事件，才会将本轮 `assistant` 消息追加到 `messages`。中途断开的情况会丢弃当前响应，从上一条完整的 `user` 消息重新发起请求。
>
> 来源：`01-services-api.md`

> **Q**: `configureApiKeyHeaders` 从多个来源读取 API Key，如何处理多来源冲突？
>
> **A**: A：优先级从高到低：
> 1. `process.env.ANTHROPIC_API_KEY`（环境变量，最高优先级）
> 2. 函数参数传入的 `apiKey`（编程式调用）
> 3. `~/.anthropic/credentials` INI 文件（工具链兼容格式）
> 4. `~/.claude/credentials` 文件（Claude Code 专用格式）
>
> 高优先级来源有值时，低优先级来源被忽略。实践中，大多数用户通过环境变量配置，credentials 文件主要用于多账号切换（通过 `AWS_PROFILE` 风格的 `[profile]` 区分）。注意：当 OAuth token 存在（Claude.ai 订阅用户）时，`configureApiKeyHeaders` 不会被调用，两套鉴权体系完全互斥。
>
> 来源：`01-services-api.md`

> **Q**: `x-client-request-id` 请求头在实际故障排查中如何使用？
>
> **A**: A：`x-client-request-id` 是每次 HTTP 请求的唯一 UUID，由 `buildFetch` 注入。它的作用是关联客户端视角的请求（Claude Code 日志）与服务端视角的请求（Anthropic 后端日志）。当用户报告"请求卡住/超时但没有错误消息"时，技术支持可以通过以下步骤排查：
> 1. 用户在 `CLAUDE_CODE_DEBUG=1` 模式下复现问题，日志中记录每个请求的 `x-client-request-id`
> 2. 将该 UUID 提供给 Anthropic 支持团队，在服务端日志中查询对应请求的处理状态
> 3. 确认请求是否到达服务器、在哪个处理阶段失败（鉴权、路由、模型推理、响应编码等）
>
> 这是分布式系统中"trace ID"模式的简化实现，专门解决"客户端超时但不知道服务端发生了什么"的黑盒问题。
>
> 来源：`01-services-api.md`

> **Q**: 指数退避中的 25% 随机抖动是否足够防止多客户端同步重试（"雷鸣群效应"）？
>
> **A**: A：25% 抖动在大多数场景下足够，但在极端场景（数千个 Claude Code 实例同时遭遇 429）下可能不够。完整的雷鸣群防御需要：
> 1. **全随机抖动（Full Jitter）**：`delay = random(0, baseDelay)`，分散效果最好但平均延迟最高
> 2. **等比随机抖动（Equal Jitter）**：`delay = baseDelay/2 + random(0, baseDelay/2)`，当前实现接近此模式
> 3. **令牌桶/漏桶**：在客户端实现速率限制，主动控制请求频率
>
> Claude Code 的 25% 抖动是在"用户等待时间"和"分散效果"之间的工程权衡。对于单用户工具（每次只有 1-2 个并发请求），当前实现已足够；企业规模部署（Bedrock/Vertex）需考虑在网关层添加速率控制。
>
> 来源：`01-services-api.md`

> **Q**: 如果需要新增一个「用户反馈」事件类型，需要修改哪些文件？
>
> **A**: > 1. 在 `analytics/index.ts` 的 `logEvent` 文档中无需修改（接口已通用）；2. 若需要 PII 字段（如用户标识），在 metadata key 加 `_PROTO_` 前缀；3. 若是新事件上报到 Datadog 的自定义指标，需在 `analytics/sink.ts` 的 Datadog 路由规则中增加事件名映射；4. 若需在 BigQuery 有专用列，需要修改 1P exporter 的 schema 映射（`firstPartyEventLoggingExporter`）。应用侧调用只需：`logEvent('user_feedback_submitted', { rating: 5 })`。
>
> 来源：`02-services-others.md`

> **Q**: 如何验证诊断追踪服务在特定 IDE 版本下是否正常工作？
>
> **A**: > 1. 开启 `--debug` 模式，检查 `DiagnosticsTrackingError` 日志（路径不匹配时触发）；2. 观察 `beforeFileEdited` 是否在工具调用前被触发（可在工具执行日志中搜索 `getDiagnostics`）；3. 若 IDE 不支持 `getDiagnostics` RPC，服务会在 `catch` 中静默忽略，无错误输出——可通过检查 `diagnosticTracker.initialized` 属性确认初始化状态；4. 利用 `DiagnosticTrackingService.formatDiagnosticsSummary` 格式化输出验证诊断内容正确性。
>
> 来源：`02-services-others.md`

> **Q**: 如何为 Claude Code 新增「获取 git log 最近 10 条提交」的工具函数？
>
> **A**: > 参照 `gitDiff.ts` 的模式：1) 调用 `getIsGit()` 确认在仓库内；2) 使用 `execFileNoThrow(gitExe(), ['log', '--oneline', '-10'], { timeout: GIT_TIMEOUT_MS })` 执行命令；3) 检查返回码（非 0 时返回 null）；4) 解析 stdout 为 `{ hash: string, message: string }[]`；5) 若需要跨调用缓存，用 `memoize`（会话级）或 `memoizeWithLRU`（多路径）包装。注意使用 `--no-optional-locks` 参数。
>
> 来源：`03-utils-git.md`

> **Q**: 如果用户的 git 版本较旧不支持某个命令参数，如何保证 Claude Code 的健壮性？
>
> **A**: > 参照已有模式：`execFileNoThrow` 返回 `{ stdout, stderr, code }`，`code !== 0` 时返回 null/空值而不抛出异常；调用方在 `if (code !== 0) return null` 后优雅降级。此外 `gitExe()` 用 `memoize` 缓存 `which('git')` 的结果，若 git 不在 PATH 中返回 fallback 字符串 `'git'`，子进程启动失败时 `execFileNoThrow` 也同样不抛出。整个 git 工具层均遵循「失败返回空」的设计契约。
>
> 来源：`03-utils-git.md`

> **Q**: 如何为企业 SSO 添加新的认证来源？
>
> **A**: > 参照现有模式：1) 在 `getAuthTokenSource` 的优先级链中添加新来源检查（如 `process.env.ENTERPRISE_SSO_TOKEN`）；2) 在 `ApiKeySource` 类型联合中添加新值；3) 在 `getAnthropicClient` 中的 `configureApiKeyHeaders` 路径中处理新 token 格式（设置 `Authorization: Bearer <token>`）；4) 在 `withRetry` 的 `shouldRetry` 中考虑 SSO token 过期时的重试行为（类比 OAuth 的 401 处理）；5) 如果 SSO token 有过期时间，参照 `checkAndRefreshOAuthTokenIfNeeded` 实现刷新逻辑并配合 lockfile 防并发。
>
> 来源：`04-utils-model-auth.md`

> **Q**: 调试「为什么 Claude Code 没有使用我配置的 API key」的步骤是什么？
>
> **A**: > 1. 开启 `--debug` 模式，检查 `[API:auth]` 前缀的调试日志；2. 调用 `getAuthTokenSource()` 返回值（在调试模式下会记录）来确认认证来源；3. 检查是否处于 `isManagedOAuthContext()` 状态（远程/桌面启动），该状态会屏蔽本地 key；4. 确认 `isAnthropicAuthEnabled()` 是否为 false（存在外部 API key 且非 managed 上下文会阻止 OAuth，但不影响 API key 读取）；5. 检查 `ANTHROPIC_API_KEY` 环境变量是否被 `settings.json` 中的 `env.ANTHROPIC_API_KEY` 覆盖（后者通过 `applyConfigEnvironmentVariables` 在 settings 加载时写入 `process.env`）。
>
> 来源：`04-utils-model-auth.md`

> **Q**: 如何为新上线的模型（如假设的 claude-haiku-5）添加成本支持？
>
> **A**: > 按照源码注释 `// @[MODEL LAUNCH]: Add a pricing entry for the new model below.` 指示：1) 在 `model/configs.ts` 添加 `CLAUDE_HAIKU_5_CONFIG`（含 `firstParty` 名称字符串）；2) 在 `modelCost.ts` 添加对应的价格常量（或复用已有 tier）；3) 在 `MODEL_COSTS` 映射中添加 `[firstPartyNameToCanonical(CLAUDE_HAIKU_5_CONFIG.firstParty)]: COST_HAIKU_5`；4) 若需要 Fast Mode 动态定价，参照 `getOpus46CostTier` 添加条件分支；5) 更新 `model/model.ts` 中的短名称别名（如 `'haiku5'`）。
>
> 来源：`05-utils-cost-token.md`

> **Q**: 如何在测试环境中模拟高成本使用场景以验证成本展示逻辑？
>
> **A**: > 可以直接构造 `BetaUsage` 对象传入 `calculateUSDCost`：`calculateUSDCost('claude-sonnet-4-6-20251101', { input_tokens: 1_000_000, output_tokens: 200_000, cache_creation_input_tokens: 500_000, cache_read_input_tokens: 2_000_000, server_tool_use: { web_search_requests: 100 } })`。对于集成测试，可以通过 VCR（`services/vcr.ts`）录制真实 API 响应，提取其中的 `usage` 字段，使用固定数据验证成本计算的数学正确性和边界条件（如未知模型回退、Fast Mode 切换）。
>
> 来源：`05-utils-cost-token.md`

> **Q**: 如何在不破坏不可变性原则的情况下向 AppState 添加新字段？
>
> **A**: > 1. 在 `AppStateStore.ts` 的 `AppState` 类型定义中添加新字段（TypeScript 会强制所有创建点更新）；2. 在 `getDefaultAppState()` 工厂函数中添加初始值；3. 如果新字段需要持久化，在 `onChangeAppState` 中添加相应的 diff 检测和 `saveGlobalConfig` 调用；4. 所有状态更新都通过 `store.setState(prev => ({ ...prev, newField: value }))` 进行，无需修改 store 本身；5. 若有 CCR 同步需求，在 `notifySessionMetadataChanged` 调用处添加对应字段。
>
> 来源：`06-state.md`

> **Q**: 如何在 headless 模式（无 React）下使用 AppState？
>
> **A**: > `store.ts` 的 `createStore` 完全不依赖 React，可在非 React 环境中直接使用：`const store = createStore(getDefaultAppState(), onChangeAppState)`，然后通过 `store.getState()` 读取、`store.setState(prev => ...)` 更新。这正是 CLI 模式（`print.ts`/`headless mode`）的工作方式——`onChangeAppState` 中的 `notifyPermissionModeChanged` 在 headless 模式下也能正常工作，因为注册的监听器不依赖 React 渲染。
>
> 来源：`06-state.md`

> **Q**: 如何为新增的 `mcp` 类型钩子扩展 HookCommandSchema？
>
> **A**: > 1. 在 `buildHookSchemas` 函数中新增 `McpHookSchema = z.object({ type: z.literal('mcp'), server: z.string(), tool: z.string(), ... })`；2. 将 `McpHookSchema` 加入 `HookCommandSchema` 的 `discriminatedUnion` 数组；3. 在推断类型中添加 `export type McpHook = Extract<HookCommand, { type: 'mcp' }>`；4. 在 `src/utils/hooks/` 的执行引擎中添加 `mcp` 分支处理；5. 由于使用 `lazySchema`，模式在首次调用时才初始化，新增的 `McpHookSchema` 不影响加载性能。
>
> 来源：`07-schemas.md`

> **Q**: 如何调试「hooks 配置解析失败」的问题？
>
> **A**: > Zod 的 `parse` 方法在失败时抛出包含详细路径的 `ZodError`，`safeParse` 则返回 `{ success: false, error: ZodError }`。在 settings 解析的 try-catch 中可以通过 `error.flatten()` 或 `error.format()` 获取结构化错误信息（精确到字段路径）。常见问题：1) `type` 字段拼写错误（`discriminatedUnion` 会明确报告「invalid_union_discriminator」）；2) `timeout` 传了字符串而非数字；3) `asyncRewake: true` 但同时设置了 `async: false`（逻辑冲突，schema 不检查但执行引擎会处理）。运行 `claude --debug` 可以看到完整的配置解析日志。
>
> 来源：`07-schemas.md`

> **Q**: 如何为新上线的模型添加一个版本升级迁移脚本？
>
> **A**: > 参照 `migrateSonnet45ToSonnet46.ts` 的模式：1) 创建 `migrations/migrateXxxToYyy.ts`；2) Guard clauses 检查：提供器类型（firstParty/3P）、用户订阅层级（若有限制）、当前 model 字符串是否匹配旧版本；3) 调用 `updateSettingsForSource('userSettings', { model: newAlias })`；4) 可选：通过 `saveGlobalConfig` 记录迁移时间戳供 UI 显示迁移通知；5) 在 `setup.ts` 的迁移调用序列中添加新函数（注意顺序，避免迁移间的依赖冲突）；6) 发布前确认函数幂等——已升级的用户再次运行时应直接 return。
>
> 来源：`08-constants-types-migrations.md`

> **Q**: 如何扩展记忆系统支持「项目级」记忆（区别于用户级记忆）？
>
> **A**: > 当前 `loadMemoryPrompt` 支持「auto memory」（用户级，路径 `~/.claude/projects/<slug>/memory/`）和「team memory」。新增项目级记忆：1) 在 `memdir/paths.ts` 添加 `getProjectMemPath()` 返回项目根目录下的 `.claude/memory/`；2) 在 `memdir/memdir.ts` 的 `loadMemoryPrompt` 路由逻辑中添加新分支（需在 autoEnabled 之前检查，因为项目记忆优先级更高）；3) 调用 `ensureMemoryDirExists(projectMemDir)` 确保目录存在；4) 复用 `buildMemoryLines('project memory', projectMemDir)` 构建提示文本；5) 在 `isAutoMemoryEnabled` 类似的地方添加 `isProjectMemoryEnabled` 开关，支持用户在 settings 中控制。
>
> 来源：`08-constants-types-migrations.md`

> **Q**: 如果要为企业用户添加一段"公司安全策略"的 prompt，应该放在静态区域还是动态区域？
>
> **A**: > 取决于策略内容是否因用户/组织而异。如果所有企业用户共享相同的策略文本（如「不得输出包含 PII 的内容」），应放在静态区域并设置 `scope: 'global'`，享受跨用户缓存收益。如果策略包含组织特定内容（如「${公司名}的数据分类标准是...」），则必须放在动态区域，否则不同公司的请求会错误地命中彼此的缓存。实现上，在 `fetchSystemPromptParts()` 中根据用户 tenant 信息，将企业策略段落插入到 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 之前（静态）或之后（动态）即可。
>
> 来源：`09-system-prompt工程.md`

> **Q**: 如何调试「系统提示组装后 token 超出预期」的问题？
>
> **A**: > 排查路径：1) 在 `buildSystemPromptBlocks()` 出口处添加日志，打印每个段落的名称和字符数，找出"意外大"的段落；2) 检查 CLAUDE.md 发现结果——项目中是否存在超大的 CLAUDE.md（常见：将 API 文档直接粘贴进去）；3) 检查 Git status 是否命中截断（`status.length > 2000`），如果未截断但 monorepo 有大量修改文件则需降低阈值；4) 检查 MCP 指令——注册了过多工具的 MCP 服务器可能贡献数千 token；5) 使用 `countTokens()` 工具函数（`src/utils/tokens.ts`）对每个段落独立计数，可精确定位。
>
> 来源：`09-system-prompt工程.md`

> **Q**: 如果用户报告「Claude Code 在长会话中突然忘记了我之前说的话」，应该如何排查是哪层压缩导致的？
>
> **A**: > 排查路径：1) 检查会话日志中是否有 `autocompact_triggered` 事件——如果有，查看压缩发生的时间点，对照「忘记」的内容是否在该时间点之前；2) 查看摘要内容（通常保存在日志的 `compact_summary` 字段），检查 9 类保留信息中是否缺少「忘记」的内容；3) 如果是用户的反馈/约束被忘记（如「不要用 Redux」），这是第 6 类信息的遗漏，说明 AutoCompact 的 prompt 对这类约束处理不足；4) 如果是文件内容被忘记，可能是重建阶段没有选到该文件（看看它是否在修改频率 top 5 之外）；5) Context Collapse 导致的遗忘通常不是突然的，而是渐进的——如果是突然忘记大量内容，99% 是 AutoCompact。
>
> 来源：`10-上下文压缩.md`

> **Q**: 如何在自定义 Claude Code SDK 调用中禁用 AutoCompact，保持完整上下文？
>
> **A**: > 在创建 `QueryEngine` 时设置 `QueryEngineConfig` 中的 `disableAutoCompact: true`（或对应的配置字段）。注意副作用：禁用 AutoCompact 后，长会话最终会触发 API 的 context length 错误（429 或特定错误码），调用方需要自行处理这个错误。推荐的替代方案是：1) 使用更大上下文窗口的模型变体（如 claude 的 1m token 版本 `claude-sonnet[1m]`）；2) 在每次 `submitMessage()` 前手动截断历史消息（保留最近 N 轮），在应用层实现自定义的压缩策略；3) 如果使用 Context Collapse（`isContextCollapseEnabled = true`），AutoCompact 会自动被抑制，Collapse 作为更温和的替代方案生效。
>
> 来源：`10-上下文压缩.md`

### UI 与交互（07-UI与交互/）

> **Q**: 如果要在 Ink 组件中实现虚拟滚动（只渲染可视区域的行），需要在哪些层次做工作？
>
> **A**: 需要协同三个层次：
> 1. **React 层**：`useVirtualScroll` 钩子（`src/hooks/useVirtualScroll.ts`）根据 `scrollTop` 和视口高度计算当前应渲染的子项范围，只将可视区域的 React 元素传给渲染树。
> 2. **DOM 层**：`DOMElement` 的 `scrollClampMin` / `scrollClampMax` 字段记录当前已挂载子项的覆盖范围，防止 `scrollTo` 的直接写操作超过 React 异步渲染追上之前的空白区域（blank screen）。
> 3. **渲染层**：`render-node-to-output.ts` 读取 `scrollTop` 并在绘制时偏移子节点坐标，`pendingScrollDelta` 的逐帧漏斗（SCROLL_MAX_PER_FRAME）确保快速滑动时显示中间帧而非直接跳到终点。
>
> 来源：`01-ink渲染引擎.md`

> **Q**: CLAUDE_CODE_DEBUG_REPAINTS 环境变量开启后，引擎如何定位导致全屏刷新（full reset）的组件？
>
> **A**: 开启后，协调器的 `createInstance` 会通过 `getOwnerChain(internalHandle)` 读取 React Fiber 的 `_debugOwner` 链路，将组件调用栈（如 `['ToolUseLoader', 'Messages', 'REPL']`）存入节点的 `debugOwnerChain` 字段。当 log-update 触发全屏 reset 时，引擎调用 `findOwnerChainAtRow(root, y)` 深度优先遍历 DOM 树，通过 Yoga 计算的 `getComputedTop()` + `getComputedHeight()` 定位 `y` 行所属节点，返回该节点的 `debugOwnerChain`，即可精确归因到触发重绘的 React 组件。
>
> 来源：`01-ink渲染引擎.md`

> **Q**: 如果要在 Claude Code 中添加一个新的 UI 对话框，应该在哪个层次注入？遵循什么规范？
>
> **A**: 参考现有的 `CostThresholdDialog`、`BypassPermissionsModeDialog` 等对话框：
> 1. 在 `src/components/` 创建对话框组件，接收 `onDone/onCancel` 回调。
> 2. 在 REPL.tsx 或相关状态中添加显示条件状态（`useState<boolean>`）。
> 3. 使用 Ink 的 `Box` 组件实现绝对定位覆盖层（`style={{ position: 'absolute' }}`）或通过 `overlayContext` 注册。
> 4. 确保对话框组件处理 `Escape` 键关闭，避免光标锁死。
> 5. 遵循 `design-system/` 的 `ThemedBox` / `ThemedText` 使用主题颜色，不硬编码 ANSI 颜色代码。
>
> 来源：`02-核心组件.md`

> **Q**: React Compiler 处理后的组件如何调试？_c() 槽的内容能在 DevTools 中查看吗？
>
> **A**: React Compiler 生成的槽数组是普通 JS 数组，存储在组件的 Hook 状态中。在 React DevTools（Ink 开发模式下连接 `react-devtools-core`）中，可以看到组件 Hooks 列表中一个 `State: Array(n)` 条目，即为缓存槽数组。每个槽交替存储"上次的依赖值"和"上次的输出值"。由于 Compiler 会为每个子表达式插入注释（`// 缓存槽 i`），Source Map 还原后可以对应到原始代码。实际调试时，更推荐在 `.env` 中设置 `CLAUDE_CODE_DEBUG_REPAINTS=1` 并借助引擎的重绘追踪来定位性能问题。
>
> 来源：`02-核心组件.md`

> **Q**: 如果要新增一个 `Claude Code config` 的交互式配置 Screen，应该如何接入现有路由体系？
>
> **A**: 1. 在 `src/screens/` 创建 `ConfigScreen.tsx`，接收 `{ onDone: (result?: ConfigResult) => void }` Props。
> 2. 在 `src/index.ts` 的启动逻辑中，检测 `claude config` 子命令，将 `ConfigScreen` 作为初始渲染根组件。
> 3. `ConfigScreen` 完成后调用 `onDone(result)`，启动逻辑根据 `result` 决定是退出进程还是转入 REPL。
> 4. 若需要从 REPL 内部打开配置（如 `/config` 命令），则通过 REPL 的 `CommandResultDisplay` 机制（`onDone(result, { display: 'interactive' })`）在 REPL 内渲染配置组件，完成后恢复 REPL 状态。
>
> 来源：`03-screens路由.md`

> **Q**: REPL.tsx 中的 `switchSession` 是如何在不重启进程的情况下切换会话的？
>
> **A**: `switchSession`（来自 `bootstrap/state.js`）更新全局会话 ID 并清除当前会话的所有状态（消息数组、成本跟踪、文件历史快照等）。REPL 通过订阅 AppState 变化检测到 `currentSessionId` 更新后，触发一次完整的"会话初始化"流程：重新加载历史消息（如果是恢复会话）或清空消息数组（如果是新建会话），重置工具权限上下文，并重新执行 session start 钩子。整个过程在 React 状态更新链内完成，Ink 的差量渲染确保界面平滑过渡，无需重启 Node.js 进程。
>
> 来源：`03-screens路由.md`

> **Q**: 如果要为 REPL 添加"多面板模式"（同时显示主对话和工作者对话），需要修改哪些核心结构？
>
> **A**: A：多面板模式需要以下改动：
> 1. **REPL 状态层**：将单一的 `messages` 数组扩展为 `Map<sessionId, Message[]>`，每个面板对应一个 session 的消息历史
> 2. **渲染层**：引入 Ink 的水平 `Box flexDirection="row"` 布局，每个面板包裹在独立的 `Box width="50%"` 中
> 3. **焦点管理**：使用 Ink 的 `useFocusManager()` 实现面板间焦点切换（`Tab` 切换，有焦点的面板接收键盘输入）
> 4. **QueryLoop 绑定**：每个面板的 PromptInput 提交时，向对应 `sessionId` 的 QueryLoop 实例发送消息
> 5. **AppState 扩展**：`activePanelSessionId` 字段标识当前活动面板
>
> 挑战在于 REPL.tsx 当前的所有状态假设"单一活跃会话"，需要大量重构。最小破坏性路径是引入 `PanelContext`，将面板感知下沉到子组件，REPL 顶层保持单会话视角。
>
> 来源：`03-screens路由.md`

> **Q**: Doctor Screen 的 `Suspense` 边界在 Ink（CLI）环境中与 Web 环境有何差异？
>
> **A**: A：在 Web 环境中，Suspense fallback 通常是视觉上的占位 UI（骨架屏），不影响其他内容的显示。在 Ink（CLI）环境中，Suspense 的行为相同，但渲染载体是终端字符流：
> - fallback（`<Spinner />`）会在终端输出动画字符序列
> - Promise 解析后，Ink 的差量渲染计算新旧输出的差量，发送 ANSI 控制码更新终端内容
> - 由于终端没有 CSS/DOM，"替换" Spinner 为实际内容时，Ink 使用光标移动指令（`\x1B[nA\x1B[K`）清除旧行再写入新行
>
> Doctor Screen 使用多个独立的 `Suspense` 边界（npm 版本、GCS 版本各自独立），这样其中一个网络请求超时不会阻塞另一个的显示，用户能看到部分诊断结果而非全量等待。
>
> 来源：`03-screens路由.md`

> **Q**: REPL 的 `permissionRequest` 状态如何防止同时处理两个并发工具权限请求？
>
> **A**: A：`permissionRequest` 是 `ToolUseConfirm | null` 的单值状态（非队列），同一时刻只能有一个权限请求处于等待状态。工具执行框架（`QueryLoop`）在调用 `onPermissionRequest` 时会等待前一个请求的 Promise resolve 后才能发起下一个——因为工具是按顺序执行的，前一个工具的权限确认（或拒绝）是执行下一个工具的前提条件。若协调器模式下多个工作者并发请求权限，每个工作者的 `QueryLoop` 独立持有自己的 `permissionRequest` 回调引用，由各自的子 UI 面板（`TaskView`）渲染，不会聚合到主 REPL 的 `permissionRequest` 状态中。
>
> 来源：`03-screens路由.md`

> **Q**: 如果要为 Claude Code 实现"命令面板"（Ctrl+P 弹出命令搜索框），应该使用哪些钩子组合？
>
> **A**: 参考 `src/components/GlobalSearchDialog.tsx` 的实现模式：
> 1. `useGlobalKeybindings` 或 `useInput`：监听 `Ctrl+P` 开关命令面板。
> 2. `useHistorySearch` 或 `useSearchInput`：处理输入框内的实时过滤逻辑。
> 3. `useVirtualScroll`：若命令列表超过 50 项，使用虚拟滚动渲染结果。
> 4. `useArrowKeyHistory` 类似的模块级缓存：预加载可用命令列表（`mergedCommands`），避免每次打开面板都重新扫描工具和 Slash 命令。
> 5. `useTypeahead`：提供命令名称的前缀匹配高亮。
>
> 来源：`04-hooks.md`

> **Q**: `useVimInput` 的 `dot-repeat`（`.` 命令）是如何实现的？
>
> **A**: `PersistentState.lastChange`（`RecordedChange` 联合类型）记录了最近一次修改操作的完整信息：操作类型（operator/insert/x 等）、动作（motion）、次数（count）。执行 `.` 时，`onDotRepeat` 回调重新播放 `lastChange`：若为 `insert` 类型，重新调用 `textInput.onInput` 依次输入 `insertedText` 中的每个字符；若为 `operator` 类型，重新调用 `executeOperatorMotion(op, motion, count, ctx)` 执行相同的文本操作。`insertedText` 在 INSERT 模式下每次 `onInput` 时追加字符，`Escape` 切回 NORMAL 模式时将完整的插入文本固化为 `lastChange`。
>
> 来源：`04-hooks.md`

> **Q**: 如何为团队创建一个强制所有成员使用 "code-review" 风格的输出样式？
>
> **A**: 1. 在项目仓库根目录创建 `.claude/output-styles/code-review.md`：
>    ```markdown
>    ---
>    name: Code Review
>    description: Claude reviews code in detail before suggesting changes
>    keep-coding-instructions: true
>    ---
>    Before writing any code changes, always:
>    1. Analyze the existing code structure and patterns
>    2. Identify potential issues in the current implementation
>    3. Explain your proposed changes and why they improve the code
>    ```
> 2. 在 `.claude/settings.json`（项目级配置）中设置：`{ "outputStyle": "Code Review" }`
> 3. 提交这两个文件到仓库，团队成员在项目目录下运行 Claude Code 时会自动使用该样式。
>
> 若需要强制覆盖（即使用户本地设置了其他样式），则需要通过插件机制设置 `forceForPlugin: true`，但这会影响所有使用该插件的用户，应谨慎使用。
>
> 来源：`05-outputStyles.md`

> **Q**: `getAllOutputStyles` 使用 `memoize` 缓存在测试环境中有什么潜在问题？
>
> **A**: Jest/Vitest 等测试框架在单个测试文件内共享同一个模块实例，`memoize` 缓存跨测试用例持久化。若测试 A 调用 `getAllOutputStyles('/project-a')` 后测试 B 也用同样的 `cwd`，测试 B 会读到测试 A 的缓存结果（即使测试 B mock 了文件系统）。解决方法是在每个测试的 `beforeEach` 中调用 `clearAllOutputStylesCache()`，或在 `jest.mock` 中 mock 整个 `getAllOutputStyles` 函数。源码中 `clearOutputStyleCaches` 函数的存在正是为了解决这类测试隔离问题。
>
> 来源：`05-outputStyles.md`

> **Q**: 如果要为 Buddy 增加"心情系统"（根据用户今日对话轮次改变精灵表情），应该在哪里实现？
>
> **A**: 1. **状态来源**：在 `AppState` 中维护 `sessionTurnCount` 计数器，每次 AI 响应后递增。
> 2. **心情映射**：在 `companion.ts` 中添加 `getMood(turnCount): MoodType` 函数，将轮次映射到心情（0-5 轮：energetic，5-20 轮：focused，20+ 轮：tired）。
> 3. **精灵扩展**：在 `sprites.ts` 中为每个物种添加"情绪覆盖帧"（在现有帧基础上修改嘴型字符），避免为每种心情完整复制精灵定义。
> 4. **渲染传递**：`CompanionSprite` 接收 `mood` prop，传递给 `renderFace()` 函数，在 `{E}` 替换时同时替换嘴型占位符。
> 5. **气泡触发**：心情变化时（如从 focused 进入 tired）可以触发一次对话气泡（"需要休息了..."），通过 `addNotification` 系统实现。
>
> 来源：`06-buddy-AI伴侣.md`

> **Q**: Buddy 功能的 `feature('BUDDY')` 开关在构建期是如何工作的？
>
> **A**: `feature('BUDDY')` 是 Bun 构建系统提供的编译时宏（`bun:bundle` 模块的特性）。在构建配置中，功能开关被设为 `true` 或 `false`，构建器在打包时将所有 `feature('BUDDY')` 表达式替换为字面量布尔值。若为 `false`，所有 `if (!feature('BUDDY')) return []` 的分支变成 `if (!false) return []`，即 `if (true) return []`，dead-code-elimination 步骤会识别出 `if (!false)` 后的其他分支永远不会执行，从而移除整个 Buddy 功能模块的代码，包括精灵定义（约 2KB 字符数据）、AI 提示、API 调用等。这确保外部分发版本（面向普通用户）的包体积不包含未启用功能的代码。
>
> 来源：`06-buddy-AI伴侣.md`

> **Q**: 如何为 Claude Code 添加一个新的 Vim 动作，例如 `gd`（跳转到定义）？
>
> **A**: 1. 在 `vim/transitions.ts` 的 `fromG()` 函数中添加 `d` 键的处理：
>    ```typescript
>    if (input === 'd') {
>      return { execute: () => ctx.gotoDefinition?.() }
>    }
>    ```
> 2. 在 `TransitionContext` 类型（`vim/transitions.ts`）中添加 `gotoDefinition?: () => void` 可选函数。
> 3. 在 `useVimInput` 的 `ctx` 对象中注入 `gotoDefinition` 实现（调用 IDE 集成的跳转逻辑）。
> 4. 由于 `gd` 不修改文本，不需要更新 `PersistentState.lastChange`（`.` 命令不应重复 `gd`）。
> 5. 添加测试：`transition({ type: 'g', count: 1 }, 'd', ctx)` 应返回 `{ execute: fn }`。
>
> 来源：`07-voice-vim.md`

> **Q**: 如果要将语音输入扩展为支持"连续对话"（录音结束后自动提交），应该修改哪个层次？
>
> **A**: "连续对话"模式（类似 Siri 的对话流）需要在 `useVoiceIntegration` 层（非 `useVoice` 层）添加逻辑：
>
> 1. 检测 `voiceState` 从 `'processing'` 回到 `'idle'` 且 `transcript` 非空时，自动调用 `onSubmit(transcript)`（而非仅 `onChange(transcript)`）。
> 2. 在 `AppState` 中添加 `voiceContinuousMode: boolean` 状态，用户通过设置开启。
> 3. `useVoice` 本身不感知"连续模式"，它只负责录音和转录，保持单一职责。
> 4. 注意：需要在提交后立即重新激活录音等待下一句话，或添加静默检测（`FOCUS_SILENCE_TIMEOUT_MS = 5000ms` 已存在，可复用）来决定何时结束对话流。
>
> 来源：`07-voice-vim.md`

### 网络与远程（08-网络与远程/）

> **Q**: 如何扩展 remote 模块支持多会话并发观察？
>
> **A**: 当前 `RemoteSessionManager` 是单会话设计。扩展思路：① 创建 `MultiSessionManager` 持有 `Map<sessionId, RemoteSessionManager>`；② 每个实例独立维护 WebSocket 连接与权限请求队列；③ 上层通过事件总线（如 `EventEmitter`）统一接收各会话消息，按 `sessionId` 路由到对应的 REPL 渲染上下文。
>
> 来源：`01-remote.md`

> **Q**: 当 CCR 后端发布新消息类型时，升级路径是什么？
>
> **A**: 1. 后端先上线新类型，旧客户端通过 `sdkMessageAdapter` 的 `default` 分支返回 `{ type: 'ignored' }` 安全降级；
> 2. 客户端在 `convertSDKMessage` 的 `switch` 中新增 `case`，实现转换逻辑；
> 3. 若需要 UI 渲染，在 REPL 消息列表组件中添加对应渲染分支；
> 4. 全程无破坏性变更，新旧客户端均可与同一后端协作。
>
> 来源：`01-remote.md`

> **Q**: 如何为 Direct Connect 服务器实现会话级速率限制？
>
> **A**: 在 `ServerConfig` 中增加 `rateLimit` 字段（如每秒最大消息数）；在 WebSocket message handler 中维护每个 `sessionId` 的令牌桶（Token Bucket），超出限制时返回 `control_response { subtype: 'error', error: 'rate_limit_exceeded' }`；同时在 `SessionInfo` 中记录 `messagesPerSecond` 指标用于监控。
>
> 来源：`02-server.md`

> **Q**: 在 CI 环境中使用 Direct Connect 时，如何安全传递 `authToken`？
>
> **A**: 推荐通过环境变量注入（如 `CLAUDE_SERVER_TOKEN`），服务端启动时从环境读取；CI 系统（GitHub Actions、GitLab CI）通过 Secret 机制注入，不写入代码仓库。避免将 token 放入 URL 参数（会出现在日志中）或 git 历史中。客户端在请求时通过 `Authorization: Bearer` Header 传递，Header 在 TLS 加密下传输。
>
> 来源：`02-server.md`

> **Q**: 如何为 bridge 模块添加多环境支持（同一机器注册为多个 CCR 环境）？
>
> **A**: 当前 `runBridgeLoop()` 是单环境模型。扩展方案：① 为每个目录/Git 仓库调用一次 `runBridgeLoop()`，各自持有独立的 `environmentId`；② 共享同一个 `BridgeApiClient`（无状态）和 `spawner`（有状态，需加锁）；③ 在 `bridgeMain.ts` 外层添加环境发现逻辑（如扫描 `~/workspace/*` 的 git 仓库）；④ GrowthBook Gate `tengu_ccr_bridge_multi_environment` 已存在对应的功能开关。
>
> 来源：`03-bridge.md`

> **Q**: 在网络抖动频繁的环境中，如何优化 bridge 的稳定性？
>
> **A**: 1. 调小 `BackoffConfig.connInitialMs`（如 500ms）以更快重连，同时调大 `connCapMs`（如 5 分钟）以避免过于频繁的重连冲击；
> 2. 在 `runBridgeLoop()` 中检测系统睡眠（通过比较定时器实际间隔与预期间隔），睡眠唤醒后立即重置错误计数并重连（代码中 `pollSleepDetectionThresholdMs` 已实现此逻辑）；
> 3. 对 heartbeat 失败引入指数退避，避免在网络恢复瞬间洪泛 API；
> 4. 增加 `onReconnected` 事件统计 MTTR（平均恢复时间），接入可观测性系统。
>
> 来源：`03-bridge.md`

> **Q**: 如何为 upstreamproxy 添加对 HTTP（非 HTTPS）流量的支持？
>
> **A**: 当前设计明确只代理 HTTPS（注释说明 HTTP 无凭证注入需求且路由到代理会导致 405）。若需要代理 HTTP（如某些内网 CI 服务），需要：① 在 `relay.ts` 中识别非 CONNECT 请求（GET/POST 等方法）；② 对 HTTP 请求用 WebSocket 帧传递完整的 HTTP 请求/响应字节；③ CCR 服务端实现对应的 HTTP 转发逻辑；④ 在 `getUpstreamProxyEnv()` 中额外设置 `HTTP_PROXY`/`http_proxy`。
>
> 来源：`04-upstreamproxy-moreright.md`

> **Q**: moreright 的 overlay 机制如何保证公开构建与内部构建的类型兼容性？
>
> **A**: 存根文件与内部实现必须保持相同的函数签名（TypeScript 接口）。构建时通过 `tsconfig.paths` 或构建工具（Bun bundle）的 alias 配置，将 `src/moreright/` 指向内部实现目录。TypeScript 编译会对两套实现独立进行类型检查：存根文件的类型注解定义了契约，内部实现若偏离契约则编译失败，确保 API 兼容性。
>
> 来源：`04-upstreamproxy-moreright.md`

> **Q**: 如何在企业环境中部署 KAIROS 助手守护进程？
>
> **A**: 推荐方案：① 在专用服务器上以 `systemd` 服务管理 `claude --assistant` 进程（配合 `WorkingDirectory` 和 `User`）；② 环境变量通过 `EnvironmentFile` 注入 Claude Code 的 API 密钥；③ 设置 `RestartSec=10` 和 `Restart=on-failure` 实现自动重启；④ 通过 `journald` 收集日志并设置 `StandardOutput=append:/var/log/claude-assistant.log`；⑤ 在 Grafana 仪表板中监控 heartbeat 调用频率和会话成功率。
>
> 来源：`05-assistant-KAIROS.md`

> **Q**: 用户在 `claude assistant` 观察会话时发送消息，会发生什么？
>
> **A**: 观察端以 `viewerOnly=true` 连接，但仍然可以发送用户消息（通过 `RemoteSessionManager.sendMessage()` 的 HTTP POST 路径）。这意味着观察者可以向正在运行的 KAIROS 守护 Agent 发送新的指令或补充信息，形成"中途插入"的协作模式。区别在于观察者无法中断当前正在执行的操作（不发送 interrupt），只能在 Agent 完成当前任务后处理新消息。这与 claude.ai Web 界面的行为一致——Web 端也可以发送新消息，但不能强制终止当前任务。
>
> 来源：`05-assistant-KAIROS.md`

> **Q**: 如何为 `getUserContext()` 添加对 `.claudeignore` 文件的支持？
>
> **A**: 1. 在 `getUserContext()` 中调用新函数 `getClaudeIgnoreRules()`，读取 CWD 下的 `.claudeignore` 文件
> 2. 若文件存在，将规则解析为 glob 列表并序列化为人类可读字符串
> 3. 返回值加入 `getUserContext()` 的结果对象中（如 `{ claudeIgnore: ... }`）
> 4. 需要使 `getUserContext` 的 memoize 缓存也在 `.claudeignore` 文件变化时失效（可通过 `fs.watch` 触发 `getUserContext.cache.clear()`）
>
> 来源：`06-context-native-ts.md`

> **Q**: 在 CI/CD 流水线中，`getGitStatus()` 的结果对 LLM 性能有什么影响？
>
> **A**: CI 环境通常是浅克隆（`--depth=1`），`git log -n 5` 可能只返回 1 条提交；同时 CI 工作区干净（无未提交更改），`git status --short` 返回空。LLM 收到的系统提示中 git 状态极短，减少了 token 消耗。但若 CI 克隆了大量子模块，git status 会变慢（除非配置了 `--ignore-submodules`）。另一个考量是 CI 可能有较高的 prompt cache 命中率（相同仓库多次运行 git log 结果相同），Anthropic 的 prompt caching 机制会缓存 system prompt 的 token，降低重复运行的成本。
>
> 来源：`06-context-native-ts.md`

---

> 源码版权归 [Anthropic](https://www.anthropic.com) 所有，本笔记仅供学习研究使用。
> 文档内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议。