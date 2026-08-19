# acp4idea

An **Agent Client Protocol (ACP) v1** server bundle for the DeepSeek Harness (dsh).
It exposes dsh as a coding agent that IntelliJ IDEA, Zed, and any other ACP v1
client can drive over stdio.

- IDEA (or Zed) is the ACP *client*; dsh is the ACP *agent/server*.
- One long-lived JSON-RPC 2.0 stream over stdin/stdout (newline-delimited JSON).
- Each ACP session is a real dsh Agent, created through the same core registry
  that dsh-headless uses, and streamed back to the IDE as session/update events.

## Architecture

```
IDEA (ACP client)
   |  JSON-RPC 2.0 over stdio
   v
bin/acp4idea.js ---> dsh --profile acp
                      |
                      +-- src/acp/transport.ts         framing + JSON-RPC dispatch
                      +-- src/acp/server.ts            initialize / session/* handlers
                      +-- src/bridge/dsh-agent-bridge.ts  ctx.agents factory
                      +-- src/bridge/event-map.ts         session events -> ACP updates
```

| Layer | File | Role |
|-------|------|------|
| Transport | src/acp/transport.ts | JSON-RPC 2.0 over stdio, request/response correlation |
| Protocol types | src/acp/types.ts | ACP v1 wire types + method-name constants |
| Server | src/acp/server.ts | initialize, session/new, session/prompt, session/stop, session/cancel, session/update |
| Agent bridge | src/bridge/dsh-agent-bridge.ts | one dsh Agent per ACP session via ctx.agents |
| Event map | src/bridge/event-map.ts | dsh session events -> ACP session updates |
| Plugin entry | src/index.ts | Cordis plugin: name / inject / apply / Config |
| Bundle patch | cordis.patch.yml | mounts the plugin over dsh-base (headless-style) |

## Protocol mapping (dsh -> ACP)

| dsh session event | ACP session/update |
|-------------------|--------------------|
| assistant/message (text) | agent_message_chunk |
| assistant/message (reasoning) | agent_thought_chunk |
| tool/call | tool_call (in_progress) |
| tool/result | tool_call_update (completed / failed) |
| todo/write | plan |

Stop reasons fold from the turn/end reason:
completed -> end_turn, aborted -> cancelled, max-tokens -> max_tokens, else end_turn.

## Build

```sh
pnpm install
pnpm build   # tsc -> lib/
```

## Install into dsh

acp4idea is a dsh *bundle* (it declares dsh.bundle.patch). Create a dedicated
profile whose bundle stack is dsh-base + acp4idea:

```sh
# creates ~/.dsh/profiles/acp with dsh-base, then adds this bundle
dsh plugin --profile acp add @deepseek-ai/dsh-acp4idea
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
streams the full transcript to the IDE. The ACP client-side delegation surface
(fs/read_text_file, fs/write_text_file, terminal/*) is implemented in the
transport/server as typed helpers but not yet wired to dsh's tool executor; a
future tool-interception layer can route dsh tool calls through the IDE so edits
and terminals render natively.

## References

- Agent Client Protocol: https://agentclientprotocol.com
- JetBrains ACP: https://www.jetbrains.com/help/ai-assistant/acp.html
- dsh-headless (the one-shot analog this bundle mirrors): @deepseek-ai/dsh-headless
