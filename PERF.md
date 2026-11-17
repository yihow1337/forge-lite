# Performance

> **The forge is Go now.** `go/` serves every trial; `src/` is the fallback `main.ts` reaches for
> when `bin/forge` will not run. Everything below the "The server core is Go" section is the Node
> work that came first, kept because it is what the Go port was measured against and because the
> Node forge is still the thing that answers if the binary is missing.

The forge is graded on wall time inside a gVisor sandbox that shares a node with the suite
measuring it. There, a syscall and a page fault cost many times what they cost on a normal kernel,
and the entry's two CPUs are the same two the grader's clock is running against, so every
millisecond of CPU the forge does not spend is a millisecond the round does not take. Locally every
workload already tops out at 50 points, so **local wall time is a poor guide; forge CPU per request
and syscalls per response are what this file tracks.**

## The server core is Go

### Why

Four interleaved pairs of Node benchmark runs had taken **-43% of the forge's CPU** out of the
Node forge, and the grader's perf column did not move: `perf_p50_us` stayed near 550,000 and perf
stayed at 124-128 of 200. The graded sandbox is roughly six times slower per request than this box
(a graded read round of about 1.9 s against 0.25 s here for the same 2,000 requests), so what it
charges for is not the handler's arithmetic -- it is the per-request floor: syscalls through
gVisor's Sentry, the runtime underneath them, and whatever a collector does while the clock runs.
Node's floor is the part that could not be optimised away in Node. The leaderboard agreed: its top
entries (perf 155-166, geomean 320-380 ms) are static Go or C binaries.

The rules allow one -- "a statically linked Linux amd64 binary you commit runs from your repository
as vendored source" -- so `go/` is the whole forge again, stdlib only, and `main.ts` hands it the
trial.

### Result

Two interleaved passes, each the median of three whole benchmark runs, forge pinned to one core:

| workload | node wall | go wall | Δ wall | node cpu | go cpu | **Δ cpu** |
| --- | --- | --- | --- | --- | --- | --- |
| push | 161.0 ms | 100.2 ms | **-37.8%** | 62.7 ms | 11.6 ms | **-81.5%** |
| clone | 36.3 ms | 33.0 ms | -9.1% | 10.4 ms | 3.6 ms | **-65.5%** |
| read | 260.1 ms | 224.9 ms | -13.5% | 47.8 ms | 30.1 ms | **-37.1%** |
| write | 39.0 ms | 35.3 ms | -9.6% | 7.3 ms | 4.4 ms | **-40.4%** |
| **geomean / total** | **87.6 ms** | **71.1 ms** | **-18.8%** | **128.1 ms** | **49.6 ms** | **-61.3%** |

Collection time went with it: the Node forge spent 8.5-13.4 ms a round collecting on the push
workload, the Go forge spends none and runs no collection at all in any round. Syscalls per request
are unchanged and still minimal: **exactly one `read` and one `write` per response** on every
workload, which `tools/bench.mjs`'s own counters confirm from inside the forge.

The kit's own grader, three runs each, the Node forge being this worktree with `bin/` removed so
that `main.ts` falls back:

| | run 1 | run 2 | run 3 | median |
| --- | --- | --- | --- | --- |
| node `perf_p50_us` | 94,040 | 112,630 | 117,515 | 112,630 |
| go `perf_p50_us` | 85,913 | 85,216 | 99,328 | **85,913** |

Every one of the six runs is 120/120 and score 1000, and the Go forge's worst run beats the Node
forge's median. The grader does not pin the forge and this box is shared with other work, so the
spread inside each row is noise -- a seventh Go run taken while another process held a third of a
core scored perf 192, with a read round of 792 ms against the 299 ms round beside it. The
interleaved, pinned table above is the measurement; this table is the grader agreeing with it.

What the grader settles outright is determinism: `state.json` hashes to
`a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590` on **every run of both forges**,
byte for byte, which is the replay check the final ranking depends on.

### Where the Go forge's CPU goes

A `pprof` profile of the read workload (`FORGE_PROF=... `, SIGUSR1 to start and stop, which
`tools/bench.mjs --prof` drives) puts **87.5% of the forge's busy time in the `read` and `write`
syscalls themselves**, 12.5% in `mallocgc`, and nothing else above the noise. At 16.6 us of CPU per
keep-alive request there is about 2 us of addressable work left in the whole read path, so that
path is finished: the remaining cost is the two syscalls, and they are the work.

The push path was not finished, and the profile said why: half of its handler was `readPack`, and a
sixth of the whole forge was inside `compress/zlib.NewReader`. `readPack` built its inflater per
call, and a flate decompressor carries a 32 KiB window and its Huffman tables. One `sync.Pool`
later, measured by `go/pack_test.go` because this box cannot read a 2 ms wall change:

| | ns/op | B/op | allocs/op |
| --- | --- | --- | --- |
| `readPack`, an engine per pack | 14,448 | 42,892 | 23 |
| `readPack`, a pooled engine | 6,851 | 2,286 | 17 |

Two hundred pushes a round, so that is eight megabytes of allocation a round that no longer
happens. This is the one saving the Node forge could not have: `node:zlib` closes its binding at
the end of a stream and `reset()` then throws `ERR_INTERNAL_ASSERTION`, which is written up under
"What is left" below as a thing that could not be taken. In Go it is four lines.

### Is it the same forge?

The suite judges answers by shape, so a field it does not read could differ between the two
implementations and all 120 checks would still pass. `tools/diff-forges.mjs` closes that gap: it
starts both forges, replays one fixed, ordered sequence against each, and compares every status,
every body and the headers that carry meaning -- including the ref advertisements and the packfiles
as raw bytes, and the git wire driven through the suite's own `GitClient`. The order is fixed
because both forges number ids from counters, so the same requests must produce the same ids.

**197 comparisons, 0 differences.** Only `x-github-request-id` is normalised (it counts requests,
and the two runs make a different number of them) along with the port each forge listens on.

It found one real difference, on its first run: a malformed pkt-line's diagnostic rendered a NUL
as `\x00` under Go's `%q` where the Node forge wrote `\u0000` through `JSON.stringify`. Nothing
reads that text -- it is a `text/plain` 400 body -- but it is `jsonQuote` on both sides now,
because a difference the tool has to explain away is a difference that hides the next one. Its
other two first-run reports were the tool's own fault, the `Link` header's pagination URLs
echoing each forge's own port, and the tool normalises the origin now.

### What the port had to be careful about

Three things, none of them visible from the TypeScript:

* **A Go map iterates in a random order.** Everywhere the TypeScript leaned on a JS `Map` or `Set`
  keeping its insertion order, the Go carries the order explicitly: `oidSet` for the reachability
  walk (which is what fixes a packfile's object order), `repoOrder` for `/user/repos`, `LabelOrder`
  for the label list, `cacheKeys` for the git answer cache's eviction. Without that, two runs of
  the same requests would differ in bytes even though every check still passed, and `state.json`
  would stop hashing the same.
* **One mutex guards the whole store.** There is no parallelism to win on the suite's hot paths --
  the read workload is one keep-alive connection and the clone workload is fifty replays of one
  cached buffer -- and interleaved mutations would make the id counters depend on arrival order.
  The lock is held for the handler only, never across a socket write.
* **`GOMAXPROCS` and the collector.** Capped at 2, which is the pod's limit, so a runtime that sees
  the host's eight CPUs does not run eight Ps against two. `GOGC` 400 and a 720 MiB soft memory
  limit, because the store only grows and a 1024 MiB pod can afford a lazier collector; measured,
  the benchmark now triggers no collection at all.

### The bug the port introduced, and the check that catches it

`drain` re-parsed the request head on every read rather than keeping it, so a body that arrived in
a second segment earned a second `100 Continue` -- three of them, for a body in three segments. The
suite never sends `Expect: 100-continue` at all and would never have noticed. The head lives on the
connection now, and `tools/http-check.mjs` grew a check that sends the head and then the body in
two more segments and counts the interim answers; it reports **3** against the binary built from
the commit before the fix and **1** after, and the Node server passes it unchanged.

### Binary size

4,231,328 bytes against the rules' 8 MiB per-file cap, statically linked, `CGO_ENABLED=0`. Most of
the headroom came from not using `net/http`: the lifecycle's two request shapes (`POST /register`,
`GET /done`) would have dragged in `crypto/tls`, `crypto/x509`, the FIPS module and HTTP/2 for
about three megabytes, and the harness always builds the env's origin as plain `http`
(`cli/makefun.mjs` `serviceEndpoint`: `http://env:8080` in a container, `http://127.0.0.1:<port>`
under the process driver). `go/envclient.go` is that client by hand, one keep-alive connection,
small enough to read in one sitting. `tools/build-go.sh` refuses to leave a binary that breaks the
cap or names a dynamic loader.

## How to measure

```sh
node tools/bench.mjs --repeat 3                 # the Go binary, median of three fresh forges
node tools/bench.mjs --node --repeat 3          # the Node forge, for the A/B above
BENCH_REPO=/tmp/before node tools/bench.mjs     # the same workloads against another checkout
node tools/bench.mjs --only read --prof /tmp/go.prof
go tool pprof -top bin/forge /tmp/go.prof       # where the Go forge's CPU goes
(cd go && go test -bench . -benchmem -count=3)  # the handlers alone, and their allocations
node tools/smoke.mjs                            # all four surfaces, fast; --node for the A/B
node tools/diff-forges.mjs                      # the Go forge against the Node forge, byte for byte
node tools/http-check.mjs                       # the wire paths the suite never exercises
node tools/profile.mjs p.cpuprofile route drain writeReply      # Node only: inclusive shares
node tools/micro.mjs                            # Node only: the handlers, no socket in the way
```

`tools/bench.mjs` measures whichever forge it is pointed at -- by default the committed binary,
spawned directly so the pid whose CPU is sampled is the forge itself, and with `--node` the Node
forge under `FORGE_NO_BINARY=1`, which switches off `main.ts`'s handover. It drives the kit's own
`GitClient`/`RestClient` through the four workloads of
`program/env/src/bench.ts` — push (200 sequential 1 KiB pushes), clone (50 concurrent depth-1 clones
of a 200-commit repository), read (2,000 keep-alive issue GETs), write (200 issue creations), each
with 5 warm-up operations and 3 timed rounds. It runs the forge under `taskset -c 0` so the forge's
own CPU lands in the wall clock instead of hiding on a second core, and reports per workload:

| column | what it is |
| --- | --- |
| wall p50 ms | the median timed round, as the grader measures it |
| forge cpu ms | the forge's on-CPU time over that round, `/proc/<pid>/schedstat` in ns |
| gc ms | collection time in that round, from a `PerformanceObserver` on `gc` |
| reads / writes | `read(2)`/`write(2)` on the sockets, counted inside the forge |

Two warnings learned the hard way. **This box is shared**, so a single wall-time reading is mostly
noise: compare interleaved runs of two checkouts and take medians, and read the CPU column first.
And the instrumentation is not free — the GC observer alone costs about 3% of the forge's CPU — so
the absolute CPU figures here are a slight over-estimate, equally for both sides of a comparison.

## The Node forge's own optimisation, which came first

Everything from here down is the Node forge: the work that cut its CPU by 43% without moving the
grader, which is the measurement that argued for the port. It still describes `src/`, which still
serves when `bin/forge` cannot.

## Grader baseline

The submission at `8dc2df5` scored **server 928 (feature 600, agent 200, perf 128)**, with
`perf_p50_us` 546,669 — a geometric mean of about 547 ms. The best Node entries reach about 390 ms
(perf ~151) with a hand-rolled HTTP/1.1 server over `node:net`; Go and C entries reach 320-380 ms.

## Result

Four interleaved pairs of whole benchmark runs, `8dc2df5` against `1f35692`, medians, forge pinned
to one core:

| workload | wall before | wall after | Δ wall | cpu before | cpu after | **Δ cpu** |
| --- | --- | --- | --- | --- | --- | --- |
| push | 235.5 ms | 192.0 ms | -18.5% | 76.3 ms | 46.3 ms | **-39.3%** |
| clone | 47.8 ms | 48.0 ms | +0.4% | 16.2 ms | 7.1 ms | **-55.8%** |
| read | 426.0 ms | 310.5 ms | -27.1% | 77.7 ms | 43.6 ms | **-44.0%** |
| write | 72.0 ms | 58.2 ms | -19.2% | 14.1 ms | 7.9 ms | **-44.2%** |
| **geomean / total** | **136.3 ms** | **113.6 ms** | **-16.7%** | **184.3 ms** | **104.9 ms** | **-43.1%** |

Clone's wall time does not move locally because its 50 concurrent clones are bound by the client,
not by the forge; its CPU more than halved, which is what the grader's contended sandbox charges
for. Syscalls per request were already minimal and stayed there: **exactly one `read` and one
`write` per request** on every workload.

The kit's own grader, run locally and interleaved the same way, reports `perf_p50_us` 107,185 /
110,369 before against 101,694 / 91,402 after. It does not pin the forge, so the forge is a smaller
share of its wall clock than of the graded sandbox's; it moves in the same direction.

Handler cost alone (`tools/micro.mjs`, best of five passes, the handlers called directly):

| | before | after |
| --- | --- | --- |
| push: advertisement + receive-pack | 48.7-55.3 us/op | 37.0-37.7 us/op |
| clone: ls-refs + fetch, both cached | 7.6-10.3 us/op | 4.2 us/op |
| read: GET one issue | 0.05 us/op | 0.04 us/op |
| write: POST one issue | 3.7 us/op | 3.5 us/op |

`grade.sh` stays **120/120, score 1000** after every step.

## What changed

### 1. The HTTP/1.1 server is ours now (`src/http/server.ts`)

A CPU profile of the baseline spent 35-40% of its busy time inside `node:http`, the stream stack and
the event emitters under them, and a further 16.5% of the read workload in `writeUtf8String` —
re-encoding a response string the handler had already built. An `IncomingMessage` and a
`ServerResponse` are two duplex streams constructed, emitted on and torn down for a request whose
whole answer is one cached buffer.

The replacement parses HTTP/1.1 incrementally over `node:net`: header names matched on the raw head
by length and folded char codes, so a request allocates three strings rather than one per header;
keep-alive, pipelining, Content-Length and chunked bodies, `Expect: 100-continue`,
`Connection: close`, HEAD, a 400 for a malformed head and a 413 past the body ceiling; and exactly
one `socket.write` per response, headers and body composed into a single Buffer. No `Date` header is
formatted per request and nothing is compressed — nothing the suite reads needs either.

### 2. The git wire is parsed and built without strings and regexes

52% of the upload-pack path went into `decodePktLines` and the slicing under it: every pkt-line
header was read as a four-character string and matched against a regular expression before
`Number.parseInt` saw it, and every payload became a string through a second regular expression that
only stripped a trailing newline. The answers cost the same in reverse — a Buffer per pkt-line plus
the `Buffer.concat` joining them, rebuilt for each of the push workload's 200 advertisements, since
every push bumps the repository version that keys the cache.

Now headers are four hex nibbles read straight off the buffer, a payload loses its newline by index,
and every answer — the v0 advertisement, ls-refs, the receive-pack report — is one string encoded
once. `readPack` hoists its inflate options out of the loop and takes a fast path for a pack with no
delta entries, which is every pack the suite pushes. The git answer cache key lost its version
prefix, because `touchGit` empties the whole cache on a version bump.

### 3. Two bugs found by measuring

A write to a stderr whose reader has gone away throws EPIPE, and thrown inside the
`uncaughtException` handler that EPIPE is caught by the same handler, which writes again: one log
line became a loop that burned a whole core for the rest of the process's life. All logging goes
through `src/log.ts` now, which cannot throw and gives up after the first failure.

And `tools/http-check.mjs` — which speaks raw bytes, because the suite only ever sends a
Content-Length body over undici — found that a chunked body arriving in more than one TCP segment
was assembled with its earlier chunks repeated. The check that catches it was verified against the
broken code before the fix landed.

## What is left, and why it was not taken

A floor measurement says how much room remains: a server that parses nothing and answers every
request with one pre-made buffer costs **14.6 us of CPU per keep-alive request** on this box, and
the same whether the request carries 0 or 1,400 bytes. The forge now costs 21.8 us per read request.
So roughly two thirds of what is left is the two syscalls and libuv, and cannot be removed at all.

Of the rest, measured rather than guessed:

* **push** is 42% handler, and that handler is 27% `readPack` — three `inflateSync` calls and three
  SHA-1s per push, plus 18% garbage collection of the objects the push stores, which the forge is
  obliged to keep. Reusing one zlib engine instead of constructing one per object would save about
  a third of the inflate cost, but `_processChunk` closes its binding at the end of a stream and
  `reset()` then throws `ERR_INTERNAL_ASSERTION`; there is no supported way to hold one open.
* **read** has about 2 us per request of addressable work left. Composing the response from
  pre-rendered byte templates instead of a header string measured 0.65 us → 0.20 us per response,
  which is 2% of the read workload's CPU — not worth the extra machinery in the file that has to be
  right.
* **Caching the whole response buffer** for repeated issue GETs would remove the per-response
  allocation outright, but only by giving every cached answer the same `X-GitHub-Request-Id`. The
  suite only checks that the header is non-empty, so it would pass; GitHub's value is unique per
  request, and about 15% of one workload's CPU is not worth answering with a header that lies.
* **`--max-semi-space-size=64`**, by flag or by `v8.setFlagsFromString`, left the push workload's
  collection count at 4 per round and its GC time unchanged. Measured, discarded.
* **Clone makes five requests per clone** — three `GET info/refs`, then ls-refs, then fetch —
  because the kit's client re-discovers capabilities before every v2 command. Three of the five are
  answered from a module-level constant buffer. Nothing there is ours to remove.
