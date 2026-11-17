# Performance

The forge is graded on wall time inside a gVisor sandbox that shares two CPUs with the suite
measuring it. There, a syscall costs many times what it costs on a normal kernel, and the entry and
the env compete for the same two cores, so every millisecond of CPU the forge does not spend is a
millisecond the suite gets back. Locally every workload already tops out at 50 points, so local
wall time is a poor guide; **forge CPU per request and socket writes per response are the numbers
this file tracks.**

## How to measure

```sh
node tools/bench.mjs --repeat 3          # all four workloads, median of three fresh forges
node tools/bench.mjs --only read --prof /tmp/read.cpuprofile
BENCH_REPO=/tmp/before node tools/bench.mjs   # the same workloads against another checkout
```

`tools/bench.mjs` drives the kit's own `GitClient`/`RestClient` through the four workloads of
`program/env/src/bench.ts` (push 200 sequential 1 KiB pushes, clone 50 concurrent depth-1 clones of
a 200-commit repository, read 2,000 keep-alive issue GETs, write 200 issue creations; 5 warm-up
operations and 3 timed rounds each). It runs the forge under `taskset -c 0`, so the forge's own CPU
lands in the wall clock instead of hiding on a second core, and reports per workload:

| column | what it is |
| --- | --- |
| wall p50 ms | the median timed round, exactly as the grader measures it |
| forge cpu ms | the forge process's on-CPU time over that round, from `/proc/<pid>/schedstat` (ns) |
| writes/round | libuv stream writes, i.e. `write(2)`/`writev(2)` calls, counted in-process by `src/stats.ts` under `FORGE_STATS=1` |

This box is shared with other work, so wall time swings 30-50% run to run while CPU stays steady;
read the CPU column first and treat wall as corroboration.

## Grader baseline

The submission at `8dc2df5` scored **server 928 (feature 600, agent 200, perf 128)**, with
`perf_p50_us` 546,669 — a geometric mean of about 547 ms across the four workloads. The best Node
entries reach about 390 ms (perf ~151) with a hand-rolled HTTP/1.1 server over `node:net`; Go and C
entries reach 320-380 ms.

## Measurements

Each row is the median of three fresh forges on this box, all four workloads. "cpu total" is the
sum of the four workloads' per-round CPU.

| step | push cpu | clone cpu | read cpu | write cpu | **cpu total** | wall geomean |
| --- | --- | --- | --- | --- | --- | --- |
| 0. baseline, `node:http` (`8dc2df5`) | 56.4 ms | 17.6 ms | 51.9 ms | 9.0 ms | **134.9 ms** | 90.4 ms |
| 1. hand-rolled HTTP/1.1 over `node:net` | 48.6 ms | 7.5 ms | 40.0 ms | 7.5 ms | **103.6 ms** | 84.6 ms |

Writes per response were already 1.00 at the baseline (node:http corks headers and body into one
`writev`), and stay 1.00: the new server composes every answer into a single Buffer and makes
exactly one `socket.write` per response.

### 1. Hand-rolled HTTP/1.1 over node:net

A CPU profile of the baseline forge (`tools/bench.mjs --prof`) spent 35-40% of its busy time inside
`node:http`, the stream stack and the event emitters under them, and a further 16.5% of the read
workload in `writeUtf8String` — re-encoding a response string the handler had already built. An
`IncomingMessage` and a `ServerResponse` are two duplex streams constructed, emitted on and torn
down for a request whose whole answer is one cached buffer.

`src/http/server.ts` replaces that with an incremental parser over `node:net`: header names matched
on the raw head text by length and folded char codes (so a request allocates three strings, not one
per header), keep-alive and pipelining, Content-Length and chunked bodies, `Expect: 100-continue`,
`Connection: close`, HEAD without a body, and one `socket.write` per response with headers and body
composed into a single Buffer. No `Date` header is formatted per request and no response is
compressed; nothing the suite checks reads either.

Result: **-23% forge CPU overall**, and -57% on clone, whose answers are pure cached buffers and
were therefore almost all framework cost. Conformance stayed 120/120.

It also fixed a latent CPU sink found while measuring: a write to a stderr whose reader has gone
away throws EPIPE, and thrown from inside the `uncaughtException` handler that EPIPE is caught by
the same handler, which writes again — one log line became a loop that burned a whole core. All
logging now goes through `src/log.ts`, which cannot throw and gives up after the first failure.
