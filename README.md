# Magpie Muse CLI

Use your **official Muse Code CLI** as a Magpie provider. Tested on Linux with **Muse Code 1.4.15 and 1.4.18**. CLI release numbers are not locked; the bridge checks the MSP wire protocol and required capabilities. The SDK dependency is pinned for reproducible installs, independently of the CLI release number.

```text
Your agent → Magpie → this plugin → muse serve → Meta
                                ↕ MCP
                   tool_calls → your agent → tool results
```

Muse owns authentication and upstream requests. This plugin never imports a DCA token, mints an API key, or calls Meta's API itself. Client tools are exposed to Muse through per-session MCP. Their names and arguments return to your agent as ordinary tool calls; your agent executes them with its own permissions and returns the results. Muse then continues the same turn.

This replaces the package entry point of the earlier direct-OAuth plugin. Its source remains in this repository for history, documented in [LEGACY-OAUTH.md](LEGACY-OAUTH.md), but is not loaded or included in the CLI package.

## Install in Magpie

Install Muse Code from its official source, check `muse --version`, and sign in using `muse login` if you have not already. Existing CLI authentication is reused. You do not need to downgrade Muse to 1.4.15.

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

### Updating and CLI compatibility

If an older plugin says **“This bridge is pinned to Muse CLI 1.4.15”**, update the plugin checkout:

```sh
git pull --ff-only
npm ci --ignore-scripts
```

Then turn this plugin off and on in Magpie and retry linking. That error came from the old plugin's release-number check, even when Muse was already installed correctly. Version 0.3.2 removes it.

The host must implement MSP envelope v1 and grant `sessionMcp`. The SDK treats an additive schema fingerprint change as a compatibility warning, not a reason to reject a newer CLI. A genuinely unsupported envelope or missing capability still fails with the detected CLI version and executable path. This does not guarantee that every future CLI change will be compatible; `npm run doctor` tests the installed CLI with an offline echo turn, and `doctor --live` additionally tests the actual account.

`MUSE_CLI_BIN=/absolute/path/to/muse npm run doctor` shows the executable selected. Magpie GUI applications can have a different PATH from a terminal; set `museBin` in plugin Options if needed. The CLI's model catalog supplies available models rather than restricting discovery to a static list.

## Working directory and tool permissions

Magpie passes the client's project through `X-Magpie-Work-Dir`. The plugin decodes and validates that directory. A remote agent's path must exist on the Magpie machine; otherwise configure `workspace` explicitly. It never substitutes Magpie's configuration directory for your project.

The actual Muse session runs in a new, empty directory owned by the bridge, **not in your repository**. Muse is launched with `--preset empty --trust-workspace --disable-shell --disable-write --disable-request-user-input`; session MCP requires workspace trust, so only that empty directory is trusted. The session selects Muse's built-in `:ask-me` permission profile. Client MCP calls are admitted once; the agent still controls their actual execution and approval. No persistent approval rules are written.

The real-CLI regression test inspects the primary model request and verifies it offers only the `mcp__magpie_client` tool namespace. The host also sets an empty `run.reminder_roster` so internal reminder observers do not generate extra model requests; this is checked with both tested CLI releases.

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

## Token usage

Token reporting works independently of USD pricing. Counts come from the official CLI, not a local text tokenizer, and reach both the client response and Magpie's Usage ledger.

| Counter | Chat Completions field | Magpie ledger |
| --- | --- | --- |
| Whole prompt, including cache | `prompt_tokens` | `in + cache_read + cache_write` |
| Uncached input | Prompt minus cache reads/writes | `in` |
| Output, including reasoning and tool generation | `completion_tokens` | `out` |
| Cache read | `prompt_tokens_details.cached_tokens` | `cache_read` |
| Cache write | `prompt_tokens_details.cache_write_tokens` | `cache_write` |
| Reasoning, already included in output | `completion_tokens_details.reasoning_tokens` | `reasoning` |
| Total, counting each token once | `total_tokens` | Prompt + output |

The bridge uses Muse's server-derived `promptTokens`/`totalTokens` when available, because raw input counters can use different cache conventions. It keeps separate cache-read/cache-write counts when Muse supplies them. A missing optional split is exported as 0; this does **not** prove the provider performed no cache writes. The tested live Meta sessions reported cache reads but no separate cache-write count.

Each client tool response reports the usage available at that point. The final response reports only the remaining usage, excluding tokens already returned with previous tool calls. Late usage is included when the native turn finishes. Multiple completions, parallel tools and subsequent user turns do not double count prior usage. Streamed responses include a final usage chunk before `[DONE]`; Magpie also converts the counters to Responses and Anthropic Messages formats.

## Optional USD estimates

The provider is labeled **Muse CLI**. Reference USD figures use [Meta's public API prices](https://dev.meta.ai/products/meta-model-api/), checked **2026-11-13**; they are **not an additional charge to your Muse Code subscription**. Set `referencePricing: false` to turn off the bundled price snapshot while keeping all token reporting. See [PRICING.md](PRICING.md) for the rate table and limitations.

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
- Equivalent tool schemas with different JSON key ordering, or a reordered tool list, preserve the session. Duplicate names and invalid schema containers fail before a turn starts.
- A native event gap, truncated completed answer or disagreement with already streamed text produces an explicit error. Replayed token-usage cursors are counted only once.
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

Validated in development: Node 24.22.1, Muse Code 1.4.15-R8339.1 and 1.4.18-R8587.1, Magpie 0.1.3903, Linux x64. Official CLI artifact sizes/SHA-256 and the Magpie release checksum were verified before execution. Separate live-account tests cover Spark 1.3, Spark 1.3 Contributor and Wonder 1.0; see [TESTING.md](TESTING.md) for the exact runs and scope. Live tests are opt-in and are not part of `npm test`.

The SDK transport, authentication boundaries and implementation tradeoffs of another community bridge were reviewed before adopting selected compatibility and robustness ideas; see [UPSTREAM-REVIEW.md](UPSTREAM-REVIEW.md).

MIT. Original upstream copyright/license retained.
