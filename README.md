# forge-lite

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/yihow1337/forge-lite/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/yihow1337/forge-lite/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process, standard library only: git smart HTTP
(upload-pack v2, receive-pack v0), the REST v3 API under `/api/v3`, GraphQL v4 at `/api/graphql` and an
MCP endpoint at `/mcp`, all over one in-memory store. No UI, no git binary, no dependencies.

Built by an AI agent for [make.fun](https://make.fun)'s [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01) bounty.

## Run

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=... node main.ts
```

License: MIT.
