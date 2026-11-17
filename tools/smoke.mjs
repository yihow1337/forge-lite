#!/usr/bin/env node
// tools/smoke.mjs -- a fast sanity pass over one forge, before the grader's 120 checks.
//
// It starts the binary (or `node main.ts` with --node), waits for the register, and walks the four
// surfaces: REST, GraphQL, MCP and git smart HTTP, including a push and a depth-1 clone through the
// suite's own GitClient. Every assertion prints a line; a failure exits non-zero.
//
//   node tools/smoke.mjs              the committed bin/forge
//   node tools/smoke.mjs --node       the Node forge, for an A/B of the same assertions
//   FORGE_BIN=/tmp/forge node tools/smoke.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const KIT = process.env.MAKEFUN_KIT ?? '/workspace/makefun/git-forge/kit/github-core-clone-01-kit';
const SRC = `${KIT}/program/env/src`;

const { GitClient, CONFORMANCE_IDENTITY, ZERO_OID, buildCommit, buildTree, hashObject, writePack } =
  await import(`${SRC}/git-client.ts`);

const TOKEN = 'smoke-token';
const USE_NODE = process.argv.includes('--node');

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    process.stdout.write(`  ok    ${name}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}${detail === '' ? '' : ` -- ${detail}`}\n`);
  }
}

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
        for (const resolveOne of waiters.splice(0)) resolveOne(entryPort);
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

const env = await startEnvStub();
const command = USE_NODE ? 'node' : (process.env.FORGE_BIN ?? `${REPO}/bin/forge`);
const args = USE_NODE ? ['main.ts'] : [];
const child = spawn(command, args, {
  cwd: REPO,
  env: { ...process.env, MAKEFUN_ENV_URL: env.url, MAKEFUN_SHOP_TOKEN: TOKEN },
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.on('error', (err) => {
  process.stderr.write(`[smoke] could not start ${command}: ${err.message}\n`);
  process.exit(1);
});

const port = await Promise.race([
  env.waitForRegister(),
  new Promise((_, reject) => setTimeout(() => reject(new Error('no register in 10 s')), 10_000)),
]);
const base = `http://127.0.0.1:${port}`;
process.stdout.write(`[smoke] ${USE_NODE ? 'node main.ts' : command} on ${base}\n`);

async function api(method, path, body, token = TOKEN) {
  const headers = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // left null; the caller checks what it needs
  }
  return { status: res.status, headers: res.headers, text, json };
}

try {
  // ------------------------------------------------------------------ lifecycle and REST
  const health = await api('GET', '/healthz', undefined, null);
  check('healthz', health.status === 200 && health.json?.ok === true, health.text);

  const anon = await api('GET', '/api/v3/user', undefined, null);
  check('401 without a token', anon.status === 401 && typeof anon.json?.message === 'string', anon.text);

  const user = await api('GET', '/api/v3/user');
  check('GET /user', user.status === 200 && typeof user.json?.login === 'string', user.text);
  const owner = user.json.login;

  check('x-github-request-id', (user.headers.get('x-github-request-id') ?? '') !== '', 'missing');

  const created = await api('POST', '/api/v3/user/repos', { name: 'smoke-one', auto_init: true });
  check('POST /user/repos', created.status === 201 && created.json?.name === 'smoke-one', created.text);

  const dupe = await api('POST', '/api/v3/user/repos', { name: 'smoke-one' });
  check('duplicate repo is 422', dupe.status === 422, dupe.text);

  const put = await api('PUT', `/api/v3/repos/${owner}/smoke-one/contents/docs/readme.md`, {
    message: 'add readme',
    content: Buffer.from('# hello\n', 'utf8').toString('base64'),
  });
  check('PUT contents creates (201)', put.status === 201 && /^[0-9a-f]{40}$/.test(put.json?.commit?.sha ?? ''), put.text);

  const putAgain = await api('PUT', `/api/v3/repos/${owner}/smoke-one/contents/docs/readme.md`, {
    message: 'update readme',
    content: Buffer.from('# hello again\n', 'utf8').toString('base64'),
    sha: put.json.content.sha,
  });
  check('PUT contents updates (200)', putAgain.status === 200, putAgain.text);

  const getContents = await api('GET', `/api/v3/repos/${owner}/smoke-one/contents/docs/readme.md`);
  check(
    'GET contents round-trips',
    getContents.status === 200 && Buffer.from(getContents.json?.content ?? '', 'base64').toString('utf8') === '# hello again\n',
    getContents.text,
  );

  const dir = await api('GET', `/api/v3/repos/${owner}/smoke-one/contents/docs`);
  check('GET contents lists a directory', dir.status === 200 && Array.isArray(dir.json) && dir.json[0]?.name === 'readme.md', dir.text);

  const label = await api('POST', `/api/v3/repos/${owner}/smoke-one/labels`, { name: 'bug', color: 'ff0000' });
  check('POST labels', label.status === 201 && label.json?.name === 'bug', label.text);

  const issue = await api('POST', `/api/v3/repos/${owner}/smoke-one/issues`, { title: 'first', body: 'b', labels: ['bug'] });
  check('POST issues', issue.status === 201 && issue.json?.number === 1 && issue.json?.labels?.[0]?.name === 'bug', issue.text);

  const badLabel = await api('POST', `/api/v3/repos/${owner}/smoke-one/issues`, { title: 'nope', labels: ['ghost'] });
  check('unknown label is 422', badLabel.status === 422, badLabel.text);

  const readIssue = await api('GET', `/api/v3/repos/${owner}/smoke-one/issues/1`);
  check('GET issue', readIssue.status === 200 && readIssue.json?.title === 'first', readIssue.text);

  const patched = await api('PATCH', `/api/v3/repos/${owner}/smoke-one/issues/1`, { state: 'closed' });
  check('PATCH issue closes', patched.status === 200 && patched.json?.state === 'closed', patched.text);

  const comment = await api('POST', `/api/v3/repos/${owner}/smoke-one/issues/1/comments`, { body: 'hi' });
  check('POST comment', comment.status === 201 && comment.json?.body === 'hi', comment.text);

  const foreign = await api('GET', '/api/v3/repos/someone-else/smoke-one');
  check('foreign owner is 404', foreign.status === 404, foreign.text);

  const malformed = await fetch(`${base}/api/v3/repos/${owner}/smoke-one/issues`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{not json',
  });
  check('malformed body is 400', malformed.status === 400, String(malformed.status));

  const unknown = await api('GET', '/api/v3/nope/nope');
  check('unknown route is a JSON 404', unknown.status === 404 && typeof unknown.json?.message === 'string', unknown.text);

  // 30 repositories, then the pagination header.
  for (let index = 0; index < 12; index += 1) await api('POST', '/api/v3/user/repos', { name: `smoke-page-${index}` });
  const paged = await api('GET', '/api/v3/user/repos?per_page=10');
  check(
    'per_page=10 pages and links',
    paged.status === 200 && paged.json?.length === 10 && (paged.headers.get('link') ?? '').includes('rel="next"'),
    `${paged.json?.length} ${paged.headers.get('link')}`,
  );

  // ------------------------------------------------------------------ GraphQL
  async function graphql(query, variables) {
    const res = await api('POST', '/api/graphql', { query, variables });
    return res;
  }
  const viewer = await graphql('{ viewer { login databaseId } }');
  check('graphql viewer', viewer.status === 200 && viewer.json?.data?.viewer?.login === owner, viewer.text);

  const repoQuery = await graphql(
    'query R($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id name nameWithOwner viewerPermission issues(first: 5) { totalCount nodes { number title } } } }',
    { owner, name: 'smoke-one' },
  );
  const repoNode = repoQuery.json?.data?.repository;
  check(
    'graphql repository + issues',
    repoQuery.status === 200 && repoNode?.nameWithOwner === `${owner}/smoke-one` && repoNode?.issues?.totalCount === 1,
    repoQuery.text,
  );

  const aliased = await graphql('{ a: viewer { l: login } __typename }');
  check('graphql aliases', aliased.json?.data?.a?.l === owner, aliased.text);

  const fragment = await graphql('{ repository(owner: "' + owner + '", name: "smoke-one") { ...R } } fragment R on Repository { name databaseId }');
  check('graphql fragments', fragment.json?.data?.repository?.name === 'smoke-one', fragment.text);

  const unknownField = await graphql('{ viewer { nope } }');
  check('graphql unknown field errors with HTTP 200', unknownField.status === 200 && Array.isArray(unknownField.json?.errors), unknownField.text);

  const missingRepo = await graphql(`{ repository(owner: "${owner}", name: "ghost") { name } }`);
  check('graphql unknown repository is null', missingRepo.json?.data?.repository === null, missingRepo.text);

  const introspect = await graphql('{ __type(name: "Repository") { name kind fields { name } } }');
  check('graphql introspection', (introspect.json?.data?.__type?.fields ?? []).some((f) => f.name === 'issues'), introspect.text);

  const batch = await api('POST', '/api/graphql', [{ query: '{ viewer { login } }' }, { query: '{ viewer { databaseId } }' }]);
  check('graphql batching', Array.isArray(batch.json) && batch.json.length === 2 && batch.json[0]?.data?.viewer?.login === owner, batch.text);

  const mutation = await graphql(
    'mutation M($id: ID!) { createIssue(input: { repositoryId: $id, title: "from graphql" }) { issue { number title } } }',
    { id: repoNode.id },
  );
  check('graphql createIssue', mutation.json?.data?.createIssue?.issue?.title === 'from graphql', mutation.text);

  const anonGraphql = await api('POST', '/api/graphql', { query: '{ viewer { login } }' }, null);
  check('graphql 401 without a token', anonGraphql.status === 401, anonGraphql.text);

  // ------------------------------------------------------------------ MCP
  async function rpc(body, token = TOKEN) {
    return api('POST', '/mcp', body, token);
  }
  const discover = await rpc({ jsonrpc: '2.0', id: 1, method: 'server/discover' });
  check(
    'mcp server/discover',
    discover.json?.result?.supportedVersions?.includes('2026-07-28') && discover.json?.result?.capabilities?.tools !== undefined,
    discover.text,
  );

  const init = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  check('mcp initialize', init.json?.result?.protocolVersion === '2025-06-18' && init.json?.result?.serverInfo?.name !== undefined, init.text);

  const list1 = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const list2 = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  check('mcp tools/list is frozen', JSON.stringify(list1.json.result) === JSON.stringify(list2.json.result), 'two calls differ');
  check('mcp tools/list has the six tools', list1.json?.result?.tools?.length === 6, list1.text);

  const call = await rpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'create_issue', arguments: { owner, repo: 'smoke-one', title: 'from mcp' } },
  });
  check('mcp tools/call create_issue', (call.json?.result?.content?.[0]?.text ?? '').includes('from mcp'), call.text);

  const missingArgs = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'create_issue', arguments: {} } });
  check('mcp missing args is isError', missingArgs.json?.result?.isError === true, missingArgs.text);

  const unknownTool = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  check('mcp unknown tool is -32602', unknownTool.json?.error?.code === -32602, unknownTool.text);

  const badRpc = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: 'not json',
  });
  const badRpcBody = await badRpc.json();
  check('mcp non-JSON is 400 / -32700', badRpc.status === 400 && badRpcBody?.error?.code === -32700, JSON.stringify(badRpcBody));

  const anonRpc = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, null);
  check('mcp 401 without a token', anonRpc.status === 401, anonRpc.text);

  const notification = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  check('mcp notification is 202 with no body', notification.status === 202 && notification.text === '', `${notification.status} ${notification.text}`);

  // ------------------------------------------------------------------ git smart HTTP
  const git = new GitClient({ baseUrl: base, token: TOKEN, timeoutMs: 10_000 });
  await git.createRepo(owner, 'smoke-git');

  const v2 = await git.advertisement(owner, 'smoke-git', 'git-upload-pack');
  check('info/refs advertises v2', v2.protocol === 2 && v2.capabilities.has('ls-refs'), JSON.stringify([...v2.capabilities.keys()]));
  const v0 = await git.advertisement(owner, 'smoke-git', 'git-receive-pack');
  check(
    'receive-pack advertises v0 caps',
    v0.protocol === 0 && v0.capabilities.has('report-status') && v0.capabilities.has('delete-refs') && v0.capabilities.has('side-band-64k'),
    JSON.stringify([...v0.capabilities.keys()]),
  );

  // A first push: blob, tree, commit.
  const blob = Buffer.from('smoke\n', 'utf8');
  const blobOid = hashObject('blob', blob);
  const tree = buildTree([{ mode: '100644', name: 'smoke.txt', oid: blobOid }]);
  const treeOid = hashObject('tree', tree);
  const commit = buildCommit({
    tree: treeOid,
    parents: [],
    message: 'smoke: one\n',
    author: CONFORMANCE_IDENTITY,
    committer: CONFORMANCE_IDENTITY,
    timestamp: 1_700_000_000,
  });
  const commitOid = hashObject('commit', commit);
  const pack = writePack([
    { type: 'blob', data: blob },
    { type: 'tree', data: tree },
    { type: 'commit', data: commit },
  ]);
  const pushed = await git.push(owner, 'smoke-git', [{ oldOid: ZERO_OID, newOid: commitOid, ref: 'refs/heads/main' }], { pack });
  check('push reports ok', pushed.report?.unpackOk === true && pushed.report.refs[0]?.ok === true, JSON.stringify(pushed.report));

  const refs = await git.lsRefs(owner, 'smoke-git', { symrefs: true, peel: true });
  const mainRef = refs.refs.find((r) => r.name === 'refs/heads/main');
  check('ls-refs sees the pushed ref', mainRef?.oid === commitOid, JSON.stringify(refs.refs));
  check('ls-refs reports HEAD symref', refs.headSymref === 'refs/heads/main', JSON.stringify(refs.refs));

  const prefixed = await git.lsRefs(owner, 'smoke-git', { prefixes: ['refs/tags/'] });
  check('ls-refs honours ref-prefix server-side', prefixed.rawRefs.length === 0, JSON.stringify(prefixed.rawRefs));

  const fetched = await git.fetch(owner, 'smoke-git', { wants: [commitOid], done: true });
  check(
    'fetch sends the closure with a good checksum',
    fetched.checksumOk && fetched.objects.has(commitOid) && fetched.objects.has(treeOid) && fetched.objects.has(blobOid),
    `${fetched.objects.size} objects, checksum ${fetched.checksumOk}`,
  );

  // A second commit, then a depth-1 fetch must stop at the tip.
  const blob2 = Buffer.from('smoke two\n', 'utf8');
  const tree2 = buildTree([{ mode: '100644', name: 'smoke.txt', oid: hashObject('blob', blob2) }]);
  const commit2 = buildCommit({
    tree: hashObject('tree', tree2),
    parents: [commitOid],
    message: 'smoke: two\n',
    author: CONFORMANCE_IDENTITY,
    committer: CONFORMANCE_IDENTITY,
    timestamp: 1_700_000_001,
  });
  const commit2Oid = hashObject('commit', commit2);
  const push2 = await git.push(owner, 'smoke-git', [{ oldOid: commitOid, newOid: commit2Oid, ref: 'refs/heads/main' }], {
    pack: writePack([
      { type: 'blob', data: blob2 },
      { type: 'tree', data: tree2 },
      { type: 'commit', data: commit2 },
    ]),
  });
  check('fast-forward push is ok', push2.report?.refs[0]?.ok === true, JSON.stringify(push2.report));

  const stale = await git.push(owner, 'smoke-git', [{ oldOid: commitOid, newOid: commitOid, ref: 'refs/heads/main' }], {
    pack: writePack([]),
  });
  check('non-fast-forward is refused', stale.report?.refs[0]?.ok === false, JSON.stringify(stale.report));

  const shallow = await git.fetch(owner, 'smoke-git', { wants: [commit2Oid], depth: 1, done: true });
  check('depth-1 stops at the tip', shallow.objects.has(commit2Oid) && !shallow.objects.has(commitOid), `${shallow.objects.size} objects`);
  check('depth-1 names the shallow boundary', shallow.shallow.includes(commit2Oid), JSON.stringify(shallow.shallow));

  const deleted = await git.push(owner, 'smoke-git', [{ oldOid: commit2Oid, newOid: ZERO_OID, ref: 'refs/heads/main' }], {
    pack: writePack([]),
  });
  check('delete-refs works', deleted.report?.refs[0]?.ok === true, JSON.stringify(deleted.report));

  const missingRepoRefs = await fetch(`${base}/${owner}/ghost.git/info/refs?service=git-upload-pack`);
  check('unknown repo is 404', missingRepoRefs.status === 404, String(missingRepoRefs.status));

  const brokenPost = await fetch(`${base}/${owner}/smoke-git.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: Buffer.from('zzzz not pkt-lines'),
  });
  check('a malformed git body is 400', brokenPost.status === 400, String(brokenPost.status));

  const stillAlive = await api('GET', '/api/v3/user');
  check('the forge survives bad input', stillAlive.status === 200, stillAlive.text);

  // ------------------------------------------------------------------ pulls
  await git.createRepo(owner, 'smoke-pr');
  const baseBlob = Buffer.from('base\n', 'utf8');
  const baseTree = buildTree([{ mode: '100644', name: 'f.txt', oid: hashObject('blob', baseBlob) }]);
  const baseCommit = buildCommit({
    tree: hashObject('tree', baseTree),
    parents: [],
    message: 'base\n',
    author: CONFORMANCE_IDENTITY,
    committer: CONFORMANCE_IDENTITY,
    timestamp: 1_700_000_000,
  });
  const baseOid = hashObject('commit', baseCommit);
  await git.push(owner, 'smoke-pr', [{ oldOid: ZERO_OID, newOid: baseOid, ref: 'refs/heads/main' }], {
    pack: writePack([
      { type: 'blob', data: baseBlob },
      { type: 'tree', data: baseTree },
      { type: 'commit', data: baseCommit },
    ]),
  });
  const featureBlob = Buffer.from('feature\n', 'utf8');
  const featureTree = buildTree([
    { mode: '100644', name: 'f.txt', oid: hashObject('blob', baseBlob) },
    { mode: '100644', name: 'g.txt', oid: hashObject('blob', featureBlob) },
  ]);
  const featureCommit = buildCommit({
    tree: hashObject('tree', featureTree),
    parents: [baseOid],
    message: 'feature\n',
    author: CONFORMANCE_IDENTITY,
    committer: CONFORMANCE_IDENTITY,
    timestamp: 1_700_000_002,
  });
  const featureOid = hashObject('commit', featureCommit);
  await git.push(owner, 'smoke-pr', [{ oldOid: ZERO_OID, newOid: featureOid, ref: 'refs/heads/feature' }], {
    pack: writePack([
      { type: 'blob', data: featureBlob },
      { type: 'tree', data: featureTree },
      { type: 'commit', data: featureCommit },
    ]),
  });

  const pull = await api('POST', `/api/v3/repos/${owner}/smoke-pr/pulls`, { title: 'pr', head: 'feature', base: 'main' });
  check('POST pulls', pull.status === 201 && pull.json?.number >= 1 && pull.json?.mergeable === true, pull.text);

  const files = await api('GET', `/api/v3/repos/${owner}/smoke-pr/pulls/${pull.json.number}/files`);
  check('GET pull files', files.status === 200 && files.json?.[0]?.filename === 'g.txt', files.text);

  const merged = await api('PUT', `/api/v3/repos/${owner}/smoke-pr/pulls/${pull.json.number}/merge`, {});
  check('PUT merge', merged.status === 200 && merged.json?.merged === true, merged.text);

  const remerge = await api('PUT', `/api/v3/repos/${owner}/smoke-pr/pulls/${pull.json.number}/merge`, {});
  check('a merged pull cannot merge again (405)', remerge.status === 405, remerge.text);

  const mergedContents = await api('GET', `/api/v3/repos/${owner}/smoke-pr/contents/g.txt`);
  check('the merge landed on the base branch', mergedContents.status === 200, mergedContents.text);

  const badPull = await api('POST', `/api/v3/repos/${owner}/smoke-pr/pulls`, { title: 'x', head: 'ghost', base: 'main' });
  check('an unknown head is 422', badPull.status === 422, badPull.text);
} catch (err) {
  failures += 1;
  process.stdout.write(`  FAIL  threw ${err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : String(err)}\n`);
}

child.kill('SIGTERM');
env.close();
process.stdout.write(failures === 0 ? '[smoke] all checks passed\n' : `[smoke] ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
