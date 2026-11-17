# github-core-clone-01 — build plan

A standalone GitHub-compatible forge: git smart HTTP, REST v3, GraphQL v4 and MCP, all in memory,
standard library only.

It exists twice. `go/` is what serves a trial, built to `bin/forge` and committed; `src/` is the
Node 22 forge it was ported from, which `main.ts` falls back to when the binary will not run. The
two tables below are the same forge in both languages, file for file. [PERF.md](PERF.md) says why.

## Modules, Go (`go/`, what serves)

| file | what it owns |
| --- | --- |
| `main.go` | the lifecycle: listen(0) on 0.0.0.0, POST /register, poll /done, exit 0; GOMAXPROCS and GC tuning; SIGUSR1 pprof, SIGUSR2 counters |
| `httpserver.go` | HTTP/1.1 over `net.Listener`: keep-alive, pipelining, Content-Length and chunked, `Expect: 100-continue`, one write per response |
| `envclient.go` | the lifecycle's HTTP client by hand, one keep-alive connection (so `net/http` stays out of the binary) |
| `router.go` | the routing `app.ts` owns, under one store mutex |
| `store.go` | repos, refs, object stores, issues, labels, comments, pulls, id counters -- with the JS Maps' insertion order carried explicitly |
| `objects.go` | sha1 object ids, commit/tree/tag parse + build, tree path get/set/remove, ancestry, 3-way tree merge |
| `pack.go` | pkt-line codec, pack writer, pack reader (ofs/ref deltas), one pooled zlib engine |
| `githttp.go` | info/refs, upload-pack v2 ls-refs/fetch (+shallow/deepen) and v0, receive-pack v0 |
| `rest.go` | every `/api/v3` route |
| `graphql.go` | the parser, the executor over ordered result objects, introspection |
| `mcp.go` | JSON-RPC 2.0: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `json.go` | `JSON.stringify`'s escaping out, `encoding/json` in |
| `pack_test.go` | the pack reader's round trip, its bounds, and the benchmarks behind PERF.md |

## Modules, Node (`src/`, the fallback)

| file | what it owns |
| --- | --- |
| `main.ts` | the handover to `bin/forge`, and the same lifecycle when it cannot run |
| `app.ts` | `createApp()`: one `http.Server`, the router, keep-alive + `setNoDelay` tuning |
| `src/store.ts` | repos, refs, per-repo object stores, issues, labels, comments, pulls, id counters |
| `src/git/objects.ts` | sha1 object ids, commit/tree/tag parse + build, tree path get/set/remove, ancestry, 3-way tree merge |
| `src/git/pack.ts` | pkt-line codec, pack writer, pack reader (ofs/ref deltas) |
| `src/git/http.ts` | info/refs (v2 caps + v0 advertisement), upload-pack v2 ls-refs/fetch (+shallow/deepen) and v0 fallback, receive-pack v0 (report-status, side-band-64k, delete-refs, fast-forward) |
| `src/rest.ts` | every `/api/v3` route |
| `src/graphql.ts` | a small GraphQL parser + executor, the schema the suite queries, introspection |
| `src/mcp.ts` | JSON-RPC 2.0 over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |

## The 120 checks and how each is satisfied

### git (30)
* `advertise-v2` — `Git-Protocol: version=2` on `GET info/refs?service=git-upload-pack` answers
  `version 2` + `agent`, `ls-refs=unborn`, `fetch=shallow`, `object-format=sha1`, flush.
* `advertise-receive-pack` — v0 only: `# service=git-receive-pack`, flush, `<oid> <ref>\0report-status
  report-status-v2 delete-refs side-band-64k ofs-delta agent=…`, flush.
* `advertise-headers` — content types `application/x-git-{upload,receive}-pack-advertisement`; v0
  upload-pack opens with the service preamble, v2 with `version 2`.
* `unknown-repo-404` / `repo-survives-errors` — unknown repo is 404 on both services; a malformed
  POST body answers 400 and never throws.
* `ls-refs`, `ls-refs-prefix` — v2 `command=ls-refs` with `peel`, `symrefs`, `unborn`,
  server-side `ref-prefix` filtering; HEAD carries `symref-target:`, annotated tags `peeled:`.
* `clone-empty` — a repo with no refs advertises only an unborn HEAD and transfers no objects.
* `push-*` — receive-pack: command list + pack, per-ref `ok`/`ng … non-fast-forward`, creates,
  deletes, mixed reports, 100-file commits, report framed in side-band-64k band 1.
* `clone-*`, `fetch-*`, `pack-*`, `sideband-framing` — upload-pack v2 fetch: wants minus haves
  closure, `deepen`/`shallow` boundary handling, packfile section in band 1 with a correct trailer.

### repos (15), issues (15), pulls (20), protocol (5)
All REST v3 routes listed in `checks-rest.ts`'s header, with the exact statuses: 201/200/409 for
contents, 422 for an unknown label, 404 for a foreign owner, 401 without a token, 405 for a
conflicted merge, a JSON `{message}` body on every error, `X-GitHub-Request-Id` on every reply,
`Link: …; rel="next"` on `/user/repos?per_page=10`.

### graphql (20)
A hand-written parser (operations, variables, aliases, inline fragments, enum/list/object
arguments) and an executor over a static schema: `viewer`, `repository`, `node`, `__type`;
`Repository.{id,databaseId,name,nameWithOwner,owner,defaultBranchRef,viewerPermission,
hasIssuesEnabled,issue,issues,pullRequests,pullRequest}`; `Issue`, `PullRequest`, connections with
cursor pagination; mutations `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
`addComment`. Unknown field → HTTP 200 + `errors`; unknown repository → `data.repository: null`;
operation batching → a JSON array answered in order; 401 without a token.

### mcp (15)
`server/discover` (revision 2026-07-28, `supportedVersions`, `capabilities.tools`, serverInfo in
`_meta`), `initialize` for the legacy era, a frozen `tools/list` payload (byte-identical across
calls) of `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
`merge_pull_request`, each with a description and an object inputSchema; `tools/call` acts on the
same store REST serves; unknown tool → `-32602`; missing args → `isError: true`; a non-JSON body →
HTTP 400 + `-32700`; no Authorization → HTTP 401.

## Performance (T_ref: push 1641 ms, clone 267 ms, read 2760 ms, write 349 ms)
* `setNoDelay(true)` on every socket, long `keepAliveTimeout`, no per-request `new URL()`,
  no `Date.now()` in a response body (fixed timestamps keep the state export deterministic too).
* Issue and pull response bodies are serialized once and cached, invalidated on mutation.
* Advertisement and fetch-pack bytes are cached per repository version, so 50 concurrent depth-1
  clones of a 200-commit repository replay one prebuilt buffer.
* receive-pack indexes only the objects the pack carries (3 per 1 KiB push).

## Determinism
No clock, no randomness anywhere a pass/fail bit can see: ids are counters, timestamps are fixed
constants plus a counter, request ids are constant.
