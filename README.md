# Magpie Muse

Use a Muse subscription through Magpie's gateway. Version **0.4.0** calls Meta's **Responses API directly**, following the architecture used by [oh-my-pi](UPSTREAM-REVIEW.md). It does not require Muse CLI or the Muse SDK.

```text
OpenCode / another client → Magpie → this plugin → Meta Responses API
           ↑                                      ↓
           └──── client tool execution ← tool calls
```

The client's system instructions reach the API as `instructions` or the roles produced by Magpie's protocol conversion. The plugin preserves developer/user messages, message order, images, assistant history, tool call ids and tool results. It adds no Muse CLI system prompt or transcript wrapper. Meta's own model policy still applies.

## Install and sign in

```sh
git clone https://github.com/sojuno/muse.git
cd muse
npm ci --ignore-scripts
magpie plugin add "$PWD"
magpie plugin login muse
magpie provider test muse
```

Select **Muse (Subscription API)** in Magpie. Sign-in opens Meta's device authorization page; approve the displayed code with the intended account. Magpie stores the resulting credentials. This plugin does not read or change your Muse CLI login. An existing Meta/Muse API key is also supported through Magpie's second sign-in method.

When updating an existing checkout:

```sh
git pull --ff-only
npm ci --ignore-scripts
```

Reload the installed plugin in Magpie, then sign in to `muse`. The former CLI backend used provider id `muse-cli`; its local connection marker is not API authentication. Update the client's selected model from `muse-cli/<model>` to `muse/<model>`. Remove old CLI-specific options such as `museBin`, `serveArgs` and `workspace` from the installed plugin's Options. If an older standalone OAuth plugin also registers `muse`, disable that duplicate first.

## Models and Contributor

Examples of Magpie model ids:

- `muse/muse-spark-1.3`
- `muse/muse-spark-1.3-contributor`
- `muse/muse-wonder-1.0`
- `muse/muse-wonder-1.0-contributor`

All four passed live API tests. Wonder Contributor also passed a real OpenCode write/read/edit/shell workflow. The exact `-contributor` id is sent upstream; selecting it is an explicit choice of Meta's Contributor lane, whose data policy can differ from the ordinary lane.

The account's `/models` response supplies the catalog, including newly advertised models. Supported Wonder/Spark Contributor aliases are added when their base model is listed. A fallback catalog is available if discovery fails; a catalog entry does not establish account access. Wonder Full, Spark 1.2 and other fallback entries have not all been tested live. Reasoning-effort variants are exposed; the service decides which efforts a model accepts.

## Tools, MCP and client permissions

`bash`/`shell`, `read`, `write`, `edit` and MCP tools execute in the **calling client**, with that client's workspace and permissions. The API plugin has no tool executor, starts no Muse process and connects to no gateway-side MCP server. It returns tool calls to the client and sends the client's actual results back to Meta.

Configure MCP servers in OpenCode or your other client. Their tools work when the client sends them as function definitions and returns their results. The bridge maps API wire names and restores the original client/MCP names, including names with characters Meta rejects.

MCP **resources** are data a server exposes, such as documents; **prompts** are reusable prompt templates. A client can fetch these and include their contents in the conversation. The plugin itself does not implement MCP resource/prompt discovery or execute server connections. Hosted Responses tools such as `{ "type": "mcp", "server_url": "…" }` are rejected explicitly. Use client function tools for search and other integrations too.

Automatic tool choice and `none` are supported. Meta does not implement forced `required`/named tool choice on this path; these requests return an explicit error. A caller requiring that guarantee must handle this service limitation.

## Prompt and protocol handling

Magpie accepts OpenAI Chat Completions, Responses and Anthropic Messages, translating them to the provider's Responses format. The plugin then:

- Keeps supplied `instructions`, message roles/content and function outputs in their API fields; an absent `instructions` becomes an empty string.
- Converts function names to stable API-safe names, adds the original name to the description, and restores names in streamed and buffered responses.
- Preserves reasoning events, usage and subscription allowance events. Bare reasoning references are omitted for stateless requests; rejected encrypted or expired reasoning can be retried without changing ordinary messages or tool outputs.
- Defaults to `store: false`, retaining an explicit caller setting. Missing `previous_response_id` context is returned as an error; it is never silently discarded to start a new conversation.
- Removes Meta-rejected metadata fields: `generate`, `prompt_cache_retention`, `safety_identifier`, `stream_options`, `client_metadata`.

Small live tests verified separate system/developer/user instructions on Spark and Wonder in both lanes. They do not establish every model's instruction-following behavior. See [TESTING.md](TESTING.md) for exact test scope.

## Token usage

Counts come from **Meta's response**, not a local estimate. They pass through to client responses and Magpie's Usage ledger.

| Counter | Responses API | Magpie ledger |
| --- | --- | --- |
| Whole prompt, including cache | `input_tokens` | `in + cache_read + cache_write` |
| Uncached input | Input minus cache reads/writes | `in` |
| Output, including reasoning | `output_tokens` | `out` |
| Cache read | `input_tokens_details.cached_tokens` | `cache_read` |
| Cache write | `input_tokens_details.cache_write_tokens`, when supplied | `cache_write` |
| Reasoning, already included in output | `output_tokens_details.reasoning_tokens` | `reasoning` |
| Total, counting each token once | `total_tokens` | Whole prompt + output |

Chat/Messages fields use Magpie's equivalent conversions. Live Wonder Contributor reported nonzero cache reads and reasoning. Nonzero cache-write preservation is verified with controlled gateway responses; live tests reported no separate writes. An absent split displayed as zero does not establish that the service performed no cache writes. Reasoning text is forwarded when the service returns it; a reasoning token count does not promise visible private reasoning.

USD reference pricing is **off by default**. Token reporting works independently. Optional explicit/reference pricing is documented in [PRICING.md](PRICING.md).

## Development

```sh
npm test
```

The shipped default provider has **no runtime dependencies or install scripts**. The pinned Muse SDK is a development dependency used only by the archived CLI backend's regressions. Source-only `cli-plugin.mjs` and older adapters remain for history; they are excluded from the API package. Current and historical test evidence are separated in [TESTING.md](TESTING.md) and [CLI-TESTING.md](CLI-TESTING.md).

Inference is restricted to `https://api.meta.ai/v1/responses`; auth uses the exact Meta device/key endpoints. Redirects and foreign inference destinations are refused. The explicit `localTestBackend` option is for loopback tests and accepts only dummy credentials prefixed `test-only`; keep it off for real accounts. The plugin identifies itself as `magpie-muse`, with no CLI version gate or fabricated build identity.
