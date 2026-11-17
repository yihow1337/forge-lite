// The git object model: ids, the four object types, and the tree surgery the contents and merge
// APIs need. Everything here is pure: a repository's object map goes in, bytes and ids come out.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** The all-zero id: an unborn ref's value in a receive-pack command. */
export const ZERO_OID = '0'.repeat(40);

/** A map from object id to object: one repository's loose store. */
export type ObjectStore = Map<string, GitObject>;

/** git's object id: SHA-1 over `<type> <size>\0` and the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\u0000`, 'latin1');
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object and answer its id (an id already held is left alone). */
export function putObject(store: ObjectStore, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.toString('latin1', offset, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree order: byte order of the name, a directory compared as if it ended in '/'. */
function treeKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

/** Serialize tree entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeKey(a), treeKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'), Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface BuildCommitFields {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
  timezone?: string;
}

/** The identity every commit this forge makes on its own carries. */
export const FORGE_IDENTITY = 'make.fun forge <forge@make.fun>';

/** Build a commit object's bytes, byte-for-byte as git writes them. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  const timestamp = fields.timestamp ?? 1735689600;
  const timezone = fields.timezone ?? '+0000';
  const author = `${fields.author ?? FORGE_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? fields.author ?? FORGE_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message: blank < 0 ? '' : text.slice(blank + 2) };
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') view.object = value;
    else if (key === 'type') view.type = value;
    else if (key === 'tag') view.tag = value;
    else if (key === 'tagger') view.tagger = value;
  }
  return view;
}

/** Follow tag objects down to the first non-tag object; null when one is missing. */
export function peel(store: ObjectStore, oid: string): string | null {
  let current: string | undefined = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return null;
}

/** Whether `oid` is a 40-character lowercase hex id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * Every object reachable from `roots`. `stopCommits` names commits whose parents are not walked
 * (a shallow boundary); a missing object ends that branch of the walk instead of throwing.
 */
export function reachable(store: ObjectStore, roots: Iterable<string>, stopCommits?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (root !== ZERO_OID) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (stopCommits === undefined || !stopCommits.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** The commits reachable from `roots` by parent links, newest first (breadth-first, deduplicated). */
export function commitList(store: ObjectStore, roots: readonly string[], limit = 1000): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const queue: string[] = [];
  for (const root of roots) {
    const resolved = peel(store, root);
    if (resolved !== null) queue.push(resolved);
  }
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/** Whether `ancestor` is reachable from `tip` by parent links (so `tip` fast-forwards it). */
export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  const target = peel(store, ancestor) ?? ancestor;
  const start = peel(store, tip);
  if (start === null) return false;
  if (start === target) return true;
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === target) return true;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits, or null when they share none. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const left = new Set(commitList(store, [a], 5000));
  for (const oid of commitList(store, [b], 5000)) if (left.has(oid)) return oid;
  return null;
}

/** The commit a ref value points at, following tags; null when it is not a commit. */
export function commitOf(store: ObjectStore, oid: string): string | null {
  const resolved = peel(store, oid);
  if (resolved === null) return null;
  return store.get(resolved)?.type === 'commit' ? resolved : null;
}

/** The tree of a commit, or null. */
export function treeOfCommit(store: ObjectStore, commitOid: string): string | null {
  const object = store.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** The entry at `segments` under `treeOid`, or null when the path is absent. */
export function treeLookup(store: ObjectStore, treeOid: string, segments: readonly string[]): TreeEntry | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** A copy of `treeOid` with `segments` set to `oid` (mode `mode`); intermediate trees are created. */
export function treeWithPath(store: ObjectStore, treeOid: string | null, segments: readonly string[], oid: string, mode = '100644'): string {
  const object = treeOid === null ? undefined : store.get(treeOid);
  const entries = object !== undefined && object.type === 'tree' ? parseTree(object.data) : [];
  const head = segments[0] as string;
  const kept = entries.filter((entry) => entry.name !== head);
  if (segments.length === 1) {
    kept.push({ mode, name: head, oid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    kept.push({ mode: '40000', name: head, oid: treeWithPath(store, existing?.oid ?? null, segments.slice(1), oid, mode) });
  }
  return putObject(store, 'tree', buildTree(kept));
}

/** A copy of `treeOid` without `segments`; null when the path was not there. */
export function treeWithoutPath(store: ObjectStore, treeOid: string, segments: readonly string[]): string | null {
  const object = store.get(treeOid);
  if (object === undefined || object.type !== 'tree') return null;
  const entries = parseTree(object.data);
  const head = segments[0] as string;
  const existing = entries.find((entry) => entry.name === head);
  if (existing === undefined) return null;
  let kept: TreeEntry[];
  if (segments.length === 1) {
    kept = entries.filter((entry) => entry.name !== head);
  } else {
    if (existing.mode !== '40000') return null;
    const child = treeWithoutPath(store, existing.oid, segments.slice(1));
    if (child === null) return null;
    kept = entries.filter((entry) => entry.name !== head);
    kept.push({ mode: '40000', name: head, oid: child });
  }
  return putObject(store, 'tree', buildTree(kept));
}

/** One path in a flattened tree walk. */
export interface FlatEntry {
  path: string;
  mode: string;
  oid: string;
}

/** Every blob path under `treeOid`, depth first, as `path -> {mode, oid}`. */
export function flattenTree(store: ObjectStore, treeOid: string | null, prefix = '', out: Map<string, FlatEntry> = new Map()): Map<string, FlatEntry> {
  if (treeOid === null) return out;
  const object = store.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { path, mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build a tree from a flat path map (the merge's output). */
export function treeFromPaths(store: ObjectStore, paths: ReadonlyMap<string, FlatEntry>): string {
  let tree = putObject(store, 'tree', buildTree([]));
  for (const entry of [...paths.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    tree = treeWithPath(store, tree, entry.path.split('/'), entry.oid, entry.mode);
  }
  return tree;
}

/** The result of a three-way tree merge. */
export interface MergeResult {
  conflict: boolean;
  tree: string | null;
  conflicts: string[];
}

/** A path-level three-way merge of `ours` and `theirs` over `base`. */
export function mergeTrees(store: ObjectStore, baseTree: string | null, ourTree: string | null, theirTree: string | null): MergeResult {
  const base = flattenTree(store, baseTree);
  const ours = flattenTree(store, ourTree);
  const theirs = flattenTree(store, theirTree);
  const merged = new Map<string, FlatEntry>(ours);
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameOid = (x?: FlatEntry, y?: FlatEntry): boolean => (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
    if (sameOid(o, t)) continue;
    if (sameOid(b, o)) {
      if (t === undefined) merged.delete(path);
      else merged.set(path, t);
      continue;
    }
    if (sameOid(b, t)) continue;
    conflicts.push(path);
  }
  if (conflicts.length > 0) return { conflict: true, tree: null, conflicts };
  return { conflict: false, tree: treeFromPaths(store, merged), conflicts: [] };
}
