# Historical CLI backend tests

These results describe v0.3.x and the source-only `cli-plugin.mjs` backend. The default v0.4.0 backend is the direct subscription API; see [TESTING.md](TESTING.md).

# Validation record

## Wonder Contributor, MCP and reasoning — 2026-11-13, v0.3.3

Added `muse-cli/muse-wonder-1.0-contributor` when the account's native catalog includes Wonder 1.0. The previous plugin only generated Spark contributor aliases. An explicit contributor row supplied by a future CLI catalog is retained with its own metadata. Wonder Contributor has no bundled reference price and does not inherit the ordinary model's price; all token reporting is independent of pricing.

A direct live probe with official **Muse 1.4.18-R8587.1**, contributor mode `on` and the user's existing CLI login succeeded. Native `session/tokenUsage.modelId` was exactly **`muse-wonder-1.0-contributor`**, not the ordinary Wonder id. It reported 19,500 prompt tokens, 29 output tokens and 13 reasoning tokens for a short test reply.

A further live workflow ran through **Magpie → Bun plugin → official CLI → Meta** using the new model entry. Streamed chat requested a real client-side stdio MCP filesystem read, returned the actual random temporary-file contents and continued the conversation without another tool call. `reasoning_effort: low` was selected. Responses matched Magpie's own Usage ledger exactly across the three HTTP requests:

| Model | Uncached input | Cache read | Cache write* | Whole prompt | Output | Reasoning† | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| muse-wonder-1.0-contributor | 20,711 | 40,296 | 0 | 61,007 | 316 | 135 | 61,323 |

*No separate cache-write count was reported live; nonzero read/write transport is tested through the gateway. †Reasoning is included in output. This live workflow exposed reasoning tokens but **no reasoning text**. The plugin forwards summary text if the CLI supplies it; it cannot create text the model does not expose.

**119 executed, 119 passed, 0 failed, 0 skipped** with the official 1.4.18 CLI and real Magpie/Bun gateway enabled. The four official-CLI/local-backend cases verify that the native wire model retains its contributor suffix, reasoning effort reaches the model request, reasoning summaries reach streaming and buffered clients without duplication, and MCP tools continue the same turn. Wonder Contributor is included; all four cases also pass with the official 1.4.15 binary. Additional gateway checks preserve nonzero cache read/write and reasoning counts in Chat, Responses and Messages, plus a streamed Wonder Contributor MCP/reasoning round trip.

MCP support here means **tools supplied by the client**, including tools backed by a real stdio MCP server. It does not add MCP resources/prompts, server OAuth management or every native CLI feature. The new live result verifies Wonder **1.0 Contributor**, not an untested Wonder Full contributor variant or every possible MCP server.

## CLI compatibility and community bridge review — 2026-11-13, v0.3.2

The previous plugin incorrectly rejected any CLI whose release string did not start with `1.4.15`, even after a successful MSP handshake. That caused Magpie's **“Sign-in didn't finish / This bridge is pinned to Muse CLI 1.4.15”** error for a correctly installed 1.4.18 CLI. The exact-release gate is removed. Compatibility uses the MSP envelope and `sessionMcp` grant; additive SDK fingerprint differences are warnings, as specified by the official SDK.

Downloaded official **Muse Code 1.4.18 (1.4.18-R8587.1)** from Meta's stable-channel manifest and verified **485,689,688 bytes**, SHA-256 `57732db89e25a58196c923b3790aa3e2a85b8d1ad5094492384792260e65b538`, before execution. SDK 1.4.15 was still the latest npm SDK observed, and works against this newer CLI in the checks below.

- **115 executed, 115 passed, 0 failed, 0 skipped** with the 1.4.18 binary and actual Magpie/Bun gateway enabled. This includes compatible release-label/fingerprint changes, rejection of unsupported wire envelopes, canonical tool comparisons, duplicate/invalid tools, explicit failures for gaps/truncation/text disagreement, and usage-cursor deduplication.
- All three official-CLI integration cases also passed on **1.4.15**: normal buffered, normal streaming, contributor streaming. Both CLI releases retained exact tool/token behavior and made **zero internal reminder model requests** with the empty reminder roster.
- `doctor` passed a real 1.4.18 offline echo turn, printed the selected executable and observed CLI version, and exposed the fingerprint difference as a warning.
- Reviewed the community bridge at a specific commit and applied selected ideas; see [UPSTREAM-REVIEW.md](UPSTREAM-REVIEW.md). No upstream runtime code was copied or executed. `npm audit --omit=dev` reported **0 known vulnerabilities** in this package's dependency tree; this is an advisory check, not proof of absence of malicious code.

Separate live tests then ran through **real Magpie → Bun plugin → official 1.4.18 CLI → Meta**, using the existing account. Each model passed streaming, a real client MCP temporary-file read and result, a subsequent user message without tools, and exact response/Usage-ledger agreement:

| Model | Uncached input | Cache read | Cache write* | Whole prompt | Output | Reasoning† | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| muse-spark-1.3 | 20,676 | 40,290 | 0 | 60,966 | 310 | 128 | 61,276 |
| muse-spark-1.3-contributor | 20,648 | 40,290 | 0 | 60,938 | 305 | 124 | 61,243 |
| muse-wonder-1.0 | 20,667 | 40,296 | 0 | 60,963 | 301 | 115 | 61,264 |

*No separate cache-write count was reported by these live sessions; nonzero write transport remains covered by gateway regressions. †Reasoning is included in output; cache is included in whole prompt. Each row sums all three client requests in that model's live workflow. Account credentials and actual temporary-file contents were not stored in the repository. This validates these models and the tested CLI releases, not every future CLI build or every MCP feature.

## Complete token counters and Wonder — 2026-11-13, v0.3.1

Live checks used the user's existing official CLI login through **Magpie 0.1.3903 → Bun plugin → Muse Code 1.4.15 → Meta**. Spark 1.3, Spark 1.3 Contributor and **Wonder 1.0** each passed streamed chat, a real client-side stdio MCP file read, returning the actual file contents, and a following user message without tools. Each workflow made three client HTTP requests.

All response counters summed exactly to Magpie's own Usage ledger, including **nonzero live cache hits**:

| Model | Uncached input | Cache read | Cache write* | Whole prompt | Output | Reasoning† | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| muse-spark-1.3 | 19,650 | 38,370 | 0 | 58,020 | 313 | 140 | 58,333 |
| muse-spark-1.3-contributor | 19,722 | 38,370 | 0 | 58,092 | 341 | 164 | 58,433 |
| muse-wonder-1.0 | 19,604 | 38,376 | 0 | 57,980 | 246 | 66 | 58,226 |

*These live sessions did not report a separate cache-write count. A missing optional split is exported as 0, not evidence that the provider performed no writes. Automated Magpie/Bun tests use explicit nonzero cache writes (3), cache reads (6) and reasoning (2) and verify preservation in Chat, Responses, Anthropic Messages and the Usage ledger in both normal and contributor lanes.

†Reasoning is already contained in output. Whole prompt includes uncached input and cache reads/writes; total is whole prompt plus output. Counts include the CLI's own instructions and all completions in each workflow, not just visible answer text.

The bridge now uses Muse's server-derived counted-once prompt/total values, preserves read/write splits and reports incremental tool-step usage. The final response excludes tokens already returned with earlier tool calls. Tests cover a raw input counter that excludes cache, fallback without a turn aggregate, reset on the next user turn, and exact token sums across multiple completions using the unmodified official CLI and a deterministic local backend.

**102 tests executed, 102 passed, 0 failed, 0 skipped**, with the official Muse and Magpie test binaries enabled (48 legacy, 39 bridge, 5 pricing, 3 official CLI, 7 gateway including nested checks). Package validation includes the new usage module. Token reporting is independent of optional reference pricing. No real credential values or live file contents were saved in the repository.

This establishes live support for Wonder **1.0**, not every Wonder variant, and MCP tools rather than resources/prompts.

## Live account, contributor and USD reference costs — 2026-11-13

The user completed the official `muse login` device flow. Separate live tests then ran through the actual Magpie gateway/Bun plugin host, the official Muse Code 1.4.15 CLI, and Meta's real service. No credential values were read by the plugin or copied into repository files/test fixtures.

Both `muse-cli/muse-spark-1.3` and `muse-cli/muse-spark-1.3-contributor` passed:

- Published in Magpie's model catalog; selected model retained through the request.
- Streamed chat and a client-side MCP filesystem tool performing a real read of a randomly generated temporary file.
- The tool result returned to the same Muse turn and the final answer contained the actual file contents.
- A following message repeated the correct contents without calling a tool.
- Separate CLI processes selected ordinary mode `off` and contributor mode `on`.

Two further small live chat requests verified token counts and USD estimates in **Magpie's own Usage ledger**, the source used by its Usage UI:

| Model | Prompt tokens | Output tokens | Cached input | API-reference USD |
| --- | ---: | ---: | ---: | ---: |
| muse-spark-1.3 | 18,505 | 23 | 0 | $0.023229 |
| muse-spark-1.3-contributor | 18,505 | 23 | 0 | $0.0018551 |

Each response included 11 reasoning tokens, already contained in the 23 output tokens. Token totals include the CLI's own instructions. The ledger totals matched the streamed usage and the calculation against Meta's public per-million-token rates. These are **reference estimates, not extra subscription charges**; see [PRICING.md](PRICING.md).

Automated regression run with all test binaries enabled: **97 executed, 97 passed, 0 failed, 0 skipped** (48 legacy, 35 bridge, 5 pricing, 3 official CLI, 6 gateway including nested protocol/contributor/accounting checks). The contributor CLI regression also verifies that the **actual CLI wire request** retains `muse-spark-1.3-contributor`, rather than only relabeling its response.

That earlier live run covered Spark 1.3 and its contributor variant; Wonder 1.0 is covered above. Subscription allowance cards, full cross-process pending-tool recovery, MCP resources/prompts and tiered Ember price export remain outside this implementation.

## Expanded capability check — 2026-11-13

Full run with `MUSE_TEST_BIN` and `MAGPIE_TEST_BIN`: **88 executed, 88 passed, 0 failed, 0 skipped**. This includes 48 legacy tests, 34 bridge tests, two official Muse CLI cases, and four actual Magpie gateway tests (parent plus three protocols).

| Capability | Evidence | Scope |
| --- | --- | --- |
| Chat and conversation reuse | Scripted MSP subprocess; real CLI echo | No live Meta model |
| Streaming and tool continuation | Official Muse 1.4.15, streaming/non-streaming | Backend on loopback |
| Multiple tool calls | Two tool calls with official CLI; consecutive steps with scripted MSP | Client owns execution |
| MCP tools | Actual CLI ↔ HTTP MCP bridge; independent stdio filesystem MCP reads a real temporary file | Tools only |
| OpenAI Chat/Responses and Anthropic Messages | Real Magpie/Bun gateway, tools and returned results | Scripted MSP subprocess |
| Reasoning, usage and effort | MSP event/command regression tests | No model reasoning-quality claim |
| Inline images | Input payload reaches turn/start | Vision inference not tested |
| Quota/auth failures | 429/401 before output, including streaming | Scripted CLI error events |
| Unsupported features | Explicit tests for MCP resources/prompts, structured output, audio and remote images | Not implemented |

The expanded run found and fixed a status-mapping defect: quota errors became 502, and streaming committed 200 before an immediate auth/quota error. These now preserve 429/401 until output begins. Errors after output begins remain SSE errors.

The stdio filesystem MCP test is a separate client-side process performing a real file read. It does not establish compatibility with every third-party MCP server, server OAuth, resources or prompts. The protocol conversion tests demonstrate Chat, Responses and Messages transport behavior, not every Codex/Claude client feature. At that stage live Meta account inference had not yet been verified; see subsequent live checks above. Full subscription/interactive parity remains unverified.

## Initial validation — 2026-11-12

Validated on Linux x64 on 2026-11-12 with Node 24.22.1, Muse Code 1.4.15-R8339.1, SDK 1.4.15 and Magpie 0.1.3903.

- `MUSE_TEST_BIN=/absolute/path/to/muse npm test`: **66 executed, 66 passed, 0 failed, 0 skipped**. The default suite without that variable skips the official-CLI integration explicitly.
- Real official Muse CLI + localhost deterministic Responses backend: client tool schema reached the model, Muse requested the MCP tool, the plugin returned the original client tool name/arguments, and the client's result reached the same Muse turn. The primary model request contained only the client MCP tool namespace. Approval was once-only, with no persistent policy grant.
- Real Muse echo: `npm run doctor` passed without a Meta login.
- Real Magpie + its Bun plugin host: installed this folder, linked local CLI, and `magpie provider test muse-cli` passed using real Muse's echo provider (117 ms in the final check).
- Real Magpie HTTP gateway + Bun plugin + test MSP subprocess: returned `tool_calls`, accepted a client tool result, and returned `MAGPIE_GATEWAY_TOOL_OK` from the resumed turn.
- New regression tests cover streaming/non-streaming, parallel tool calls, conversation reuse, history/model changes, cancellation before the turn ack, startup races, CLI crash/restart, tool timeout, cross-session result rejection, missing CLI/capability, and closing a session with a pending tool call. Inherited 48 tests cover the legacy implementation separately; they do not validate CLI behavior.
- `npm pack --dry-run --ignore-scripts`: package includes the new entry, CLI, runtime modules, icon, license and documentation. The legacy OAuth runtime files are excluded.
- Official Muse artifact size and SHA-256 matched the release manifest. Magpie's executable matched the release's SHA256SUMS. TLS and dependency integrity verification remained enabled.

Not verified: live Meta-account inference, quota exhaustion behavior, Windows/macOS, exact Claude bridge system-prompt semantics, subscription allowance cards, or cross-process restoration of a pending client tool. No claim of full Claude feature parity is made. The install and limits are documented in README.md.
