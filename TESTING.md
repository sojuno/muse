# Validation record

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

The stdio filesystem MCP test is a separate client-side process performing a real file read. It does not establish compatibility with every third-party MCP server, server OAuth, resources or prompts. The protocol conversion tests demonstrate Chat, Responses and Messages transport behavior, not every Codex/Claude client feature. Live Meta account inference, quota accounting and full subscription/interactive parity remain unverified.

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
