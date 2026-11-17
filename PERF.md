# Performance

The forge is graded on wall time inside a gVisor sandbox that shares a node with the suite
measuring it. There, a syscall and a page fault cost many times what they cost on a normal kernel,
and the entry's two CPUs are the same two the grader's clock is running against, so every
millisecond of CPU the forge does not spend is a millisecond the round does not take. Locally every
workload already tops out at 50 points, so **local wall time is a poor guide; forge CPU per request
and syscalls per response are what this file tracks.**

## How to measure

```sh
node tools/bench.mjs --repeat 3                 # the four workloads, median of three fresh forges
BENCH_REPO=/tmp/before node tools/bench.mjs     # the same workloads against another checkout
node tools/bench.mjs --only read --prof p.cpuprofile
node tools/profile.mjs p.cpuprofile route drain writeReply      # inclusive shares
node tools/micro.mjs                            # the handlers alone, no socket in the way
node tools/http-check.mjs                       # the wire paths the suite never exercises
```

`tools/bench.mjs` drives the kit's own `GitClient`/`RestClient` through the four workloads of
`program/env/src/bench.ts` — push (200 sequential 1 KiB pushes), clone (50 concurrent depth-1 clones
of a 200-commit repository), read (2,000 keep-alive issue GETs), write (200 issue creations), each
with 5 warm-up operations and 3 timed rounds. It runs the forge under `taskset -c 0` so the forge's
own CPU lands in the wall clock instead of hiding on a second core, and reports per workload:

| column | what it is |
| --- | --- |
| wall p50 ms | the median timed round, as the grader measures it |
| forge cpu ms | the forge's on-CPU time over that round, `/proc/<pid>/schedstat` in ns |
| gc ms | collection time in that round, from a `PerformanceObserver` on `gc` |
| reads / writes | `read(2)`/`write(2)` on the sockets, counted at libuv's stream handle |

Two warnings learned the hard way. **This box is shared**, so a single wall-time reading is mostly
noise: compare interleaved runs of two checkouts and take medians, and read the CPU column first.
And the instrumentation is not free — the GC observer alone costs about 3% of the forge's CPU — so
the absolute CPU figures here are a slight over-estimate, equally for both sides of a comparison.

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
