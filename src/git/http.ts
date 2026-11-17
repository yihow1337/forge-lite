// git smart HTTP: the ref advertisement (v2 capabilities and the v0 preamble), upload-pack
// (protocol v2 ls-refs and fetch, with a v0 fallback) and receive-pack (v0 only).
//
// Every answer is one buffer. A repository's advertisement and fetch answers are cached against
// its version counter, so the benchmark's 50 concurrent depth-1 clones replay one prebuilt body.

import {
  ZERO_OID,
  commitOf,
  isAncestor,
  isOid,
  parseCommit,
  peel,
  reachable,
  type GitObject,
} from './objects.ts';
import { DELIM_TEXT, FLUSH_TEXT, decodePktLines, delimPkt, flushPkt, pkt, pktText, readPack, sidebandChunks, sidebandText, writePack } from './pack.ts';
import { touchGit, type RepoRec, type Store } from '../store.ts';

/** The agent string this forge advertises. */
export const AGENT = 'makefun-forge/1.0';

/** One answer the git surface produces. */
export interface GitReply {
  status: number;
  type: string;
  body: Buffer;
}

const UPLOAD_ADVERT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const V2_CAPABILITIES = Buffer.concat([
  pkt('version 2\n'),
  pkt(`agent=${AGENT}\n`),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow\n'),
  pkt('object-format=sha1\n'),
  flushPkt(),
]);

const UPLOAD_V0_CAPS = [
  'multi_ack',
  'multi_ack_detailed',
  'thin-pack',
  'side-band',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'deepen-since',
  'deepen-not',
  'no-progress',
  'include-tag',
  'allow-tip-sha1-in-want',
  'allow-reachable-sha1-in-want',
  'object-format=sha1',
  `agent=${AGENT}`,
];

const RECEIVE_V0_CAPS = ['report-status', 'report-status-v2', 'delete-refs', 'side-band-64k', 'ofs-delta', 'object-format=sha1', `agent=${AGENT}`];

/** The two capability lists as the wire carries them, joined once rather than once an answer. */
const UPLOAD_V0_CAPS_TEXT = UPLOAD_V0_CAPS.join(' ');
const RECEIVE_V0_CAPS_TEXT = RECEIVE_V0_CAPS.join(' ');

function textReply(status: number, text: string): GitReply {
  return { status, type: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

/** The refs a repository advertises, HEAD first, every other ref in name order. */
interface AdvertisedRef {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function advertisedRefs(repo: RepoRec): AdvertisedRef[] {
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const out: AdvertisedRef[] = [];
  const headOid = repo.refs.get(headRef);
  if (headOid !== undefined) out.push({ name: 'HEAD', oid: headOid, symrefTarget: headRef });
  else out.push({ name: 'HEAD', oid: ZERO_OID, symrefTarget: headRef, unborn: true });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: AdvertisedRef = { name, oid };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = peel(repo.objects, oid);
      if (target !== null) entry.peeled = target;
    }
    out.push(entry);
  }
  return out;
}

/**
 * How many built answers one repository keeps. A cache key carries what the client asked for -- its
 * wants, its haves, its ref-prefixes -- so the number of distinct keys at one repository version is
 * the client's to choose, and each value is a whole packfile. The benchmark's clones repeat one key
 * and the conformance checks use a few dozen, so this ceiling is never reached by honest traffic; it
 * is here so that varied traffic costs a bounded amount of heap instead of a growing one.
 */
const CACHE_ENTRIES_MAX = 64;

function cached(repo: RepoRec, key: string, build: () => Buffer): Buffer {
  // No version in the key: touchGit empties the whole cache on every version bump, so everything
  // in it already belongs to the current version, and a key built per lookup would be waste.
  const hit = repo.cache.get(key);
  if (hit !== undefined) {
    // Refresh the entry's place in the Map's insertion order: eviction below drops the coldest key.
    repo.cache.delete(key);
    repo.cache.set(key, hit);
    return hit;
  }
  const built = build();
  while (repo.cache.size >= CACHE_ENTRIES_MAX) {
    const coldest = repo.cache.keys().next();
    if (coldest.done === true) break;
    repo.cache.delete(coldest.value);
  }
  repo.cache.set(key, built);
  return built;
}

/**
 * The v0 ref advertisement body for one service. Built as one string and encoded once: the push
 * workload asks for this advertisement before every one of its two hundred pushes, and each push
 * bumps the repository's version, so this is rebuilt two hundred times a round and must not cost
 * a Buffer per pkt-line plus the concat that joins them.
 */
function v0Advertisement(repo: RepoRec, service: string, caps: string): Buffer {
  let text = `${pktText(`# service=${service}\n`)}${FLUSH_TEXT}`;
  let first = true;
  for (const ref of advertisedRefs(repo)) {
    if (ref.unborn === true) continue;
    text += pktText(first ? `${ref.oid} ${ref.name}\u0000${caps}\n` : `${ref.oid} ${ref.name}\n`);
    first = false;
    if (ref.peeled !== undefined) text += pktText(`${ref.peeled} ${ref.name}^{}\n`);
  }
  if (first) text += pktText(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  return Buffer.from(`${text}${FLUSH_TEXT}`, 'utf8');
}

/** The capability list a v0 upload-pack advertisement carries (the symref is the repo's HEAD). */
function uploadCaps(repo: RepoRec): string {
  return `${UPLOAD_V0_CAPS_TEXT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------- ls-refs

interface LsRefsArgs {
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
}

function lsRefs(repo: RepoRec, args: LsRefsArgs): Buffer {
  let text = '';
  for (const ref of advertisedRefs(repo)) {
    if (ref.unborn === true && !args.unborn) continue;
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = ref.unborn === true ? `unborn ${ref.name}` : `${ref.oid} ${ref.name}`;
    if (args.symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    text += pktText(`${line}\n`);
  }
  return Buffer.from(`${text}${FLUSH_TEXT}`, 'utf8');
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

interface FetchPlan {
  objects: GitObject[];
  shallowLines: string[];
}

function parentsOf(repo: RepoRec, oid: string): string[] {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return [];
  return parseCommit(object.data).parents;
}

/** Which objects a fetch must send, and the shallow boundary it moves the client to. */
function planFetch(repo: RepoRec, args: FetchArgs): FetchPlan {
  const store = repo.objects;
  const clientShallow = new Set(args.shallow);
  const haveClosure = args.haves.length === 0 ? new Set<string>() : reachable(store, args.haves, clientShallow);
  const shallowLines: string[] = [];
  let send: Set<string>;

  if (args.depth !== null && args.depth > 0) {
    const level = new Map<string, number>();
    const boundary = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = [];
    for (const want of args.wants) {
      const commit = commitOf(store, want);
      if (commit !== null) queue.push({ oid: commit, depth: 1 });
    }
    while (queue.length > 0) {
      const item = queue.shift() as { oid: string; depth: number };
      const known = level.get(item.oid);
      if (known !== undefined && known <= item.depth) continue;
      level.set(item.oid, item.depth);
      const parents = parentsOf(repo, item.oid);
      if (item.depth < args.depth) {
        for (const parent of parents) queue.push({ oid: parent, depth: item.depth + 1 });
      } else if (parents.length > 0) {
        boundary.add(item.oid);
      }
    }
    const window = new Set(level.keys());
    send = reachable(store, window, window);
    for (const oid of boundary) if (!clientShallow.has(oid)) shallowLines.push(`shallow ${oid}`);
    for (const oid of clientShallow) if (window.has(oid) && !boundary.has(oid)) shallowLines.push(`unshallow ${oid}`);
    // A want that is not a commit (an annotated tag) still travels whole.
    for (const want of args.wants) {
      if (commitOf(store, want) === want) continue;
      for (const oid of reachable(store, [want], window)) send.add(oid);
    }
  } else {
    send = reachable(store, args.wants);
  }

  const objects: GitObject[] = [];
  for (const oid of send) {
    if (haveClosure.has(oid)) continue;
    const object = store.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallowLines };
}

function fetchBody(repo: RepoRec, args: FetchArgs): Buffer {
  const key = `fetch|${args.depth ?? 0}|${[...args.wants].sort().join(',')}|${[...args.haves].sort().join(',')}|${[...args.shallow].sort().join(',')}`;
  return cached(repo, key, () => {
    const plan = planFetch(repo, args);
    const parts: Buffer[] = [];
    if (plan.shallowLines.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const line of plan.shallowLines) parts.push(pkt(`${line}\n`));
      parts.push(delimPkt());
    }
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandChunks(writePack(plan.objects)));
    parts.push(flushPkt());
    return Buffer.concat(parts);
  });
}

function fetchBodyV0(repo: RepoRec, args: FetchArgs): Buffer {
  const key = `fetch0|${args.depth ?? 0}|${[...args.wants].sort().join(',')}|${[...args.haves].sort().join(',')}|${[...args.shallow].sort().join(',')}`;
  return cached(repo, key, () => {
    const plan = planFetch(repo, args);
    const parts: Buffer[] = [];
    if (plan.shallowLines.length > 0) {
      for (const line of plan.shallowLines) parts.push(pkt(`${line}\n`));
      parts.push(flushPkt());
    }
    parts.push(pkt('NAK\n'));
    parts.push(...sidebandChunks(writePack(plan.objects)));
    parts.push(flushPkt());
    return Buffer.concat(parts);
  });
}

// ---------------------------------------------------------------- request parsing

interface Command {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** One pkt-line's payload as text, without its trailing newline and without a regular expression. */
function lineOf(payload: Buffer): string {
  const end = payload.length > 0 && payload[payload.length - 1] === 10 ? payload.length - 1 : payload.length;
  return payload.toString('utf8', 0, end);
}

function parseReceiveRequest(body: Buffer): { commands: Command[]; caps: Set<string>; pack: Buffer } {
  const decoded = decodePktLines(body, 0, true);
  const commands: Command[] = [];
  const caps = new Set<string>();
  let first = true;
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    let line = lineOf(packet.payload);
    if (first) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).split(' ')) if (cap !== '') caps.add(cap.split('=')[0] as string);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const firstSpace = line.indexOf(' ');
    if (firstSpace < 0) continue;
    const secondSpace = line.indexOf(' ', firstSpace + 1);
    if (secondSpace < 0 || secondSpace + 1 >= line.length) continue;
    commands.push({ oldOid: line.slice(0, firstSpace), newOid: line.slice(firstSpace + 1, secondSpace), ref: line.slice(secondSpace + 1) });
  }
  return { commands, caps, pack: body.subarray(decoded.offset) };
}

// ---------------------------------------------------------------- the surface

/** One request as the git surface reads it. */
export interface GitHttpRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  gitProtocolV2: boolean;
  body: Buffer;
}

/**
 * Serve one git smart-HTTP request; null when the path is not this surface's. `segments` is the
 * path split on '/', with the leading empty entry dropped.
 */
export function handleGit(store: Store, request: GitHttpRequest): GitReply | null {
  const segments = request.segments;
  if (segments.length < 3) return null;
  const owner = segments[0] as string;
  const rawRepo = segments[1] as string;
  if (!rawRepo.endsWith('.git')) return null;
  const name = rawRepo.slice(0, -4);
  const tail =
    segments.length === 3
      ? (segments[2] as string)
      : segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs'
        ? 'info/refs'
        : '';
  if (tail !== 'info/refs' && tail !== 'git-upload-pack' && tail !== 'git-receive-pack') return null;
  store.latchOwner(owner);
  const repo = store.repo(owner, name);

  if (tail === 'info/refs') {
    if (request.method !== 'GET') return textReply(405, 'method not allowed\n');
    const service = request.query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return textReply(403, 'dumb http is not supported\n');
    if (repo === undefined) return textReply(404, 'repository not found\n');
    if (service === 'git-upload-pack') {
      if (request.gitProtocolV2) return { status: 200, type: UPLOAD_ADVERT, body: V2_CAPABILITIES };
      return { status: 200, type: UPLOAD_ADVERT, body: cached(repo, 'adv0u', () => v0Advertisement(repo, service, uploadCaps(repo))) };
    }
    return { status: 200, type: RECEIVE_ADVERT, body: cached(repo, 'adv0r', () => v0Advertisement(repo, service, RECEIVE_V0_CAPS_TEXT)) };
  }

  if (request.method !== 'POST') return textReply(405, 'method not allowed\n');
  if (repo === undefined) return textReply(404, 'repository not found\n');

  if (tail === 'git-upload-pack') {
    try {
      return uploadPack(repo, request);
    } catch (err) {
      return textReply(400, `bad request: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  try {
    return receivePack(repo, request);
  } catch (err) {
    return textReply(400, `bad request: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function uploadPack(repo: RepoRec, request: GitHttpRequest): GitReply {
  const decoded = decodePktLines(request.body, 0, false);
  const lines: string[] = [];
  for (const packet of decoded.packets) if (packet.kind === 'data') lines.push(lineOf(packet.payload));

  let command = '';
  for (const line of lines) {
    if (line.startsWith('command=')) {
      command = line.slice('command='.length);
      break;
    }
  }

  if (command === 'ls-refs') {
    const args: LsRefsArgs = { prefixes: [], peel: false, symrefs: false, unborn: false };
    for (const line of lines) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    const key = `ls|${args.peel ? 1 : 0}${args.symrefs ? 1 : 0}${args.unborn ? 1 : 0}|${args.prefixes.join(',')}`;
    return { status: 200, type: UPLOAD_RESULT, body: cached(repo, key, () => lsRefs(repo, args)) };
  }

  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let sawWant = false;
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (isOid(oid)) args.wants.push(oid);
      sawWant = true;
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5, 45);
      if (isOid(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48);
      if (isOid(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      args.depth = Number.parseInt(line.slice(7), 10);
    } else if (line === 'done') {
      args.done = true;
    }
  }
  if (!sawWant) throw new Error('no want line in the request');
  args.wants = [...new Set(args.wants)].filter((oid) => repo.objects.has(oid));
  args.haves = args.haves.filter((oid) => repo.objects.has(oid));
  if (command === 'fetch') return { status: 200, type: UPLOAD_RESULT, body: fetchBody(repo, args) };
  return { status: 200, type: UPLOAD_RESULT, body: fetchBodyV0(repo, args) };
}

function receivePack(repo: RepoRec, request: GitHttpRequest): GitReply {
  const parsed = parseReceiveRequest(request.body);
  const sidebandWanted = parsed.caps.has('side-band-64k') || parsed.caps.has('side-band');
  let report = '';
  let unpackDetail = 'ok';
  if (parsed.pack.length > 0) {
    try {
      const objects = readPack(parsed.pack, repo.objects);
      for (const [oid, object] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    } catch (err) {
      unpackDetail = `index-pack failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  report += pktText(`unpack ${unpackDetail}\n`);

  let changed = false;
  for (const command of parsed.commands) {
    if (unpackDetail !== 'ok') {
      report += pktText(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        report += pktText(`ng ${command.ref} deletion of a ref that does not exist\n`);
        continue;
      }
      repo.refs.delete(command.ref);
      changed = true;
      report += pktText(`ok ${command.ref}\n`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report += pktText(`ng ${command.ref} missing necessary objects\n`);
      continue;
    }
    if (current === undefined || current === command.newOid || isAncestor(repo.objects, current, command.newOid)) {
      repo.refs.set(command.ref, command.newOid);
      changed = true;
      report += pktText(`ok ${command.ref}\n`);
      continue;
    }
    report += pktText(`ng ${command.ref} non-fast-forward\n`);
  }
  if (changed || parsed.pack.length > 0) touchGit(repo);

  // The report is a handful of short lines; one string and one encode, not a Buffer a line.
  const inner = `${report}${FLUSH_TEXT}`;
  const text = sidebandWanted ? `${sidebandText(inner)}${FLUSH_TEXT}` : inner;
  return { status: 200, type: RECEIVE_RESULT, body: Buffer.from(text, 'utf8') };
}
