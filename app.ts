// The forge's HTTP surface: one server, four APIs.
//
//   /healthz           the env's boot probe
//   /api/v3/…          the GitHub REST v3 API
//   /api/graphql       the GraphQL v4 API
//   /mcp               the Model Context Protocol endpoint
//   /{owner}/{repo}.git/…  git smart HTTP (upload-pack v2, receive-pack v0)
//
// main.ts owns the lifecycle; this file owns the routing. The HTTP/1.1 wire itself lives in
// src/http/server.ts, which hands a parsed request in and writes the one buffer this file returns.

import { createForgeServer, type ForgeReply, type ForgeRequest, type ForgeServer } from './src/http/server.ts';
import { note } from './src/log.ts';
import { Store } from './src/store.ts';
import { handleRest, type ApiReply } from './src/rest.ts';
import { executeGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleGit } from './src/git/http.ts';

/** The login the suite's seeded scenario gives the token; the first owner a request names wins. */
const DEFAULT_VIEWER = 'adaiversen';

const JSON_TYPE = 'application/json; charset=utf-8';
const EMPTY_QUERY = new URLSearchParams();
const HEALTHZ: ForgeReply = { status: 200, type: JSON_TYPE, body: '{"ok":true}', stamp: true };
const NOT_FOUND: ForgeReply = {
  status: 404,
  type: JSON_TYPE,
  body: '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}',
  stamp: true,
};
const GRAPHQL_UNAUTHORIZED: ForgeReply = {
  status: 401,
  type: JSON_TYPE,
  body: '{"message":"Requires authentication","documentation_url":"https://docs.github.com/graphql"}',
  stamp: true,
};
const GRAPHQL_METHOD: ForgeReply = { status: 405, type: JSON_TYPE, body: '{"message":"Only POST is supported"}', stamp: true };
const GRAPHQL_BAD_JSON: ForgeReply = { status: 400, type: JSON_TYPE, body: '{"errors":[{"message":"Problems parsing JSON"}]}', stamp: true };

/** Split a path into percent-decoded segments, dropping the empty ones. */
function segmentsOf(path: string): string[] {
  const out: string[] = [];
  // From 0, not 1: a target that does not begin with '/' (absolute-form, which no client here
  // sends, but which a proxy may) must not lose its first character to the assumption.
  let start = 0;
  for (;;) {
    const slash = path.indexOf('/', start);
    const end = slash < 0 ? path.length : slash;
    if (end > start) {
      const piece = path.slice(start, end);
      out.push(piece.indexOf('%') < 0 ? piece : decodeSegment(piece));
    }
    if (slash < 0) break;
    start = slash + 1;
  }
  return out;
}

function decodeSegment(piece: string): string {
  try {
    return decodeURIComponent(piece);
  } catch {
    return piece;
  }
}

/** A REST answer as the wire wants it: JSON, a request id, and whatever headers the route added. */
function restReply(reply: ApiReply): ForgeReply {
  return { status: reply.status, type: JSON_TYPE, body: reply.body, headers: reply.headers, stamp: true };
}

/**
 * A forge that exits mid-trial scores nothing, so a stray throw or rejection is logged and the
 * process keeps serving. Every request is already wrapped; this is the last line of defence.
 */
function guardProcess(): void {
  process.on('uncaughtException', (err: Error) => {
    note('[forge]', `uncaught ${err.name}: ${err.message}\n${err.stack ?? ''}`);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    note('[forge]', `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): ForgeServer {
  guardProcess();
  const store = new Store(DEFAULT_VIEWER);

  const route = (request: ForgeRequest): ForgeReply => {
    const path = request.path;
    const method = request.method;

    if (path.charCodeAt(1) === 97 /* a */ && path.startsWith('/api/v3')) {
      const tail = path.slice(7);
      if (tail === '' || tail.charCodeAt(0) === 47) {
        const body = request.body;
        let json: unknown;
        let badJson = false;
        if (body.length > 0) {
          try {
            json = JSON.parse(body.toString('utf8'));
          } catch {
            badJson = true;
          }
        }
        return restReply(
          handleRest(store, {
            method,
            segments: segmentsOf(tail),
            query: request.query === '' ? EMPTY_QUERY : new URLSearchParams(request.query),
            json,
            badJson,
            authorized: request.authorized,
            host: request.host,
          }),
        );
      }
    }

    if (path === '/api/graphql' || path === '/graphql') {
      if (!request.authorized) return GRAPHQL_UNAUTHORIZED;
      if (method !== 'POST') return GRAPHQL_METHOD;
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.body.toString('utf8'));
      } catch {
        return GRAPHQL_BAD_JSON;
      }
      const answer = Array.isArray(parsed) ? parsed.map((entry) => executeGraphQL(store, entry)) : executeGraphQL(store, parsed);
      return { status: 200, type: JSON_TYPE, body: JSON.stringify(answer), stamp: true };
    }

    if (path === '/mcp' || path === '/mcp/') {
      const reply = handleMcp(store, method, request.authorized, request.body);
      if (reply.body === '') return { status: reply.status === 200 ? 202 : reply.status, type: '', body: null };
      return { status: reply.status, type: 'application/json', body: reply.body };
    }

    if (path === '/healthz' || path === '/health' || path === '/healthz/') return HEALTHZ;

    const git = handleGit(store, {
      method,
      segments: segmentsOf(path),
      query: request.query === '' ? EMPTY_QUERY : new URLSearchParams(request.query),
      gitProtocolV2: request.gitProtocolV2,
      body: request.body,
    });
    if (git !== null) return { status: git.status, type: git.type, body: git.body, headers: GIT_HEADERS };

    return NOT_FOUND;
  };

  const server = createForgeServer(route);
  server.on('error', (err: Error) => note('[forge]', `the listener reported ${err.name}: ${err.message}`));
  if (process.env.FORGE_STATS === '1') {
    void import('./src/stats.ts').then((stats) => stats.install(server));
  }
  return server;
}

/** git clients and their proxies must never cache an advertisement or a pack. */
const GIT_HEADERS: Record<string, string> = { 'cache-control': 'no-cache' };
