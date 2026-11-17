#!/usr/bin/env node
// tools/micro.mjs -- the forge's handlers, timed without a socket in the way.
//
// tools/bench.mjs measures what the grader measures: a whole round over TCP, where the forge's own
// work is a minority of the wall clock and the sampling profiler has little to sample. This file
// is the complement: it calls handleGit and handleRest directly with the same bytes the suite
// sends, many times, and reports microseconds per operation. A change to the git or REST hot path
// shows up here first, and only then has to prove itself in bench.mjs.
//
//   node tools/micro.mjs            every case
//   MICRO_REPO=/tmp/before node tools/micro.mjs   the same cases against another checkout
//   node tools/micro.mjs push       one case
//   node tools/micro.mjs --prof p   write a V8 CPU profile of the run

import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';

const KIT = process.env.MAKEFUN_KIT ?? '/workspace/makefun/git-forge/kit/github-core-clone-01-kit';
const SRC = `${KIT}/program/env/src`;
const { CONFORMANCE_IDENTITY, ZERO_OID, buildCommit, buildTree, hashObject, writePack, encodePktLines } = await import(`${SRC}/git-client.ts`);
const { generateBlobText, scenarioRng, buildScenario } = await import(`${SRC}/wire.ts`);

// MICRO_REPO points the forge imports at another checkout, so one change can be measured against
// the commit before it with the same fixtures and the same process.
const FORGE = process.env.MICRO_REPO ?? new URL('..', import.meta.url).pathname;
const { Store } = await import(`${FORGE}/src/store.ts`);
const { handleGit } = await import(`${FORGE}/src/git/http.ts`);
const { handleRest } = await import(`${FORGE}/src/rest.ts`);

const EMPTY_QUERY = new URLSearchParams();
const RECEIVE_QUERY = new URLSearchParams('service=git-receive-pack');
const OWNER = buildScenario().viewer.login;

/** The receive-pack request body one push sends: the command list, a flush, then the pack. */
function receiveBody(command, pack, caps) {
  const first = `${command.oldOid} ${command.newOid} ${command.ref}\u0000${caps}`;
  return Buffer.concat([encodePktLines([`${first}\n`]), Buffer.from('0000', 'latin1'), pack]);
}

function pushPayloads(count) {
  const rng = scenarioRng('bench.push');
  const out = [];
  let parent = null;
  for (let index = 0; index < count; index += 1) {
    const blob = Buffer.from(generateBlobText(rng, 1_024), 'utf8');
    const tree = buildTree([{ mode: '100644', name: 'bench-data.txt', oid: hashObject('blob', blob) }]);
    const commit = buildCommit({
      tree: hashObject('tree', tree),
      parents: parent === null ? [] : [parent],
      message: `bench: push ${index + 1}\n`,
      author: CONFORMANCE_IDENTITY,
      committer: CONFORMANCE_IDENTITY,
      timestamp: 1_700_000_000 + index,
    });
    const oid = hashObject('commit', commit);
    out.push({
      command: { oldOid: parent ?? ZERO_OID, newOid: oid, ref: 'refs/heads/main' },
      pack: writePack([
        { type: 'blob', data: blob },
        { type: 'tree', data: tree },
        { type: 'commit', data: commit },
      ]),
    });
    parent = oid;
  }
  return out;
}

/** Set while a case runs, so a profile samples the measured loop and not the fixture building. */
let sampling = { start() {}, stop() {} };

/**
 * Time `body`, after a warm-up of the same shape, in microseconds per call. The loop runs several
 * times and the BEST pass is reported: this box runs other work, and a preempted pass measures the
 * neighbours rather than the code. The median is printed beside it so a suspiciously lucky best
 * is visible.
 */
function time(name, iterations, body) {
  for (let i = 0; i < Math.min(iterations, 200); i += 1) body(i);
  const passes = [];
  for (let pass = 0; pass < PASSES; pass += 1) {
    sampling.start();
    const started = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) body(i);
    sampling.stop();
    passes.push(Number(process.hrtime.bigint() - started) / 1_000 / iterations);
  }
  passes.sort((a, b) => a - b);
  const best = passes[0];
  const mid = passes[Math.ceil(passes.length / 2) - 1];
  console.log(`${name.padEnd(34)} best ${best.toFixed(2).padStart(7)} us/op   median ${mid.toFixed(2).padStart(7)}   (${iterations} ops x ${PASSES})`);
}

const CASES = {
  /** One push: the receive-pack advertisement the client fetches first, then the pack exchange. */
  push() {
    const iterations = 500;
    // The chain is consumed, never replayed: one payload per timed operation, warm-up included.
    const payloads = pushPayloads(200 + PASSES * iterations + 10);
    const store = new Store(OWNER);
    store.latchOwner(OWNER);
    store.createRepo('micro-push');
    let next = 0;
    const caps = 'report-status side-band-64k agent=git/2.44';
    time('push: advert + receive-pack', iterations, () => {
      handleGit(store, { method: 'GET', segments: [OWNER, 'micro-push.git', 'info', 'refs'], query: RECEIVE_QUERY, gitProtocolV2: false, body: Buffer.alloc(0) });
      const payload = payloads[next++];
      const reply = handleGit(store, {
        method: 'POST',
        segments: [OWNER, 'micro-push.git', 'git-receive-pack'],
        query: EMPTY_QUERY,
        gitProtocolV2: false,
        body: receiveBody(payload.command, payload.pack, caps),
      });
      if (reply.status !== 200) throw new Error(`push answered ${reply.status}`);
    });
  },

  /** One depth-1 clone's two upload-pack calls, both served from the per-version cache. */
  clone() {
    const store = new Store(OWNER);
    store.latchOwner(OWNER);
    store.createRepo('micro-clone');
    const payloads = pushPayloads(1);
    handleGit(store, {
      method: 'POST',
      segments: [OWNER, 'micro-clone.git', 'git-receive-pack'],
      query: EMPTY_QUERY,
      gitProtocolV2: false,
      body: receiveBody(payloads[0].command, payloads[0].pack, 'report-status'),
    });
    const tip = payloads[0].command.newOid;
    const lsRefs = encodePktLines(['command=ls-refs\n', 'agent=git/2.44\n', '0001', 'peel\n', 'symrefs\n', 'unborn\n', 'ref-prefix HEAD\n', 'ref-prefix refs/heads/\n']);
    const fetch = encodePktLines(['command=fetch\n', 'agent=git/2.44\n', '0001', 'thin-pack\n', 'no-progress\n', 'ofs-delta\n', 'deepen 1\n', `want ${tip}\n`, 'done\n']);
    time('clone: ls-refs + fetch (cached)', 5_000, () => {
      handleGit(store, { method: 'POST', segments: [OWNER, 'micro-clone.git', 'git-upload-pack'], query: EMPTY_QUERY, gitProtocolV2: true, body: lsRefs });
      handleGit(store, { method: 'POST', segments: [OWNER, 'micro-clone.git', 'git-upload-pack'], query: EMPTY_QUERY, gitProtocolV2: true, body: fetch });
    });
  },

  /** One GET of one issue: the read workload's whole server-side cost above the socket. */
  read() {
    const store = new Store(OWNER);
    store.latchOwner(OWNER);
    store.createRepo('micro-read');
    handleRest(store, { method: 'POST', segments: ['repos', OWNER, 'micro-read', 'issues'], query: EMPTY_QUERY, json: { title: 'a benchmark issue', body: 'x'.repeat(400) }, badJson: false, authorized: true, host: 'h' });
    const segments = ['repos', OWNER, 'micro-read', 'issues', '1'];
    time('read: GET one issue', 100_000, () => {
      const reply = handleRest(store, { method: 'GET', segments, query: EMPTY_QUERY, json: undefined, badJson: false, authorized: true, host: 'h' });
      if (reply.status !== 200) throw new Error(`read answered ${reply.status}`);
    });
  },

  /** One issue creation. */
  write() {
    const store = new Store(OWNER);
    store.latchOwner(OWNER);
    store.createRepo('micro-write');
    const segments = ['repos', OWNER, 'micro-write', 'issues'];
    const json = { title: 'a benchmark issue', body: 'x'.repeat(400) };
    time('write: POST one issue', 50_000, () => {
      const reply = handleRest(store, { method: 'POST', segments, query: EMPTY_QUERY, json, badJson: false, authorized: true, host: 'h' });
      if (reply.status !== 201) throw new Error(`write answered ${reply.status}`);
    });
  },
};

const args = process.argv.slice(2);
let prof = null;
let PASSES = 5;
const names = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--prof') prof = args[++i];
  else if (args[i] === '--passes') PASSES = Number.parseInt(args[++i], 10);
  else names.push(args[i]);
}

let session = null;
const profiles = [];
if (prof !== null) {
  session = new Session();
  session.connect();
  session.post('Profiler.enable');
  session.post('Profiler.setSamplingInterval', { interval: 50 });
  sampling = {
    start() {
      session.post('Profiler.start');
    },
    stop() {
      session.post('Profiler.stop', (_err, value) => profiles.push(value.profile));
    },
  };
}

for (const name of names.length > 0 ? names : Object.keys(CASES)) CASES[name]();

if (session !== null) {
  writeFileSync(prof, JSON.stringify(profiles[profiles.length - 1]));
  console.log(`profile written to ${prof}`);
}
