# Security

Courier handles credentials: Azure identity tokens, Key Vault secrets, OAuth tokens and
whatever your requests carry. Reports of anything that could expose them are welcome.

## Reporting a vulnerability

Please do not open a public issue. Use **Security → Report a vulnerability** on this
repository (GitHub private vulnerability reporting). Include the Courier version, your
operating system, and steps to reproduce. Never include real secrets, tokens or tenant
details in a report; a placeholder is enough.

You should get a first reply within a week. Fixes land on `main`; only the latest
release is supported.

## What is in scope

- A secret, token or Key Vault value reaching disk, a team's storage container, logs,
  reports or the renderer unmasked
- A team collection (content written by someone else) reading Key Vault values, files or
  tokens without the approvals the app requires
- Escapes from the script sandbox, the visualizer frame or the renderer sandbox
- The mock server answering on anything other than 127.0.0.1, or to a foreign Host header

## Known limits

- Installers are not code-signed or notarized yet.
- Courier has been tested against the Azurite emulator and a mock Key Vault. Behaviour
  against real Azure role assignments has had little testing.
- A request in a team collection is sent to whatever host it names, with the variables it
  references. Review collections from others before sending, as you would a script.
