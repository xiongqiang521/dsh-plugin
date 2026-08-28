# acp4idea

给 DeepSeek Harness (dsh) 用的 **Agent Client Protocol (ACP) v1** 服务端 bundle。
它把 dsh 变成一个编码 Agent，让 IntelliJ IDEA、Zed 以及任何 ACP v1 客户端都能通过
stdio 驱动它。

- IDEA（或 Zed）是 ACP *客户端*；dsh 是 ACP *服务端/Agent*。
- 一条长驻的 JSON-RPC 2.0 流，走 stdin/stdout（换行分隔的 JSON）。
- 每个 ACP 会话对应一个真实的 dsh Agent，通过 dsh-headless 所用的同一个核心
  注册表（ctx.agents）创建，并以 session/update 事件流式回传给 IDE。

适配器设计参考了 [svkozak/pi-acp](https://github.com/svkozak/pi-acp)：流式增量在
到达客户端前先合并，按会话累计 token 用量并上报，prompt 回合显式排队且支持取消，
线上消息形状与官方 ACP schema 一致。

## 架构

```
IDEA (ACP client)
   |  JSON-RPC 2.0 over stdio
   v
bin/acp4idea.js ---> dsh --profile acp
                      |
                      +-- src/acp/transport.ts           组帧 + JSON-RPC 分发
                      +-- src/acp/server.ts              initialize / session/* 处理器
                      +-- src/acp/session-update-pump.ts 流式增量合并投递（25ms / 8KiB）
                      +-- src/bridge/dsh-agent-bridge.ts ctx.agents 工厂、排队、用量
                      +-- src/bridge/event-map.ts        session 事件 -> ACP ops
```

| 层 | 文件 | 职责 |
|----|------|------|
| 传输 | src/acp/transport.ts | stdio 上的 JSON-RPC 2.0，请求/响应关联 |
| 协议类型 | src/acp/types.ts | ACP v1 线格式类型 + 方法名常量（官方 schema 形状） |
| 服务端 | src/acp/server.ts | initialize、session/new、session/prompt、session/stop、session/cancel、session/update |
| 更新泵 | src/acp/session-update-pump.ts | 合并流式增量（25ms / 8KiB）、FIFO 排序屏障、完成后 flush |
| Agent 桥接 | src/bridge/dsh-agent-bridge.ts | 每个 ACP 会话对应一个 dsh Agent（ctx.agents）；prompt 排队、用量、元数据 |
| 事件映射 | src/bridge/event-map.ts | dsh session 事件 -> ACP ops（纯函数） |
| 插件入口 | src/index.ts | Cordis 插件：name / inject / apply / Config |
| Bundle patch | cordis.patch.yml | 把插件挂载到 dsh-base 之上（headless 风格） |

## 协议映射（dsh -> ACP）

| dsh session 事件 | ACP session/update |
|------------------|--------------------|
| assistant/chunk（text-delta） | agent_message_chunk（合并后） |
| assistant/chunk（reasoning-delta） | agent_thought_chunk（合并后） |
| assistant/message（组装消息） | 仅当该 step 没有流式 chunk 时才回退发文本；用量始终累计 |
| tool/call | tool_call（in_progress，规范 ToolKind） |
| tool/result | tool_call_update（completed / failed，content 数组 + rawOutput） |
| todo/write | plan |
| 回合完成 | usage_update（累计 tokens）+ session_info_update（updatedAt） |
| 首个 prompt | session_info_update（派生的标题） |

停止原因由 turn/end 的 reason 折算：
completed -> end_turn，aborted -> cancelled，max-tokens -> max_tokens，其余 -> end_turn。

并发的 session/prompt 调用按会话 FIFO 排队，客户端会收到队列位置提示；
session/cancel 会清空排队中的 prompt 并取消正在运行的回合。

## 执行模式与模型选择

ACP 的会话模式与模型选择器适配到 dsh 自身的概念：

- **模式 = dsh agent preset**（`ctx.agentPresets`）。`session/new` 把 preset 名单
  作为 `modes` 通告（id/name/description 取自各 preset 的元数据）。
  `session/set_mode` 通过 `recompose` 把会话重链到另一个 preset —— 仅在会话尚未
  产生任何对话内容时允许（dsh 的换装安全规则），之后会以 `InvalidParams` 拒绝。
  切换成功会发 `current_mode_update`。本 bundle 自己挂载
  `@deepseek-ai/dsh-agent-presets`（dsh-base 不挂，只有 Web app 挂），所以
  headless/stdio profile 也能拿到模式列表。
- **模型选择器** = `session/set_config_option("model", "<provider>/<model>")`。
  `session/new` 通过 `ctx.llm.listProviders()` / `listModels()` 枚举所有已注册
  provider 的模型。切换更新会话的可变 `ModelSelectionRef`（由
  `installModelSelection` 安装），从下一个模型 step 生效。当前选择始终出现在
  列表里，即使其路由没有活跃目录。
- **推理档位** = `session/set_config_option("thought_level", "<effort>")`，
  由 `resolveModelInfo` 返回的当前模型 reasoning efforts 驱动。
- **兼容入口**：保留 `session/set_model` 作为模型切换的别名（响应为空，刷新后的
  选项经 `config_option_update` 送达）。
- 每次切换都会返回/通知刷新后的完整 `configOptions`；`usage_update` 报告的
  `size` 在 adapter 披露时使用所选模型的真实 context window（`resolveModelInfo`）。

## 线格式说明

本服务端发出的消息遵循官方 ACP schema（`@agentclientprotocol/sdk`）：

- `tool_call` / `tool_call_update` 使用纯字符串 `ToolCallStatus`
  （`pending` / `in_progress` / `completed` / `failed`）和固定 `ToolKind`
  词表（`read` / `edit` / `delete` / `move` / `search` / `execute` /
  `think` / `fetch` / `switch_mode` / `other`）。
- 工具输出以 `content: ToolCallContent[]` 数组 + `rawOutput` 原始字符串交付，
  而不是裸字符串字段。
- `available_commands_update` 携带 `availableCommands`。
- `initialize` 返回 `agentInfo`（name / title / version），并协商协议版本
  （支持请求版本则返回之，否则返回自身版本）。
- `session/new` 拒绝非绝对路径的 `cwd`。

## 配置

bundle 配置项：

| 键 | 默认值 | 作用 |
|----|--------|------|
| `agentPreset` | — | 附加到创建会话的持久 agent preset |
| `sessionUpdateMode` | `coalesced` | `coalesced` 将流式消息/推理增量最多按 25ms 或 8KiB 合并；`legacy` 每个增量单独发一条通知（诊断基线） |
| `contextWindow` | `131072` | ACP `usage_update` 中通告的上下文窗口大小（tokens） |

## 构建

```sh
pnpm install
pnpm build   # tsc -> lib/
pnpm test    # pump + event-map 单元测试，然后是 stdio smoke 测试
```

## 安装到 dsh

acp4idea 是一个 dsh *bundle*（它声明了 dsh.bundle.patch）。创建一个专用 profile，
其 bundle 栈为 dsh-base + acp4idea：

```sh
# 创建 ~/.dsh/profiles/acp（含 dsh-base），然后加入本 bundle
dsh plugin --profile acp add @xiongqiang521/dsh-acp4idea
```

本 bundle 会自行挂载 `@deepseek-ai/dsh-agent-presets`（用于 ACP 模式）。如果你的
profile 用 `autoInstallPeers: false`（生成 profile 的 pnpm 默认），需要手动安装一次
peer：

```sh
cd ~/.dsh/profiles/acp && pnpm add @deepseek-ai/dsh-agent-presets
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
- pi-acp（本 bundle 借鉴其流式合并/排队设计的 ACP 适配器）：
  https://github.com/svkozak/pi-acp
