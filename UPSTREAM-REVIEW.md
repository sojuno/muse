# Community bridge review — 2026-11-13

Reviewed [DylanLIiii/magpie-muse-bridge](https://github.com/DylanLIiii/magpie-muse-bridge) at commit [`aba1edbe1d5e975735a997c435fb24120733251a`](https://github.com/DylanLIiii/magpie-muse-bridge/tree/aba1edbe1d5e975735a997c435fb24120733251a), package 0.2.2, licensed MIT. This is a source review, not a certification of every release or its dependencies. No upstream runtime code was copied into this plugin, and it is not a runtime dependency.

## Security observations

Read the shipped JavaScript modules (`index.mjs`, `sdk-runtime.mjs`, `mcp-server.mjs`, `muse-auth.mjs`, `muse-usage.mjs`), package/lock metadata and CI workflow. No obvious credential-exfiltration endpoint, obfuscated payload, persistence installer or install lifecycle hook was found in those files. Upstream network inference is delegated to the official CLI; its control server binds to loopback and authenticates with a random per-conversation token. The lockfile names the official npm SDK 1.4.14 as its only dependency. Tests and diagnostics are separate from the shipped package; upstream live tests and author-specific remote-machine commands were not executed.

The upstream bridge deliberately links and synchronizes `auth.json` into isolated settings directories. Its `syncAuth` reads the replacement credential file and can overwrite the original when its contents differ. That is not by itself evidence of malicious behavior, but without cross-process freshness coordination an older conversation's refresh could overwrite newer credentials. Our plugin continues to let the CLI manage the original authentication directly; it does not copy or synchronize credential contents.

The source review cannot establish the absence of every backdoor, audit Meta's closed-source CLI, or vouch for later upstream commits. Our official test executables were downloaded separately and matched their release manifests before execution.

## Useful design choices and resulting changes

| Upstream choice | Applied here |
| --- | --- |
| SDK transport and capability negotiation | Keep the existing official SDK/MSP bridge; remove the erroneous exact CLI release gate. Additive fingerprint changes remain warnings. Unsupported envelope versions and missing `sessionMcp` remain actionable errors. |
| Canonical tool-schema comparisons | Preserve native turns when JSON object keys or the tool list are reordered; reject duplicate names/invalid schema containers. |
| Empty reminder roster | Disable internal reminder model requests using the official host configuration; verify absence of these requests with the real CLI. |
| Refuse incomplete or inconsistent output | Report event gaps, truncated completed answers and text disagreement explicitly instead of a successful partial answer. |
| Usage cursor deduplication | Count replayed usage notifications only once while retaining prompt/output/cache-read/cache-write/reasoning totals. |

Both implementations let the original client execute tools and return the result to the same native Muse turn. The current plugin already supports real Magpie Chat, Responses and Messages conversions, dynamic CLI model discovery, and explicit separate normal/contributor hosts.

## Differences retained

- Upstream uses SDK 1.4.14 and advertises a static model list. This plugin uses SDK 1.4.15 (the latest npm SDK observed during this review) and the CLI's live model catalog. A pinned dependency does not require an identical CLI release number.
- Upstream starts hosts with contributor mode `off` and checks selected models against its Meta catalog. This plugin retains `-contributor` model ids and dedicated contributor hosts; copying that upstream setting would regress a required feature.
- Native shell and writes remain disabled here, with once-only admission of the bridge's client MCP tools, an empty temporary workspace, and a secret loopback endpoint that rejects browser origins.
- Upstream provides browser/device login inside Magpie and subscription allowance cards via `muse usage --json`. This plugin currently links an existing official CLI login and reports request token usage. It does not claim those account-UI features or full feature parity; adding them is separate from fixing CLI compatibility.

See [TESTING.md](TESTING.md) for the tests of the resulting implementation, including the actual 1.4.18 CLI. Passing our tests is not a claim that the upstream project's tests were executed.
