<div align="center">

# Claude Code v2.1.88 — Deep Source Analysis

[**🌐 English**](./README_en.md) | [**🇨🇳 中文**](./README.md)

[![Version](https://img.shields.io/badge/Claude_Code-v2.1.88-blue.svg?style=flat-square)](https://www.anthropic.com/claude-code)
[![Documentation](https://img.shields.io/badge/Docs-56_Articles-success.svg?style=flat-square)](#-repository-structure-56-articles)
[![Interview QA](https://img.shields.io/badge/Interview_QA-484_questions-orange.svg?style=flat-square)](./INTERVIEW_QA.md)
[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC_BY--NC_4.0-lightgrey.svg?style=flat-square)](https://creativecommons.org/licenses/by-nc/4.0/)
[![Status: Complete](https://img.shields.io/badge/Status-Complete-green.svg?style=flat-square)](#)

*A comprehensive engineering reference for Claude Code's internals — architecture, design patterns, and interview prep*

</div>

<br/>

## What Is This?

This repository is a systematic, source-level analysis of **Anthropic's Claude Code (v2.1.88)** — the production AI agent CLI that ships as an npm package. Using source map recovery techniques on the published bundle, we reverse-engineered the internal architecture into 55 structured articles spanning 8 core modules.

Each article follows a consistent three-part format: a narrative walkthrough of the source code, a set of design-decision Q&As (the kind that come up in senior engineering interviews), and Mermaid diagrams that visualize data flows, state machines, and module dependencies. The goal is not just to describe what the code does, but to explain *why* each architectural choice was made and what trade-offs it involves.

This is a reference for engineers who want to understand how a production-grade AI agent CLI actually works under the hood — not from a marketing description, but from the source code itself.

---

## Why This Matters

Claude Code is one of the few production AI agent systems whose internals can be studied in depth. What makes it architecturally interesting is not that it calls an LLM API, but *how* the system is structured around the inherent constraints of that interaction: token limits, streaming latency, tool execution side effects, multi-turn context management, and the need to render a responsive UI while all of this is happening concurrently.

A few highlights that distinguish Claude Code's architecture from naive LLM wrapper implementations:

- The **QueryLoop** is a stateless, dependency-injectable execution kernel that drives multi-turn agentic behavior. Stateful session management is cleanly separated into `QueryEngine`, making the core loop independently testable.
- The **4-tier context compression pipeline** (snip → microcompact → contextCollapse → autocompact) handles the hard problem of keeping long conversations within the model's context window without destroying semantic continuity — and does so progressively, only escalating to expensive full-history summarization when cheaper strategies are insufficient.
- The **terminal UI** is built on React 19 with a custom reconciler and Yoga WASM for flexbox layout, treating the terminal as a first-class rendering target with diffed, double-buffered output. This is not a standard Ink usage — it is a custom reconciliation layer.
- The **tool system** uses a `buildTool()` factory with lazy Zod schema initialization, meaning 40+ built-in tools impose near-zero startup cost on a cold CLI invocation.
- The **authentication chain** handles 7 credential sources (direct API key, Claude.ai OAuth, AWS Bedrock IAM, GCP Vertex ADC, Azure Foundry AAD, enterprise SSO, desktop app injection) through a single responsibility-chain entry point.

If you are preparing for a senior engineering interview, building your own AI agent framework, or simply want to understand what "production AI tooling" looks like at the implementation level, this is the reference you are looking for.

---

## Repository Structure (55 Articles)

The repository mirrors the physical module layout of the Claude Code source. Start with the global overview, then navigate by area of interest.

**[00 — Global Architecture Overview](./00-全局架构总览.md)**
The recommended entry point. Covers the 7 core architectural decisions, the full user-interaction lifecycle (10 stages from keypress to rendered output), and a module dependency topology. Read this first.

---

**[01 — Core Entry](./01-核心入口/) · 4 articles**
The CLI bootstrap sequence: how `cli.tsx` hands off to `main.tsx`, parallel prefetch debouncing that hides startup latency, Commander-based argument parsing, and the dual-path routing engine that separates MDM-managed and Keychain-based authentication flows at process start.

**[02 — Tool System](./02-工具系统/) · 9 articles**
The 40+ built-in tool registry: the `ToolDef<I,O>` interface contract, the `buildTool()` factory pattern, lazy Zod schema initialization, MCP dynamic loading, `BashTool` sandbox defense mechanisms, the 4-stage tool execution lifecycle (`validateInput → checkPermissions → call → mapResult`), and the `StreamingToolExecutor` that runs tools in parallel.

**[03 — Command System](./03-命令系统/) · 9 articles**
The slash-command infrastructure: the three-way priority instruction chain, memoized command registration, feature flag gating, the fault injection strategy (`bridge-kick`), and the cache zero-trace (`btw`) processing mode. Covers all three command categories: Prompt, Local, and JSX.

**[04 — Agent Coordination](./04-Agent协调/) · 6 articles**
The core of the system. The `query.ts` QueryLoop lifecycle — how the `while(true)` loop drives multi-turn agentic execution. The 4-tier context compression pipeline in detail. The `QueryEngine` stateful session manager. The multi-agent coordinator and environment-variable-based mode switching. The three-layer multi-agent collaboration architecture (Swarm in-process runner, Coordinator pure-orchestration mode, Task system, and 6 rules for cross-agent permission propagation). The Fork sub-agent mechanism and message construction strategy for maximizing Prompt Cache hit rates, including the double-safeguard anti-recursion design.

**[05 — Extension System](./05-扩展系统/) · 3 articles**
How Claude Code is extended at runtime: the plugin joint-dispatch mechanism, state machine skill design, dynamic skill directory scanning, and chord key input bindings.

**[06 — Services & Infrastructure](./06-服务与基础/) · 10 articles**
The foundational layer: the Anthropic API client with retry and streaming, the 7-level authentication priority chain, Zod schema definitions for all core types (`Message`, `ToolResult`, etc.), the immutable global `AppState` store, token counting and cost calculation utilities, and the migration infrastructure. System prompt segmented-cache architecture (`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, the "constitution" static region, CLAUDE.md hierarchical discovery, Git status injection, and MCP incremental injection). The four-layer context compression strategy (tool result truncation, image replacement, Context Collapse, AutoCompact) including the AutoCompact threshold formula, circuit-breaker mechanism, 9 categories of preserved information, and the mutual-exclusion relationship between Context Collapse and AutoCompact.

**[07 — UI & Interaction](./07-UI与交互/) · 7 articles**
The React 19 + Ink terminal rendering engine: the custom `react-reconciler` that maps virtual DOM to `DOMElement` trees, Yoga WASM flexbox layout computation, double-buffered diff rendering to stdout, core UI components (`PermissionRequest`, `Spinner`, `Messages`), and the deterministic Buddy companion system with its bones/soul storage separation.

**[08 — Network & Remote](./08-网络与远程/) · 6 articles**
The remote execution layer: the CCR WebSocket session manager, the KAIROS SSE remote agent daemon, `BoundedUUIDSet` for deduplication, Protobuf custom packetization, upstream proxy tunnels, and the local bridge server.

**[09 — Practical Guide](./09-实战指南/) · 1 article**
A hands-on implementation guide derived from the source architecture. Walks through building a lightweight agent client from scratch, covering QueryLoop wiring, tool system integration, context compression, and streaming output — the complete implementation path in one document.

---

## Key Architectural Insights

These are the findings that stood out most during the analysis — decisions that are non-obvious but make sense once you understand the constraints they solve.

- **The terminal UI runs React 19 with a custom reconciler and Yoga WASM.** Rather than writing imperative ANSI escape sequences, the entire terminal UI is modeled as `UI = f(state)`. A custom `react-reconciler` maps the React virtual DOM to Ink's `DOMElement` tree, Yoga computes flexbox layout in WASM, and a double-buffered diff renderer outputs only changed lines to stdout. This eliminates flicker during streaming and makes UI components independently testable.

- **Context compression is a 4-tier progressive pipeline, not a single truncation.** Before each API call, the message history passes through: (1) `snip` — truncate oversized individual tool results; (2) `microcompact` — compress redundant sections of the most recent large tool result; (3) `contextCollapse` — fold completed tool-call sequences into inline summaries; (4) `autocompact` — invoke Claude itself to summarize the full history when utilization exceeds a threshold. Each tier is more expensive than the last, so the system only escalates when necessary. This keeps costs low while preventing `prompt_too_long` errors on long sessions.

- **All 40+ tool schemas are lazily initialized via a `lazySchema()` wrapper.** TypeScript getter functions ensure Zod schema objects are only constructed on first access. Combined with the `buildTool()` factory, this means the full tool registry registers at near-zero startup cost — critical for a CLI where cold-start latency is user-visible.

- **The QueryLoop is stateless; session state lives in a separate `QueryEngine` object.** `query()` is a pure execution kernel that takes all context as parameters and supports dependency injection (`callModel`, `autocompact`, etc. are replaceable for testing). `QueryEngine` is the stateful session manager that holds `mutableMessages` and `totalUsage` across `submitMessage()` calls. This separation means the core loop is unit-testable in isolation while the session layer can fulfill the SDK contract for external consumers like Claude Desktop.

- **The multi-agent system uses three distinct collaboration layers, not a single dispatch mechanism.** The Swarm layer handles in-process sub-agent execution with shared memory. The Coordinator layer is a pure orchestrator — it never executes tools directly, only spawns and sequences child agents. The Task system bridges them via a well-defined permission propagation model with 6 explicit rules governing what a sub-agent is allowed to do relative to its parent. This layered design prevents the implicit permission escalation that plagues simpler multi-agent frameworks.

- **Fork-based sub-agents maximize prompt cache hit rates through deliberate message construction.** When spawning a sub-agent, the system constructs the message history so that the cacheable prefix (system prompt + prior conversation) is as long as possible before the dynamic portion begins. Combined with a double-safeguard anti-recursion mechanism (environment variable + call stack depth check), this design makes deep agent trees both cache-efficient and stack-safe.

- **The system prompt has a hard segmentation boundary (`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`) that separates the static "constitution" region from dynamic content.** Everything before the boundary — tool schemas, CLAUDE.md hierarchy, core behavioral rules — is eligible for prompt caching across turns. Everything after — Git status, MCP incremental injections, per-turn context — is excluded. This single boundary is what makes system prompt caching practical in a tool-heavy, MCP-connected session.

- **The Buddy companion's appearance is never stored — it is re-derived deterministically.** The companion's visual characteristics (`CompanionBones`) are computed from `hash(userId + SALT)` via the Mulberry32 PRNG on every load, so they are tamper-proof by design: there is no stored value to edit. The AI-generated personality (`CompanionSoul`) is stored once. One species name is constructed at runtime via `String.fromCharCode()` to avoid triggering build-artifact canary scanners that flag certain string literals — a detail that reveals how seriously the team takes supply-chain security.

---

## Getting Started

**If you are new here**, start with [00-全局架构总览.md](./00-全局架构总览.md). It covers the full architecture in one document and will orient you before diving into any module group.

**For interview preparation**, the recommended priority order is:

1. `04-Agent协调/04-QueryEngine.md` — session management, write-ahead logging, double-buffered messages
2. `04-Agent协调/03-query.md` — query loop, 4-tier compression, tool execution
3. `02-工具系统/00-工具系统总览.md` — ToolDef interface, buildTool factory, permission lifecycle
4. `07-UI与交互/01-ink渲染引擎.md` — React reconciler, Yoga layout, diff rendering
5. `06-服务与基础/04-utils-model-auth.md` — 7-level auth chain, OAuth refresh, multi-cloud

**For a systematic deep-dive**, start from the infrastructure layer (`06`), work up through the tool layer (`02`), then the query layer (`04`), then commands and extensions (`03`, `05`), and finish with the entry point and UI (`01`, `07`, `08`).

---

## Contributing

This project completed its static analysis of v2.1.88, but Claude Code is actively updated. Community contributions to keep the analysis current are very welcome.

**Ways to contribute:**

1. **Submit Issues / Errata** — If you find unclear explanations, outdated descriptions after a Claude Code update, or formatting errors, open an Issue.
2. **Version Update Tracking** — If you have recovered source maps from a newer version, submit a PR with analysis of new or changed features (e.g., updated MCP protocol support, new tool implementations).
3. **Code Validation Examples** — Submit concrete code snippets or runtime screenshots that validate or illustrate specific architectural claims in the articles.

Before submitting a PR, please follow the existing `"Narrative + Q&A + Mermaid"` three-part article structure.

---

## License

> **Copyright notice**: Source code copyright belongs to [Anthropic](https://www.anthropic.com). This documentation is compiled from reverse engineering / static analysis for learning and research purposes only, and does not redistribute original source code.
>
> The documentation content is licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). Commercial use (including paid courses or training materials) requires written permission.

*Built for the AI engineering community.*
