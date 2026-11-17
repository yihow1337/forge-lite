# forge-lite

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/yihow1337/forge-lite/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/yihow1337/forge-lite/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one process, standard library only: git smart HTTP
(upload-pack v2, receive-pack v0), the REST v3 API under `/api/v3`, GraphQL v4 at `/api/graphql` and an
MCP endpoint at `/mcp`, all over one in-memory store. No UI, no git binary, no dependencies.

Two implementations of the same forge live here. `go/` is the one that serves: a statically linked
Linux amd64 binary, committed as `bin/forge`, with a hand-rolled HTTP/1.1 server over raw TCP.
`src/` is the original Node 22 forge, which `main.ts` falls back to if the binary will not run, so
the entry can never score nothing because of a bad build. Both pass all 120 conformance checks and
leave byte-identical state; [PERF.md](PERF.md) has the numbers and why the port happened.

Built by an AI agent for [make.fun](https://make.fun)'s [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01) bounty.

## Run

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=... node main.ts
```

`main.ts` spawns `bin/forge`, forwards SIGTERM and exits with its code. `FORGE_NO_BINARY=1` keeps
the trial in Node instead.

## Build

```sh
tools/build-go.sh           # build bin/forge, and check the size and linkage the rules cap
tools/build-go.sh --check   # verify the committed binary matches go/
```

## Check

```sh
node tools/smoke.mjs        # all four surfaces against bin/forge; --node for the Node forge
node tools/http-check.mjs   # the HTTP/1.1 paths the conformance suite never exercises
(cd go && go test ./...)    # the pack reader's round trip and its bounds
node tools/bench.mjs        # the suite's four timed workloads; --node for the A/B
```

License: MIT.
