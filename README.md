<div align="center">

# 🧑‍💻 Claude Code 源码深度剖析笔记

[**🌐 English Version**](./README_en.md) | [**🇨🇳 中文版本**](./README.md)

[![Version](https://img.shields.io/badge/Claude_Code-v2.1.88-blue.svg?style=flat-square)](https://www.anthropic.com/claude-code)
[![Documentation](https://img.shields.io/badge/Docs-55_Articles-success.svg?style=flat-square)](#-目录大纲)
[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC_BY--NC_4.0-lightgrey.svg?style=flat-square)](https://creativecommons.org/licenses/by-nc/4.0/)
[![Status: Complete](https://img.shields.io/badge/Status-Complete-green.svg?style=flat-square)](#)

*面向工程面试复习与高级全栈源码学习的“硬核”分析笔记*<br>
*(基于 Claude Code v2.1.88 npm 发布包 source map 还原版本)*

</div>

<br/>

## 📖 项目简介

本项目是一套系统性解读 **Anthropic Claude Code (v2.1.88)** 内部引擎与架构的开源笔记。通过 8 个核心模块的切分，共产出 55 篇高质量的技术解析文档。旨在帮助深入理解当前顶尖前沿 AI Agent 框架的落地实现、交互架构与安全设计。

文档特点：
- 🔍 **源码级剖析**：深入到每一行关键代码的实现细节。
- 🏗️ **架构可视化**：大量的高质量 Mermaid 架构图、数据流图。
- 💡 **面试与思考 Q&A**：每篇文章均附带“设计决策”、“权衡与优化”等高频 Q&A，将理论与实战思考结合。
- 🇨🇳 **全中文语境**：降低深度技术的阅读门槛。

---

## 🗺️ 核心导读

若您是第一次来到本项目，强烈建议从总览开始阅读：
👉 **[00-全局架构总览](./00-全局架构总览.md)** —— 包含 7 大核心架构设计、宏观数据流以及模块依赖拓扑图。

## 📚 目录大纲 (55 篇全覆盖)

本项目依据源码的物理模块划分为了 8 大专区。你可以直接点击对应子目录查看深入的分析报告：

- 🚀 **[01-核心入口](./01-核心入口/)**：探究 CLI 引导程序、并行防抖启动机制与双路径路由引擎（MDM/Keychain）。
- 🛠️ **[02-工具系统](./02-工具系统/)**：揭秘 MCP 动态加载、BashTool 沙箱防御机制以及 ToolDef 工厂模式体系。
- ⚡️ **[03-命令系统](./03-命令系统/)**：解读三路优先级指令链、故障注入策略 (`bridge-kick`) 与缓存零痕迹 (`btw`) 处理。
- 🧠 **[04-Agent协调](./04-Agent协调/)**：核心剖析！QueryLoop 生命周期、强大的**四级上下文压缩流水线**及原子通知机制；**三层多 Agent 协作架构**（Swarm 进程内运行器、Coordinator 纯编排模式、Task 系统与权限传递）；**Fork 子 Agent 机制**与消息构建策略最大化 Prompt Cache 命中率。
- 🔌 **[05-扩展系统](./05-扩展系统/)**：掌握外部世界联动能力：插件联合分派机制、状态机技能设计以及组合键和弦输入。
- 🧱 **[06-服务与基础](./06-服务与基础/)**：全局视角：7级证书优先级的安全验证、Zod防向后循环引用以及不可变Store层；**System Prompt 分段缓存架构**（`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`、CLAUDE.md 层级发现、MCP 增量注入）；**四层上下文压缩策略**详解（工具结果截断/图片替换/Context Collapse/AutoCompact 互斥机制）。
- 🎨 **[07-UI与交互](./07-UI与交互/)**：React 19 自定义协调前端、Yoga WASM 高性能 Flex 布局以及确定性的 Buddy 伴侣算法。
- 🌐 **[08-网络与远程](./08-网络与远程/)**：探析 KAIROS 守护观察机制、BoundedUUIDSet 去重、Protobuf 定制化封包与上游代理隧道。
- 🛠️ **[09-实战指南](./09-实战指南/)**：基于源码架构的动手实践指南，从零搭建轻颗粒 Agent 客户端，覆盖 QueryLoop、工具系统、上下文压缩与流式输出的完整实现路径。

---

## 🤝 参与贡献 (Contributing)

本项目已完成 v2.1.88 的静态解构，但随着 Claude Code 的快速更新，我们非常欢迎社区的力量共同维护与进化本项目！

**你可以通过以下方式协助仓库的增长：**

1. **🌟 提交 Issue / 勘误**：遇到表述不清、代码更新或文档排版错误？请随时开 Issue！
2. **🔄 版本更新跟踪**：如果您抓取到了更新版本的 source map 差异，欢迎提 PR 来补充新特性的分析（例如新版 MCP 协议支持）。
3. **🎨 提供更好的 Demo 图**：在对应的章节提交具体的代码片段验证样例或运行截图。

*提交 PR 前请确保保持原有的 `“叙述 + QA + Mermaid”` 三段式排版规范。*

---

## 📝 TODO 列表

- [x] 撰写一份《用本文总结的架构搭建你自己的轻颗粒 Agent 客户端》的综合指南。→ [09-实战指南/01-搭建轻颗粒Agent客户端.md](./09-实战指南/01-搭建轻颗粒Agent客户端.md)

---

<div align="center">

> **版权声明**：源码版权归 [Anthropic](https://www.anthropic.com) 所有，本文档基于逆向/静态分析和学习研究编撰，不含直接盗用源码打包行为。<br>
> 文档内容本身采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议，未经书面许可不可用于任何形式的商业付费课程倒卖。

*Built with ❤️ for the AI Engineering Community.*

</div>
