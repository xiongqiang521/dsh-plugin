# acp4idea

给 DeepSeek Harness (dsh) 用的 **Agent Client Protocol (ACP) v1** 服务端 bundle。
它把 dsh 变成一个编码 Agent，让 IntelliJ IDEA、Zed 以及任何 ACP v1 客户端都能通过
stdio 驱动它。

- IDEA（或 Zed）是 ACP *客户端*；dsh 是 ACP *服务端/Agent*。
- 一条长驻的 JSON-RPC 2.0 流，走 stdin/stdout（换行分隔的 JSON）。
- 每个 ACP 会话对应一个真实的 dsh Agent，通过 dsh-headless 所用的同一个核心
  注册表（ctx.agents）创建，并以 session/update 事件流式回传给 IDE。

## 架构

```
IDEA (ACP client)
   |  JSON-RPC 2.0 over stdio
   v
bin/acp4idea.js ---> dsh --profile acp
                      |
                      +-- src/acp/transport.ts         组帧 + JSON-RPC 分发
                      +-- src/acp/server.ts            initialize / session/* 处理器
                      +-- src/bridge/dsh-agent-bridge.ts  ctx.agents 工厂
                      +-- src/bridge/event-map.ts         session 事件 -> ACP 更新
```

| 层 | 文件 | 职责 |
|----|------|------|
| 传输 | src/acp/transport.ts | stdio 上的 JSON-RPC 2.0，请求/响应关联 |
| 协议类型 | src/acp/types.ts | ACP v1 线格式类型 + 方法名常量 |
| 服务端 | src/acp/server.ts | initialize、session/new、session/prompt、session/stop、session/cancel、session/update |
| Agent 桥接 | src/bridge/dsh-agent-bridge.ts | 每个 ACP 会话对应一个 dsh Agent（ctx.agents） |
| 事件映射 | src/bridge/event-map.ts | dsh session 事件 -> ACP session 更新 |
| 插件入口 | src/index.ts | Cordis 插件：name / inject / apply / Config |
| Bundle patch | cordis.patch.yml | 把插件挂载到 dsh-base 之上（headless 风格） |

## 协议映射（dsh -> ACP）

| dsh session 事件 | ACP session/update |
|------------------|--------------------|
| assistant/message（文本） | agent_message_chunk |
| assistant/message（推理） | agent_thought_chunk |
| tool/call | tool_call（in_progress） |
| tool/result | tool_call_update（completed / failed） |
| todo/write | plan |

停止原因由 turn/end 的 reason 折算：
completed -> end_turn，aborted -> cancelled，max-tokens -> max_tokens，其余 -> end_turn。

## 构建

```sh
pnpm install
pnpm build   # tsc -> lib/
```

## 安装到 dsh

acp4idea 是一个 dsh *bundle*（它声明了 dsh.bundle.patch）。创建一个专用 profile，
其 bundle 栈为 dsh-base + acp4idea：

```sh
# 创建 ~/.dsh/profiles/acp（含 dsh-base），然后加入本 bundle
dsh plugin --profile acp add @deepseek-ai/dsh-acp4idea
```

随后 ACP 服务端由以下命令启动：

```sh
dsh --profile acp
```

或等价地，用自带的包装器：

```sh
acp4idea    # bin/acp4idea.js
```

## 让 IntelliJ IDEA 接入

1. 安装/升级 IntelliJ IDEA 并启用 JetBrains AI Assistant 插件（2025.3+）。
2. 在 AI Assistant 的 ACP 设置里，新增一个自定义 Agent，启动命令任选其一：

   - Windows（dsh 是 .ps1/.cmd 脚本，必须用 cmd.exe 包装，否则 IDEA 的
     CreateProcess 直接执行脚本会报 error 193）：
     `cmd /c dsh --profile acp`
   - 任意系统最直接（node 直接跑 dsh 的 JS 入口，不经过脚本 shim）：
     `node C:\\nvm4w\\nodejs\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile acp`
   - 或用自带的包装器：`bin/acp4idea.js` 的绝对路径
     （包装器在 Windows 上会自动用 cmd.exe 解析 shim）。

   务必带上 `--profile acp`：IDEA 会原样启动该命令，而 dsh 必须指定 profile
   （裸 `dsh` 会直接报错）。

3. 打开项目，选中该 Agent，开始对话。参见 JetBrains 官方文档：
   https://www.jetbrains.com/help/ai-assistant/acp.html

说明：

- 环境变量 DSH_BIN / DSH_ACP_PROFILE 可覆盖包装器的命令与 profile。
- 和其它 dsh 界面一样，dsh profile 需要已配置模型；默认模型选择读取自
  ctx.agentDefaultModel。

## 范围与扩展点

首个版本在 dsh 本机本地运行工具（bash / pwsh / fs），并把完整对话流式回传给 IDE。
ACP 的客户端委托面（fs/read_text_file、fs/write_text_file、terminal/*）已在
transport/server 中实现为带类型的辅助方法，但尚未接入 dsh 的工具执行器；后续的
工具拦截层可以把 dsh 的工具调用路由到 IDE，从而让编辑与终端在 IDE 中原生呈现。

## 参考

- Agent Client Protocol：https://agentclientprotocol.com
- JetBrains ACP：https://www.jetbrains.com/help/ai-assistant/acp.html
- dsh-headless（本 bundle 对齐的一次性驱动示例）：@deepseek-ai/dsh-headless
