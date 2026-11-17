// The Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over the streamable-HTTP transport.
//
// Both eras are served: `server/discover` (revision 2026-07-28) and the `initialize` handshake of
// the earlier revisions. The tools act on the same store the REST surface serves — every call is
// routed through handleRest, so an object created over MCP reads back identically over /api/v3.

import { handleRest, type ApiReply } from './rest.ts';
import type { Store } from './store.ts';

/** The revision this server prefers, and the ones it says it supports. */
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

/** One answer the MCP endpoint produces. */
export interface McpReply {
  status: number;
  body: string;
}

interface ToolSpec {
  name: string;
  title: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
}

const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a new repository owned by the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The name of the repository to create.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Read one repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Open a new issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all (open by default).' },
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create pull request',
    description: 'Open a pull request from a head branch into a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The branch the changes are on.' },
      base: { type: 'string', description: 'The branch the changes are merged into.' },
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge an open pull request as a squash commit on its base branch.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
  },
];

/** The exact `tools` array two tools/list calls must answer, byte for byte. */
const TOOLS_JSON = JSON.stringify(
  TOOL_SPECS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required, additionalProperties: false },
  })),
);

const DISCOVER_RESULT = JSON.stringify({
  resultType: 'discover',
  supportedVersions: SUPPORTED_VERSIONS,
  capabilities: { tools: { listChanged: false } },
  instructions: 'A GitHub-compatible forge: create repositories, issues and pull requests, and merge them.',
  serverInfo: SERVER_INFO,
  _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resultBody(id: unknown, result: string): string {
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":${result}}`;
}

function errorBody(id: unknown, code: number, message: string): string {
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"error":{"code":${code},"message":${JSON.stringify(message)}}}`;
}

function toolResult(text: string, structured: unknown, isError = false): string {
  const payload: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (structured !== undefined) payload.structuredContent = structured;
  if (isError) payload.isError = true;
  return JSON.stringify(payload);
}

function rest(store: Store, method: string, segments: string[], json?: unknown, query?: Record<string, string>): ApiReply {
  return handleRest(store, {
    method,
    segments,
    query: new URLSearchParams(query ?? {}),
    json,
    badJson: false,
    authorized: true,
    host: 'mcp',
  });
}

function stringArg(args: Record<string, unknown>, ...names: readonly string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function numberArg(args: Record<string, unknown>, ...names: readonly string[]): number | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

function missing(names: readonly string[]): string {
  return toolResult(`missing required argument(s): ${names.join(', ')}`, { error: 'missing_arguments', missing: names }, true);
}

function failed(reply: ApiReply): string {
  const message = reply.body === null ? `HTTP ${reply.status}` : reply.body;
  return toolResult(`the request failed with HTTP ${reply.status}: ${message}`, { error: 'request_failed', status: reply.status }, true);
}

function ok(reply: ApiReply): string {
  const text = reply.body ?? '{}';
  let structured: unknown;
  try {
    structured = JSON.parse(text);
  } catch {
    structured = undefined;
  }
  return toolResult(text, Array.isArray(structured) ? undefined : structured);
}

/** Run one tool call and answer the JSON-RPC `result` body (a tool failure is isError, not an error). */
function callTool(store: Store, name: string, args: Record<string, unknown>): string | null {
  const bare = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const canonical = TOOL_SPECS.find((tool) => bare === tool.name.replace(/_/g, '') || bare.endsWith(tool.name.replace(/_/g, '')));
  if (canonical === undefined) return null;
  const full = stringArg(args, 'full_name', 'repo_full_name');
  let owner = stringArg(args, 'owner', 'owner_login', 'login');
  let repo = stringArg(args, 'repo', 'repository', 'repo_name');
  if (full.includes('/')) {
    const parts = full.split('/');
    if (owner === '') owner = parts[0] as string;
    if (repo === '') repo = parts.slice(1).join('/');
  }
  if (owner === '') owner = store.viewer;

  if (canonical.name === 'create_repo') {
    const repoName = stringArg(args, 'name', 'repo', 'repository', 'repo_name');
    if (repoName === '') return missing(['name']);
    const created = rest(store, 'POST', ['user', 'repos'], { name: repoName, description: stringArg(args, 'description'), private: args.private === true });
    if (created.status === 201) return ok(created);
    const existing = rest(store, 'GET', ['repos', store.viewer, repoName]);
    return existing.status === 200 ? ok(existing) : failed(created);
  }

  if (canonical.name === 'get_repo') {
    if (repo === '') return missing(['repo']);
    const reply = rest(store, 'GET', ['repos', owner, repo]);
    return reply.status === 200 ? ok(reply) : failed(reply);
  }

  if (canonical.name === 'create_issue') {
    const title = stringArg(args, 'title', 'issue_title');
    const absent: string[] = [];
    if (repo === '') absent.push('repo');
    if (title === '') absent.push('title');
    if (absent.length > 0) return missing(absent);
    const reply = rest(store, 'POST', ['repos', owner, repo, 'issues'], { title, body: stringArg(args, 'body', 'description') });
    return reply.status === 201 ? ok(reply) : failed(reply);
  }

  if (canonical.name === 'list_issues') {
    if (repo === '') return missing(['repo']);
    const state = stringArg(args, 'state', 'status');
    const reply = rest(store, 'GET', ['repos', owner, repo, 'issues'], undefined, { state: state === '' ? 'open' : state, per_page: '100' });
    return reply.status === 200 ? toolResult(reply.body ?? '[]', undefined) : failed(reply);
  }

  if (canonical.name === 'create_pull_request') {
    const title = stringArg(args, 'title', 'pr_title');
    const head = stringArg(args, 'head', 'head_ref', 'head_branch', 'source');
    const base = stringArg(args, 'base', 'base_ref', 'base_branch', 'target');
    const absent: string[] = [];
    if (repo === '') absent.push('repo');
    if (title === '') absent.push('title');
    if (head === '') absent.push('head');
    if (base === '') absent.push('base');
    if (absent.length > 0) return missing(absent);
    const reply = rest(store, 'POST', ['repos', owner, repo, 'pulls'], { title, body: stringArg(args, 'body'), head, base });
    return reply.status === 201 ? ok(reply) : failed(reply);
  }

  const number = numberArg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number');
  const absent: string[] = [];
  if (repo === '') absent.push('repo');
  if (number === null) absent.push('pull_number');
  if (absent.length > 0) return missing(absent);
  const reply = rest(store, 'PUT', ['repos', owner, repo, 'pulls', String(number), 'merge'], { merge_method: 'squash' });
  return reply.status === 200 ? ok(reply) : failed(reply);
}

/** Serve one POST /mcp. `authorized` is whether the request carried an Authorization header. */
export function handleMcp(store: Store, method: string, authorized: boolean, body: Buffer): McpReply {
  if (method === 'DELETE' || method === 'GET') return { status: 202, body: '' };
  if (method !== 'POST') return { status: 405, body: errorBody(null, -32600, 'the MCP endpoint takes POST') };
  if (!authorized) return { status: 401, body: errorBody(null, -32001, 'Requires authentication') };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: errorBody(null, -32700, 'Parse error') };
  }

  if (Array.isArray(parsed)) {
    const bodies = parsed.map((entry) => dispatch(store, entry)).filter((entry): entry is string => entry !== null);
    return { status: bodies.length === 0 ? 202 : 200, body: bodies.length === 0 ? '' : `[${bodies.join(',')}]` };
  }
  const answer = dispatch(store, parsed);
  if (answer === null) return { status: 202, body: '' };
  return { status: 200, body: answer };
}

function dispatch(store: Store, message: unknown): string | null {
  if (!isRecord(message)) return errorBody(null, -32600, 'Invalid Request');
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = isRecord(message.params) ? message.params : {};
  if (id === undefined || id === null) {
    // A notification: nothing to answer.
    return null;
  }

  if (method === 'server/discover') return resultBody(id, DISCOVER_RESULT);
  if (method === 'initialize') {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0] as string;
    const version = SUPPORTED_VERSIONS.includes(asked) ? asked : (SUPPORTED_VERSIONS[0] as string);
    return resultBody(id, JSON.stringify({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO }));
  }
  if (method === 'ping') return resultBody(id, '{}');
  if (method === 'tools/list') return resultBody(id, `{"tools":${TOOLS_JSON}}`);
  if (method === 'resources/list') return resultBody(id, '{"resources":[]}');
  if (method === 'prompts/list') return resultBody(id, '{"prompts":[]}');
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const result = callTool(store, name, args);
    if (result === null) return errorBody(id, -32602, `Unknown tool ${JSON.stringify(name)}`);
    return resultBody(id, result);
  }
  return errorBody(id, -32601, `Method not found: ${method}`);
}
