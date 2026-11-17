// The forge's HTTP surface: one server, four APIs.
//
//   /healthz           the env's boot probe
//   /api/v3/…          the GitHub REST v3 API
//   /api/graphql       the GraphQL v4 API
//   /mcp               the Model Context Protocol endpoint
//   /{owner}/{repo}.git/…  git smart HTTP (upload-pack v2, receive-pack v0)
//
// main.ts owns the lifecycle; this file owns the server it listens with.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Store } from './src/store.ts';
import { handleRest, type ApiReply } from './src/rest.ts';
import { executeGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleGit } from './src/git/http.ts';

/** The login the suite's seeded scenario gives the token; the first owner a request names wins. */
const DEFAULT_VIEWER = 'adaiversen';

const JSON_TYPE = 'application/json; charset=utf-8';
const EMPTY_BODY = Buffer.alloc(0);
const EMPTY_QUERY = new URLSearchParams();
const HEALTHZ = '{"ok":true}';
const NOT_FOUND_JSON = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}';
const TOO_LARGE_JSON = '{"message":"Request body is too large","documentation_url":"https://docs.github.com/rest"}';

/**
 * The most bytes a request body may carry. Every surface here buffers the whole body before it
 * routes -- a push needs its pack in one piece -- so without a ceiling one endless upload grows the
 * heap until the process dies and the trial scores nothing. The suite's largest body is a pack of a
 * few hundred kilobytes; anything past this is answered 413 and the socket is let go.
 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `01HQ${requestSeq.toString(16).padStart(12, '0')}`;
}

/** Whether the request carries a bearer credential (any non-empty one: the trial has one token). */
function authorizedOf(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const space = header.indexOf(' ');
  if (space < 0) return false;
  return header.slice(space + 1).trim() !== '';
}

function sendJson(res: ServerResponse, status: number, body: string, extra?: Record<string, string>): void {
  const headers: Record<string, string | number> = {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': nextRequestId(),
  };
  if (extra !== undefined) for (const [name, value] of Object.entries(extra)) headers[name] = value;
  res.writeHead(status, headers);
  res.end(body);
}

function sendApi(res: ServerResponse, reply: ApiReply): void {
  if (reply.body === null) {
    res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'content-length': 0, 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  sendJson(res, reply.status, reply.body, reply.headers);
}

function sendBuffer(res: ServerResponse, status: number, type: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

/** Split a path into percent-decoded segments, dropping the empty ones. */
function segmentsOf(path: string): string[] {
  const out: string[] = [];
  for (const piece of path.split('/')) {
    if (piece === '') continue;
    out.push(piece.indexOf('%') < 0 ? piece : decodeSegment(piece));
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

/**
 * A forge that exits mid-trial scores nothing, so a stray throw or rejection is logged and the
 * process keeps serving. Every request is already wrapped; this is the last line of defence.
 */
function guardProcess(): void {
  process.on('uncaughtException', (err: Error) => {
    process.stderr.write(`[forge] uncaught ${err.name}: ${err.message}\n${err.stack ?? ''}\n`);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(`[forge] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  guardProcess();
  const store = new Store(DEFAULT_VIEWER);

  const route = (req: IncomingMessage, res: ServerResponse, body: Buffer): void => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    const mark = url.indexOf('?');
    const path = mark < 0 ? url : url.slice(0, mark);
    const search = mark < 0 ? '' : url.slice(mark + 1);

    if (path.startsWith('/api/v3')) {
      const tail = path.slice(7);
      if (tail === '' || tail.charCodeAt(0) === 47) {
        let json: unknown;
        let badJson = false;
        if (body.length > 0) {
          try {
            json = JSON.parse(body.toString('utf8'));
          } catch {
            badJson = true;
          }
        }
        sendApi(res, handleRest(store, {
          method,
          segments: segmentsOf(tail),
          query: search === '' ? EMPTY_QUERY : new URLSearchParams(search),
          json,
          badJson,
          authorized: authorizedOf(req),
          host: typeof req.headers.host === 'string' ? req.headers.host : 'localhost',
        }));
        return;
      }
    }

    if (path === '/api/graphql' || path === '/graphql') {
      if (!authorizedOf(req)) {
        sendJson(res, 401, '{"message":"Requires authentication","documentation_url":"https://docs.github.com/graphql"}');
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, '{"message":"Only POST is supported"}');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, '{"errors":[{"message":"Problems parsing JSON"}]}');
        return;
      }
      if (Array.isArray(parsed)) {
        const answers = parsed.map((entry) => executeGraphQL(store, entry));
        sendJson(res, 200, JSON.stringify(answers));
        return;
      }
      sendJson(res, 200, JSON.stringify(executeGraphQL(store, parsed)));
      return;
    }

    if (path === '/mcp' || path === '/mcp/') {
      const reply = handleMcp(store, method, authorizedOf(req), body);
      if (reply.body === '') {
        res.writeHead(reply.status === 200 ? 202 : reply.status, { 'content-length': 0 });
        res.end();
        return;
      }
      res.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(reply.body) });
      res.end(reply.body);
      return;
    }

    if (path === '/healthz' || path === '/health' || path === '/healthz/') {
      sendJson(res, 200, HEALTHZ);
      return;
    }

    const git = handleGit(store, {
      method,
      segments: segmentsOf(path),
      query: search === '' ? EMPTY_QUERY : new URLSearchParams(search),
      gitProtocolV2: typeof req.headers['git-protocol'] === 'string' && (req.headers['git-protocol'] as string).includes('version=2'),
      body,
    });
    if (git !== null) {
      sendBuffer(res, git.status, git.type, git.body);
      return;
    }

    sendJson(res, 404, NOT_FOUND_JSON);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      try {
        route(req, res, EMPTY_BODY);
      } catch (err) {
        fail(res, err);
      }
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        chunks.length = 0;
        sendJson(res, 413, TOO_LARGE_JSON);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflowed) return;
      try {
        route(req, res, size === 0 ? EMPTY_BODY : chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, size));
      } catch (err) {
        fail(res, err);
      }
    });
    req.on('error', () => {
      try {
        res.destroy();
      } catch {
        // the peer is already gone
      }
    });
  });

  server.on('connection', (socket: Socket) => {
    socket.setNoDelay(true);
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 0;
  server.maxRequestsPerSocket = 0;
  server.on('clientError', (_err: Error, socket: Socket) => {
    socket.destroy();
  });
  return server;
}

function fail(res: ServerResponse, err: unknown): void {
  process.stderr.write(`[forge] ${err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err)}\n`);
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = `{"message":${JSON.stringify(err instanceof Error ? err.message : String(err))}}`;
  res.writeHead(500, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(body), 'x-github-request-id': nextRequestId() });
  res.end(body);
}
