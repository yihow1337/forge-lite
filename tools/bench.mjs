#!/usr/bin/env node
// tools/bench.mjs -- the forge's own copy of the suite's four timed workloads.
//
// The grader measures wall time on a shared, syscall-expensive gVisor sandbox, where per-request
// CPU and socket writes dominate. Locally every workload already tops out at 50 points, so wall
// time alone says nothing about a change. This tool therefore reports three numbers a workload:
//
//   wall ms   the median of the three rounds, exactly as bench.ts measures them
//   cpu ms    the forge process's own on-CPU time over the timed rounds (/proc/<pid>/schedstat,
//             nanoseconds, so a 300 ms round is still measured to four digits)
//   writes    how many libuv stream writes (one write/writev syscall each) the forge made, counted
//             inside the process by src/stats.ts under FORGE_STATS=1
//
// The forge runs under `taskset -c 0`, pinned to one core, so its CPU cost shows up in the wall
// clock instead of hiding behind the client's own core. The client (this process) is not pinned.
//
// The workloads are the ones in the kit's program/env/src/bench.ts, driven through the suite's own
// GitClient and RestClient so the bytes on the wire are the bytes the grader sends:
//   push   200 sequential 1 KiB pushes (info/refs + receive-pack each)
//   clone  50 concurrent depth-1 clones of a 200-commit repository
//   read   2000 sequential GET issues/{n} on one keep-alive connection
//   write  200 sequential POST issues
// Each runs 5 untimed warm-up operations and then 3 timed rounds, and reports the median round.
//
// Usage:
//   node tools/bench.mjs                      the Go binary, all four workloads, full size
//   node tools/bench.mjs --node               `node main.ts` with the handover disabled
//   node tools/bench.mjs --only read,write    a subset
//   node tools/bench.mjs --rounds 1           fewer rounds while iterating
//   node tools/bench.mjs --repeat 5           five fresh forges, reported as the median of the five
//   node tools/bench.mjs --json out.json      also write the raw numbers
//   node tools/bench.mjs --no-taskset         do not pin the forge to core 0
//   BENCH_REPO=/tmp/before node tools/bench.mjs   measure another checkout of the forge

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The worktree whose main.ts is measured; another checkout makes an A/B run one flag. */
const REPO = process.env.BENCH_REPO ?? resolve(HERE, '..');
const KIT = process.env.MAKEFUN_KIT ?? '/workspace/makefun/git-forge/kit/github-core-clone-01-kit';
const SRC = `${KIT}/program/env/src`;

const { GitClient, CONFORMANCE_IDENTITY, ZERO_OID, buildCommit, buildTree, hashObject, writePack } = await import(`${SRC}/git-client.ts`);
const { RestClient, apiPath } = await import(`${SRC}/rest-client.ts`);
const { buildScenario, generateBlobText, scenarioRng } = await import(`${SRC}/wire.ts`);

// ---------------------------------------------------------------- options

function parseArgs(argv) {
  const out = { only: null, rounds: 3, warmup: 5, json: null, taskset: true, label: '', prof: null, heap: null, repeat: 1, node: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') out.only = new Set((argv[++i] ?? '').split(',').filter(Boolean));
    else if (arg === '--rounds') out.rounds = Number.parseInt(argv[++i] ?? '3', 10);
    else if (arg === '--warmup') out.warmup = Number.parseInt(argv[++i] ?? '5', 10);
    else if (arg === '--json') out.json = argv[++i] ?? null;
    else if (arg === '--label') out.label = argv[++i] ?? '';
    else if (arg === '--repeat') out.repeat = Number.parseInt(argv[++i] ?? '1', 10);
    else if (arg === '--prof') out.prof = argv[++i] ?? '/tmp/forge-prof';
    else if (arg === '--heap') out.heap = argv[++i] ?? '/tmp/forge-heap.json';
    else if (arg === '--no-taskset') out.taskset = false;
    else if (arg === '--node') out.node = true;
    else if (arg === '--binary') out.node = false;
    else throw new Error(`unknown option ${arg}`);
  }
  return out;
}

const OPTIONS = parseArgs(process.argv.slice(2));
/** Which forge the last run started: reported with the table so a number is never misattributed. */
let KIND = 'unknown';
const TOKEN = 'bench-token';

// The same fixture constants bench.ts uses, so the payloads are byte-identical to the grader's.
const PUSH_REPO = 'bench-push';
const CLONE_REPO = 'bench-clone';
const READ_REPO = 'bench-read';
const WRITE_REPO = 'bench-write';
const PUSH_FILE = 'bench-data.txt';
const CLONE_FILE = 'history.txt';
const PUSH_CHANGE_BYTES = 1_024;
const CLONE_CHANGE_BYTES = 512;
const CLONE_HISTORY_COMMITS = 200;
const BENCH_EPOCH_SEC = 1_700_000_000;
const MAIN_REF = 'refs/heads/main';

const WORKLOADS = [
  { name: 'push', ops: 200, tRef: 1640.82 },
  { name: 'clone', ops: 50, tRef: 266.941 },
  { name: 'read', ops: 2_000, tRef: 2759.715 },
  { name: 'write', ops: 200, tRef: 348.965 },
];

// ---------------------------------------------------------------- the env the entry registers with

/** A stand-in for the suite's env: it takes the entry's /register and answers /done. */
function startEnvStub() {
  let entryPort = null;
  let done = false;
  const waiters = [];
  const server = createServer((req, res) => {
    if (req.url === '/register' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          entryPort = JSON.parse(Buffer.concat(chunks).toString('utf8')).port;
        } catch {
          entryPort = null;
        }
        for (const resolve of waiters.splice(0)) resolve(entryPort);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ done }));
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      ready({
        url: `http://127.0.0.1:${server.address().port}`,
        waitForRegister: () => (entryPort !== null ? Promise.resolve(entryPort) : new Promise((r) => waiters.push(r))),
        finish: () => {
          done = true;
        },
        close: () => server.close(),
      });
    });
  });
}

// ---------------------------------------------------------------- the forge under test

/**
 * The process's own on-CPU time in ms. schedstat field 0 is nanoseconds, far finer than ticks --
 * but /proc/<pid>/schedstat covers the main thread alone, and the Go forge serves on whichever
 * thread the scheduler picked, so this sums every thread of the group.
 */
function cpuMsOf(pid) {
  try {
    let total = 0;
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try {
        total += Number(readFileSync(`/proc/${pid}/task/${tid}/schedstat`, 'utf8').split(' ')[0]);
      } catch {
        // a thread that exited between the listing and the read contributes what it had, which
        // we cannot recover; the forge's threads live for the whole run, so this is noise only.
      }
    }
    return total / 1e6;
  } catch {
    return Number.NaN;
  }
}

/**
 * The forge under test. By default that is the committed Go binary, spawned directly so the pid
 * whose CPU is measured IS the forge; `--node` runs `node main.ts` with the handover disabled,
 * which is how the two are compared in one tool.
 */
async function startForge(envUrl) {
  const binary = process.env.FORGE_BIN ?? `${REPO}/bin/forge`;
  const runsNode = OPTIONS.node || !existsSync(binary);
  const program = runsNode ? ['node', 'main.ts'] : [binary];
  const [command, ...args] = OPTIONS.taskset ? ['taskset', '-c', '0', ...program] : program;
  const child = spawn(command, args, {
    cwd: REPO,
    env: {
      ...process.env,
      MAKEFUN_ENV_URL: envUrl,
      MAKEFUN_SHOP_TOKEN: TOKEN,
      FORGE_STATS: '1',
      ...(runsNode ? { FORGE_NO_BINARY: '1' } : {}),
      ...(OPTIONS.prof === null ? {} : { FORGE_PROF: OPTIONS.prof }),
      ...(OPTIONS.heap === null ? {} : { FORGE_HEAP: OPTIONS.heap }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stats = null;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    stderr += text;
    for (const line of text.split('\n')) {
      if (line.startsWith('[forge-stats] ')) {
        try {
          stats = JSON.parse(line.slice('[forge-stats] '.length));
        } catch {
          // a torn line; the next dump wins
        }
      }
    }
  });
  child.stdout.resume();
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal === null) process.stderr.write(`[bench] the forge exited ${code}\n${stderr}\n`);
  });
  return {
    child,
    kind: runsNode ? 'node' : 'go',
    /** Ask the forge to dump its counters and wait for the line to arrive. */
    async readStats() {
      stats = null;
      child.kill('SIGUSR2');
      for (let i = 0; i < 200 && stats === null; i += 1) await new Promise((r) => setTimeout(r, 5));
      return stats;
    },
    stderrText: () => stderr,
  };
}

// ---------------------------------------------------------------- fixtures (as bench.ts builds them)

function buildPushPayloads(count) {
  const rng = scenarioRng('bench.push');
  const payloads = [];
  let parent = null;
  for (let index = 0; index < count; index += 1) {
    const blob = Buffer.from(generateBlobText(rng, PUSH_CHANGE_BYTES), 'utf8');
    const blobOid = hashObject('blob', blob);
    const tree = buildTree([{ mode: '100644', name: PUSH_FILE, oid: blobOid }]);
    const treeOid = hashObject('tree', tree);
    const commit = buildCommit({
      tree: treeOid,
      parents: parent === null ? [] : [parent],
      message: `bench: push ${index + 1}\n`,
      author: CONFORMANCE_IDENTITY,
      committer: CONFORMANCE_IDENTITY,
      timestamp: BENCH_EPOCH_SEC + index,
    });
    const commitOid = hashObject('commit', commit);
    payloads.push({
      command: { oldOid: parent ?? ZERO_OID, newOid: commitOid, ref: MAIN_REF },
      pack: writePack([
        { type: 'blob', data: blob },
        { type: 'tree', data: tree },
        { type: 'commit', data: commit },
      ]),
    });
    parent = commitOid;
  }
  return payloads;
}

function buildCloneHistory() {
  const rng = scenarioRng('bench.clone');
  const objects = [];
  let tip = '';
  for (let index = 0; index < CLONE_HISTORY_COMMITS; index += 1) {
    const blob = Buffer.from(generateBlobText(rng, CLONE_CHANGE_BYTES), 'utf8');
    const blobOid = hashObject('blob', blob);
    const tree = buildTree([{ mode: '100644', name: CLONE_FILE, oid: blobOid }]);
    const treeOid = hashObject('tree', tree);
    const commit = buildCommit({
      tree: treeOid,
      parents: tip === '' ? [] : [tip],
      message: `bench: history ${index + 1}\n`,
      author: CONFORMANCE_IDENTITY,
      committer: CONFORMANCE_IDENTITY,
      timestamp: BENCH_EPOCH_SEC + index,
    });
    tip = hashObject('commit', commit);
    objects.push({ type: 'blob', data: blob }, { type: 'tree', data: tree }, { type: 'commit', data: commit });
  }
  return { tip, pack: writePack(objects) };
}

// ---------------------------------------------------------------- running one workload

function assertPushOk(result, ref) {
  if (result.report === null) throw new Error(`push ${ref}: no report-status`);
  if (!result.report.unpackOk) throw new Error(`push ${ref}: unpack failed (${result.report.unpackDetail})`);
  const report = result.report.refs.find((entry) => entry.ref === ref);
  if (report === undefined || !report.ok) throw new Error(`push ${ref}: refused`);
}

async function recreateRepo(git, rest, owner, repo) {
  await rest.delete(apiPath('repos', owner, repo));
  await git.createRepo(owner, repo);
}

const BODIES = {
  async push(ctx) {
    const { git, rest, owner } = ctx;
    await recreateRepo(git, rest, owner, PUSH_REPO);
    const payloads = buildPushPayloads(ctx.warmup + ctx.rounds * ctx.ops);
    let next = 0;
    return async () => {
      const payload = payloads[next++];
      assertPushOk(await git.push(owner, PUSH_REPO, [payload.command], { pack: payload.pack }), MAIN_REF);
    };
  },
  async clone(ctx) {
    const { git, rest, owner } = ctx;
    await recreateRepo(git, rest, owner, CLONE_REPO);
    const history = buildCloneHistory();
    assertPushOk(await git.push(owner, CLONE_REPO, [{ oldOid: ZERO_OID, newOid: history.tip, ref: MAIN_REF }], { pack: history.pack }), MAIN_REF);
    const once = async () => {
      const result = await git.clone(owner, CLONE_REPO, { depth: 1, parse: false, singleBranch: true });
      if (result.checksumOk !== true) throw new Error('clone: the pack checksum did not verify');
      if (result.packBytes <= 0) throw new Error('clone: no packfile');
    };
    // One "operation" of this workload is the whole fan-out of `ops` concurrent clones.
    return { once, concurrent: true };
  },
  async read(ctx) {
    const { git, rest, owner, scenario } = ctx;
    await recreateRepo(git, rest, owner, READ_REPO);
    const template = scenario.issues[0];
    const created = await rest.post(apiPath('repos', owner, READ_REPO, 'issues'), { body: { title: `${template.title} (bench setup)`, body: template.body } });
    if (created.status !== 201) throw new Error(`read setup: HTTP ${created.status} ${created.text.slice(0, 120)}`);
    const path = apiPath('repos', owner, READ_REPO, 'issues', created.body.number);
    return async () => {
      const response = await rest.get(path);
      if (response.status !== 200) throw new Error(`read: HTTP ${response.status}`);
    };
  },
  async write(ctx) {
    const { git, rest, owner, scenario } = ctx;
    await recreateRepo(git, rest, owner, WRITE_REPO);
    const total = ctx.warmup + ctx.rounds * ctx.ops;
    const payloads = [];
    for (let index = 0; index < total; index += 1) {
      const template = scenario.issues[index % scenario.issues.length];
      payloads.push({ title: `${template.title} [bench ${index + 1}]`, body: template.body });
    }
    const path = apiPath('repos', owner, WRITE_REPO, 'issues');
    let next = 0;
    return async () => {
      const response = await rest.post(path, { body: payloads[next++] });
      if (response.status !== 201) throw new Error(`write: HTTP ${response.status}`);
    };
  },
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

function points(p50, tRef) {
  return Math.round(Math.min(50, Math.max(0, 25 - 12.5 * Math.log2(p50 / tRef))));
}

async function runWorkload(spec, ctx, forge) {
  const prepared = await BODIES[spec.name](ctx);
  const concurrent = typeof prepared === 'object';
  const once = concurrent ? prepared.once : prepared;

  // bench.ts warms up with single operations even for the concurrent workload.
  for (let i = 0; i < ctx.warmup; i += 1) await once();

  // Restart the profile here, after the warm-ups: a profile that starts at boot is a quarter
  // listen()'s DNS lookup and module loading, which no round ever pays for.
  if (OPTIONS.prof !== null) {
    forge.child.kill('SIGUSR1');
    await new Promise((r) => setTimeout(r, 300));
  }
  const before = await forge.readStats();
  const roundsMs = [];
  const roundsCpu = [];
  for (let round = 0; round < ctx.rounds; round += 1) {
    const cpu0 = cpuMsOf(forge.child.pid);
    const wall0 = performance.now();
    if (concurrent) await Promise.all(Array.from({ length: ctx.ops }, once));
    else for (let i = 0; i < ctx.ops; i += 1) await once();
    roundsMs.push(performance.now() - wall0);
    roundsCpu.push(cpuMsOf(forge.child.pid) - cpu0);
  }
  const after = await forge.readStats();

  const opsPerRound = spec.ops;
  const delta = (field) => (before !== null && after !== null ? after[field] - before[field] : Number.NaN);
  const writes = delta('writes');
  const responses = delta('responses');
  return {
    name: spec.name,
    roundsMs: roundsMs.map((ms) => Math.round(ms * 1000) / 1000),
    p50Ms: median(roundsMs),
    cpuMs: median(roundsCpu),
    writesPerRound: writes / ctx.rounds,
    responsesPerRound: responses / ctx.rounds,
    writesPerResponse: writes / responses,
    readsPerRound: delta('reads') / ctx.rounds,
    gcMs: delta('gcMs') / ctx.rounds,
    gcMajorMs: delta('gcMajorMs') / ctx.rounds,
    gcCount: delta('gcCount') / ctx.rounds,
    opsPerRound,
    points: points(median(roundsMs), spec.tRef),
  };
}

// ---------------------------------------------------------------- the run

/** One whole measurement: a fresh forge, the selected workloads, and the forge stopped again. */
async function runOnce() {
  const env = await startEnvStub();
  const forge = await startForge(env.url);
  const port = await Promise.race([
    env.waitForRegister(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('the forge never registered')), 30_000)),
  ]);
  const baseUrl = `http://127.0.0.1:${port}`;
  const scenario = buildScenario();
  const owner = scenario.viewer.login;

  KIND = forge.kind;
  const results = [];
  try {
    for (const spec of WORKLOADS) {
      if (OPTIONS.only !== null && !OPTIONS.only.has(spec.name)) continue;
      const git = new GitClient({ baseUrl, token: TOKEN, timeoutMs: 120_000 });
      const rest = new RestClient({ baseUrl, token: TOKEN, timeoutMs: 120_000 });
      const ctx = { git, rest, owner, scenario, ops: spec.ops, rounds: OPTIONS.rounds, warmup: OPTIONS.warmup };
      results.push(await runWorkload(spec, ctx, forge));
    }
  } finally {
    if (OPTIONS.prof !== null || OPTIONS.heap !== null) {
      forge.child.kill('SIGUSR1');
      await new Promise((r) => setTimeout(r, 1_000));
    }
    // Stop the forge before moving on. An orphan keeps polling an env that died with its parent,
    // and several of them pinned to the same core quietly ruin every later measurement -- which
    // is exactly what happened the first time this tool was run.
    env.finish();
    forge.child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (forge.child.exitCode !== null || forge.child.signalCode !== null) return resolve();
      forge.child.once('exit', resolve);
      setTimeout(() => {
        forge.child.kill('SIGKILL');
        resolve();
      }, 2_000);
    });
    env.close();
  }
  return results;
}

async function main() {
  // This box is shared, so one measurement is mostly noise: repeat the whole thing and keep the
  // median of each workload's own numbers. CPU is far steadier than wall time and is what the
  // grader's gVisor sandbox actually charges for, so read that column first.
  const runs = [];
  for (let repeat = 0; repeat < Math.max(1, OPTIONS.repeat); repeat += 1) runs.push(await runOnce());

  const results = runs[0].map((_, index) => {
    const across = runs.map((run) => run[index]);
    return {
      name: across[0].name,
      p50Ms: median(across.map((r) => r.p50Ms)),
      cpuMs: median(across.map((r) => r.cpuMs)),
      writesPerRound: median(across.map((r) => r.writesPerRound)),
      responsesPerRound: median(across.map((r) => r.responsesPerRound)),
      writesPerResponse: median(across.map((r) => r.writesPerResponse)),
      readsPerRound: median(across.map((r) => r.readsPerRound)),
      gcMs: median(across.map((r) => r.gcMs)),
      gcMajorMs: median(across.map((r) => r.gcMajorMs)),
      gcCount: median(across.map((r) => r.gcCount)),
      points: median(across.map((r) => r.points)),
      runs: across.map((r) => ({ p50Ms: r.p50Ms, cpuMs: r.cpuMs })),
    };
  });

  const geomean = Math.exp(results.reduce((sum, r) => sum + Math.log(r.p50Ms), 0) / results.length);
  console.log('');
  console.log(`forge: ${KIND}${OPTIONS.taskset ? ', pinned to core 0' : ''}`);
  const pad = (text, width) => String(text).padStart(width);
  console.log('');
  console.log(`workload   wall p50 ms   forge cpu ms   gc ms (major)   gcs   reads   writes   w/resp   pts`);
  for (const r of results) {
    console.log(
      `${r.name.padEnd(8)} ${pad(r.p50Ms.toFixed(1), 12)} ${pad(r.cpuMs.toFixed(1), 14)} ${pad(`${r.gcMs.toFixed(1)} (${r.gcMajorMs.toFixed(1)})`, 15)} ${pad(Math.round(r.gcCount), 5)} ${pad(Math.round(r.readsPerRound), 7)} ${pad(Math.round(r.writesPerRound), 8)} ${pad(r.writesPerResponse.toFixed(2), 8)} ${pad(r.points, 5)}`,
    );
  }
  console.log('');
  console.log(
    `geomean wall p50: ${geomean.toFixed(1)} ms   forge cpu over the four medians: ${results.reduce((s, r) => s + r.cpuMs, 0).toFixed(1)} ms   (${OPTIONS.repeat} run(s))`,
  );
  if (OPTIONS.label !== '') console.log(`label: ${OPTIONS.label}`);

  if (OPTIONS.json !== null) {
    writeFileSync(OPTIONS.json, `${JSON.stringify({ label: OPTIONS.label, repeat: OPTIONS.repeat, geomeanMs: geomean, workloads: results }, null, 2)}\n`);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[bench] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
