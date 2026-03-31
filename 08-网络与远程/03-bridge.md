# bridge（IPC 桥接） — Claude Code 源码分析

> 模块路径：`src/bridge/`
> 核心职责：实现 Claude Code 本地 CLI 与 claude.ai Remote Control（CCR）云端平台之间的双向 IPC 桥接，通过轮询/WebSocket 接收工作任务并派生（spawn）子进程执行
> 源码版本：v2.1.88

## 一、模块概述

`src/bridge/` 是 Claude Code Remote Control 功能（`claude remote-control` / `claude bridge`）的核心实现。它将本地机器注册为 CCR 平台的一个 **环境（Environment）**，持续轮询云端分配的工作任务（Work），并为每个任务派生独立的 Claude Code 子进程执行。子进程通过 WebSocket（v1）或 SSE + CCRClient（v2）将消息流双向传递给 claude.ai 前端。

模块包含约 30 个文件，核心文件：
- `bridgeMain.ts`：桥接主循环 `runBridgeLoop()`
- `bridgeMessaging.ts`：消息处理工具：类型守卫、入站路由、控制请求处理、`BoundedUUIDSet` 环形缓冲去重
- `replBridgeTransport.ts`：传输层抽象（v1 HybridTransport / v2 SSETransport+CCRClient）
- `bridgeApi.ts`：CCR REST API 客户端封装
- `types.ts`：全量类型定义

---

## 二、架构设计

### 2.1 核心类/接口/函数

| 名称 | 类型 | 职责 |
|---|---|---|
| `runBridgeLoop()` | 函数 | 桥接主循环：注册环境、轮询工作、派生会话、管理生命周期 |
| `handleIngressMessage()` | 函数 | 解析入站 WebSocket 消息，路由到权限响应/控制请求/SDK消息处理器 |
| `handleServerControlRequest()` | 函数 | 响应服务端发起的控制请求（initialize、set_model、interrupt 等） |
| `BoundedUUIDSet` | 类 | 固定容量环形缓冲 UUID 集合，用于 echo 消息去重 |
| `ReplBridgeTransport` | 接口 | v1/v2 传输抽象：write/writeBatch/flush/connect/reportState |

### 2.2 模块依赖关系图

```
claude.ai Web Frontend
      │
      │  WebSocket / SSE
      ▼
CCR 云端平台 (api.anthropic.com)
      │ 环境注册 / 工作轮询
      │ POST /environments/{id}/work/{id}/heartbeat
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│                     src/bridge/                              │
│                                                              │
│  bridgeMain.ts                                               │
│   runBridgeLoop()                                            │
│    ├── registerBridgeEnvironment()  (注册本机为 CCR 环境)    │
│    ├── pollForWork()                (轮询工作任务)            │
│    ├── spawner.spawn()              (派生子进程)              │
│    └── heartbeatWork()             (维持任务租约)             │
│                                                              │
│  bridgeMessaging.ts                                          │
│    handleIngressMessage()  ─────────► replBridgeTransport    │
│    handleServerControlRequest()      (v1 WS / v2 SSE)        │
│    BoundedUUIDSet (echo 去重)                                 │
│                                                              │
│  sessionRunner.ts (派生子进程)                                │
│  jwtUtils.ts      (JWT 刷新调度)                             │
│  trustedDevice.ts (设备信任令牌)                             │
└─────────────────────────────────────────────────────────────┘
      │
      │ 子进程 stdin/stdout
      ▼
Claude Code 子进程 (--sdk-url / --input-format stream-json)
```

### 2.3 关键数据流

**工作分配与执行：**
```
CCR 平台
  → pollForWork() 返回 WorkResponse { id, data, secret }
  → decodeWorkSecret() 解码 base64url WorkSecret
  → 获取 api_base_url、session_ingress_token、mcp_config 等
  → spawner.spawn({ sessionId, sdkUrl, accessToken })
  → 子进程建立 WebSocket 连接到 session-ingress
  → 双向消息流通过 ReplBridgeTransport 传递
```

**入站消息路由：**
```
服务端 WebSocket 帧 (JSON)
  → handleIngressMessage(data, recentPostedUUIDs, recentInboundUUIDs, ...)
  → isSDKControlResponse?  → onPermissionResponse()
  → isSDKControlRequest?   → onControlRequest() → handleServerControlRequest()
  → isSDKMessage?
      UUID 在 recentPostedUUIDs? → 忽略（自己发的 echo）
      UUID 在 recentInboundUUIDs? → 忽略（重复投递）
      type === 'user' → recentInboundUUIDs.add(uuid) → onInboundMessage()
      其他 → logForDebugging 忽略
```

---

## 三、核心实现走读

### 3.1 关键流程（编号步骤）

**桥接启动与环境注册：**
1. `runBridgeLoop()` 接受 `BridgeConfig`（目录、机器名、分支、最大会话数等）
2. 调用 `api.registerBridgeEnvironment(config)` 获取 `environment_id` 和 `environment_secret`
3. 进入轮询循环：`api.pollForWork(environmentId, environmentSecret, signal)`
4. 收到 `WorkResponse` 后解码 `WorkSecret`，提取会话参数
5. 调用 `spawner.spawn()` 派生子进程，返回 `SessionHandle`
6. 每 30 秒调用 `api.heartbeatWork()` 延续任务租约
7. 子进程结束时调用 `api.stopWork()` 释放任务

**控制请求处理（服务端 → REPL）：**
1. claude.ai 发起 `control_request { subtype: 'initialize' }`
2. `handleServerControlRequest()` 构造响应：包含 `commands: []`、`pid: process.pid`
3. claude.ai 发起 `set_model` → 调用 `onSetModel` 回调切换模型
4. claude.ai 发起 `interrupt` → 调用 `onInterrupt` 中断当前任务
5. 所有响应通过 `transport.write(event)` 写回服务端

### 3.2 重要源码片段（带中文注释）

**入站消息路由（`src/bridge/bridgeMessaging.ts`）：**
```typescript
export function handleIngressMessage(
  data: string,
  recentPostedUUIDs: BoundedUUIDSet,   // 我方发出的 UUID（过滤 echo）
  recentInboundUUIDs: BoundedUUIDSet,  // 已处理的入站 UUID（过滤重复投递）
  onInboundMessage: ..., onPermissionResponse?: ..., onControlRequest?: ...,
): void {
  const parsed = normalizeControlMessageKeys(jsonParse(data))

  if (isSDKControlResponse(parsed)) {
    onPermissionResponse?.(parsed)
    return
  }
  if (isSDKControlRequest(parsed)) {
    // 服务端要求必须在 ~10-14s 内响应，否则 WS 被断开
    onControlRequest?.(parsed)
    return
  }
  if (!isSDKMessage(parsed)) return

  const uuid = 'uuid' in parsed ? parsed.uuid : undefined
  if (uuid && recentPostedUUIDs.has(uuid)) return  // 自己发的，忽略 echo
  if (uuid && recentInboundUUIDs.has(uuid)) return  // 已处理过，忽略重复

  if (parsed.type === 'user') {
    if (uuid) recentInboundUUIDs.add(uuid)
    void onInboundMessage?.(parsed)  // fire-and-forget（可能含 async 附件解析）
  }
}
```

**BoundedUUIDSet 环形缓冲（`src/bridge/bridgeMessaging.ts`）：**
```typescript
export class BoundedUUIDSet {
  private readonly ring: (string | undefined)[]
  private readonly set = new Set<string>()
  private writeIdx = 0

  add(uuid: string): void {
    if (this.set.has(uuid)) return
    // 淘汰最老的条目（FIFO 语义）
    const evicted = this.ring[this.writeIdx]
    if (evicted !== undefined) this.set.delete(evicted)
    this.ring[this.writeIdx] = uuid
    this.set.add(uuid)
    this.writeIdx = (this.writeIdx + 1) % this.capacity  // 循环写指针
  }
}
```

**控制请求响应（`src/bridge/bridgeMessaging.ts`）：**
```typescript
case 'initialize':
  response = {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: request.request_id,
      response: {
        commands: [],          // REPL 自己处理命令，不暴露给服务端
        output_style: 'normal',
        models: [],            // 模型信息由 REPL 管理
        account: {},
        pid: process.pid,      // 进程 ID 供服务端调试用
      },
    },
  }
  break
```

### 3.3 设计模式分析

- **命令模式**：`handleServerControlRequest()` 将服务端的 `control_request` 按 `subtype` 分发到对应的处理逻辑，并通过统一接口返回 `control_response`，与命令模式的调度者-接收者分离相符
- **策略模式**：`ReplBridgeTransport` 接口隔离 v1（HybridTransport）和 v2（SSETransport + CCRClient）的实现差异，调用方（replBridge）无需感知版本
- **令牌桶（环形缓冲）**：`BoundedUUIDSet` 以固定内存实现 O(1) 的 add/has 操作，是标准环形缓冲（Circular Buffer）数据结构在消息去重场景的应用

---

## 四、高频面试 Q&A

### 设计决策题

**Q1：为什么对入站 `control_request` 必须在 10-14 秒内响应？**

这是 CCR 平台的服务端超时机制：若 REPL 不响应 `initialize` 等控制请求，服务端认为客户端已断线并强制关闭 WebSocket。这是一种健康检查设计——确保连接的 REPL 实例是活跃可交互的，而不仅仅是网络层连通。`outboundOnly` 模式仍然对 `initialize` 响应成功（其他操作返回错误），正是因为不响应会导致连接被断开，从而失去消息接收能力。

**Q2：`recentPostedUUIDs` 和 `recentInboundUUIDs` 分别解决什么问题？**

- `recentPostedUUIDs`：存储本地发出消息的 UUID。服务端将所有消息广播给同一会话的所有订阅者（包括发送者自己），防止 REPL 将自己发出的消息作为"新消息"重复处理（echo 回声）。
- `recentInboundUUIDs`：存储已成功处理的入站消息 UUID。在 transport swap（切换传输层）时服务端会重放历史消息，通过记录已处理 UUID 防止同一条用户消息被重复执行（如重复调用工具）。

### 原理分析题

**Q3：`WorkSecret` 为什么采用 base64url JSON 而非直接在 API 响应中返回字段？**

`WorkSecret` 包含敏感信息（`session_ingress_token`、API 密钥等），通过 base64url 编码的字符串字段传递有两个好处：① 服务端可在不修改 API 字段定义的情况下向 secret 添加新字段（向后兼容）；② 日志、监控工具在记录 API 响应时难以直接读取其内容（增加了一层混淆）。

**Q4：心跳（heartbeatWork）为什么用 SessionIngressAuth 而不是 EnvironmentSecretAuth？**

心跳是高频操作（每 30 秒一次），`SessionIngressAuth` 使用 JWT 令牌（无 DB 查询）验证，延迟更低；`EnvironmentSecretAuth` 需要数据库查找环境记录，开销更大。`SESSION_INGRESS_TOKEN` 绑定到具体会话，粒度更细，也符合最小权限原则——心跳只需证明"我持有这个会话的令牌"。

**Q5：`BackoffConfig` 为什么分 `conn*` 和 `general*` 两组参数？**

连接重建（WebSocket 断开后重连）和一般性错误重试的语义不同：连接重建通常需要更长的等待（避免 SYN flood），上限 2 分钟、放弃时间 10 分钟；一般性 API 错误（如 409 冲突）可以更快重试（初始 500ms、上限 30 秒）。分离配置使测试时可以单独调整两类退避行为，而不影响另一个。

### 权衡与优化题

**Q6：`BoundedUUIDSet` 的容量如何选择？**

容量必须大于在"窗口时间"内可能并发的消息数量。对于 bridge 场景，echo 去重需覆盖从发送到收到回声的 RTT（通常 < 1 秒），按 100 条/秒的消息速率，容量 128 即可。`recentInboundUUIDs` 需覆盖 transport swap 的窗口（通常 < 30 秒的历史），按低速率 10 条/分钟，容量 64 足够。选择 2 的幂次（64/128）使模运算高效。

**Q7：为什么 `onInboundMessage` 使用 `void` 而不是 `await`？**

入站消息处理可能含异步操作（如附件 URL 解析，需要 HTTP 请求），若 `await`，消息处理器会阻塞 WebSocket 的 message 事件循环，导致后续消息积压。使用 `void` 让处理函数异步执行，WebSocket 可立即处理下一条消息。错误处理由处理函数内部的 `try-catch` 负责，不影响主循环。

### 实战应用题

**Q8：如何为 bridge 模块添加多环境支持（同一机器注册为多个 CCR 环境）？**

当前 `runBridgeLoop()` 是单环境模型。扩展方案：① 为每个目录/Git 仓库调用一次 `runBridgeLoop()`，各自持有独立的 `environmentId`；② 共享同一个 `BridgeApiClient`（无状态）和 `spawner`（有状态，需加锁）；③ 在 `bridgeMain.ts` 外层添加环境发现逻辑（如扫描 `~/workspace/*` 的 git 仓库）；④ GrowthBook Gate `tengu_ccr_bridge_multi_environment` 已存在对应的功能开关。

**Q9：在网络抖动频繁的环境中，如何优化 bridge 的稳定性？**

1. 调小 `BackoffConfig.connInitialMs`（如 500ms）以更快重连，同时调大 `connCapMs`（如 5 分钟）以避免过于频繁的重连冲击；
2. 在 `runBridgeLoop()` 中检测系统睡眠（通过比较定时器实际间隔与预期间隔），睡眠唤醒后立即重置错误计数并重连（代码中 `pollSleepDetectionThresholdMs` 已实现此逻辑）；
3. 对 heartbeat 失败引入指数退避，避免在网络恢复瞬间洪泛 API；
4. 增加 `onReconnected` 事件统计 MTTR（平均恢复时间），接入可观测性系统。

---
> **版权声明**：源码版权归 [Anthropic](https://www.anthropic.com) 所有，本文档基于 Claude Code v2.1.88 source map 还原版本分析，仅供学习研究使用。文档内容采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) 协议。
