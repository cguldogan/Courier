# Contributing

Thanks for helping. Courier is an Electron + React + TypeScript app; the plan and open
phases are in [docs/PLAN.md](docs/PLAN.md).

## Setup

```sh
npm ci
npm run dev        # run the app
npm run typecheck
npm test           # unit and integration tests (Azurite + a mock Key Vault, no real Azure)
npm run build
npm run e2e        # drives the real UI and the command-line runner
```

On an Apple-silicon Mac whose shell runs under Rosetta, prefix the commands with
`arch -arm64`.

## Rules for changes

- All four of `typecheck`, `test`, `build` and `e2e` must pass.
- New behaviour comes with tests; user-facing features are also driven in `e2e/`.
- Tests never touch real Azure. Use the Azurite and mock Key Vault helpers in
  `tests/helpers.ts`.
- Keep the security model: sandboxed renderer, one typed preload API, all network and
  secret handling in the main process, and only `src/main/index.ts` and `src/main/ipc.ts`
  import `electron`.
- Secrets are resolved at send time and masked everywhere else. A change that stores,
  logs or syncs a resolved secret will not be merged.
- No real names, emails, tenant or subscription ids, hostnames or tokens in code, tests,
  fixtures, screenshots or commit messages. Use `example.com`-style placeholders.

## Pull requests

Describe what changed and how you verified it. Security problems go through the process
in [SECURITY.md](SECURITY.md), not a public issue or pull request.
