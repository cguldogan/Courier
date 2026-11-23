# Courier plan

Status key: **Done**, **In progress**, **Planned**. Each phase ships only when `npm run typecheck`,
`npm test`, `npm run build` and `npm run e2e` pass, and its features are driven through the real
UI in the end-to-end run. The Postman feature research behind this list is in
[RESEARCH.md](RESEARCH.md).

## Done

- Request editor, tabs, collections, folders, environments, globals, history, cookie jar
- Auth: Basic, Bearer, API key, OAuth 2.0 client credentials, Azure identity token
- Phase 2 auth types, Phase 3 scripting and the Phase 4 command-line runner (below)
- Scripts in a QuickJS isolate with a `pm.*` subset; collection runner with data files
- Postman v2.1, OpenAPI 3 and cURL import; Postman export; code snippets
- Azure identity sign-in: automatic, managed identity, Azure CLI, browser
- Sync to Azure Blob Storage with ETag conflicts; Key Vault references; script access to
  Key Vault gated per collection

## Phase 1 — Personal + Teams (Done)

- Personal items are local files only; nothing is uploaded.
- A team is its own storage container, so Azure RBAC on the container is the isolation boundary.
- Join a team by storage URL + container; a team file supplies its name and Key Vault list.
- Vault hosts that arrive from a team file need approval on each machine.
- Per-team sync, errors and conflicts; move items between Personal and teams.

## Phase 2 — Authorization types (Done)

| Feature | Acceptance |
| --- | --- |
| OAuth 2.0 authorization code + PKCE | System browser with a loopback redirect; token cached and refreshed; client secrets may be Key Vault references; tokens never written to disk in plain text |
| Digest | Challenge/response against a test server, `qop=auth`, MD5 and SHA-256 |
| AWS Signature v4 | Signs headers and query; verified against AWS's published test vectors |
| NTLM | Three-message handshake against a test server on a kept-alive connection |
| JWT bearer | HS256/RS256/ES256 signing; private keys may be Key Vault references |

Shipped as specified, with Postman v2.1 import/export (`oauth2`, `digest`, `awsv4`, `ntlm`, `jwt`),
secret-scan findings for their literal secrets, and placeholder-only code snippets. Tokens are kept
encrypted with Electron `safeStorage` or in memory only; a team collection's OAuth hosts need approval
on each machine. Verified with AWS's SigV4 suite and S3 examples, the MS-NLMP NTLMv2 and RFC 1320 MD4
known answers, the RFC 7616 example, and local fake servers (vitest and the UI end-to-end run). Not
verified against a real identity provider, AWS or Windows server.

OAuth 1.0, Hawk, Akamai EdgeGrid and ASAP stay out unless someone needs them.

## Phase 3 — Scripting (Done)

| Feature | Acceptance |
| --- | --- |
| `pm.execution.setNextRequest` | Runner follows the scripted order; `null` stops the run; loop guard |
| `pm.cookies` and `pm.cookies.jar()` | Read, set and clear cookies for the request's domain |
| `pm.visualizer.set(template, data)` | Renders in a sandboxed frame with no script or network access to the app |

Also `pm.execution.skipRequest()`. Deviations from Postman (README, "Scripting additions"): the cookie
jar API reaches only the current request's host instead of a configurable allowlist; visualizer
templates are rendered by Courier with a Handlebars subset, `{{{x}}}` is escaped, and template scripts
and network loads never run.

## Phase 4 — Command-line runner (Done)

- `courier run <collection>` runs a collection file, or a team collection by name, without a window.
- Options: environment, data file, iterations, delay, bail, folder filter.
- Uses the same Azure identity modes, so managed identity works on build agents; Key Vault
  references resolve; secrets stay masked in output.
- Reporters: console, JSON and JUnit XML; non-zero exit code on any failure.

Shipped as `out/cli/courier.cjs` (plain Node, `src/cli/`, built by `npm run build` or `npm run
build:cli`; `bin` entry `courier`), sharing the app's executor, runner, sandbox, Key Vault and blob code.
It reads Courier and Postman collection, environment and globals files, or downloads a team collection
and environment read-only (by name or id; nothing uploaded, no cache). Also `--globals`, `--env-var`,
`--timeout`, `--insecure`, `--max-jumps`, repeatable `--folder`. Sign-in is managed identity or the
Azure CLI (`auto` tries both), only when a run needs it; no browser. Team-file Key Vaults need
`--approve-vault <host>`; scripts read Key Vault only with `--allow-script-vault`, optionally pinned
with `--scripts-sha256`. OAuth 2.0 authorization code fails with `AUTH_REQUIRED`. Nothing is read from
or written to userData. Exit codes 0 / 1 / 2. Verified with vitest (in-process and the built bundle
as a child process), against Azurite, the mock Key Vault and the fake identity, and by `e2e/cli.mjs`.
Not verified: real managed identity or Azure CLI sign-in, a real Storage Account or Key Vault, the
pipeline snippets in the README, and running from an electron-builder package (only the development
Electron binary with `ELECTRON_RUN_AS_NODE=1` was tried). Differences from Newman (from
general knowledge, not re-checked): no HTML reporter, no cookie-jar file, request body files are not
sent, and `--timeout` is per request.

## Phase 5 — More protocols (Planned)

| Feature | Acceptance |
| --- | --- |
| WebSocket | Connect with headers and auth, send text/binary, message log, saved messages, variables resolved |
| gRPC | Load `.proto` files or use server reflection; unary and streaming calls; metadata; TLS |

## Phase 6 — Mock servers and monitors (Planned)

Postman runs these in its cloud. Courier's versions run on the user's machine.

| Feature | Acceptance |
| --- | --- |
| Saved response examples | Save a response as an example on a request; synced with the collection |
| Mock server | Local HTTP server that matches method + path (and an optional example header) to saved examples; start/stop per collection; request log |
| Monitors | Scheduled collection runs while the app is open, or unattended through the command-line runner; run history and failure notifications |

## Later

- Signed and notarized installers for macOS and Windows, auto-update
- Continuous integration running the test suites on every push
- A trial against a real Storage Account and Key Vault, browser sign-in and managed-identity
  sign-in on an Azure-hosted machine
- Published API documentation, Flows
