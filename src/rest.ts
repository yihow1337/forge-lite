// The GitHub REST v3 surface, under /api/v3.
//
// Every reply is JSON; an error carries {"message": …}. Issue and pull-request bodies are
// serialized once and cached on the record, so the read benchmark's 2,000 GETs of one issue cost
// a map lookup and a socket write.

import {
  commitList,
  commitOf,
  flattenTree,
  isOid,
  mergeBase,
  mergeTrees,
  parseCommit,
  parseTree,
  peel,
  putObject,
  treeLookup,
  treeOfCommit,
  treeWithPath,
  treeWithoutPath,
  type ObjectStore,
} from './git/objects.ts';
import { EPOCH_ISO, branchNames, branchTip, commitTree, touchGit, type IssueRec, type PullRec, type RepoRec, type Store } from './store.ts';

/** One REST answer: a status and a JSON body (null for 204). */
export interface ApiReply {
  status: number;
  body: string | null;
  headers?: Record<string, string>;
}

/** One REST request, already split and parsed. */
export interface ApiRequest {
  method: string;
  /** The path segments after /api/v3, each percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when there was none. */
  json: unknown;
  /** Set when a body was sent and did not parse. */
  badJson: boolean;
  authorized: boolean;
  host: string;
}

const NOT_FOUND = 'Not Found';

function reply(status: number, value: unknown): ApiReply {
  return { status, body: JSON.stringify(value) };
}

function error(status: number, message: string): ApiReply {
  return { status, body: `{"message":${JSON.stringify(message)},"documentation_url":"https://docs.github.com/rest"}` };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function intOf(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ---------------------------------------------------------------- JSON views

function userOf(store: Store): Record<string, unknown> {
  return {
    login: store.viewer,
    id: store.viewerId,
    node_id: nodeId('User', store.viewerId),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    html_url: `/${store.viewer}`,
    url: `/api/v3/users/${store.viewer}`,
  };
}

function repoJson(store: Store, repo: RepoRec): string {
  if (repo.json !== null) return repo.json;
  const fullName = `${repo.owner}/${repo.name}`;
  const text = JSON.stringify({
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: fullName,
    private: repo.private,
    owner: userOf(store),
    html_url: `/${fullName}`,
    url: `/api/v3/repos/${fullName}`,
    description: repo.description,
    fork: false,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    pushed_at: EPOCH_ISO,
    git_url: `/${fullName}.git`,
    clone_url: `/${fullName}.git`,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issueOrder.length,
    default_branch: repo.defaultBranch,
    visibility: repo.private ? 'private' : 'public',
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  });
  repo.json = text;
  return text;
}

function labelJson(label: { id: number; name: string; color: string }): Record<string, unknown> {
  return { id: label.id, node_id: nodeId('Label', label.id), name: label.name, color: label.color, default: false, description: null, url: '' };
}

function issueJson(store: Store, repo: RepoRec, issue: IssueRec): string {
  if (issue.json !== null) return issue.json;
  const fullName = `${repo.owner}/${repo.name}`;
  const text = JSON.stringify({
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: null,
    locked: false,
    labels: issue.labels.map(labelJson),
    user: userOf(store),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    closed_at: issue.state === 'closed' ? EPOCH_ISO : null,
    html_url: `/${fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${fullName}`,
    comments_url: `/api/v3/repos/${fullName}/issues/${issue.number}/comments`,
    author_association: 'OWNER',
  });
  issue.json = text;
  return text;
}

function pullJson(store: Store, repo: RepoRec, pull: PullRec): string {
  if (pull.json !== null) return pull.json;
  const fullName = `${repo.owner}/${repo.name}`;
  const text = JSON.stringify({
    id: pull.id,
    node_id: nodeId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable: pull.merged ? null : mergeableOf(repo, pull),
    mergeable_state: pull.merged ? 'unknown' : 'clean',
    merged_at: pull.merged ? EPOCH_ISO : null,
    closed_at: pull.state === 'closed' ? EPOCH_ISO : null,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    merge_commit_sha: pull.mergeCommitSha,
    user: userOf(store),
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, user: userOf(store), repo: null },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, user: userOf(store), repo: null },
    html_url: `/${fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${fullName}/pulls/${pull.number}`,
    comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    author_association: 'OWNER',
  });
  pull.json = text;
  return text;
}

/** Whether a pull request still merges cleanly (GitHub's `mergeable`). */
export function mergeableOf(repo: RepoRec, pull: PullRec): boolean {
  const head = branchTip(repo, pull.head) ?? pull.headSha;
  const base = branchTip(repo, pull.base) ?? pull.baseSha;
  const merged = planMerge(repo, head, base);
  return merged !== null;
}

interface MergePlan {
  tree: string;
  base: string;
  head: string;
}

/** The tree a squash merge of `head` into `base` produces, or null when the two conflict. */
function planMerge(repo: RepoRec, head: string, base: string): MergePlan | null {
  const headCommit = commitOf(repo.objects, head);
  const baseCommit = commitOf(repo.objects, base);
  if (headCommit === null || baseCommit === null) return null;
  const ancestor = mergeBase(repo.objects, headCommit, baseCommit);
  const result = mergeTrees(
    repo.objects,
    ancestor === null ? null : treeOfCommit(repo.objects, ancestor),
    treeOfCommit(repo.objects, baseCommit),
    treeOfCommit(repo.objects, headCommit),
  );
  if (result.conflict || result.tree === null) return null;
  return { tree: result.tree, base: baseCommit, head: headCommit };
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const parsed = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
  const fullName = `${repo.owner}/${repo.name}`;
  const who = { name: repo.owner, email: `${repo.owner}@example.invalid`, date: EPOCH_ISO };
  return {
    sha: oid,
    node_id: nodeId('Commit', 1),
    commit: {
      message: parsed.message.replace(/\n$/, ''),
      author: who,
      committer: who,
      tree: { sha: parsed.tree },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: parsed.parents.map((parent) => ({ sha: parent })),
    html_url: `/${fullName}/commit/${oid}`,
    url: `/api/v3/repos/${fullName}/commits/${oid}`,
  };
}

// ---------------------------------------------------------------- helpers

/** Resolve a ref name or object id to a commit id. */
function resolveCommittish(repo: RepoRec, ref: string): string | null {
  if (ref === '') return branchTip(repo, repo.defaultBranch) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return commitOf(repo.objects, branch);
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return commitOf(repo.objects, tag);
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return commitOf(repo.objects, direct);
  if (isOid(ref) && repo.objects.has(ref)) return commitOf(repo.objects, ref);
  return null;
}

function blobText(objects: ObjectStore, oid: string): Buffer {
  const object = objects.get(oid);
  return object === undefined ? Buffer.alloc(0) : object.data;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < data.length; index += 1) if (data[index] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

function clearIssueCache(issue: IssueRec): void {
  issue.json = null;
}

// ---------------------------------------------------------------- the router

/** Serve one /api/v3 request. */
export function handleRest(store: Store, request: ApiRequest): ApiReply {
  const segments = request.segments;
  const method = request.method;

  if (segments.length === 0) {
    return {
      status: 200,
      body: JSON.stringify({
        current_user_url: '/api/v3/user',
        current_user_repositories_url: '/api/v3/user/repos',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
        user_repositories_url: '/api/v3/user/repos',
        graphql_url: '/api/graphql',
      }),
      headers: { 'x-oauth-scopes': 'repo, read:org, admin:org', 'x-accepted-oauth-scopes': '', 'x-github-media-type': 'github.v3; format=json' },
    };
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    return reply(200, { installed_version: '3.12.0', verifiable_password_authentication: false, packages: [], ssh_keys: [] });
  }

  if (!request.authorized) return error(401, 'Requires authentication');
  if (request.badJson) return error(400, 'Problems parsing JSON');

  if (segments[0] === 'rate_limit' && segments.length === 1) {
    const core = { limit: 5000, remaining: 5000, reset: 0, used: 0 };
    return reply(200, { resources: { core, graphql: core, search: core }, rate: core });
  }

  if (segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') return reply(200, userOf(store));
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') return listUserRepos(store, request);
      if (method === 'POST') return createUserRepo(store, request);
      return error(404, NOT_FOUND);
    }
    return error(404, NOT_FOUND);
  }

  if (segments[0] === 'repos') {
    if (segments.length < 3) return error(404, NOT_FOUND);
    const owner = segments[1] as string;
    const name = segments[2] as string;
    store.latchOwner(owner);
    const repo = store.repo(owner, name);
    const rest = segments.slice(3);
    if (repo === undefined) {
      if (rest.length === 0 && method === 'DELETE') return error(404, NOT_FOUND);
      return error(404, NOT_FOUND);
    }
    return repoRoute(store, repo, rest, request);
  }

  return error(404, NOT_FOUND);
}

function listUserRepos(store: Store, request: ApiRequest): ApiReply {
  const perPage = Math.min(100, intOf(request.query.get('per_page'), 30));
  const page = intOf(request.query.get('page'), 1);
  const all = [...store.repos.values()];
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const body = `[${slice.map((repo) => repoJson(store, repo)).join(',')}]`;
  const last = Math.max(1, Math.ceil(all.length / perPage));
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const url = (target: number): string => `http://${request.host}/api/v3/user/repos?per_page=${perPage}&page=${target}`;
  if (page < last) links.push(`<${url(page + 1)}>; rel="next"`, `<${url(last)}>; rel="last"`);
  if (page > 1) links.push(`<${url(1)}>; rel="first"`, `<${url(page - 1)}>; rel="prev"`);
  if (links.length > 0) headers.link = links.join(', ');
  return { status: 200, body, headers };
}

function createUserRepo(store: Store, request: ApiRequest): ApiReply {
  const body = record(request.json);
  const name = str(body.name);
  if (name === '') return error(422, 'Repository creation failed: name is required');
  if (store.repos.has(name)) return error(422, 'Repository creation failed: name already exists on this account');
  const repo = store.createRepo(name, {
    description: str(body.description),
    private: body.private === true,
    defaultBranch: str(body.default_branch, 'main'),
  });
  if (repo === undefined) return error(422, 'Repository creation failed: name already exists on this account');
  if (body.auto_init === true) {
    const tree = putObject(repo.objects, 'tree', Buffer.alloc(0));
    commitTree(store, repo, repo.defaultBranch, tree, 'Initial commit');
  }
  return { status: 201, body: repoJson(store, repo) };
}

function repoRoute(store: Store, repo: RepoRec, rest: string[], request: ApiRequest): ApiReply {
  const method = request.method;

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(store, repo) };
    if (method === 'PATCH') {
      const body = record(request.json);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.name === 'string' && body.name !== repo.name) {
        store.repos.delete(repo.name);
        repo.name = body.name;
        store.repos.set(repo.name, repo);
      }
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      repo.json = null;
      return { status: 200, body: repoJson(store, repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.name);
      return { status: 204, body: null };
    }
    return error(404, NOT_FOUND);
  }

  const head = rest[0] as string;

  if (head === 'branches') return branchesRoute(repo, rest, method);
  if (head === 'commits') return commitsRoute(repo, rest, request);
  if (head === 'git') return gitDataRoute(repo, rest, request);
  if (head === 'contents') return contentsRoute(store, repo, rest.slice(1), request);
  if (head === 'labels') return labelsRoute(store, repo, rest, request);
  if (head === 'issues') return issuesRoute(store, repo, rest, request);
  if (head === 'pulls') return pullsRoute(store, repo, rest, request);
  if (head === 'collaborators' && method === 'GET') return { status: 200, body: '[]' };
  return error(404, NOT_FOUND);
}

function branchesRoute(repo: RepoRec, rest: string[], method: string): ApiReply {
  if (method !== 'GET') return error(404, NOT_FOUND);
  if (rest.length === 1) {
    const list = branchNames(repo).map((name) => ({
      name,
      commit: { sha: branchTip(repo, name) as string, url: '' },
      protected: false,
    }));
    return reply(200, list);
  }
  const name = rest.slice(1).join('/');
  const tip = branchTip(repo, name);
  if (tip === undefined) return error(404, 'Branch not found');
  return reply(200, { name, commit: { sha: tip, commit: commitJson(repo, tip).commit, url: '' }, protected: false, _links: {} });
}

function commitsRoute(repo: RepoRec, rest: string[], request: ApiRequest): ApiReply {
  if (request.method !== 'GET') return error(404, NOT_FOUND);
  if (rest.length >= 2) {
    const oid = resolveCommittish(repo, rest.slice(1).join('/'));
    if (oid === null) return error(404, 'No commit found');
    return reply(200, commitJson(repo, oid));
  }
  const ref = request.query.get('sha') ?? '';
  const tip = resolveCommittish(repo, ref);
  if (tip === null) return reply(200, []);
  const perPage = Math.min(100, intOf(request.query.get('per_page'), 30));
  const list = commitList(repo.objects, [tip], perPage);
  return reply(200, list.map((oid) => commitJson(repo, oid)));
}

function gitDataRoute(repo: RepoRec, rest: string[], request: ApiRequest): ApiReply {
  if (rest[1] === 'refs') {
    if (request.method === 'POST' && rest.length === 2) {
      const body = record(request.json);
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || ref.length < 6) return error(422, 'Reference name is not valid');
      if (!isOid(sha) || !repo.objects.has(sha)) return error(422, 'Object does not exist');
      if (repo.refs.has(ref)) return error(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      touchGit(repo);
      return reply(201, { ref, node_id: nodeId('Ref', 1), url: '', object: { sha, type: 'commit', url: '' } });
    }
    if (request.method === 'GET') {
      const wanted = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(wanted);
      if (sha === undefined) return error(404, NOT_FOUND);
      return reply(200, { ref: wanted, node_id: nodeId('Ref', 1), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
    }
    if (request.method === 'DELETE') {
      const wanted = `refs/${rest.slice(2).join('/')}`;
      if (!repo.refs.delete(wanted)) return error(404, NOT_FOUND);
      touchGit(repo);
      return { status: 204, body: null };
    }
    return error(404, NOT_FOUND);
  }
  if (rest[1] === 'commits' && rest.length === 3 && request.method === 'GET') {
    const oid = rest[2] as string;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return error(404, NOT_FOUND);
    const parsed = parseCommit(object.data);
    return reply(200, { sha: oid, message: parsed.message, tree: { sha: parsed.tree }, parents: parsed.parents.map((sha) => ({ sha })) });
  }
  if (rest[1] === 'blobs' && rest.length === 3 && request.method === 'GET') {
    const oid = rest[2] as string;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'blob') return error(404, NOT_FOUND);
    return reply(200, { sha: oid, size: object.data.length, encoding: 'base64', content: object.data.toString('base64') });
  }
  return error(404, NOT_FOUND);
}

// ---------------------------------------------------------------- contents

function contentEntry(repo: RepoRec, path: string, oid: string, withContent: boolean): Record<string, unknown> {
  const data = blobText(repo.objects, oid);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const fullName = `${repo.owner}/${repo.name}`;
  const entry: Record<string, unknown> = {
    type: 'file',
    name,
    path,
    sha: oid,
    size: data.length,
    url: `/api/v3/repos/${fullName}/contents/${path}`,
    html_url: `/${fullName}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${fullName}/git/blobs/${oid}`,
    download_url: `/${fullName}/raw/${path}`,
    encoding: 'base64',
    _links: {},
  };
  if (withContent) entry.content = data.toString('base64');
  return entry;
}

function contentsRoute(store: Store, repo: RepoRec, pathSegments: string[], request: ApiRequest): ApiReply {
  const path = pathSegments.join('/').replace(/^\/+|\/+$/g, '');
  const method = request.method;

  if (method === 'GET') {
    const ref = request.query.get('ref') ?? '';
    const commit = resolveCommittish(repo, ref);
    if (commit === null) return error(404, 'This repository is empty.');
    const tree = treeOfCommit(repo.objects, commit);
    if (tree === null) return error(404, NOT_FOUND);
    if (path === '') return reply(200, directoryListing(repo, tree, ''));
    const entry = treeLookup(repo.objects, tree, path.split('/'));
    if (entry === null) return error(404, NOT_FOUND);
    if (entry.mode === '40000') return reply(200, directoryListing(repo, entry.oid, path));
    return reply(200, contentEntry(repo, path, entry.oid, true));
  }

  if (method === 'PUT' || method === 'DELETE') {
    if (path === '') return error(404, NOT_FOUND);
    const body = record(request.json);
    const branch = str(body.branch, repo.defaultBranch);
    const tip = branchTip(repo, branch);
    const tree = tip === undefined ? null : treeOfCommit(repo.objects, tip);
    const segments = path.split('/');
    const existing = tree === null ? null : treeLookup(repo.objects, tree, segments);
    const givenSha = str(body.sha);
    const message = str(body.message, method === 'PUT' ? 'Update file' : 'Delete file');

    if (method === 'DELETE') {
      if (existing === null) return error(404, NOT_FOUND);
      if (givenSha !== '' && givenSha !== existing.oid) return error(409, 'sha does not match');
      const newTree = treeWithoutPath(repo.objects, tree as string, segments);
      if (newTree === null) return error(404, NOT_FOUND);
      const commit = commitTree(store, repo, branch, newTree, message);
      return reply(200, { content: null, commit: { sha: commit, node_id: nodeId('Commit', 1), message, tree: { sha: newTree }, parents: tip === undefined ? [] : [{ sha: tip }] } });
    }

    const encoding = str(body.encoding, 'base64');
    const raw = str(body.content);
    const data = encoding === 'base64' ? Buffer.from(raw.replace(/\s+/g, ''), 'base64') : Buffer.from(raw, 'utf8');
    if (givenSha !== '') {
      if (existing === null) return error(404, NOT_FOUND);
      if (givenSha !== existing.oid) return error(409, `${path} does not match ${givenSha}`);
    }
    const blob = putObject(repo.objects, 'blob', data);
    const newTree = treeWithPath(repo.objects, tree, segments, blob);
    const commit = commitTree(store, repo, branch, newTree, message);
    const status = existing === null ? 201 : 200;
    return {
      status,
      body: JSON.stringify({
        content: contentEntry(repo, path, blob, false),
        commit: { sha: commit, node_id: nodeId('Commit', 1), message, tree: { sha: newTree }, parents: tip === undefined ? [] : [{ sha: tip }], html_url: '', url: '' },
      }),
    };
  }

  return error(404, NOT_FOUND);
}

/** One directory's own entries (never recursive), as the contents API lists them. */
function directoryListing(repo: RepoRec, treeOid: string, prefix: string): unknown[] {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const out: unknown[] = [];
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.oid, size: 0, url: '', html_url: '', git_url: '', download_url: null, _links: {} });
    } else {
      out.push(contentEntry(repo, path, entry.oid, false));
    }
  }
  return out;
}

// ---------------------------------------------------------------- labels

function labelsRoute(store: Store, repo: RepoRec, rest: string[], request: ApiRequest): ApiReply {
  if (rest.length === 1 && request.method === 'GET') return reply(200, [...repo.labels.values()].map(labelJson));
  if (rest.length === 1 && request.method === 'POST') {
    const body = record(request.json);
    const name = str(body.name);
    if (name === '') return error(422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) return error(422, 'Validation Failed: label already exists');
    const label = { id: store.nextId(), name, color: str(body.color, 'ededed') };
    repo.labels.set(name, label);
    return reply(201, labelJson(label));
  }
  if (rest.length === 2 && request.method === 'GET') {
    const label = repo.labels.get(rest[1] as string);
    if (label === undefined) return error(404, NOT_FOUND);
    return reply(200, labelJson(label));
  }
  return error(404, NOT_FOUND);
}

// ---------------------------------------------------------------- issues

/** Create one issue; a label the repository does not hold is a 422. */
export function createIssue(store: Store, repo: RepoRec, input: { title: string; body?: string; labels?: readonly unknown[] }): ApiReply {
  if (input.title === '') return error(422, 'Validation Failed: title is required');
  const labels: IssueRec['labels'] = [];
  for (const entry of input.labels ?? []) {
    const name = typeof entry === 'string' ? entry : str(record(entry).name);
    const label = repo.labels.get(name);
    if (label === undefined) return error(422, `Validation Failed: label ${JSON.stringify(name)} does not exist`);
    labels.push(label);
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: IssueRec = {
    id: store.nextId(),
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    comments: [],
    json: null,
  };
  repo.issues.set(number, issue);
  repo.issueOrder.push(number);
  repo.json = null;
  return { status: 201, body: issueJson(store, repo, issue) };
}

function issuesRoute(store: Store, repo: RepoRec, rest: string[], request: ApiRequest): ApiReply {
  const method = request.method;
  if (rest.length === 1) {
    if (method === 'POST') {
      const body = record(request.json);
      return createIssue(store, repo, { title: str(body.title), body: str(body.body), labels: Array.isArray(body.labels) ? body.labels : undefined });
    }
    if (method !== 'GET') return error(404, NOT_FOUND);
    const state = request.query.get('state') ?? 'open';
    const direction = request.query.get('direction') ?? 'desc';
    const perPage = Math.min(100, intOf(request.query.get('per_page'), 30));
    const page = intOf(request.query.get('page'), 1);
    let numbers = repo.issueOrder;
    if (state !== 'all') numbers = numbers.filter((number) => (repo.issues.get(number) as IssueRec).state === state);
    const ordered = direction === 'asc' ? numbers : [...numbers].reverse();
    const slice = ordered.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
    return { status: 200, body: `[${slice.map((number) => issueJson(store, repo, repo.issues.get(number) as IssueRec)).join(',')}]` };
  }

  const number = Number.parseInt(rest[1] as string, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;

  if (rest.length === 2) {
    if (issue === undefined) return error(404, NOT_FOUND);
    if (method === 'GET') return { status: 200, body: issueJson(store, repo, issue) };
    if (method === 'PATCH') {
      const body = record(request.json);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels: IssueRec['labels'] = [];
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : str(record(entry).name);
          const label = repo.labels.get(name);
          if (label === undefined) return error(422, `Validation Failed: label ${JSON.stringify(name)} does not exist`);
          labels.push(label);
        }
        issue.labels = labels;
      }
      clearIssueCache(issue);
      return { status: 200, body: issueJson(store, repo, issue) };
    }
    return error(404, NOT_FOUND);
  }

  if (rest.length === 3 && rest[2] === 'comments') {
    if (issue === undefined) return error(404, NOT_FOUND);
    if (method === 'GET') return { status: 200, body: `[${issue.comments.map((comment) => comment.json).join(',')}]` };
    if (method === 'POST') {
      const body = record(request.json);
      const comment = addComment(store, repo, issue, str(body.body));
      return { status: 201, body: comment.json };
    }
    return error(404, NOT_FOUND);
  }

  if (rest.length === 3 && rest[2] === 'labels' && method === 'POST') {
    if (issue === undefined) return error(404, NOT_FOUND);
    const body = record(request.json);
    const names = Array.isArray(body.labels) ? body.labels : [];
    for (const entry of names) {
      const name = typeof entry === 'string' ? entry : str(record(entry).name);
      const label = repo.labels.get(name);
      if (label === undefined) return error(422, `Validation Failed: label ${JSON.stringify(name)} does not exist`);
      if (!issue.labels.some((held) => held.name === name)) issue.labels.push(label);
    }
    clearIssueCache(issue);
    return reply(200, issue.labels.map(labelJson));
  }

  return error(404, NOT_FOUND);
}

/** Add one comment to an issue and answer the record (its JSON is built once). */
export function addComment(store: Store, repo: RepoRec, issue: IssueRec, body: string): { id: number; body: string; json: string } {
  const id = store.nextId();
  const json = JSON.stringify({
    id,
    node_id: nodeId('IssueComment', id),
    body,
    user: userOf(store),
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  });
  const comment = { id, body, json };
  issue.comments.push(comment);
  clearIssueCache(issue);
  return comment;
}

// ---------------------------------------------------------------- pull requests

/** Open one pull request; an unknown head or base branch is a 422. */
export function createPull(store: Store, repo: RepoRec, input: { title: string; body?: string; head: string; base: string }): ApiReply {
  const head = input.head.includes(':') ? (input.head.split(':').pop() as string) : input.head;
  const base = input.base;
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (headSha === undefined) return error(422, `Validation Failed: head ${JSON.stringify(head)} does not exist`);
  if (baseSha === undefined) return error(422, `Validation Failed: base ${JSON.stringify(base)} does not exist`);
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRec = {
    id: store.nextId(),
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    head,
    base,
    headSha,
    baseSha,
    merged: false,
    mergeCommitSha: null,
    json: null,
  };
  repo.pulls.set(number, pull);
  repo.pullOrder.push(number);
  return { status: 201, body: pullJson(store, repo, pull) };
}

/** Merge one pull request as a squash commit on its base branch. */
export function mergePull(store: Store, repo: RepoRec, pull: PullRec): ApiReply {
  if (pull.state === 'closed' || pull.merged) return error(405, 'Pull Request is not mergeable');
  const head = branchTip(repo, pull.head) ?? pull.headSha;
  const base = branchTip(repo, pull.base) ?? pull.baseSha;
  const plan = planMerge(repo, head, base);
  if (plan === null) return error(405, 'Pull Request is not mergeable');
  const message = pull.body === '' ? `${pull.title} (#${pull.number})` : `${pull.title} (#${pull.number})\n\n${pull.body}`;
  const sha = commitTree(store, repo, pull.base, plan.tree, message);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = sha;
  pull.json = null;
  return reply(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

function pullFiles(repo: RepoRec, pull: PullRec): unknown[] {
  const head = commitOf(repo.objects, branchTip(repo, pull.head) ?? pull.headSha);
  const base = commitOf(repo.objects, branchTip(repo, pull.base) ?? pull.baseSha);
  if (head === null) return [];
  const ancestor = base === null ? null : mergeBase(repo.objects, head, base);
  const before = flattenTree(repo.objects, ancestor === null ? null : treeOfCommit(repo.objects, ancestor));
  const after = flattenTree(repo.objects, treeOfCommit(repo.objects, head));
  const out: unknown[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const old = before.get(path);
    const now = after.get(path);
    if (old !== undefined && now !== undefined && old.oid === now.oid) continue;
    let status = 'modified';
    let additions = 0;
    let deletions = 0;
    if (old === undefined && now !== undefined) {
      status = 'added';
      additions = Math.max(1, lineCount(blobText(repo.objects, now.oid)));
    } else if (now === undefined && old !== undefined) {
      status = 'removed';
      deletions = Math.max(1, lineCount(blobText(repo.objects, old.oid)));
    } else if (old !== undefined && now !== undefined) {
      additions = Math.max(1, lineCount(blobText(repo.objects, now.oid)));
      deletions = Math.max(1, lineCount(blobText(repo.objects, old.oid)));
    }
    out.push({
      sha: now?.oid ?? old?.oid ?? '',
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    });
  }
  return out;
}

function pullsRoute(store: Store, repo: RepoRec, rest: string[], request: ApiRequest): ApiReply {
  const method = request.method;
  if (rest.length === 1) {
    if (method === 'POST') {
      const body = record(request.json);
      return createPull(store, repo, { title: str(body.title), body: str(body.body), head: str(body.head), base: str(body.base) });
    }
    if (method !== 'GET') return error(404, NOT_FOUND);
    const state = request.query.get('state') ?? 'open';
    const perPage = Math.min(100, intOf(request.query.get('per_page'), 30));
    const page = intOf(request.query.get('page'), 1);
    let numbers = repo.pullOrder;
    if (state !== 'all') numbers = numbers.filter((number) => (repo.pulls.get(number) as PullRec).state === state);
    const slice = numbers.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
    return { status: 200, body: `[${slice.map((number) => pullJson(store, repo, repo.pulls.get(number) as PullRec)).join(',')}]` };
  }

  const number = Number.parseInt(rest[1] as string, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;

  if (rest.length === 2) {
    if (pull === undefined) return error(404, NOT_FOUND);
    if (method === 'GET') return { status: 200, body: pullJson(store, repo, pull) };
    if (method === 'PATCH') {
      const body = record(request.json);
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed' || body.state === 'open') pull.state = body.state;
      pull.json = null;
      return { status: 200, body: pullJson(store, repo, pull) };
    }
    return error(404, NOT_FOUND);
  }

  if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
    if (pull === undefined) return error(404, NOT_FOUND);
    return reply(200, pullFiles(repo, pull));
  }

  if (rest.length === 3 && rest[2] === 'merge') {
    if (pull === undefined) return error(404, NOT_FOUND);
    if (method === 'PUT') return mergePull(store, repo, pull);
    if (method === 'GET') return pull.merged ? { status: 204, body: null } : error(404, NOT_FOUND);
    return error(404, NOT_FOUND);
  }

  if (rest.length === 3 && rest[2] === 'commits' && method === 'GET') {
    if (pull === undefined) return error(404, NOT_FOUND);
    const head = commitOf(repo.objects, branchTip(repo, pull.head) ?? pull.headSha);
    if (head === null) return reply(200, []);
    return reply(200, commitList(repo.objects, [head], 20).map((oid) => commitJson(repo, oid)));
  }

  return error(404, NOT_FOUND);
}

/** The commit a ref value peels to, exported for the other surfaces. */
export function peelRef(repo: RepoRec, oid: string): string | null {
  return peel(repo.objects, oid);
}
