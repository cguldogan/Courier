# Research: Postman's feature set and what Courier covers

Researched 2026-11-23. Sources are linked inline. Where a page could only be partially
fetched, the item is marked *(general knowledge)* and should be re-checked before relying on it.

## 1. What Postman is made of

| Area | Postman | Source |
| --- | --- | --- |
| Collections | Groups of saved requests, nested folders; run manually, on a schedule, from CI or a webhook; auto-generated docs | [Postman elements](https://learning.postman.com/docs/getting-started/basics/postman-elements) |
| Collection format | JSON v2.1: `info`, `item` (request or folder), `event` (pre-request / test scripts), `variable`, `auth`; collection auth applies unless a request overrides it | [v2.1 schema docs](https://schema.postman.com/json/collection/v2.1.0/docs/index.html) |
| Variables | Scopes, narrowest wins: local → data → environment → collection → global. Each variable has a *local value* (never synced) and a *shared value* (synced to the team) | [Variables](https://learning.postman.com/docs/sending-requests/variables/variables/) |
| Authorization | No auth, API key, Basic, Bearer, JWT bearer; plus Digest, OAuth 1.0, OAuth 2.0, Hawk, AWS Signature, NTLM, Akamai EdgeGrid, ASAP *(general knowledge — page fetch was truncated after JWT bearer)* | [Authorization types](https://learning.postman.com/docs/sending-requests/authorization/authorization-types/) |
| Scripts | JavaScript before/after a request at collection, folder and request level. Sandbox API: `pm.request`, `pm.response`, `pm.sendRequest`, `pm.test`, `pm.expect`, `pm.info`, `pm.cookies`, `pm.execution`, `pm.vault`, `pm.visualizer`, `pm.require`, variable scopes | [Sandbox reference](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/overview) |
| Collection Runner | Environment, iterations, data file (CSV/JSON), request order/selection, delay, stop on error, keep variable values, cookie options, persist responses; `setNextRequest`; scheduling and performance runs in the cloud | [Collection runs](https://learning.postman.com/docs/collections/running-collections/intro-to-collection-runs/) |
| Cloud platform | Workspaces and team sync, monitors, mock servers, Flows, API docs publishing, Postman CLI | [Postman elements](https://learning.postman.com/docs/getting-started/basics/postman-elements) |
| Protocols | HTTP/REST, GraphQL, gRPC, WebSocket, Socket.IO, MQTT, MCP *(general knowledge)* | — |

## 2. How the alternatives share collections and keep secrets

Bruno keeps collections in a git repo:

- Collections are plain files on disk so API changes are reviewed like code; the docs name
  GitHub, GitLab, Bitbucket and **Azure DevOps** as hosts, with collections either beside the
  source code or in a dedicated repo. In Bruno 3 the in-app branching, conflict resolution,
  commit and push are paid features.
  ([Bruno git integration](https://docs.usebruno.com/git-integration/overview))
- Secrets are stripped before sharing: secret variables are stored locally (OS-level
  encryption or AES-256), or come from a `.env` file or an external secret manager.
  ([Bruno secrets](https://docs.usebruno.com/secrets-management/overview))

Postman by contrast syncs collection JSON through its own cloud; git tracking is possible but
not the primary workflow, and the free plan is now single-user (per third-party 2026
comparisons — [tech-insider](https://tech-insider.org/api-testing-tools-postman-vs-bruno-vs-insomnia-vs-hoppscotch-2026/),
treat as unverified).

## 3. Azure identity, Blob Storage and Key Vault

Courier stores team content in Storage Account containers and secrets in Key Vault, both reached
with the signed-in Azure identity. Personal items never leave the machine. (A git-repo backend was considered and dropped: collections carry
tokens and credentials, and git history is permanent.)

- **Managed identities only exist on Azure-hosted compute.** Azure manages the credential and
  the app stores no secret; a laptop has no managed identity. Courier therefore offers managed
  identity (for Azure VMs / AVD / Arc machines) alongside Azure CLI and interactive browser
  sign-in for developer machines.
  ([Managed identities overview, via the Azure DevOps identity guide](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/service-principal-managed-identity))
- **Blob data access needs a data-plane role.** Creating or owning a storage account does not
  grant data access through Entra ID; the identity (user, group, service principal or managed
  identity) needs **Storage Blob Data Contributor** (read/write) or **Storage Blob Data Reader**,
  scoped to the account or, better, the container. Role changes can take up to 10 minutes to
  apply. ([Assign an Azure role for blob data access](https://learn.microsoft.com/en-us/azure/storage/blobs/assign-azure-role-data-access))
- **Isolation follows the container, so a team is a container.** A role assignment scoped to a
  container covers every blob in it, so blob-name prefixes inside one container cannot keep groups
  apart (that would need an ABAC condition on the blob path in every assignment). Courier therefore
  models each team as its own storage location (account URL + container): the team's members get
  Storage Blob Data Contributor or Reader on that container, and nothing else separates teams.
  Private work is not uploaded at all: Personal items live only in the app's userData. A small
  `courier-team.json` at the container root carries the team name and its Key Vault list; since any
  writer can change it, Courier only contacts a vault host from it after the user approved that host.
- **Key Vault secrets** use Azure RBAC (the default model for new vaults since API version
  2026-02-01): **Key Vault Secrets User** reads secret values, **Key Vault Secrets Officer**
  also creates and updates them. `Key Vault Contributor` and `Key Vault Reader` do not expose
  secret values. Microsoft recommends one vault per application per environment with roles at
  vault scope. ([Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide))
- Prior art for vault-backed secrets in an API client: Postman's `pm.vault`, and Bruno's secret
  manager integration (section 2).

## 4. Parity table

| Postman feature | Courier |
| --- | --- |
| Collections, folders, requests, tabs | Yes |
| Variables: global / collection / environment / data / local, same precedence | Yes |
| Local vs shared variable values | Yes — shared value in the team's container, current value on this machine only |
| Auth: none, API key, Basic, Bearer, OAuth 2.0 client credentials, inheritance | Yes |
| Auth: token from the signed-in Azure identity for any scope | Yes (not in Postman) |
| Auth: JWT bearer, Digest, OAuth 1.0, OAuth 2.0 interactive grants, Hawk, AWS SigV4, NTLM, EdgeGrid, ASAP | No |
| Body: raw, urlencoded, form-data with files, GraphQL, binary | Yes |
| Pre-request and test scripts, `pm.*` subset, `pm.sendRequest` | Yes (QuickJS isolate) |
| `pm.vault.get` | Yes (reads Azure Key Vault) |
| `pm.cookies`, `pm.visualizer`, `pm.require`, `setNextRequest` | No |
| Collection Runner: iterations, delay, data file, stop on failure | Yes |
| Postman v2.1 collection + environment import/export, cURL import, OpenAPI import | Yes (OpenAPI basic) |
| Code snippets | cURL, JavaScript fetch, Python requests |
| History, cookie jar | Yes |
| Team sharing / workspaces | Teams = Azure Storage containers (join any number; RBAC on each container is the boundary), Personal = this machine only; per-team ETag-based sync with conflict resolution |
| Secrets | Azure Key Vault references (`{{vault:name}}`), resolved at send time, never stored or synced; team-wide vault aliases from the team settings, used only after the host is approved on each machine |
| Sign-in | Azure identity: managed identity, Azure CLI, interactive browser |
| Mock servers, monitors, Flows, published docs, scheduled runs, performance tests | No |
| gRPC, WebSocket, Socket.IO, MQTT, MCP | No |
