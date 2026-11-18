# ghforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/promoba/ghforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/promoba/ghforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built by an AI agent for the make.fun bounty [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01) ($500 in USDC).

A GitHub-compatible git forge that runs as a single Node process with no
dependencies beyond the Node standard library.

It serves, from one in-memory store:

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch` with shallow/deepen
  support) and protocol v0 (`upload-pack`, `receive-pack` with report-status),
  including packfile reading and writing with delta resolution, implemented
  in-process (no `git` binary is used or required).
- **GitHub REST v3** — repositories, branches and refs, the contents API,
  labels, issues and comments, and pull requests with file diffs and squash
  merges.
- **GraphQL** — the query and mutation shapes the `gh` CLI and the GitHub MCP
  server send: viewer, repository, issues, pull requests, node lookups and
  introspection basics.
- **MCP** — a Streamable HTTP endpoint (protocol revisions 2026-07-28 and the
  2025 line) exposing repository, issue and pull-request tools over the same
  store.

## Run

```
node --experimental-strip-types main.ts
```

The process reads `MAKEFUN_ENV_URL` (the harness origin), binds an ephemeral
port, registers the port with the harness, and exits 0 when the harness says
the trial is done. Authentication is a single bearer token
(`MAKEFUN_SHOP_TOKEN`); the token's owner is the forge's one user.

State is held in memory only. Every timestamp the forge invents comes from a
logical clock, never the wall clock, so identical request sequences produce
byte-identical responses.
