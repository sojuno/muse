# Magpie Muse CLI

Use your **official Muse Code CLI** as a Magpie provider. Targets **Linux + Muse Code 1.4.15** with `@muse-code/sdk` pinned to the same version.

```text
Your agent → Magpie → this plugin → muse serve → Meta
                                ↕ MCP
                   tool_calls → your agent → tool results
```

Muse owns authentication and upstream requests. This plugin never imports a DCA token, mints an API key, or calls Meta's API itself. Client tools are exposed to Muse through per-session MCP. Their names and arguments return to your agent as ordinary tool calls; your agent executes them with its own permissions and returns the results. Muse then continues the same turn.

This replaces the package entry point of the earlier direct-OAuth plugin. Its source remains in this repository for history, documented in [LEGACY-OAUTH.md](LEGACY-OAUTH.md), but is not loaded or included in the CLI package.

## Install in Magpie

Install Muse Code from its official source, verify `muse --version` reports **1.4.15**, and sign in using `muse login` if you have not already. Existing CLI authentication is reused.

From the main branch:

```sh
git clone https://github.com/sojuno/muse.git
cd muse
npm ci --ignore-scripts
magpie plugin add "$PWD"
magpie plugin login muse-cli
magpie provider test muse-cli
```

The local Magpie login links the CLI installation; it does not perform Meta OAuth or prove that the Meta account has remaining quota. A real request checks the CLI's sign-in.

Pick a model such as `muse-cli/muse-spark-1.3` or `muse-cli/muse-wonder-1.0` in Magpie. Disable the old `magpie-muse-auth` plugin if you no longer want the direct-OAuth provider. The provider ids are different, so installing this plugin does not silently change an agent's selected model.

Contributor variants are exposed as `muse-cli/muse-spark-1.3-contributor` and `muse-cli/muse-spark-1.2-contributor` when the corresponding base model is in the account's CLI catalog. The CLI catalog itself keeps the base names. The plugin preserves the suffix on the actual model selection and uses separate CLI processes with contributor mode explicitly `on` or `off`, so choosing a contributor model does not change ordinary conversations. Meta states contributor models may use submitted data to improve its products; the choice is explicit in the model picker.

If Muse is outside Magpie's PATH, set its absolute path in the installed plugin's Options:

```json
{
  "museBin": "/home/you/.local/bin/muse"
}
```

Or use the CLI, naming the installed plugin as `magpie plugin` lists it:

```sh
magpie plugin options magpie-muse-cli '{"museBin":"/home/you/.local/bin/muse"}'
```

Folder installs can be named by their absolute folder path instead. Magpie restarts its plugin host when options change. After editing source files, turn the plugin off and on in Magpie.

## Working directory and tool permissions

Magpie passes the client's project through `X-Magpie-Work-Dir`. The plugin decodes and validates that directory. A remote agent's path must exist on the Magpie machine; otherwise configure `workspace` explicitly. It never substitutes Magpie's configuration directory for your project.

The actual Muse session runs in a new, empty directory owned by the bridge, **not in your repository**. Muse is launched with `--preset empty --trust-workspace --disable-shell --disable-write --disable-request-user-input`; session MCP requires workspace trust, so only that empty directory is trusted. The session selects Muse's built-in `:ask-me` permission profile. Client MCP calls are admitted once; the agent still controls their actual execution and approval. No persistent approval rules are written.

The real-CLI regression test inspects the primary model request and verifies it offers only the `mcp__magpie_client` tool namespace. The CLI may run its own internal reminder bookkeeping separately.

Do not point Muse's `endpoint_transport` back at the same Magpie provider: that creates a routing loop. Use the normal Meta CLI provider for live use. The bridge never edits your Muse settings or credentials. Turn logs live in a temporary data directory, removed when the bridge closes normally; a force-killed host can leave temporary files for OS cleanup.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `museBin` | `muse` / `MUSE_CLI_BIN` | CLI path; detects the installer's versioned binary |
| `workspace` | From the request | Explicit client project directory when metadata is unavailable |
| `maxSessions` | 32 | Maximum in-memory conversations |
| `turnTimeoutMs` | 600000 | Maximum time for a Muse turn, including tool waits |
| `toolTimeoutMs` | 300000 | Maximum wait for a client tool result |
| `serveArgs` | `[]` | Additional official `muse serve` arguments; advanced use/testing |
| `museEnv` | `{}` | Explicit child environment additions; keep secret values out of plugin options |

`museArgs` is a prefix for test launchers, not needed for an installed CLI. Fixed sandbox/preset flags are supplied by the bridge; do not duplicate them in `serveArgs`.

Do not set `--contributor-mode` in `serveArgs`: the plugin owns that flag based on the selected model id.

## Token usage and USD estimates

Magpie records the input, output, cache-read and reasoning token counts reported by the Muse CLI. A tool step can end before the complete Muse turn has its usage; the aggregate is reported when that turn finishes. Reasoning tokens are part of output and are not added to the USD estimate a second time.

The provider is labeled **Muse CLI (API reference cost)**. USD figures are estimates using [Meta's public API prices](https://dev.meta.ai/products/meta-model-api/), checked **2026-11-13**; they are **not an additional charge to your Muse Code subscription**. See [PRICING.md](PRICING.md) for the rate table and limitations.

Per-model overrides are optional, in USD per million tokens:

```json
{
  "pricing": {
    "muse-spark-1.3": { "input": 1.25, "cacheRead": 0.15, "output": 4.25 },
    "muse-spark-1.3-contributor": { "input": 0.10, "cacheRead": 0.002, "output": 0.20 }
  }
}
```

Set `referencePricing: false` to disable the bundled public-price snapshot, or set `pricing[modelId]` to `null` to leave that model unpriced. A future USD price reported by the CLI takes precedence over the snapshot, and an explicit override takes precedence over both. Keep the snapshot current as Meta changes its pricing.

## Behavior and current limits

- Supports Chat Completions streaming/non-streaming, reasoning text, usage counts, inline images, function tools, parallel tool results, cancellation and named reasoning effort.
- Immediate CLI authentication/quota failures retain HTTP 401/429, including for streaming requests before output starts. Failures after output starts are reported in the SSE stream.
- Keeps the same Muse session across client tool steps and subsequent messages. Session identity includes conversation, subagent and project. Changed history, model, system instructions or tool definitions starts a new session seeded from the supplied history.
- After a plugin/CLI restart, conversation history can seed a new session. A lost pending tool step is rejected explicitly; retry from the user turn. There is no cross-process restoration of a tool call waiting for its result.
- Return all tool results from one response together, using their original ids and tool definitions. New turns are rejected while previous tools are pending.
- `tool_choice: "none"` prevents bridge tool execution. Named choices expose only that tool. Required/named choices are also communicated to Muse in the prompt; this is not a native model-level tool-choice guarantee.
- The CLI has its own system/runtime instructions. Client system/developer messages are included in the initial conversation seed, not installed as an exact replacement for the CLI's system prompt. This is not full behavioral parity with every Claude bridge feature.
- Structured `response_format`, audio/prediction and remote image URLs are rejected rather than silently ignored. No arbitrary external image fetches occur.
- MCP **tools** from a client, including tools backed by its own stdio MCP servers, cross the bridge. MCP resources, prompts, server installation and server OAuth are not provided by this plugin; those remain the client's responsibility.
- One local CLI account per plugin. Subscription allowance cards and multiple isolated Muse accounts are not implemented. API reference cost does not describe remaining subscription quota.
- Magpie is the supported host. OpenCode 2's native plugin interface is not implemented by this entry point.

## Verify

```sh
npm test

# Real official CLI, echo provider; no login or plan quota needed:
MUSE_CLI_BIN=/absolute/path/to/muse npm run doctor

# Real Meta sign-in and inference; spends a small amount of plan quota:
MUSE_CLI_BIN=/absolute/path/to/muse npm run doctor -- --live

# Include the full official-CLI MCP regression against a local test backend:
MUSE_TEST_BIN=/absolute/path/to/muse npm test

# Also include the actual Magpie/Bun gateway protocol tests:
MUSE_TEST_BIN=/absolute/path/to/muse MAGPIE_TEST_BIN=/absolute/path/to/magpie npm test
```

The default suite runs the inherited 48 legacy regression tests, pricing tests and CLI bridge tests. The three official-CLI tests are explicitly skipped when `MUSE_TEST_BIN` is unset; the Magpie gateway group is skipped without `MAGPIE_TEST_BIN`. Official-CLI regression tests use a dummy credential in a separate temporary configuration and route requests only to a loopback test backend. The gateway group enables subscription discovery in its isolated Magpie configuration because that is required for CLI-backed provider plugins; run it on a development/test machine. `MAGPIE_TEST_BUN` can point to an existing supported Bun executable.

Validated in development: Node 24.22.1, Muse Code 1.4.15-R8339.1, Magpie 0.1.3903, Linux x64. Real CLI artifact size/SHA-256 and the Magpie release checksum were verified before execution. Separate live-account tests on 2026-11-13 passed streaming chat, client MCP file reads and conversation continuation for both Spark 1.3 and Spark 1.3 Contributor through Magpie. Live tests are opt-in and are not part of `npm test`.

MIT. Original upstream copyright/license retained.
