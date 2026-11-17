#!/usr/bin/env node
// tools/diff-forges.mjs -- the Go forge against the Node forge, byte for byte.
//
// The conformance suite judges answers by shape: a field it does not read can differ between two
// implementations and every check still passes. For a port that is not enough -- the Node forge is
// the thing that scored 120/120, so the Go forge should answer what it answers, down to the bytes.
//
// This starts both, replays one scripted sequence against each, and compares every status, every
// body and the headers that carry meaning. The sequence is fixed and ordered because both forges
// number ids from counters: the same requests in the same order must produce the same ids, which
// is also what the grader's replay check depends on.
//
// Only x-github-request-id is normalised, because it counts requests and the two runs make a
// different number of them before the comparison starts.
//
//   node tools/diff-forges.mjs            compare, print every difference
//   node tools/diff-forges.mjs --quiet    print only the summary

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const KIT = process.env.MAKEFUN_KIT ?? '/workspace/makefun/git-forge/kit/github-core-clone-01-kit';
const SRC = `${KIT}/program/env/src`;
const QUIET = process.argv.includes('--quiet');
const TOKEN = 'diff-token';
const BINARY = process.env.FORGE_BIN ?? `${REPO}/bin/forge`;

const { GitClient, CONFORMANCE_IDENTITY, ZERO_OID, buildCommit, buildTag, buildTree, hashObject, writePack } =
  await import(`${SRC}/git-client.ts`);

if (!existsSync(BINARY)) {
  process.stderr.write(`[diff] ${BINARY} is not there; run tools/build-go.sh\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- the two forges

function startEnvStub() {
  let entryPort = null;
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
        for (const r of waiters.splice(0)) r(entryPort);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"done":false}');
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      ready({
        url: `http://127.0.0.1:${server.address().port}`,
        waitForRegister: () => (entryPort !== null ? Promise.resolve(entryPort) : new Promise((r) => waiters.push(r))),
        close: () => server.close(),
      });
    });
  });
}

async function start(kind) {
  const env = await startEnvStub();
  const child = spawn(kind === 'go' ? BINARY : 'node', kind === 'go' ? [] : ['main.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      MAKEFUN_ENV_URL: env.url,
      MAKEFUN_SHOP_TOKEN: TOKEN,
      ...(kind === 'go' ? {} : { FORGE_NO_BINARY: '1' }),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const port = await Promise.race([
    env.waitForRegister(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${kind} never registered`)), 15_000)),
  ]);
  return {
    kind,
    base: `http://127.0.0.1:${port}`,
    stop() {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
      env.close();
    },
  };
}

// ---------------------------------------------------------------- the comparison

let compared = 0;
const differences = [];

function differ(label, field, go, node) {
  differences.push({ label, field, go, node });
  if (!QUIET) {
    process.stdout.write(`  DIFF  ${label} [${field}]\n          go:   ${String(go).slice(0, 400)}\n          node: ${String(node).slice(0, 400)}\n`);
  }
}

/** Each forge listens on its own port, so a header that echoes the origin needs it normalised. */
function normaliseOrigin(value, base) {
  return value.split(base).join('http://FORGE');
}

/** The headers worth comparing: the request id counts requests, so it is normalised away. */
const COMPARED_HEADERS = ['content-type', 'link', 'x-oauth-scopes', 'x-github-media-type', 'cache-control'];

function headerSnapshot(response, base) {
  const out = {};
  for (const name of COMPARED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) out[name] = normaliseOrigin(value, base);
  }
  out['x-github-request-id-present'] = (response.headers.get('x-github-request-id') ?? '') !== '' ? 'yes' : 'no';
  return out;
}

async function once(forge, step) {
  const headers = {};
  if (step.token !== null) headers.authorization = `Bearer ${step.token ?? TOKEN}`;
  if (step.body !== undefined) headers['content-type'] = 'application/json';
  for (const [name, value] of Object.entries(step.headers ?? {})) headers[name] = value;
  const response = await fetch(`${forge.base}${step.path}`, {
    method: step.method,
    headers,
    body: step.body === undefined ? undefined : typeof step.body === 'string' ? step.body : JSON.stringify(step.body),
  });
  return { status: response.status, headers: headerSnapshot(response, forge.base), text: normaliseOrigin(await response.text(), forge.base) };
}

/** Run one scripted request against both and compare everything. */
async function compare(label, step, go, node) {
  compared += 1;
  const [a, b] = [await once(go, step), await once(node, step)];
  if (a.status !== b.status) differ(label, 'status', a.status, b.status);
  if (a.text !== b.text) differ(label, 'body', a.text, b.text);
  const headerNames = new Set([...Object.keys(a.headers), ...Object.keys(b.headers)]);
  for (const name of headerNames) {
    if (a.headers[name] !== b.headers[name]) differ(label, `header ${name}`, a.headers[name], b.headers[name]);
  }
  return a;
}

// ---------------------------------------------------------------- the scripted sequence

/** A deterministic set of git objects, so both forges are pushed byte-identical packs. */
function fixture() {
  const blobA = Buffer.from('alpha\n', 'utf8');
  const blobB = Buffer.from('beta\n', 'utf8');
  const blobC = Buffer.from('gamma\n', 'utf8');
  const treeOne = buildTree([{ mode: '100644', name: 'a.txt', oid: hashObject('blob', blobA) }]);
  const commitOne = buildCommit({
    tree: hashObject('tree', treeOne),
    parents: [],
    message: 'one\n',
    author: CONFORMANCE_IDENTITY,
    committer: CONFORMANCE_IDENTITY,
    timestamp: 1_700_000_000,
  });
  const oidOne = hashObject('commit', commitOne);
  const treeTwo = buildTree([
    { mode: '100644', name: 'a.txt', oid: hashObject('blob', blobA) },
    { mode: '040000', name: 'dir', oid: hashObject('tree', buildTree([{ mode: '100644', name: 'b.txt', oid: hashObject('blob', blobB) }])) },
  ]);
  const subTree = buildTree([{ mode: '100644', name: 'b.txt', oid: hashObject('blob', blobB) }]);
  const commitTwo = buildCommit({
    tree: hashObject('tree', treeTwo),
    parents: [oidOne],
    message: 'two\n',
    author: CONFORMANCE_IDENTITY,
    committer: CONFORMANCE_IDENTITY,
    timestamp: 1_700_000_001,
  });
  const oidTwo = hashObject('commit', commitTwo);
  const treeFeature = buildTree([
    { mode: '100644', name: 'a.txt', oid: hashObject('blob', blobA) },
    { mode: '100644', name: 'c.txt', oid: hashObject('blob', blobC) },
  ]);
  const commitFeature = buildCommit({
    tree: hashObject('tree', treeFeature),
    parents: [oidOne],
    message: 'feature\n',
    author: CONFORMANCE_IDENTITY,
    committer: CONFORMANCE_IDENTITY,
    timestamp: 1_700_000_002,
  });
  const oidFeature = hashObject('commit', commitFeature);
  const tag = buildTag({ object: oidTwo, type: 'commit', tag: 'v1', tagger: `${CONFORMANCE_IDENTITY} 1700000003 +0000`, message: 'release one\n' });
  const oidTag = hashObject('tag', tag);
  return {
    oidOne,
    oidTwo,
    oidFeature,
    oidTag,
    packMain: writePack([
      { type: 'blob', data: blobA },
      { type: 'tree', data: treeOne },
      { type: 'commit', data: commitOne },
      { type: 'blob', data: blobB },
      { type: 'tree', data: subTree },
      { type: 'tree', data: treeTwo },
      { type: 'commit', data: commitTwo },
    ]),
    packFeature: writePack([
      { type: 'blob', data: blobC },
      { type: 'tree', data: treeFeature },
      { type: 'commit', data: commitFeature },
    ]),
    packTag: writePack([{ type: 'tag', data: tag }]),
  };
}

const FIX = fixture();

/** Every scripted REST / GraphQL / MCP request, in order. `owner` is filled in once it is known. */
function script(owner) {
  const repo = `/api/v3/repos/${owner}/diff-one`;
  const steps = [
    ['root', { method: 'GET', path: '/api/v3' }],
    ['meta', { method: 'GET', path: '/api/v3/meta', token: null }],
    ['rate-limit', { method: 'GET', path: '/api/v3/rate_limit' }],
    ['user', { method: 'GET', path: '/api/v3/user' }],
    ['user anon', { method: 'GET', path: '/api/v3/user', token: null }],
    ['healthz', { method: 'GET', path: '/healthz', token: null }],
    ['unknown route', { method: 'GET', path: '/api/v3/nope/nope' }],
    ['unknown top-level', { method: 'GET', path: '/nope' }],
    ['bad json', { method: 'POST', path: '/api/v3/user/repos', body: '{nope' }],

    ['create repo', { method: 'POST', path: '/api/v3/user/repos', body: { name: 'diff-one', description: 'a < b & c > d "quoted"', auto_init: true } }],
    ['create repo again', { method: 'POST', path: '/api/v3/user/repos', body: { name: 'diff-one' } }],
    ['create repo nameless', { method: 'POST', path: '/api/v3/user/repos', body: {} }],
    ['create repo private', { method: 'POST', path: '/api/v3/user/repos', body: { name: 'diff-two', private: true, default_branch: 'trunk' } }],
    ['get repo', { method: 'GET', path: repo }],
    ['get repo foreign', { method: 'GET', path: '/api/v3/repos/someone-else/diff-one' }],
    ['get repo missing', { method: 'GET', path: `/api/v3/repos/${owner}/ghost` }],
    ['patch repo', { method: 'PATCH', path: repo, body: { description: 'patched\nwith a newline\tand a tab' } }],
    ['list repos', { method: 'GET', path: '/api/v3/user/repos' }],
    ['list repos paged', { method: 'GET', path: '/api/v3/user/repos?per_page=1&page=2' }],
    ['list repos page 1', { method: 'GET', path: '/api/v3/user/repos?per_page=1' }],
    ['collaborators', { method: 'GET', path: `${repo}/collaborators` }],

    ['put contents', { method: 'PUT', path: `${repo}/contents/docs/readme.md`, body: { message: 'add', content: Buffer.from('# hi\nline two\n', 'utf8').toString('base64') } }],
    ['put contents again', { method: 'PUT', path: `${repo}/contents/docs/readme.md`, body: { message: 'update', content: Buffer.from('# hi again\n', 'utf8').toString('base64') } }],
    ['put contents utf8 encoding', { method: 'PUT', path: `${repo}/contents/plain.txt`, body: { message: 'plain', content: 'raw bytes\n', encoding: 'utf-8' } }],
    ['put contents bad sha', { method: 'PUT', path: `${repo}/contents/docs/readme.md`, body: { message: 'x', content: 'eA==', sha: 'f'.repeat(40) } }],
    ['get contents file', { method: 'GET', path: `${repo}/contents/docs/readme.md` }],
    ['get contents dir', { method: 'GET', path: `${repo}/contents/docs` }],
    ['get contents root', { method: 'GET', path: `${repo}/contents` }],
    ['get contents missing', { method: 'GET', path: `${repo}/contents/nope.md` }],
    ['delete contents', { method: 'DELETE', path: `${repo}/contents/plain.txt`, body: { message: 'drop' } }],
    ['delete contents missing', { method: 'DELETE', path: `${repo}/contents/plain.txt`, body: { message: 'drop' } }],

    ['branches', { method: 'GET', path: `${repo}/branches` }],
    ['branch main', { method: 'GET', path: `${repo}/branches/main` }],
    ['branch missing', { method: 'GET', path: `${repo}/branches/ghost` }],
    ['commits', { method: 'GET', path: `${repo}/commits` }],
    ['commits per_page', { method: 'GET', path: `${repo}/commits?per_page=2` }],

    ['create label', { method: 'POST', path: `${repo}/labels`, body: { name: 'bug', color: 'ff0000' } }],
    ['create label default colour', { method: 'POST', path: `${repo}/labels`, body: { name: 'docs' } }],
    ['create label again', { method: 'POST', path: `${repo}/labels`, body: { name: 'bug' } }],
    ['create label nameless', { method: 'POST', path: `${repo}/labels`, body: {} }],
    ['list labels', { method: 'GET', path: `${repo}/labels` }],
    ['get label', { method: 'GET', path: `${repo}/labels/bug` }],
    ['get label missing', { method: 'GET', path: `${repo}/labels/ghost` }],

    ['create issue', { method: 'POST', path: `${repo}/issues`, body: { title: 'first <&>', body: 'a body with "quotes" and a \\ backslash', labels: ['bug'] } }],
    ['create issue plain', { method: 'POST', path: `${repo}/issues`, body: { title: 'second' } }],
    ['create issue titleless', { method: 'POST', path: `${repo}/issues`, body: { body: 'x' } }],
    ['create issue bad label', { method: 'POST', path: `${repo}/issues`, body: { title: 'x', labels: ['ghost'] } }],
    ['get issue', { method: 'GET', path: `${repo}/issues/1` }],
    ['get issue missing', { method: 'GET', path: `${repo}/issues/99` }],
    ['get issue nonnumeric', { method: 'GET', path: `${repo}/issues/abc` }],
    ['patch issue', { method: 'PATCH', path: `${repo}/issues/2`, body: { state: 'closed', title: 'second, closed' } }],
    ['add labels', { method: 'POST', path: `${repo}/issues/1/labels`, body: { labels: ['docs'] } }],
    ['comment', { method: 'POST', path: `${repo}/issues/1/comments`, body: { body: 'a comment' } }],
    ['comments', { method: 'GET', path: `${repo}/issues/1/comments` }],
    ['list issues', { method: 'GET', path: `${repo}/issues` }],
    ['list issues all asc', { method: 'GET', path: `${repo}/issues?state=all&direction=asc` }],
    ['list issues closed', { method: 'GET', path: `${repo}/issues?state=closed` }],
    ['list issues paged', { method: 'GET', path: `${repo}/issues?state=all&per_page=1&page=2` }],
  ];
  return steps.map(([label, step]) => [label, { token: undefined, ...step }]);
}

function graphqlScript(owner, repoId, issueId) {
  const q = (label, query, variables) => [label, { method: 'POST', path: '/api/graphql', body: { query, variables } }];
  return [
    q('gql viewer', '{ viewer { login databaseId id name email url avatarUrl } }'),
    q('gql repository', `{ repository(owner: "${owner}", name: "diff-one") { id databaseId name nameWithOwner description url isPrivate viewerPermission hasIssuesEnabled defaultBranchRef { name prefix target { oid } } } }`),
    q('gql repository missing', `{ repository(owner: "${owner}", name: "ghost") { name } }`),
    q('gql issues', `{ repository(owner: "${owner}", name: "diff-one") { issues(first: 10) { totalCount nodes { number title state closed labels { totalCount nodes { name color } } comments { totalCount nodes { body } } } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } edges { cursor node { number } } } } }`),
    q('gql issues desc', `{ repository(owner: "${owner}", name: "diff-one") { issues(first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { number } pageInfo { endCursor } } } }`),
    q('gql issues states', `{ repository(owner: "${owner}", name: "diff-one") { issues(states: [CLOSED]) { totalCount nodes { number } } } }`),
    q('gql issue by number', `{ repository(owner: "${owner}", name: "diff-one") { issue(number: 1) { title bodyText author { login } repository { name } assignees { totalCount } milestone } } }`),
    q('gql pulls', `{ repository(owner: "${owner}", name: "diff-one") { pullRequests(first: 5) { totalCount nodes { number title state merged mergeable headRefName baseRefName headRefOid baseRefOid isDraft files(first: 5) { totalCount nodes { path additions deletions changeType } pageInfo { hasNextPage endCursor } } } } } }`),
    q('gql labels + ref', `{ repository(owner: "${owner}", name: "diff-one") { labels { totalCount nodes { name } } ref(qualifiedName: "refs/heads/main") { name target { oid } } } }`),
    q('gql ref missing', `{ repository(owner: "${owner}", name: "diff-one") { ref(qualifiedName: "refs/heads/ghost") { name } } }`),
    q('gql node repository', `{ node(id: "${repoId}") { __typename ... on Repository { name databaseId } } }`),
    q('gql node issue', `{ node(id: "${issueId}") { __typename ... on Issue { number title } } }`),
    q('gql node junk', '{ node(id: "bm90LWFuLWlk") { __typename } }'),
    q('gql nodes', `{ nodes(ids: ["${repoId}", "${issueId}"]) { __typename } }`),
    q('gql aliases', '{ a: viewer { l: login }, b: viewer { databaseId } __typename }'),
    q('gql fragment', `{ repository(owner: "${owner}", name: "diff-one") { ...R } } fragment R on Repository { name databaseId }`),
    q('gql fragment wrong type', `{ repository(owner: "${owner}", name: "diff-one") { ...I } } fragment I on Issue { number }`),
    q('gql variables', 'query R($o: String!, $n: String!, $f: Int) { repository(owner: $o, name: $n) { issues(first: $f) { totalCount nodes { number } } } }', { o: owner, n: 'diff-one', f: 1 }),
    q('gql unknown field', '{ viewer { nope } }'),
    q('gql parse error', '{ viewer { '),
    q('gql empty query', ''),
    q('gql rate limit', '{ rateLimit { limit remaining cost resetAt } }'),
    q('gql introspect type', '{ __type(name: "Repository") { name kind description fields { name isDeprecated } interfaces possibleTypes } }'),
    q('gql introspect enum', '{ __type(name: "PullRequestState") { name kind enumValues { name } fields { name } } }'),
    q('gql introspect input', '{ __type(name: "CreateIssueInput") { name kind inputFields { name } } }'),
    q('gql introspect missing', '{ __type(name: "Nope") { name } }'),
    q('gql schema', '{ __schema { queryType { name } mutationType { name } types { name } directives } }'),
    ['gql batch', { method: 'POST', path: '/api/graphql', body: [{ query: '{ viewer { login } }' }, { query: '{ viewer { databaseId } }' }, { query: '{ viewer { nope } }' }] }],
    ['gql anon', { method: 'POST', path: '/api/graphql', body: { query: '{ viewer { login } }' }, token: null }],
    ['gql get', { method: 'GET', path: '/api/graphql' }],
    ['gql bad json', { method: 'POST', path: '/api/graphql', body: '{nope' }],
  ].map(([label, step]) => [label, { token: undefined, ...step }]);
}

function mcpScript(owner) {
  const rpc = (label, message) => [label, { method: 'POST', path: '/mcp', body: message }];
  return [
    rpc('mcp discover', { jsonrpc: '2.0', id: 1, method: 'server/discover' }),
    rpc('mcp initialize', { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    rpc('mcp initialize unknown version', { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '1999-01-01' } }),
    rpc('mcp initialize no params', { jsonrpc: '2.0', id: 4, method: 'initialize' }),
    rpc('mcp ping', { jsonrpc: '2.0', id: 5, method: 'ping' }),
    rpc('mcp tools/list', { jsonrpc: '2.0', id: 6, method: 'tools/list' }),
    rpc('mcp tools/list again', { jsonrpc: '2.0', id: 'str-id', method: 'tools/list' }),
    rpc('mcp resources/list', { jsonrpc: '2.0', id: 7, method: 'resources/list' }),
    rpc('mcp prompts/list', { jsonrpc: '2.0', id: 8, method: 'prompts/list' }),
    rpc('mcp unknown method', { jsonrpc: '2.0', id: 9, method: 'nope/nope' }),
    rpc('mcp get_repo', { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'get_repo', arguments: { owner, repo: 'diff-one' } } }),
    rpc('mcp get_repo full_name', { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_repo', arguments: { full_name: `${owner}/diff-one` } } }),
    rpc('mcp get_repo missing', { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'get_repo', arguments: { owner, repo: 'ghost' } } }),
    rpc('mcp get_repo no args', { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'get_repo', arguments: {} } }),
    rpc('mcp create_repo', { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'diff-mcp', description: 'from mcp' } } }),
    rpc('mcp create_repo again', { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'diff-mcp' } } }),
    rpc('mcp create_issue', { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'create_issue', arguments: { owner, repo: 'diff-one', title: 'mcp issue', body: 'b' } } }),
    rpc('mcp create_issue prefixed name', { jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'github.create_issue', arguments: { owner, repo: 'diff-one', title: 'prefixed' } } }),
    rpc('mcp list_issues', { jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'list_issues', arguments: { owner, repo: 'diff-one', state: 'all' } } }),
    rpc('mcp unknown tool', { jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'nope', arguments: {} } }),
    rpc('mcp merge missing pull', { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'merge_pull_request', arguments: { owner, repo: 'diff-one', pull_number: 99 } } }),
    rpc('mcp merge no number', { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'merge_pull_request', arguments: { owner, repo: 'diff-one' } } }),
    rpc('mcp notification', { jsonrpc: '2.0', method: 'notifications/initialized' }),
    rpc('mcp batch', [{ jsonrpc: '2.0', id: 22, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 23, method: 'tools/list' }]),
    rpc('mcp invalid request', 'not-an-object'),
    ['mcp bad json', { method: 'POST', path: '/mcp', body: '{nope' }],
    ['mcp anon', { method: 'POST', path: '/mcp', body: { jsonrpc: '2.0', id: 24, method: 'ping' }, token: null }],
    ['mcp get', { method: 'GET', path: '/mcp' }],
    ['mcp put', { method: 'PUT', path: '/mcp', body: { jsonrpc: '2.0', id: 25, method: 'ping' } }],
  ].map(([label, step]) => [label, { token: undefined, ...step }]);
}

// ---------------------------------------------------------------- git, through the suite's client

/** Push the same bytes to both forges and compare the report, then the advertisements. */
async function compareGit(go, node, owner) {
  const clients = { go: new GitClient({ baseUrl: go.base, token: TOKEN, timeoutMs: 20_000 }), node: new GitClient({ baseUrl: node.base, token: TOKEN, timeoutMs: 20_000 }) };

  const both = async (label, run) => {
    compared += 1;
    const [a, b] = [await run(clients.go), await run(clients.node)];
    const [sa, sb] = [JSON.stringify(a), JSON.stringify(b)];
    if (sa !== sb) differ(label, 'result', sa, sb);
    return a;
  };

  // Raw bytes, so the advertisement and the pack are compared as the wire carries them.
  const raw = async (label, path, init) => {
    compared += 1;
    const fetchOne = async (forge) => {
      const response = await fetch(`${forge.base}${path}`, {
        method: init?.method ?? 'GET',
        headers: { authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
        body: init?.body,
      });
      return { status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), body: Buffer.from(await response.arrayBuffer()).toString('base64') };
    };
    const [a, b] = [await fetchOne(go), await fetchOne(node)];
    if (a.status !== b.status) differ(label, 'status', a.status, b.status);
    if (a.type !== b.type) differ(label, 'content-type', a.type, b.type);
    if (a.cache !== b.cache) differ(label, 'cache-control', a.cache, b.cache);
    if (a.body !== b.body) {
      differ(label, 'body bytes', Buffer.from(a.body, 'base64').toString('latin1').slice(0, 300), Buffer.from(b.body, 'base64').toString('latin1').slice(0, 300));
    }
    return a;
  };

  await both('git createRepo', (client) => client.createRepo(owner, 'diff-git').then(() => 'created'));

  await raw('git info/refs upload (empty, v2)', `/${owner}/diff-git.git/info/refs?service=git-upload-pack`, { headers: { 'git-protocol': 'version=2' } });
  await raw('git info/refs upload (empty, v0)', `/${owner}/diff-git.git/info/refs?service=git-upload-pack`);
  await raw('git info/refs receive (empty)', `/${owner}/diff-git.git/info/refs?service=git-receive-pack`);
  await raw('git info/refs no service', `/${owner}/diff-git.git/info/refs`);
  await raw('git info/refs missing repo', `/${owner}/ghost.git/info/refs?service=git-upload-pack`);
  await raw('git info/refs post', `/${owner}/diff-git.git/info/refs?service=git-upload-pack`, { method: 'POST', body: Buffer.alloc(0) });

  await both('git push main', (client) =>
    client.push(owner, 'diff-git', [{ oldOid: ZERO_OID, newOid: FIX.oidTwo, ref: 'refs/heads/main' }], { pack: FIX.packMain }).then((r) => r.report),
  );
  await both('git push feature', (client) =>
    client.push(owner, 'diff-git', [{ oldOid: ZERO_OID, newOid: FIX.oidFeature, ref: 'refs/heads/feature' }], { pack: FIX.packFeature }).then((r) => r.report),
  );
  await both('git push tag', (client) =>
    client.push(owner, 'diff-git', [{ oldOid: ZERO_OID, newOid: FIX.oidTag, ref: 'refs/tags/v1' }], { pack: FIX.packTag }).then((r) => r.report),
  );
  await both('git push non-fast-forward', (client) =>
    client.push(owner, 'diff-git', [{ oldOid: FIX.oidTwo, newOid: FIX.oidOne, ref: 'refs/heads/main' }], { pack: writePack([]) }).then((r) => r.report),
  );
  await both('git push missing object', (client) =>
    client.push(owner, 'diff-git', [{ oldOid: ZERO_OID, newOid: 'a'.repeat(40), ref: 'refs/heads/absent' }], { pack: writePack([]) }).then((r) => r.report),
  );
  await both('git push delete missing', (client) =>
    client.push(owner, 'diff-git', [{ oldOid: ZERO_OID, newOid: ZERO_OID, ref: 'refs/heads/ghost' }], { pack: writePack([]) }).then((r) => r.report),
  );
  await both('git push mixed', (client) =>
    client
      .push(
        owner,
        'diff-git',
        [
          { oldOid: FIX.oidOne, newOid: FIX.oidOne, ref: 'refs/heads/main' },
          { oldOid: ZERO_OID, newOid: FIX.oidTwo, ref: 'refs/heads/extra' },
        ],
        { pack: writePack([]) },
      )
      .then((r) => r.report),
  );

  await raw('git info/refs upload (populated, v0)', `/${owner}/diff-git.git/info/refs?service=git-upload-pack`);
  await raw('git info/refs receive (populated)', `/${owner}/diff-git.git/info/refs?service=git-receive-pack`);

  await both('git ls-refs', (client) => client.lsRefs(owner, 'diff-git', { peel: true, symrefs: true, unborn: true }).then((r) => ({ refs: r.rawRefs, head: r.headSymref })));
  await both('git ls-refs prefix heads', (client) => client.lsRefs(owner, 'diff-git', { prefixes: ['refs/heads/'] }).then((r) => r.rawRefs));
  await both('git ls-refs prefix tags', (client) => client.lsRefs(owner, 'diff-git', { prefixes: ['refs/tags/'] }).then((r) => r.rawRefs));
  await both('git ls-refs no peel', (client) => client.lsRefs(owner, 'diff-git', { peel: false, symrefs: false, unborn: false }).then((r) => r.rawRefs));

  const describeFetch = (r) => ({
    objects: [...r.objects.keys()].sort(),
    shallow: [...r.shallow].sort(),
    unshallow: [...r.unshallow].sort(),
    checksumOk: r.checksumOk,
    nak: r.nak,
    deltaCount: r.deltaCount,
  });
  await both('git fetch all', (client) => client.fetch(owner, 'diff-git', { wants: [FIX.oidTwo, FIX.oidFeature], done: true }).then(describeFetch));
  await both('git fetch depth 1', (client) => client.fetch(owner, 'diff-git', { wants: [FIX.oidTwo], depth: 1, done: true }).then(describeFetch));
  await both('git fetch depth 2', (client) => client.fetch(owner, 'diff-git', { wants: [FIX.oidTwo], depth: 2, done: true }).then(describeFetch));
  await both('git fetch deepen from shallow', (client) =>
    client.fetch(owner, 'diff-git', { wants: [FIX.oidTwo], depth: 2, shallow: [FIX.oidTwo], done: true }).then(describeFetch),
  );
  await both('git fetch with have', (client) => client.fetch(owner, 'diff-git', { wants: [FIX.oidTwo], haves: [FIX.oidOne], done: true }).then(describeFetch));
  await both('git fetch tag want', (client) => client.fetch(owner, 'diff-git', { wants: [FIX.oidTag], done: true }).then(describeFetch));
  await both('git clone depth 1', (client) => client.clone(owner, 'diff-git', { depth: 1, singleBranch: true }).then((r) => ({ ok: r.checksumOk, refs: r.refs?.map((x) => x.name).sort() })));

  await raw('git upload-pack garbage', `/${owner}/diff-git.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: Buffer.from('zzzz not pkt-lines'),
  });
  await raw('git upload-pack no want', `/${owner}/diff-git.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: Buffer.from('0014command=fetch\n0000'),
  });
  await raw('git receive-pack garbage', `/${owner}/diff-git.git/git-receive-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: Buffer.from('zzzz'),
  });
  await raw('git receive-pack broken pack', `/${owner}/diff-git.git/git-receive-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: Buffer.concat([
      Buffer.from(`00a7${ZERO_OID} ${FIX.oidOne} refs/heads/broken\0report-status side-band-64k\n`),
      Buffer.from('0000'),
      Buffer.from('PACK' + '\x00'.repeat(40)),
    ]),
  });
  await raw('git not this surface', `/${owner}/diff-git/info/refs?service=git-upload-pack`);
}

// ---------------------------------------------------------------- the pull-request tail

function pullScript(owner) {
  const repo = `/api/v3/repos/${owner}/diff-git`;
  return [
    ['create pull', { method: 'POST', path: `${repo}/pulls`, body: { title: 'a pull', body: 'please merge', head: 'feature', base: 'main' } }],
    ['create pull qualified head', { method: 'POST', path: `${repo}/pulls`, body: { title: 'qualified', head: `${owner}:feature`, base: 'main' } }],
    ['create pull bad head', { method: 'POST', path: `${repo}/pulls`, body: { title: 'x', head: 'ghost', base: 'main' } }],
    ['create pull bad base', { method: 'POST', path: `${repo}/pulls`, body: { title: 'x', head: 'feature', base: 'ghost' } }],
    ['get pull', { method: 'GET', path: `${repo}/pulls/1` }],
    ['get pull missing', { method: 'GET', path: `${repo}/pulls/99` }],
    ['list pulls', { method: 'GET', path: `${repo}/pulls` }],
    ['list pulls all', { method: 'GET', path: `${repo}/pulls?state=all` }],
    ['pull files', { method: 'GET', path: `${repo}/pulls/1/files` }],
    ['pull commits', { method: 'GET', path: `${repo}/pulls/1/commits` }],
    ['pull merge check before', { method: 'GET', path: `${repo}/pulls/1/merge` }],
    ['patch pull', { method: 'PATCH', path: `${repo}/pulls/2`, body: { title: 'qualified, retitled', state: 'closed' } }],
    ['merge pull', { method: 'PUT', path: `${repo}/pulls/1/merge`, body: {} }],
    ['merge pull again', { method: 'PUT', path: `${repo}/pulls/1/merge`, body: {} }],
    ['merge closed pull', { method: 'PUT', path: `${repo}/pulls/2/merge`, body: {} }],
    ['pull merge check after', { method: 'GET', path: `${repo}/pulls/1/merge` }],
    ['get pull after merge', { method: 'GET', path: `${repo}/pulls/1` }],
    ['branches after merge', { method: 'GET', path: `${repo}/branches` }],
    ['git refs get', { method: 'GET', path: `${repo}/git/refs/heads/main` }],
    ['git refs get missing', { method: 'GET', path: `${repo}/git/refs/heads/ghost` }],
    ['git refs create', { method: 'POST', path: `${repo}/git/refs`, body: { ref: 'refs/heads/made', sha: FIX.oidOne } }],
    ['git refs create again', { method: 'POST', path: `${repo}/git/refs`, body: { ref: 'refs/heads/made', sha: FIX.oidOne } }],
    ['git refs create bad name', { method: 'POST', path: `${repo}/git/refs`, body: { ref: 'nope', sha: FIX.oidOne } }],
    ['git refs create bad sha', { method: 'POST', path: `${repo}/git/refs`, body: { ref: 'refs/heads/other', sha: 'z'.repeat(40) } }],
    ['git refs delete', { method: 'DELETE', path: `${repo}/git/refs/heads/made` }],
    ['git refs delete again', { method: 'DELETE', path: `${repo}/git/refs/heads/made` }],
    ['git commit object', { method: 'GET', path: `${repo}/git/commits/${FIX.oidOne}` }],
    ['git commit object missing', { method: 'GET', path: `${repo}/git/commits/${'0'.repeat(40)}` }],
    ['git tag ref', { method: 'GET', path: `${repo}/git/refs/tags/v1` }],
    ['commits by sha', { method: 'GET', path: `${repo}/commits/${FIX.oidOne}` }],
    ['commits by branch', { method: 'GET', path: `${repo}/commits/feature` }],
    ['commits by tag', { method: 'GET', path: `${repo}/commits/v1` }],
    ['commits missing', { method: 'GET', path: `${repo}/commits/nope` }],
    ['delete repo', { method: 'DELETE', path: `/api/v3/repos/${owner}/diff-two` }],
    ['delete repo again', { method: 'DELETE', path: `/api/v3/repos/${owner}/diff-two` }],
    ['list repos at the end', { method: 'GET', path: '/api/v3/user/repos?per_page=100' }],
  ].map(([label, step]) => [label, { token: undefined, ...step }]);
}

// ---------------------------------------------------------------- run

const go = await start('go');
const node = await start('node');
process.stdout.write(`[diff] go on ${go.base}, node on ${node.base}\n`);

try {
  const user = await compare('viewer login', { method: 'GET', path: '/api/v3/user' }, go, node);
  const owner = JSON.parse(user.text).login;

  for (const [label, step] of script(owner)) await compare(label, step, go, node);

  // The ids the node queries need, read from the Go forge (they must be equal, and the
  // 'gql repository'/'gql issue' comparisons above would have caught it if they were not).
  const repoProbe = await compare(
    'repo global id',
    { method: 'POST', path: '/api/graphql', body: { query: `{ repository(owner: "${owner}", name: "diff-one") { id issue(number: 1) { id } } }` } },
    go,
    node,
  );
  const probe = JSON.parse(repoProbe.text).data.repository;

  for (const [label, step] of graphqlScript(owner, probe.id, probe.issue.id)) await compare(label, step, go, node);
  for (const [label, step] of mcpScript(owner)) await compare(label, step, go, node);

  await compareGit(go, node, owner);
  for (const [label, step] of pullScript(owner)) await compare(label, step, go, node);

  // Mutations through GraphQL last, so the ids they consume are the same on both sides.
  for (const [label, step] of [
    ['gql createIssue', { method: 'POST', path: '/api/graphql', body: { query: `mutation { createIssue(input: { repositoryId: "${probe.id}", title: "from graphql", body: "b" }) { issue { number title body } } }` } }],
    ['gql createIssue bad repo', { method: 'POST', path: '/api/graphql', body: { query: 'mutation { createIssue(input: { repositoryId: "bm9wZQ==", title: "x" }) { issue { number } } }' } }],
    ['gql closeIssue', { method: 'POST', path: '/api/graphql', body: { query: `mutation { closeIssue(input: { issueId: "${probe.issue.id}" }) { issue { number state closed } } }` } }],
    ['gql reopenIssue', { method: 'POST', path: '/api/graphql', body: { query: `mutation { reopenIssue(input: { issueId: "${probe.issue.id}" }) { issue { number state } } }` } }],
    ['gql closeIssue bad id', { method: 'POST', path: '/api/graphql', body: { query: 'mutation { closeIssue(input: { issueId: "bm9wZQ==" }) { issue { number } } }' } }],
    ['gql addComment', { method: 'POST', path: '/api/graphql', body: { query: `mutation { addComment(input: { subjectId: "${probe.issue.id}", body: "from graphql" }) { commentEdge { cursor node { body } } subject { __typename } } }` } }],
    ['gql createPullRequest bad', { method: 'POST', path: '/api/graphql', body: { query: `mutation { createPullRequest(input: { repositoryId: "${probe.id}", headRefName: "ghost", baseRefName: "main", title: "x" }) { pullRequest { number } } }` } }],
    ['issue after mutations', { method: 'GET', path: `/api/v3/repos/${owner}/diff-one/issues/1` }],
    ['issues after mutations', { method: 'GET', path: `/api/v3/repos/${owner}/diff-one/issues?state=all` }],
  ]) {
    await compare(label, { token: undefined, ...step }, go, node);
  }
} catch (err) {
  differences.push({ label: 'harness', field: 'threw', go: String(err), node: '' });
  process.stdout.write(`  DIFF  harness threw ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
} finally {
  go.stop();
  node.stop();
}

process.stdout.write(`\n[diff] ${compared} comparisons, ${differences.length} difference(s)\n`);
process.exit(differences.length === 0 ? 0 : 1);
