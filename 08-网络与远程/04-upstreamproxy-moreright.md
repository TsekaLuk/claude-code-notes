# upstreamproxy 与 moreright — Claude Code 源码分析

> 模块路径：`src/upstreamproxy/`、`src/moreright/`
> 核心职责：`upstreamproxy` 在 CCR 容器内建立 CONNECT-over-WebSocket 代理中继，使容器内的 agent 子进程能通过受控出口访问外部网络；`moreright` 提供内部专有扩展钩子的对外存根
> 源码版本：v2.1.88

## 一、模块概述

### upstreamproxy

CCR 会话容器运行在严格的网络隔离环境中，直接出站流量受限。`upstreamproxy` 模块在容器内建立一条从本地 TCP 端口到 CCR 上游代理服务的 WebSocket 隧道，原理类似 HTTP CONNECT 代理，但使用 WebSocket 作为传输层（因为 GKE L7 ingress 不支持原生 CONNECT）。

代理中继启动后，所有子进程（Bash 工具、MCP 服务器、Python 脚本等）通过环境变量 `HTTPS_PROXY` 透明使用该代理，无需感知代理存在。上游服务在 MITM TLS 后可注入组织配置的凭证（如 Datadog API Key）。

### moreright

`moreright` 是 Claude Code 内部专有功能的扩展点钩子（如高级工具调用前/后处理逻辑），其真实实现仅存在于 Anthropic 内部构建中。公开发布版本中该目录只提供一个**函数签名完全匹配的存根（stub）**，使外部构建可以正常编译，同时内部构建可通过 overlay 替换为真实实现。

---

## 二、架构设计

### 2.1 核心类/接口/函数

| 名称 | 类型 | 职责 |
|---|---|---|
| `initUpstreamProxy()` | 函数 | 初始化代理：读取 token、下载 CA 证书、启动中继服务 |
| `getUpstreamProxyEnv()` | 函数 | 返回子进程需要的代理环境变量集合（HTTPS_PROXY、SSL_CERT_FILE 等） |
| `startUpstreamProxyRelay()` | 函数 | 启动本地 TCP 监听器，建立 CONNECT→WebSocket 中继 |
| `encodeChunk()` / `decodeChunk()` | 函数 | 手工 Protobuf 编解码（`UpstreamProxyChunk { bytes data = 1 }`） |
| `useMoreRight()` | 函数（存根） | 返回空操作钩子对象：`onBeforeQuery`、`onTurnComplete`、`render` |

### 2.2 模块依赖关系图

```
┌────────────────────────────────────────────────────────────────┐
│                  src/upstreamproxy/                             │
│                                                                 │
│  initUpstreamProxy()          （init.ts 调用一次）              │
│    ├── 检查 CLAUDE_CODE_REMOTE + CCR_UPSTREAM_PROXY_ENABLED     │
│    ├── readToken(/run/ccr/session_token)                        │
│    ├── setNonDumpable()   (prctl PR_SET_DUMPABLE=0)             │
│    ├── downloadCaBundle() (GET /v1/code/upstreamproxy/ca-cert)  │
│    ├── startUpstreamProxyRelay({ wsUrl, sessionId, token })     │
│    │     ├── Bun.listen (Bun 运行时)                            │
│    │     └── net.createServer (Node 运行时)                     │
│    └── unlink(/run/ccr/session_token)  (清理 token 文件)        │
│                                                                 │
│  getUpstreamProxyEnv()   → 子进程继承代理配置                   │
│                                                                 │
│  relay.ts                                                       │
│    handleData()  → 解析 CONNECT 请求 → openTunnel()            │
│    openTunnel()  → WebSocket → encodeChunk/decodeChunk          │
└───────────────────────────────┬─────────────────────────────────┘
                                │ 127.0.0.1:<ephemeral_port>
                ┌───────────────▼──────────────┐
                │  子进程 (Bash/Python/MCP)     │
                │  HTTPS_PROXY=http://127.0.0.1 │
                └──────────────────────────────┘
                                │ HTTP CONNECT
                                ▼
                   WebSocket Tunnel (Protobuf)
                                │
                                ▼
                  CCR 上游代理服务 (GKE 集群内)
                                │
                                ▼
                       目标 HTTPS 服务
```

```
┌──────────────────────────────────────────────────────────┐
│  src/moreright/useMoreRight.tsx                           │
│  （公开存根 / external-stubs overlay）                    │
│                                                          │
│  useMoreRight({ enabled, setMessages, ... })             │
│    → { onBeforeQuery: async () => true,                  │
│         onTurnComplete: async () => {},                  │
│         render: () => null }                             │
│                                                          │
│  ← 内部构建通过 overlay 替换为真实钩子实现               │
└──────────────────────────────────────────────────────────┘
```

### 2.3 关键数据流

**上游代理隧道建立流程：**
```
容器启动
  → initUpstreamProxy() 检查环境变量
  → 读取 /run/ccr/session_token
  → prctl(PR_SET_DUMPABLE, 0)  防 ptrace 内存转储
  → GET baseUrl/v1/code/upstreamproxy/ca-cert  下载 MITM CA 证书
  → 拼接系统 CA + MITM CA → ~/.ccr/ca-bundle.crt
  → startUpstreamProxyRelay()  绑定本地随机端口
  → unlink(/run/ccr/session_token)  token 仅留在堆内存
  → getUpstreamProxyEnv() 返回代理环境变量

子进程发起 HTTPS 请求
  → HTTPS_PROXY 拦截 → 连接到本地中继端口
  → 发送 HTTP CONNECT <target_host:443>
  → 中继解析 CONNECT，openTunnel() 建立 WebSocket 连接到 CCR 代理
  → 后续字节以 UpstreamProxyChunk protobuf 帧传输
  → CCR 代理 MITM TLS，注入凭证，转发到目标服务
```

---

## 三、核心实现走读

### 3.1 关键流程（编号步骤）

**CONNECT → WebSocket 协议转换：**
1. 本地 TCP 监听器接受客户端连接（来自 curl/Python/Node 等）
2. 积累字节直到收到完整 `CONNECT <host:port> HTTP/1.x\r\n\r\n`（CRLFCRLF 边界）
3. 提取目标地址，调用 `openTunnel()` 建立 WebSocket 连接到 CCR 代理端点
4. WebSocket 握手成功后，发送含 `CONNECT` 行和 `Proxy-Authorization` 的首包（帧）
5. 后续客户端字节按 512KB 分片，每片用 `encodeChunk()` 编码为 Protobuf 帧发送
6. 服务端返回的 Protobuf 帧经 `decodeChunk()` 解码后转发给客户端
7. 任一侧关闭时清理 WebSocket 和定时器

**Protobuf 手工编码原理：**

协议定义：`message UpstreamProxyChunk { bytes data = 1; }`

```
Wire 格式：
  字节 0:    0x0a  (field_number=1, wire_type=2 即 LEN)
  字节 1-n:  varint 编码的 data 字节长度
  字节 n+1+: 实际数据字节
```

### 3.2 重要源码片段（带中文注释）

**CA 证书下载与合并（`src/upstreamproxy/upstreamproxy.ts`）：**
```typescript
async function downloadCaBundle(baseUrl, systemCaPath, outPath): Promise<boolean> {
  const resp = await fetch(`${baseUrl}/v1/code/upstreamproxy/ca-cert`, {
    signal: AbortSignal.timeout(5000),  // 5s 超时，防止阻塞 CLI 启动
  })
  if (!resp.ok) return false
  const ccrCa = await resp.text()
  const systemCa = await readFile(systemCaPath, 'utf8').catch(() => '')
  await mkdir(join(outPath, '..'), { recursive: true })
  // 将系统 CA + CCR MITM CA 合并为单文件，供所有运行时（Node/Python/curl）使用
  await writeFile(outPath, systemCa + '\n' + ccrCa, 'utf8')
  return true
}
```

**Protobuf 手工编码（`src/upstreamproxy/relay.ts`）：**
```typescript
export function encodeChunk(data: Uint8Array): Uint8Array {
  const len = data.length
  const varint: number[] = []
  let n = len
  while (n > 0x7f) {          // varint 编码：每字节 7 位有效位
    varint.push((n & 0x7f) | 0x80)  // 最高位 1 表示还有后续字节
    n >>>= 7
  }
  varint.push(n)  // 最后一个字节最高位 0 表示结束
  const out = new Uint8Array(1 + varint.length + len)
  out[0] = 0x0a    // field 1, wire type 2 (LEN)
  out.set(varint, 1)
  out.set(data, 1 + varint.length)
  return out
}
```

**进程内存保护（`src/upstreamproxy/upstreamproxy.ts`）：**
```typescript
function setNonDumpable(): void {
  if (process.platform !== 'linux' || typeof Bun === 'undefined') return
  try {
    const ffi = require('bun:ffi')
    const lib = ffi.dlopen('libc.so.6', {
      prctl: { args: ['int', 'u64', 'u64', 'u64', 'u64'], returns: 'int' },
    })
    const PR_SET_DUMPABLE = 4
    // 禁止同 UID 进程 ptrace 本进程，防止提示注入攻击通过 gdb 读取堆内存中的 token
    lib.symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n)
  } catch { /* 非 Linux 或无 libc，静默跳过 */ }
}
```

**moreright 存根（`src/moreright/useMoreRight.tsx`）：**
```typescript
// 公开构建的空操作存根——内部构建通过 overlay 替换真实实现
export function useMoreRight(_args: {
  enabled: boolean
  setMessages: (action: M[] | ((prev: M[]) => M[])) => void
  inputValue: string
  setInputValue: (s: string) => void
  setToolJSX: (args: M) => void
}): {
  onBeforeQuery: (input: string, all: M[], n: number) => Promise<boolean>
  onTurnComplete: (all: M[], aborted: boolean) => Promise<void>
  render: () => null
} {
  return {
    onBeforeQuery: async () => true,   // 总是允许继续
    onTurnComplete: async () => {},    // 空操作
    render: () => null,                 // 不渲染任何内容
  }
}
```

### 3.3 设计模式分析

**upstreamproxy：**
- **外观模式（Facade）**：`initUpstreamProxy()` 和 `getUpstreamProxyEnv()` 是整个子系统的统一入口，隐藏了 token 读取、CA 合并、TCP 监听器、WebSocket 连接等复杂细节
- **责任链（隐式）**：代理处理分两阶段——`handleData()` 在收到完整 CONNECT 头前缓冲积累，之后进入 tunnel 阶段直接转发字节，类似责任链的状态切换
- **适配器模式**：将 HTTP CONNECT 协议适配为 WebSocket + Protobuf 传输，使 GKE L7 ingress 无需修改即可承载 CONNECT 流量

**moreright：**
- **空对象模式（Null Object Pattern）**：存根返回的对象实现了完整接口但所有方法均为空操作，使调用方无需空值检查，符合"面向接口编程"
- **覆盖层（Overlay）模式**：通过构建时的文件覆盖（overlay）机制在同一源码结构下区分公开版和内部版，是 monorepo 多构建目标的常见手段

---

## 四、高频面试 Q&A

### 设计决策题

**Q1：为什么不直接用 HTTP CONNECT 代理，而要额外封装一层 WebSocket 隧道？**

CCR 容器运行在 GKE（Google Kubernetes Engine）集群中，通过 L7 HTTP 负载均衡（Envoy/Istio）路由流量。L7 代理以 HTTP 请求为粒度处理流量，HTTP CONNECT 请求在 L7 层会被拦截或拒绝（L7 负载均衡不支持 CONNECT 方法的透明透传，需要 L4 TCP 代理）。WebSocket 升级（`Upgrade: websocket`）则是 L7 代理普遍支持的协议，因此将隧道包装在 WebSocket 连接中是最小改动的兼容方案。

**Q2：为什么选择手工编码 Protobuf 而不使用 `protobufjs` 库？**

`UpstreamProxyChunk` 只有一个字段 `bytes data = 1`，是最简单的 Protobuf 消息。手工编码的实现只需约 15 行，避免引入一个重量级运行时依赖（`protobufjs` 完整包约 500KB）。该模块是热路径（每次网络请求都会调用），手工编码也消除了库的 object allocation 和 schema 查找开销。代码注释中明确说明了 Protobuf wire format，可读性和可维护性均可接受。

### 原理分析题

**Q3：为什么在启动中继前读取 token，启动成功后才删除 token 文件？**

这是故障恢复设计：token 文件删除是不可逆操作。若 CA 证书下载失败或 TCP 监听器绑定失败，token 文件仍在磁盘上，容器重启后（supervisor 重试）可再次读取并重试初始化。若先删文件后启动监听器，一旦监听器失败就永久丢失 token，无法恢复。"成功后清理"（commit-then-cleanup）是分布式系统中确保幂等性的标准模式。

**Q4：`NO_PROXY_LIST` 为什么要以三种形式（`anthropic.com`、`.anthropic.com`、`*.anthropic.com`）列出同一域名？**

不同运行时和工具对 NO_PROXY 的解析规则不同：
- `*.anthropic.com`：Bun、curl、Go 的 glob 匹配
- `.anthropic.com`：Python urllib/httpx 的前缀匹配（自动去掉前导点匹配子域）
- `anthropic.com`：顶级域名兜底

三种形式确保 Anthropic API 请求在任何运行时都不经过代理，防止 MITM 截断对 Anthropic 的调用（Python 的 certifi 不信任 CCR 的伪造 CA）。

**Q5：`setNonDumpable()` 如何防止提示注入攻击窃取 session token？**

攻击场景：提示注入的指令让 agent 执行 `gdb -p $PPID` 附加到父进程（Claude Code），然后在进程堆内存中搜索 `session_token` 字符串并读取其值。调用 `prctl(PR_SET_DUMPABLE, 0)` 后，Linux 内核拒绝同 UID 的进程对该进程发起 `ptrace`（即使是 root 也需要 `CAP_SYS_PTRACE`），`gdb` 无法附加。Token 文件被 `unlink` 后文件系统层面也不可读。双重防护使 token 在整个会话期间仅存在于受保护的堆内存中。

### 权衡与优化题

**Q6：每次 HTTPS 请求都建立新的 WebSocket 连接，性能如何？**

当前实现对每个 `CONNECT` 请求创建一个独立的 WebSocket 连接（`openTunnel()` 中的 `new WebSocket()`）。对于 Datadog metrics 上报（低频）等场景，这个开销可接受；对于高频 API 调用（如 npm install），每次请求都需要完整的 WebSocket 握手（TCP + TLS + HTTP Upgrade），增加约 50-100ms 延迟。可优化点：实现 WebSocket 连接池，但需处理目标地址复用的正确性和连接活跃度管理。

**Q7：upstreamproxy 对子进程"fail open"（失败不阻塞）的设计有什么代价？**

优点：代理初始化失败（如 CA 证书下载超时）不会阻止 agent 会话启动，保证了服务可用性。代价：若代理静默失败，子进程发起的 HTTPS 请求会因 `HTTPS_PROXY` 指向不存在的地址而挂起（无法连接到本地代理端口），实际表现为工具调用超时，而非明确的错误消息，增加排查难度。

### 实战应用题

**Q8：如何为 upstreamproxy 添加对 HTTP（非 HTTPS）流量的支持？**

当前设计明确只代理 HTTPS（注释说明 HTTP 无凭证注入需求且路由到代理会导致 405）。若需要代理 HTTP（如某些内网 CI 服务），需要：① 在 `relay.ts` 中识别非 CONNECT 请求（GET/POST 等方法）；② 对 HTTP 请求用 WebSocket 帧传递完整的 HTTP 请求/响应字节；③ CCR 服务端实现对应的 HTTP 转发逻辑；④ 在 `getUpstreamProxyEnv()` 中额外设置 `HTTP_PROXY`/`http_proxy`。

**Q9：moreright 的 overlay 机制如何保证公开构建与内部构建的类型兼容性？**

存根文件与内部实现必须保持相同的函数签名（TypeScript 接口）。构建时通过 `tsconfig.paths` 或构建工具（Bun bundle）的 alias 配置，将 `src/moreright/` 指向内部实现目录。TypeScript 编译会对两套实现独立进行类型检查：存根文件的类型注解定义了契约，内部实现若偏离契约则编译失败，确保 API 兼容性。

---
> **版权声明**：源码版权归 [Anthropic](https://www.anthropic.com) 所有，本文档基于 Claude Code v2.1.88 source map 还原版本分析，仅供学习研究使用。文档内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议。
