#!/usr/bin/env node
// tools/profile.mjs -- read a .cpuprofile written by tools/bench.mjs --prof or tools/micro.mjs
// --prof, and print where the forge's busy time went.
//
// Inclusive time is the number to reason with: it says what share of the forge's CPU a whole
// subtree costs, so `route` tells you the handlers' share and `drain` minus `route` tells you the
// parser's. Self time alone hides a cost spread over a dozen small frames.
//
//   node tools/profile.mjs p.cpuprofile                every frame over 3% inclusive
//   node tools/profile.mjs p.cpuprofile route drain    just these
//   node tools/profile.mjs p.cpuprofile --self         self time instead

import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
for (const id of p.samples) self.set(id, (self.get(id) ?? 0) + 1);
const total = p.samples.length;
let idle = 0;
for (const [id, c] of self) { const f = byId.get(id).callFrame.functionName; if (f === '(idle)' || f === '(program)') idle += c; }
const busy = total - idle;
const incl = new Map();
function walk(id) {
  const n = byId.get(id);
  let sum = self.get(id) ?? 0;
  for (const c of n.children ?? []) sum += walk(c);
  const f = n.callFrame;
  const key = `${f.functionName || '(anon)'} @ ${(f.url || '').split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
  incl.set(key, (incl.get(key) ?? 0) + sum);
  return sum;
}
walk(p.nodes[0].id);
const want = process.argv.slice(3).filter((a) => a !== '--self');
if (process.argv.includes('--self')) {
  const agg = new Map();
  for (const [id, c] of self) {
    const f = byId.get(id).callFrame;
    if (f.functionName === '(idle)' || f.functionName === '(program)') continue;
    const key = `${f.functionName || '(anon)'} @ ${(f.url || '').split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
    agg.set(key, (agg.get(key) ?? 0) + c);
  }
  for (const [k, v] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`${((v / busy) * 100).toFixed(1).padStart(5)}% self  ${String(v).padStart(5)}  ${k}`);
  }
  console.log(`busy ${busy} of ${total}`);
  process.exit(0);
}
for (const [k, v] of [...incl.entries()].sort((a, b) => b[1] - a[1])) {
  if (want.length && !want.some((w) => k.includes(w))) continue;
  if (!want.length && v / busy < 0.03) continue;
  console.log(`${((v / busy) * 100).toFixed(1).padStart(5)}% incl  ${String(v).padStart(5)}  ${k}`);
}
console.log(`busy ${busy} of ${total}`);
