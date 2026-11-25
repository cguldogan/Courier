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

## Phase 5 — More protocols (Done)

| Feature | Acceptance |
| --- | --- |
| WebSocket | Connect with headers and auth, send text/binary, message log, saved messages, variables resolved |
| gRPC | Load `.proto` files or use server reflection; unary and streaming calls; metadata; TLS |

Shipped as two new request kinds (`type: "websocket"`, `type: "grpc"`) in collections. They are saved,
synced, secret-scanned, moved and duplicated like HTTP requests, and HTTP-only documents serialise
byte-identically to before. The engine lives in `src/main/realtime/` (`ws` 8.23, `@grpc/grpc-js` 1.14,
`protobufjs` 7.6). Handshakes and calls reuse the HTTP send path for variables, Key Vault and auth.
Digest, NTLM and AWS Signature fail with a clear error. Events stream over `ws:event` / `grpc:event`,
logs live in renderer memory only (2,000 messages / 8 MB), and connections close with their tab, their
window and on quit. The gRPC service definition is stored with the request as whitelisted protobufjs
JSON rather than a binary FileDescriptorSet. protobufjs's own descriptor conversion loses map fields,
so reflection answers are converted by Courier. `.proto` imports resolve only inside picked directories.
TLS CA, certificate and key paths stay in userData per request id and are never synced. The runner,
`courier run`, Postman export and snippets skip both kinds and name the requests they skipped.

Verified with vitest against local `ws` and `@grpc/grpc-js` servers. The gRPC servers use
`@grpc/reflection` for v1 and v1alpha. Coverage includes TLS with a trusted and an untrusted self-signed
certificate, the mock Key Vault, a hostile-definition test and an Azurite sync between two clients. The
UI end-to-end run covers connect / send / saved messages / disconnect, reflection and `.proto` import,
unary, server-streaming, bidi and error calls, team sync to a second instance and the runner's skip note.
Not verified: real public WebSocket or gRPC services, servers in other languages (Go/Java reflection
descriptors are only exercised through the converter's protoc-style map-entry handling), Protobuf
Editions files, client-certificate (mutual TLS) authentication against a server that requires it,
proxies, and WebSocket compression interop beyond `ws`.

## Phase 6 — Mock servers and monitors (Done)

Postman runs these in its cloud. Courier's versions run on the user's machine.

| Feature | Acceptance |
| --- | --- |
| Saved response examples | Save a response as an example on a request; synced with the collection |
| Mock server | Local HTTP server that matches method + path (and an optional example header) to saved examples; start/stop per collection; request log |
| Monitors | Scheduled collection runs while the app is open, or unattended through the command-line runner; run history and failure notifications |

Shipped as follows.

- **Examples**: an optional `examples` list on HTTP requests in the collection file. A request without
  examples, and so every existing file, serialises byte-identically. An example is built in main from
  the masked response of a send in this session (Key Vault values, tokens and secret-typed variable
  values masked) and the unresolved request template. Credential-carrying
  response headers (`Set-Cookie`, `Authorization`…) are left out unless kept one by one. Text bodies are
  capped at 1,000,000 characters and binary bodies at about 1.1 MB of base64, with a note. Examples are
  in the secret scan, open in their own tab (response editable), sync, duplicate and move with the
  collection, and map to and from Postman `response[]`.
- **Mock servers** (`src/main/mock/`): one `node:http` server per collection on `127.0.0.1` only, with a
  Host-header check, 1 MB body cap, a fixed delay, CORS (default on) and `{{variable}}` substitution from
  plain shared values. Key Vault references and vault- and secret-typed variables are served as `••••`.
  Matching is method + path, then the `x-mock-response-id` / `-name` / `-code` headers, query overlap,
  the most specific path, then collection order; a miss is a 404 with diagnostics. Logs are memory only
  (500 entries). Servers stop on quit and when their collection is deleted or removed. Also
  `courier mock <file>`.
- **Monitors** (`src/main/monitors.ts`): interval, daily and weekday schedules in local time, with a
  15-second tick and no replay of missed runs. A long gap gives at most one catch-up run, and runs never
  overlap. A monitor runs through the collection runner with the same Key Vault rules as an interactive
  run. Variable changes are not kept. History holds 100 runs per monitor with up to 500 results each,
  masked, in userData, never synced. An Electron `Notification` fires on the first failure and once on
  recovery, and the top bar shows a badge.

Verified with vitest:

- example round-trips and the existing fixture files staying byte-identical;
- saving a response with a mock Key Vault value, which then appears in no file;
- header stripping and opt-in, caps, Postman import and export;
- a matching table covering every rule and the 404 diagnostics;
- the Host check with raw requests, CORS and preflight, delay, substitution, port in use, hostile
  example headers, malformed and oversized requests, live edits and stop-on-delete through the core;
- the built `courier mock` as a child process;
- the scheduler on a fake clock: interval, daily, weekday, DST in America/New_York, no overlap, a single
  catch-up, disable;
- notification decisions, and monitor history masking and the Key Vault gate through the core.

The UI end-to-end run covers:

- save as example, editing an example, the mock server called from the test and from a `{{mockUrl}}`
  request, the log, and a refused foreign Host;
- a monitor every 2 seconds (test hook) that passes, fails with the badge and one stubbed OS
  notification, then recovers;
- the notification click, and the team sync of the example to the second instance;
- `courier mock` in `e2e/cli.mjs`.

Not verified:

- real OS notification delivery and its click on macOS, Windows or Linux (it is stubbed in the run);
- schedules over real days or across a real sleep/wake (only the fake clock);
- the DST cases in time zones other than America/New_York;
- mock servers used from a real browser page (CORS, Private Network Access prompts);
- examples imported from real Postman exports beyond the hand-written fixtures;
- the cron and scheduled-pipeline snippets in the README.

## Later

- Signed and notarized installers for macOS (Developer ID + notarization) and Windows (code-signing
  certificate), and auto-update. Continuous integration now exists (`.github/workflows/ci.yml`: typecheck,
  unit tests and build on Linux, macOS and Windows, x64 and arm64, plus the end-to-end run on Linux and
  macOS; `.github/workflows/build.yml`: unsigned packages for every OS and arch, smoke-tested, and a
  draft release on `v*` tags), but the packages are unsigned (macOS ad-hoc only) and nothing updates
  itself
- The end-to-end run on Windows (the command-line check stops `courier mock` with SIGINT, which Windows
  cannot send to a child process)
- A trial against a real Storage Account and Key Vault, browser sign-in and managed-identity
  sign-in on an Azure-hosted machine
- Published API documentation, Flows
- Performance (load) tests; cloud-hosted mock servers and monitors (Courier's run on the local machine
  only, while the app is open, or through `courier run` / `courier mock`)
- Webhook-triggered runs
