# acp4idea

An **Agent Client Protocol (ACP) v1** server bundle for the DeepSeek Harness (dsh).
It exposes dsh as a coding agent that IntelliJ IDEA, Zed, and any other ACP v1
client can drive over stdio.

- IDEA (or Zed) is the ACP *client*; dsh is the ACP *agent/server*.
- One long-lived JSON-RPC 2.0 stream over stdin/stdout (newline-delimited JSON).
- Each ACP session is a real dsh Agent, created through the same core registry
  that dsh-headless uses, and streamed back to the IDE as session/update events.

The adapter design follows [svkozak/pi-acp](https://github.com/svkozak/pi-acp):
streamed deltas are coalesced before they reach the client, per-session token
usage is reported, prompt turns are queued with explicit cancellation, and the
wire shapes match the canonical ACP schema.

## Architecture

```
IDEA (ACP client)
   |  JSON-RPC 2.0 over stdio
   v
bin/acp4idea.js ---> dsh --profile acp
                      |
                      +-- src/acp/transport.ts            framing + JSON-RPC dispatch
                      +-- src/acp/server.ts               initialize / session/* handlers
                      +-- src/acp/session-update-pump.ts  coalesced stream delivery (25ms / 8KiB)
                      +-- src/bridge/dsh-agent-bridge.ts  ctx.agents factory, queue, usage
                      +-- src/bridge/event-map.ts         session events -> ACP ops
```

| Layer | File | Role |
|-------|------|------|
| Transport | src/acp/transport.ts | JSON-RPC 2.0 over stdio, request/response correlation |
| Protocol types | src/acp/types.ts | ACP v1 wire types + method-name constants (canonical schema shapes) |
| Server | src/acp/server.ts | initialize, session/new, session/prompt, session/stop, session/cancel, session/update |
| Update pump | src/acp/session-update-pump.ts | coalesces stream deltas (25 ms / 8 KiB), FIFO ordering barriers, flush-on-completion |
| Agent bridge | src/bridge/dsh-agent-bridge.ts | one dsh Agent per ACP session via ctx.agents; prompt queue, usage, metadata |
| Event map | src/bridge/event-map.ts | dsh session events -> ACP ops (pure) |
| Plugin entry | src/index.ts | Cordis plugin: name / inject / apply / Config |
| Bundle patch | cordis.patch.yml | mounts the plugin over dsh-base (headless-style) |

## Protocol mapping (dsh -> ACP)

| dsh session event | ACP session/update |
|-------------------|--------------------|
| assistant/chunk (text-delta) | agent_message_chunk (coalesced) |
| assistant/chunk (reasoning-delta) | agent_thought_chunk (coalesced) |
| assistant/message (assembled) | fallback text only when the step had no streamed chunks; usage is always accumulated |
| tool/call | tool_call (in_progress, canonical ToolKind) |
| tool/result | tool_call_update (completed / failed, content array + rawOutput) |
| todo/write | plan |
| turn completion | usage_update (cumulative tokens) + session_info_update (updatedAt) |
| first prompt | session_info_update (derived title) |

Stop reasons fold from the turn/end reason:
completed -> end_turn, aborted -> cancelled, max-tokens -> max_tokens, else end_turn.

Concurrent session/prompt calls are queued FIFO per session; the client is told
the queue position, and session/cancel clears queued prompts and cancels the
running turn.

## Execution modes and model selection

ACP's session modes and model selector are adapted to dsh's own concepts:

- **Modes = dsh agent presets** (`ctx.agentPresets`). `session/new` advertises
  the preset roster as `modes` (id/name/description from each preset's
  metadata). `session/set_mode` re-links the session to another preset via
  `recompose` — valid only while the session has produced no conversation
  content, which is dsh's swap-safety rule; afterwards it is refused with
  `InvalidParams`. A successful switch emits `current_mode_update`. The bundle
  mounts `@deepseek-ai/dsh-agent-presets` itself (dsh-base does not), so a
  headless/stdio profile gets modes even without the Web app.
- **Model selector** = `session/set_config_option("model", "<provider>/<model>")`.
  `session/new` enumerates every registered provider's models via
  `ctx.llm.listProviders()` / `listModels()`. A switch updates the session's
  mutable `ModelSelectionRef` (installed by `installModelSelection`), so it
  takes effect from the next model step. The current selection is always
  surfaced, even when its route has no live catalog.
- **Thought level** = `session/set_config_option("thought_level", "<effort>")`,
  driven by the selected model's reasoning efforts from `resolveModelInfo`.
- **Legacy surface**: `session/set_model` is kept as a compatibility alias for
  the model switch (response is empty; the refreshed options arrive via
  `config_option_update`).
- Every switch returns/notifies the full refreshed `configOptions`, and the
  reported `usage_update` uses the selected model's real context window from
  `resolveModelInfo` when the adapter discloses one.

## Wire-shape notes

The messages this server emits follow the canonical ACP schema
(`@agentclientprotocol/sdk`):

- `tool_call` / `tool_call_update` use the plain-string `ToolCallStatus`
  (`pending` / `in_progress` / `completed` / `failed`) and the fixed
  `ToolKind` vocabulary (`read` / `edit` / `delete` / `move` / `search` /
  `execute` / `think` / `fetch` / `switch_mode` / `other`).
- Tool output is delivered as `content: ToolCallContent[]` plus the raw string
  in `rawOutput` — not a bare string field.
- `available_commands_update` carries `availableCommands`.
- `initialize` returns `agentInfo` (name / title / version) and negotiates the
  protocol version (requested when supported, otherwise the agent's own).
- `session/new` rejects non-absolute `cwd`.

## Configuration

The bundle config accepts:

| Key | Default | Effect |
|-----|---------|--------|
| `agentPreset` | — | Durable agent preset attached to created sessions |
| `sessionUpdateMode` | `coalesced` | `coalesced` batches streamed message/thought deltas for at most 25 ms or 8 KiB; `legacy` sends every delta as its own notification (diagnostic baseline) |
| `contextWindow` | `131072` | Context-window size (tokens) advertised in ACP `usage_update` |

## Build

```sh
pnpm install
pnpm build   # tsc -> lib/
pnpm test    # pump + event-map unit tests, then the stdio smoke test
```

## Install into dsh

acp4idea is a dsh *bundle* (it declares dsh.bundle.patch). Create a dedicated
profile whose bundle stack is dsh-base + acp4idea:

```sh
# creates ~/.dsh/profiles/acp with dsh-base, then adds this bundle
dsh plugin --profile acp add @deepseek-ai/dsh-acp4idea
```

The bundle mounts `@deepseek-ai/dsh-agent-presets` itself (for ACP modes). If
your profile uses `autoInstallPeers: false` (the pnpm default in generated
profiles), install the peer explicitly once:

```sh
cd ~/.dsh/profiles/acp && pnpm add @deepseek-ai/dsh-agent-presets
```

Then the ACP server is launched by:

```sh
dsh --profile acp
```

or, equivalently, by the bundled wrapper:

```sh
acp4idea    # bin/acp4idea.js
```

## Point IntelliJ IDEA at it

1. Install or update IntelliJ IDEA with the JetBrains AI Assistant plugin (2025.3+).
2. In the AI Assistant ACP settings, add a custom agent whose start command is
   one of the following:

   - Windows (dsh is a .ps1/.cmd script; wrap it through cmd.exe so the
     PATHEXT shim resolves, or IDEA's CreateProcess fails with error 193):
     `cmd /c dsh --profile acp`
   - Most direct on any OS (node runs dsh's JS entry, no script shim):
     `node C:\\nvm4w\\nodejs\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile acp`
   - Or the bundled wrapper: the absolute path to `bin/acp4idea.js`
     (wrapper works; it resolves the shim via cmd.exe on Windows).

   Make sure `--profile acp` is present: IDEA launches the command as-is,
   and dsh requires a profile (plain `dsh` alone fails).

3. Open a project, select the agent, and chat. See the JetBrains guide:
   https://www.jetbrains.com/help/ai-assistant/acp.html

Notes:

- DSH_BIN / DSH_ACP_PROFILE override the wrapper command and profile.
- The dsh profile needs a configured model, exactly like any other dsh surface;
  the default model selection is read from ctx.agentDefaultModel.

## Scope and extension points

The first release runs dsh tools locally (bash / pwsh / fs on the dsh host) and
streams the full transcript to the IDE — token deltas coalesced into fluent
chunks, tool calls with canonical shapes, per-turn usage, and a derived session
title. The ACP client-side delegation surface (fs/read_text_file,
fs/write_text_file, terminal/*) is implemented in the transport/server as
typed helpers but not yet wired to dsh's tool executor; a future
tool-interception layer can route dsh tool calls through the IDE so edits and
terminals render natively.

## References

- Agent Client Protocol: https://agentclientprotocol.com
- JetBrains ACP: https://www.jetbrains.com/help/ai-assistant/acp.html
- dsh-headless (the one-shot analog this bundle mirrors): @deepseek-ai/dsh-headless
- pi-acp (ACP adapter whose streaming/queueing design this bundle adapts):
  https://github.com/svkozak/pi-acp
