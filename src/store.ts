// The forge's whole state: repositories, their git objects and refs, and the issues, labels,
// comments and pull requests the REST, GraphQL and MCP surfaces all read and write.
//
// Everything lives in memory and nothing reads a clock: ids are counters and timestamps are a
// fixed epoch plus a counter, so two runs of the same request sequence leave the same state.

import { buildCommit, hashObject, putObject, type GitObject, type ObjectStore } from './git/objects.ts';

/** The timestamp every generated object and JSON date derives from (2025-01-01T00:00:00Z). */
export const EPOCH_SEC = 1_735_689_600;
/** The ISO form of EPOCH_SEC, the `created_at` every object reports. */
export const EPOCH_ISO = '2025-01-01T00:00:00Z';

export interface LabelRec {
  id: number;
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  json: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelRec[];
  comments: CommentRec[];
  /** The cached REST body; cleared by every mutation. */
  json: string | null;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  json: string | null;
}

export interface RepoRec {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  issueOrder: number[];
  pulls: Map<number, PullRec>;
  pullOrder: number[];
  nextNumber: number;
  /** Bumped by every change to refs or objects; the git response caches key on it. */
  version: number;
  cache: Map<string, Buffer>;
  json: string | null;
}

/** One forge: one user and the repositories that user owns. */
export class Store {
  viewer: string;
  viewerId: number;
  private ownerLatched: boolean;
  readonly repos: Map<string, RepoRec>;
  private nextRepoId: number;
  private nextObjectId: number;
  private commitSeq: number;

  constructor(viewer: string) {
    this.viewer = viewer;
    this.viewerId = 1000;
    this.ownerLatched = false;
    this.repos = new Map();
    this.nextRepoId = 5000;
    this.nextObjectId = 1;
    this.commitSeq = 0;
  }

  /**
   * The first owner a request names is the token's own login. The scenario's viewer is the
   * default, so a forge that is never asked still answers with the right login.
   */
  latchOwner(owner: string): void {
    if (this.ownerLatched) return;
    this.ownerLatched = true;
    if (owner === '' || owner === this.viewer) return;
    this.viewer = owner;
    for (const repo of this.repos.values()) {
      repo.owner = owner;
      repo.json = null;
    }
  }

  /** Whether `owner` is the login this token owns (another login owns nothing here). */
  owns(owner: string): boolean {
    return owner === this.viewer;
  }

  /** The next id for an issue, comment, label or pull request (one space, as GitHub has). */
  nextId(): number {
    this.nextObjectId += 1;
    return this.nextObjectId;
  }

  /** A fresh, strictly increasing commit timestamp: no two generated commits collide. */
  nextCommitTime(): number {
    this.commitSeq += 1;
    return EPOCH_SEC + this.commitSeq;
  }

  /** The repository, or undefined; `owner` must be the viewer. */
  repo(owner: string, name: string): RepoRec | undefined {
    if (!this.owns(owner)) return undefined;
    return this.repos.get(name);
  }

  /** Create a repository; undefined when the name is taken. */
  createRepo(name: string, options: { description?: string; private?: boolean; defaultBranch?: string } = {}): RepoRec | undefined {
    if (this.repos.has(name)) return undefined;
    this.nextRepoId += 1;
    const repo: RepoRec = {
      id: this.nextRepoId,
      name,
      owner: this.viewer,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      labels: new Map<string, LabelRec>(),
      issues: new Map<number, IssueRec>(),
      issueOrder: [],
      pulls: new Map<number, PullRec>(),
      pullOrder: [],
      nextNumber: 1,
      version: 0,
      cache: new Map<string, Buffer>(),
      json: null,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** Delete a repository; whether it was there. */
  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }
}

/** Mark a repository's git state changed: the advertisement and pack caches are dropped. */
export function touchGit(repo: RepoRec): void {
  repo.version += 1;
  if (repo.cache.size > 0) repo.cache.clear();
}

/** Store one object in a repository (the git state counts as changed). */
export function addObject(repo: RepoRec, type: GitObject['type'], data: Buffer): string {
  return putObject(repo.objects, type, data);
}

/** The tip of a branch, or undefined. */
export function branchTip(repo: RepoRec, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Every branch name, in insertion order with the default branch first. */
export function branchNames(repo: RepoRec): string[] {
  const names: string[] = [];
  for (const ref of repo.refs.keys()) if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
  names.sort((a, b) => (a === repo.defaultBranch ? -1 : b === repo.defaultBranch ? 1 : a < b ? -1 : a > b ? 1 : 0));
  return names;
}

/** Commit `tree` onto `branch` (creating it when it has no tip) and answer the new commit id. */
export function commitTree(store: Store, repo: RepoRec, branch: string, tree: string, message: string): string {
  const parent = branchTip(repo, branch);
  const commit = buildCommit({
    tree,
    parents: parent === undefined ? [] : [parent],
    message,
    timestamp: store.nextCommitTime(),
  });
  const oid = addObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, oid);
  touchGit(repo);
  return oid;
}

/** The id of a blob's bytes without storing it. */
export function blobId(data: Buffer): string {
  return hashObject('blob', data);
}
