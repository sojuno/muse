# Magpie Muse

Use a Muse subscription through Magpie's gateway. Since version **0.4.0** it calls Meta's **Responses API directly**, following the architecture used by [oh-my-pi](UPSTREAM-REVIEW.md). It does not require Muse CLI or the Muse SDK.

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

Select **Muse (Subscription API)** in Magpie. Sign-in opens Meta's device authorization page; approve the displayed code with the intended account. Magpie stores the resulting credentials. This plugin does not read or change your Muse CLI login. Two more ways to add an account: paste a CLIProxyAPI or Muse CLI Meta auth file (or just its `dca_token`) through the import method, which mints a fresh API key to prove the token still works; or use an existing Meta/Muse API key.

## Multiple accounts

Sign in again to add another account — `magpie plugin login muse` in a terminal, or the provider's sign-in button in the app. Magpie keeps each sign-in as its own account under the provider and spreads requests over the accounts you tick:

- An account is named by the subscription email the key mint returns (`accountId`). Signing in an email that is already there replaces that account; a different email becomes a second account. The import method adds accounts the same way, one paste each.
- Routing and failover are Magpie's: pick a routing for the provider's accounts (smart, order, drain, rotate, usage, pace, weight, fast) and a Stays setting; a rate limit or server error moves a request to the next account, and a 401 marks the account. `maxConcurrency` (8 by default) limits each account, so several accounts serve proportionally more requests in parallel.
- Everything below the routing is per account: model discovery, the usage card and allowance windows, key renewal from the account's own DCA token, and the save of a rotated key — one account's renewal never writes another account's sign-in.

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

## What reaches the model

By default no earlier reasoning item is sent and the client's system text is the first message of the conversation,
as in the same Chat Completions request sent to Meta's public API by a client that returns no reasoning items. Every
function name is sent under an alias. Each behaviour has an option, set in the installed plugin's Options.

| Option | Default | Other value |
| --- | --- | --- |
| `toolNames` | `"hashed"`: every function name is sent under a `client_…` alias, with the original name in its description | `"native"`: a name the API accepts (`A-Z a-z 0-9 _ -`, at most 64 characters, not starting with `client_`) is sent exactly as declared, description unchanged; any other name is still aliased |
| `reasoningReplay` | `"drop"`: no earlier reasoning item is sent; each request carries only the conversation's messages, tool calls and tool results | `"keep"`: sealed reasoning items in the request are sent |
| `instructionsAs` | `"message"`: the system text is sent as the first message of `input` (role `system`) and `instructions` is left empty; a request that continues a stored response keeps `instructions` | `"instructions"`: the system text stays in `instructions` |
| `cutTurns` | `"continue"`: a cut turn (below) is continued once | `"pass"`: every response goes to the client exactly as Meta ended it |

**Cut turns.** Wonder on this route sometimes ends a tool-using turn right after its opening sentence: the response is
one message ("Opening that post now."), status `completed`, no function call, 0 reasoning tokens and a few dozen output
tokens. A client that ends its turn on a text-only answer then stops before the act it announced. Sent again, the same
request is almost never cut, and with the sentence appended as the assistant's message the model answers with exactly
the call it announced. With `cutTurns: "continue"` the plugin recognises such a response (one `output_text` message of
at most 1000 characters, nothing else but empty reasoning items, at most 100 output tokens, 0 reasoning tokens, tools
offered and allowed, no `previous_response_id`) and sends the same request once more with the sentence appended. Only a
bare, whole tool call is spliced in (completed, 0 reasoning tokens, no text, only calls of offered tools with a call id
and JSON-object arguments): the client receives the sentence, the call's `output_item` and `function_call_arguments`
events and one `response.completed` carrying both outputs, the first request's input counts and both requests' output
counts. Anything else, a failure, or no answer within 180 s, and the client receives the response exactly as Meta ended
it. Each cut turn writes one `console.warn` line (`magpie-muse: cut turn <id> ... continued: <tool>` or `... not
continued: <why>`). A real short ending with no reasoning whose bare continuation is a tool call would be continued too;
none was seen in the runs this was measured on.

Aliases are restored in streamed and buffered responses. With a subscription key the service answers
`403 client_attestation_denied` to a request that declares a tool under a name the Muse Code client uses itself (seen
live with `bash`): its message says subscriptions cover the Muse Code client only and names a pay-as-you-go API key for
other clients. `"native"` is therefore not usable with such tools on a subscription key.

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
