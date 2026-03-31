<div align="center">

# 🧑‍💻 Claude Code Source Code Deep Dive Notes

[**🌐 English Version**](./README_en.md) | [**🇨🇳 中文版本**](./README.md)

[![Version](https://img.shields.io/badge/Claude_Code-v2.1.88-blue.svg?style=flat-square)](https://www.anthropic.com/claude-code)
[![Documentation](https://img.shields.io/badge/Docs-50_Articles-success.svg?style=flat-square)](#-table-of-contents)
[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC_BY--NC_4.0-lightgrey.svg?style=flat-square)](https://creativecommons.org/licenses/by-nc/4.0/)
[![Status: Complete](https://img.shields.io/badge/Status-Complete-green.svg?style=flat-square)](#)

*A "hardcore" analytical reading note aimed at engineering interview reviews and advanced full-stack source code learning*<br>
*(Based on the Claude Code v2.1.88 npm published package source map restored version)*

</div>

<br/>

## 📖 Project Introduction

This project is an open-source set of notes systematically interpreting the internal engine and architecture of **Anthropic Claude Code (v2.1.88)**. By dividing it into 8 core modules, a total of 50 high-quality technical analysis documents have been produced. It aims to help deeply understand the implementation, interaction architecture, and security design of current top-tier cutting-edge AI Agent frameworks.

Document Features:
- 🔍 **Source Code-Level Analysis**: Delves into the implementation details of every critical line of code.
- 🏗️ **Architecture Visualization**: A large number of high-quality Mermaid architecture diagrams and data flow diagrams.
- 💡 **Interview & Thinking Q&A**: Each article comes with high-frequency Q&As such as "Design Decisions", "Trade-offs and Optimizations", combining theory with practical thinking.
- 🇨🇳 **Full Chinese Context**: Lowers the reading threshold for in-depth technology.

---

## 🗺️ Core Guide

If this is your first time visiting this project, it is highly recommended to start with the overview:
👉 **[00-Global Architecture Overview](./00-全局架构总览.md)** —— Contains the 7 core architecture designs, macro data flow, and module dependency topology graph.

## 📚 Table of Contents (50 Articles Full Coverage)

This project is divided into 8 major areas based on the physical module division of the source code. You can directly click on the corresponding subdirectories to view in-depth analysis reports:

- 🚀 **[01-Core Entry](./01-核心入口/)**: Explores the CLI bootstrap program, parallel debounce startup mechanism, and dual-path routing engine (MDM/Keychain).
- 🛠️ **[02-Tool System](./02-工具系统/)**: Uncovers MCP dynamic loading, BashTool sandbox defense mechanisms, and the ToolDef factory pattern system.
- ⚡️ **[03-Command System](./03-命令系统/)**: Interprets the three-way priority instruction chain, fault injection strategy (`bridge-kick`), and cache zero-trace (`btw`) processing.
- 🧠 **[04-Agent Coordination](./04-Agent协调/)**: Core analysis! The QueryLoop lifecycle, powerful **four-level context compression pipeline**, and atomic notification mechanism.
- 🔌 **[05-Extension System](./05-扩展系统/)**: Masters external world linkage capabilities: plugin joint dispatch mechanism, state machine skill design, and chord key inputs.
- 🧱 **[06-Services & Infrastructure](./06-服务与基础/)**: Global perspective: 7-level certificate priority security verification, Zod anti-backward circular references, and immutable Store layer.
- 🎨 **[07-UI & Interaction](./07-UI与交互/)**: React 19 custom reconciliation frontend, Yoga WASM high-performance Flex layout, and deterministic Buddy companion algorithm.
- 🌐 **[08-Network & Remote](./08-网络与远程/)**: Analyzes KAIROS daemon observation mechanism, BoundedUUIDSet deduplication, Protobuf customized packetization, and upstream proxy tunnels.

---

## 🤝 Contributing

This project has completed the static deconstruction of v2.1.88, but with the rapid updates of Claude Code, we strongly welcome the power of the community to jointly maintain and evolve this project!

**You can help grow the repository in the following ways:**

1. **🌟 Submit Issues / Errata**: Encountered unclear expressions, code updates, or document formatting errors? Please feel free to open an Issue!
2. **🔄 Version Update Tracking**: If you have captured the source map differences of an updated version, you are welcome to submit a PR to supplement the analysis of new features (e.g., new MCP protocol support).
3. **🎨 Submit Agent Practice Designs**: Submit your own Agent practice design with a Demo image to be included in the notes.

*Before submitting a PR, please make sure to maintain the original `"Narrative + QA + Mermaid"` three-part layout specification.*

---

## 📝 TODO List

- [ ] Follow up on architectural evolution updates for `v3.x` / `v2.2.x` versions.
- [ ] Write a comprehensive guide on "Building Your Own Lightweight Agent Client Using the Architecture Summarized in This Document".
- [ ] Provide English versions for all documents (assistance welcomed).

---

<div align="center">

> **Copyright Notice**: The source code copyright belongs to [Anthropic](https://www.anthropic.com). This document is compiled based on reverse engineering/static analysis and learning research, and does not involve direct misappropriation of source code for packaging.<br>
> The document content itself uses the [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) license, and cannot be used for any form of commercial paid course resale without written permission.

*Built with ❤️ for the AI Engineering Community.*

</div>
