# Direct API tests — v0.4.0, 2026-11-13

The default provider is `muse`, backed directly by Meta's Responses API. No Muse CLI/SDK is involved in the API tests. Earlier CLI-backend results are preserved separately in [CLI-TESTING.md](CLI-TESTING.md).

## Automated regressions

**157 executed, 157 passed, 0 failed, 0 skipped**, with both native test executables enabled:

```sh
MUSE_TEST_BIN=/path/to/official/muse \
MAGPIE_TEST_BIN=/path/to/magpie \
MAGPIE_TEST_BUN=/path/to/magpie-bun \
npm test
```

The run used Linux, Magpie 0.1.3903, Bun 1.4.4, and Muse CLI 1.4.18 for the archived CLI tests only. Without native test variables the associated integration tests skip explicitly.

Current API coverage includes:

- Device-code authorization, key exchange, cancellation, replaced flows, refresh/concurrent persistence, transient failures and exact auth destinations. The application sends its own identity and current `{}` key-exchange body.
- Exact instructions, developer/user input, mixed text/image ordering, function arguments/call ids/results, subsequent user messages and Contributor ids. No CLI transcript or system wrapper is added.
- Original MCP/client function-name restoration in JSON and byte-split UTF-8/CRLF SSE, with reasoning and full usage retained.
- Foreign inference destinations refused before credential access; redirects refused; local test backends reject real credentials. A 401 renews once, while 429 and missing stored context remain explicit errors.
- Actual Magpie/Bun translation for Chat Completions, Responses and Anthropic Messages, including complete tool-result loops. Controlled responses report prompt 20, output 7, cache read 8, cache write 3 and reasoning 2; each ledger row retains uncached input 9 and the other splits exactly.
- Account-scoped model discovery, including simultaneous discoveries, and Contributor alias precedence. Existing OAuth-engine and archived CLI regressions are included in the total, which is not a count of live API requests.

## Live Meta subscription API

The user signed in through Magpie's device flow. Tests used that separate API account through the real Magpie/Bun host; no CLI credential files were imported. Each model passed streaming and a small conversation checking separate system JSON instructions, developer-required keys and a literal user value.

| Model | Whole prompt | Output | Cache read | Cache write* | Reasoning† | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| muse-spark-1.3 | 62 | 237 | 0 | 0 | 215 | 299 |
| muse-spark-1.3-contributor | 62 | 434 | 0 | 0 | 394 | 496 |
| muse-wonder-1.0 | 62 | 100 | 0 | 0 | 75 | 162 |
| muse-wonder-1.0-contributor | 62 | 96 | 0 | 0 | 71 | 158 |

Spark Contributor also returned a visible reasoning summary, which reached the client. A summary is not guaranteed on every response.

A separate **Spark 1.3 Contributor** test used a real, independent stdio MCP server on the client side. It initialized MCP, listed its file-read tool, forwarded the definition through Magpie, executed the returned call in the MCP process, and sent the actual random file contents back. Muse returned the exact value. A following turn changed the system instruction and appended two user messages; it obeyed the new format, retained the file value, and used the literal code from the first new message. All three requests passed, and client response usage matched Magpie's ledger exactly: prompt 1,604, output 773, reasoning 560, cache read/write 0. This verifies MCP tools through a client, rather than hosted API MCP execution.

## Actual OpenCode clients and execution location

OpenCode **1.19.5 and 2.2.7** each passed a controlled, end-to-end workflow through actual Magpie/Bun and the new API provider. The upstream Responses backend was deterministic loopback with dummy credentials for these two runs. Both clients executed their own write, read, edit and bash/shell tools, returned the actual results, and received the final response. Their differing schemas (`filePath` versus `path`, `bash` versus `shell`) worked without a fixed gateway tool schema. The client file changed as expected, shell recorded the client project directory, and a gateway-side sentinel remained unchanged.

A further **OpenCode 2.2.7 → Magpie → live Meta API** run used **Muse Wonder 1.0 Contributor**. It completed write/read/edit/shell and additional reads, with final confirmation. Only the benign shell command `pwd > client-shell.txt` was allowed, in a private temporary client project. The gateway sentinel remained unchanged. This workflow made six model requests; the ledger totals below exclude the separate smoke request above:

| Uncached input | Cache read | Cache write* | Whole prompt | Output | Reasoning† | Total |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,155 | 17,616 | 0 | 27,771 | 1,197 | 400 | 28,968 |

*Live responses reported no separate cache-write count. Nonzero cache-write transport is covered by controlled native-gateway tests. †Reasoning is already included in output; cache is already included in whole prompt.

These checks establish the named models, versions, protocols and client tools. They do not prove every future model or client, hosted API MCP execution, MCP resource/prompt discovery, or forced tool choice. MCP functions traverse the API like other client functions; MCP connections and permissions remain the client's responsibility.

Live credentials, file contents and account details are excluded from the repository and package. Executables were obtained from official release/npm sources and verified against release checksums or registry integrity before use.
