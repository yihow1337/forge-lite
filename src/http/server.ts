// A hand-rolled HTTP/1.1 server over node:net, in place of node:http.
//
// WHY THIS EXISTS
//   The forge is graded on wall time inside a gVisor sandbox that shares two CPUs with the suite
//   measuring it. There, every syscall and every byte of per-request bookkeeping is expensive, and
//   a CPU profile of the node:http forge spent 35-40% of its busy time inside node:http, the stream
//   stack and the event emitters under them -- an IncomingMessage and a ServerResponse are two
//   duplex streams built, emitted on and torn down for a request whose whole answer is one cached
//   buffer. This file keeps the wire behaviour and throws that machinery away:
//
//     * one Socket per connection and nothing else: no streams, no per-request objects beyond the
//       small ForgeRequest the router reads;
//     * header names matched on the raw text by length and folded char codes, so a request
//       allocates three strings (the head, the method and the target) rather than one per header;
//     * exactly one socket.write per response, headers and body composed into a single Buffer, so
//       one answer is one write(2); a JSON body is encoded straight into that buffer rather than
//       into a string the socket then re-encodes.
//
// WHAT IT STILL DOES, because the suite checks it
//   keep-alive (the read workload's 2,000 GETs share one connection) and `Connection: close` when
//   the client asks for it; pipelining (requests are served in arrival order, and every handler
//   here is synchronous, so the answers cannot overtake each other); Content-Length and chunked
//   request bodies; `Expect: 100-continue`; HEAD without a body; a 400 for a malformed head and a
//   413 for a body past the ceiling.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   No Date header (nothing reads it, and formatting one per request is pure cost), no response
//   compression (the suite never needs it), no trailers, no HTTP/1.0 keep-alive bargaining beyond
//   honouring `connection: close`, no request timeouts: a trial is nine hundred seconds long and
//   the lifecycle in main.ts owns the ending.

import { createServer, type Server, type Socket } from 'node:net';
import { note } from '../log.ts';

/** One request as the router reads it. Everything costly is computed once, here. */
export interface ForgeRequest {
  method: string;
  /** The raw request target: path and query, exactly as it arrived. */
  target: string;
  /** The target's path, percent-encoding untouched. */
  path: string;
  /** The target's query string without the '?', '' when there is none. */
  query: string;
  body: Buffer;
  /** Whether an Authorization header carried a non-empty credential. */
  authorized: boolean;
  /** Whether a Git-Protocol header named version 2. */
  gitProtocolV2: boolean;
  /** The Host header, 'localhost' when absent. */
  host: string;
}

/** One answer. `type` is the Content-Type; '' sends none. `body` null means no body at all. */
export interface ForgeReply {
  status: number;
  type: string;
  body: string | Buffer | null;
  headers?: Record<string, string> | undefined;
  /** Whether the answer carries X-GitHub-Request-Id (every REST and JSON answer does). */
  stamp?: boolean;
}

export type ForgeHandler = (request: ForgeRequest) => ForgeReply;

/** A server that owns its sockets, with the two shutdown helpers node:http's Server has. */
export interface ForgeServer extends Server {
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

/**
 * The most bytes a request body may carry. Every surface buffers its whole body before routing --
 * a push needs its pack in one piece -- so without a ceiling one endless upload grows the heap
 * until the process dies and the trial scores nothing.
 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** The most bytes a request head may take before it is a broken client rather than a slow one. */
const MAX_HEAD_BYTES = 128 * 1024;

const EMPTY = Buffer.alloc(0);
const CRLF2 = Buffer.from('\r\n\r\n', 'latin1');
const CONTINUE = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');
const BAD_REQUEST_BODY = '{"message":"Bad Request","documentation_url":"https://docs.github.com/rest"}';
const BAD_REQUEST = Buffer.from(
  `HTTP/1.1 400 Bad Request\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${BAD_REQUEST_BODY.length}\r\nconnection: close\r\n\r\n${BAD_REQUEST_BODY}`,
  'latin1',
);
const TOO_LARGE_BODY = '{"message":"Request body is too large","documentation_url":"https://docs.github.com/rest"}';

/** The reason phrases the forge answers with; anything else travels as a bare "OK". */
const REASON: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

// ---------------------------------------------------------------- request ids

/**
 * X-GitHub-Request-Id. A counter rather than randomness or a clock: the header has to be present
 * and non-empty, and crypto.randomUUID on every answer is a syscall-backed cost the read workload
 * would pay two thousand times a round.
 */
let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `01HQ${requestSeq.toString(16).padStart(12, '0')}`;
}

/** Every answer written, stamped or not; tools/bench.mjs reads it through src/stats.ts. */
let responses = 0;

/**
 * Set only by tools/bench.mjs. Counting the reads is how the bench tool tells "the client sent
 * this request in one segment" from "it sent the head and the body separately", which is the
 * difference between one read syscall a request and two.
 */
const MEASURING = process.env.FORGE_STATS === '1';
let reads = 0;
let readBytes = 0;

/** The counters src/stats.ts dumps on SIGUSR2. */
export function counters(): Record<string, number> {
  return { responses, reads, readBytes };
}

// ---------------------------------------------------------------- header matching

/**
 * Whether `text[start..end)` is `lower` ignoring ASCII case. `lower` must already be lowercase.
 * Comparing in place is what keeps a request from allocating a string per header name.
 */
function nameIs(text: string, start: number, end: number, lower: string): boolean {
  if (end - start !== lower.length) return false;
  for (let index = 0; index < lower.length; index += 1) {
    const code = text.charCodeAt(start + index);
    // 0x20 folds an ASCII capital to its lowercase; a non-letter is unchanged by it and simply
    // fails the comparison, which is what we want for a name that is not this one.
    if (code !== lower.charCodeAt(index) && (code | 0x20) !== lower.charCodeAt(index)) return false;
  }
  return true;
}

/** The first non-space offset at or after `start`, bounded by `end`. */
function skipSpace(text: string, start: number, end: number): number {
  let index = start;
  while (index < end && (text.charCodeAt(index) === 32 || text.charCodeAt(index) === 9)) index += 1;
  return index;
}

// ---------------------------------------------------------------- the parsed head

/** What one request's head told us, before its body arrived. */
interface Head {
  method: string;
  target: string;
  contentLength: number;
  chunked: boolean;
  close: boolean;
  expectContinue: boolean;
  authorized: boolean;
  gitProtocolV2: boolean;
  host: string;
}

/**
 * Parse a request head (the request line and every header, the final CRLF included). Null means
 * the head is malformed and the connection has earned a 400.
 */
function parseHead(text: string): Head | null {
  const firstEnd = text.indexOf('\r\n');
  if (firstEnd < 0) return null;
  const methodEnd = text.indexOf(' ');
  if (methodEnd < 0 || methodEnd > firstEnd) return null;
  const targetEnd = text.indexOf(' ', methodEnd + 1);
  if (targetEnd < 0 || targetEnd > firstEnd) return null;

  const head: Head = {
    method: text.slice(0, methodEnd),
    target: text.slice(methodEnd + 1, targetEnd),
    contentLength: 0,
    chunked: false,
    close: false,
    expectContinue: false,
    authorized: false,
    gitProtocolV2: false,
    host: 'localhost',
  };
  // HTTP/1.0 has no keep-alive unless it asks for one; the suite speaks 1.1, but a stray 1.0
  // client must not be left hanging on a socket it believes is finished.
  if (text.charCodeAt(targetEnd + 8) === 48) head.close = true;

  let lineStart = firstEnd + 2;
  for (;;) {
    const lineEnd = text.indexOf('\r\n', lineStart);
    if (lineEnd < 0 || lineEnd === lineStart) break;
    const colon = text.indexOf(':', lineStart);
    if (colon < 0 || colon > lineEnd) {
      lineStart = lineEnd + 2;
      continue;
    }
    const valueStart = skipSpace(text, colon + 1, lineEnd);
    switch (colon - lineStart) {
      case 4:
        if (nameIs(text, lineStart, colon, 'host')) head.host = text.slice(valueStart, lineEnd);
        break;
      case 6:
        if (nameIs(text, lineStart, colon, 'expect') && lineEnd - valueStart >= 4 && (text.charCodeAt(valueStart) | 0x20) === 49) {
          // "100-continue" is the only expectation HTTP/1.1 defines; anything else we ignore.
          head.expectContinue = true;
        }
        break;
      case 10:
        if (nameIs(text, lineStart, colon, 'connection')) {
          head.close = nameIs(text, valueStart, lineEnd, 'close');
        }
        break;
      case 12:
        if (nameIs(text, lineStart, colon, 'git-protocol')) {
          head.gitProtocolV2 = text.indexOf('version=2', valueStart) >= 0 && text.indexOf('version=2', valueStart) < lineEnd;
        }
        break;
      case 13:
        if (nameIs(text, lineStart, colon, 'authorization')) {
          // Any non-empty credential after the scheme counts: the trial carries one token.
          const space = text.indexOf(' ', valueStart);
          head.authorized = space >= 0 && space < lineEnd && skipSpace(text, space + 1, lineEnd) < lineEnd;
        }
        break;
      case 14:
        if (nameIs(text, lineStart, colon, 'content-length')) {
          const length = Number.parseInt(text.slice(valueStart, lineEnd), 10);
          if (!Number.isFinite(length) || length < 0) return null;
          head.contentLength = length;
        }
        break;
      case 17:
        if (nameIs(text, lineStart, colon, 'transfer-encoding')) {
          head.chunked = text.indexOf('chunked', valueStart) >= 0;
        }
        break;
      default:
        break;
    }
    lineStart = lineEnd + 2;
  }
  return head;
}

// ---------------------------------------------------------------- writing one answer

/**
 * Compose an answer into one Buffer and hand it to the socket: one write(2) a response, with the
 * body encoded directly into the same allocation as the headers.
 */
function writeReply(socket: Socket, reply: ForgeReply, headOnly: boolean, close: boolean): void {
  responses += 1;
  const body = reply.body;
  const bodyLength = body === null ? 0 : typeof body === 'string' ? Buffer.byteLength(body) : body.length;

  let head = `HTTP/1.1 ${reply.status} ${REASON[reply.status] ?? 'OK'}\r\n`;
  if (reply.type !== '') head += `content-type: ${reply.type}\r\n`;
  head += `content-length: ${bodyLength}\r\n`;
  if (reply.stamp === true) head += `x-github-request-id: ${nextRequestId()}\r\n`;
  const extra = reply.headers;
  if (extra !== undefined) for (const name in extra) head += `${name}: ${extra[name]}\r\n`;
  if (close) head += 'connection: close\r\n';
  head += '\r\n';

  const headLength = Buffer.byteLength(head);
  const send = headOnly || bodyLength === 0 ? headLength : headLength + bodyLength;
  const out = Buffer.allocUnsafe(send);
  out.write(head, 0, headLength, 'utf8');
  if (send > headLength) {
    if (typeof body === 'string') out.write(body, headLength, bodyLength, 'utf8');
    else (body as Buffer).copy(out, headLength);
  }
  socket.write(out);
}

// ---------------------------------------------------------------- one connection

/** Everything one socket is in the middle of. */
interface Conn {
  socket: Socket;
  /** Bytes received and not yet consumed by a request. */
  buf: Buffer;
  /** Where the next search for the head's end may start (bytes before it hold no CRLFCRLF). */
  scan: number;
  /** The head of the request whose body we are still waiting for, or null. */
  head: Head | null;
  /** Where that request's body begins in `buf`. */
  bodyAt: number;
  /** Decoded chunks of a chunked body, and how many bytes they hold. */
  chunks: Buffer[];
  chunkSize: number;
  dead: boolean;
}

/** Answer a broken request and hang up: a connection whose framing is lost cannot be reused. */
function refuse(conn: Conn): void {
  conn.dead = true;
  conn.socket.end(BAD_REQUEST);
}

/**
 * Decode as much of a chunked body as `buf` holds from `bodyAt`. Answers the offset just past the
 * body's last byte when the terminating zero chunk arrived, -1 while more is needed, or -2 when
 * the framing is broken. The suite never sends one; a client that does is still served.
 */
function readChunked(conn: Conn): number {
  const buf = conn.buf;
  // A re-scan: every call walks the body from the start, so the decoded chunks must start empty
  // or a body that arrived in two segments would be assembled with its first half twice.
  conn.chunks.length = 0;
  conn.chunkSize = 0;
  let offset = conn.bodyAt;
  for (;;) {
    const lineEnd = buf.indexOf(10, offset);
    if (lineEnd < 0) return -1;
    const size = Number.parseInt(buf.toString('latin1', offset, lineEnd), 16);
    if (!Number.isFinite(size) || size < 0) return -2;
    const dataAt = lineEnd + 1;
    if (size === 0) {
      // The last chunk is followed by an optional trailer section and then one empty line.
      if (buf.length >= dataAt + 2 && buf[dataAt] === 13 && buf[dataAt + 1] === 10) return dataAt + 2;
      const trailerEnd = buf.indexOf(CRLF2, lineEnd - 1);
      return trailerEnd < 0 ? -1 : trailerEnd + 4;
    }
    if (buf.length < dataAt + size + 2) return -1;
    conn.chunkSize += size;
    if (conn.chunkSize > MAX_BODY_BYTES) return -2;
    conn.chunks.push(buf.subarray(dataAt, dataAt + size));
    offset = dataAt + size + 2;
  }
}

/** Serve every whole request the connection's buffer holds, in arrival order. */
function drain(conn: Conn, handler: ForgeHandler): void {
  for (;;) {
    if (conn.dead) return;

    if (conn.head === null) {
      const end = conn.buf.indexOf(CRLF2, conn.scan);
      if (end < 0) {
        if (conn.buf.length > MAX_HEAD_BYTES) refuse(conn);
        else conn.scan = conn.buf.length > 3 ? conn.buf.length - 3 : 0;
        return;
      }
      const head = parseHead(conn.buf.toString('latin1', 0, end + 2));
      if (head === null) {
        refuse(conn);
        return;
      }
      if (head.contentLength > MAX_BODY_BYTES) {
        conn.dead = true;
        writeReply(conn.socket, { status: 413, type: 'application/json; charset=utf-8', body: TOO_LARGE_BODY, stamp: true }, false, true);
        conn.socket.end();
        return;
      }
      conn.head = head;
      conn.bodyAt = end + 4;
      conn.scan = 0;
      conn.chunks = [];
      conn.chunkSize = 0;
      if (head.expectContinue) conn.socket.write(CONTINUE);
    }

    const head = conn.head;
    let body: Buffer;
    let consumed: number;
    if (head.chunked) {
      const end = readChunked(conn);
      if (end === -1) return;
      if (end === -2) {
        refuse(conn);
        return;
      }
      body = conn.chunks.length === 0 ? EMPTY : conn.chunks.length === 1 ? (conn.chunks[0] as Buffer) : Buffer.concat(conn.chunks, conn.chunkSize);
      consumed = end;
    } else {
      consumed = conn.bodyAt + head.contentLength;
      if (conn.buf.length < consumed) return;
      body = head.contentLength === 0 ? EMPTY : conn.buf.subarray(conn.bodyAt, consumed);
    }

    // Keep the next request's bytes, and let the consumed allocation go: a subarray of a whole
    // 300 KiB pack would otherwise pin it for as long as the pipelined remainder lives.
    conn.buf = consumed === conn.buf.length ? EMPTY : Buffer.from(conn.buf.subarray(consumed));
    conn.head = null;

    const mark = head.target.indexOf('?');
    const request: ForgeRequest = {
      method: head.method,
      target: head.target,
      path: mark < 0 ? head.target : head.target.slice(0, mark),
      query: mark < 0 ? '' : head.target.slice(mark + 1),
      body,
      authorized: head.authorized,
      gitProtocolV2: head.gitProtocolV2,
      host: head.host,
    };

    let reply: ForgeReply;
    try {
      reply = handler(request);
    } catch (err) {
      note('[forge]', err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err));
      reply = { status: 500, type: 'application/json; charset=utf-8', body: `{"message":${JSON.stringify(err instanceof Error ? err.message : String(err))}}`, stamp: true };
    }
    writeReply(conn.socket, reply, head.method === 'HEAD', head.close);
    if (head.close) {
      conn.dead = true;
      conn.socket.end();
      return;
    }
  }
}

// ---------------------------------------------------------------- the server

/** An HTTP/1.1 server that answers every request with `handler`. */
export function createForgeServer(handler: ForgeHandler): ForgeServer {
  const live = new Set<Socket>();

  const server = createServer({ noDelay: true }, (socket: Socket) => {
    socket.setNoDelay(true);
    live.add(socket);
    const conn: Conn = { socket, buf: EMPTY, scan: 0, head: null, bodyAt: 0, chunks: [], chunkSize: 0, dead: false };
    socket.on('data', (chunk: Buffer) => {
      if (MEASURING) {
        reads += 1;
        readBytes += chunk.length;
      }
      conn.buf = conn.buf.length === 0 ? chunk : Buffer.concat([conn.buf, chunk]);
      drain(conn, handler);
    });
    socket.on('error', () => {
      conn.dead = true;
      socket.destroy();
    });
    socket.on('close', () => {
      conn.dead = true;
      conn.buf = EMPTY;
      live.delete(socket);
    });
    socket.on('end', () => {
      // A half-closed peer has nothing more to ask; whatever we owe it is already written.
      conn.dead = true;
      socket.end();
    });
  }) as ForgeServer;

  server.closeIdleConnections = (): void => {
    for (const socket of live) if (socket.readableLength === 0) socket.end();
  };
  server.closeAllConnections = (): void => {
    for (const socket of live) socket.destroy();
  };
  return server;
}
