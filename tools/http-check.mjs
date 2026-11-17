#!/usr/bin/env node
// tools/http-check.mjs -- wire-level checks for the hand-rolled HTTP/1.1 server.
//
// The conformance suite drives the forge through undici, which only ever sends a Content-Length
// body on a keep-alive connection. Both hand-rolled servers -- go/httpserver.go and, behind
// FORGE_NO_BINARY=1, src/http/server.ts -- also claim chunked bodies, pipelining, Expect:
// 100-continue, HEAD, Connection: close and a 400 for a malformed head, and nothing in the suite
// would notice if one of those were wrong. This file speaks raw bytes at the socket and checks
// each of them.
//
//   node tools/http-check.mjs                     the Go server main.ts hands over to
//   FORGE_NO_BINARY=1 node tools/http-check.mjs   the Node server

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.BENCH_REPO ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'check-token';

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  ok    ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `: ${detail}`}`);
  }
}

/** Start the forge behind a stub env and answer with its port. */
async function startForge() {
  let port = null;
  const waiters = [];
  let done = false;
  const env = createServer((req, res) => {
    if (req.url === '/register') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        port = JSON.parse(Buffer.concat(chunks).toString('utf8')).port;
        for (const r of waiters.splice(0)) r();
        res.end('{"ok":true}');
      });
      return;
    }
    res.end(JSON.stringify({ done }));
  });
  await new Promise((r) => env.listen(0, '127.0.0.1', r));
  const child = spawn('node', ['main.ts'], {
    cwd: REPO,
    env: { ...process.env, MAKEFUN_ENV_URL: `http://127.0.0.1:${env.address().port}`, MAKEFUN_SHOP_TOKEN: TOKEN },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await new Promise((r) => (port === null ? waiters.push(r) : r()));
  return {
    port,
    stop() {
      done = true;
      // SIGTERM, not SIGKILL: main.ts forwards it to the Go binary, and a SIGKILLed parent would
      // leave that child orphaned, polling an env that is about to close.
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
      env.close();
    },
  };
}

/** Send raw bytes, collect everything that comes back until the socket closes or `quietMs` passes. */
function speak(port, bytes, quietMs = 250) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    const chunks = [];
    let timer = null;
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(Buffer.concat(chunks).toString('latin1'));
    };
    socket.on('connect', () => {
      socket.write(bytes);
      timer = setTimeout(finish, quietMs);
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      clearTimeout(timer);
      timer = setTimeout(finish, quietMs);
    });
    socket.on('close', finish);
    socket.on('error', finish);
  });
}

const forge = await startForge();
const PORT = forge.port;
const auth = `authorization: Bearer ${TOKEN}\r\n`;
const host = `host: 127.0.0.1:${PORT}\r\n`;

try {
  console.log('HTTP/1.1 wire checks');

  {
    const body = JSON.stringify({ name: 'http-check' });
    const answer = await speak(PORT, `POST /api/v3/user/repos HTTP/1.1\r\n${host}${auth}content-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
    check('a Content-Length body creates the repository', answer.startsWith('HTTP/1.1 201 '), answer.split('\r\n')[0]);
  }

  {
    // Two whole requests in one segment: the answers must come back in order, on one connection.
    const one = `GET /healthz HTTP/1.1\r\n${host}${auth}\r\n`;
    const answer = await speak(PORT, one + one + one);
    const statuses = answer.split('HTTP/1.1 ').length - 1;
    check('pipelining answers every request in order', statuses === 3 && answer.indexOf('{"ok":true}') < answer.lastIndexOf('{"ok":true}'), `${statuses} answers`);
  }

  {
    const payload = JSON.stringify({ name: 'http-check-chunked' });
    const half = Math.floor(payload.length / 2);
    const chunked =
      `${payload.slice(0, half).length.toString(16)}\r\n${payload.slice(0, half)}\r\n` +
      `${payload.slice(half).length.toString(16)}\r\n${payload.slice(half)}\r\n0\r\n\r\n`;
    const answer = await speak(PORT, `POST /api/v3/user/repos HTTP/1.1\r\n${host}${auth}content-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n${chunked}`);
    check('a chunked body is reassembled', answer.startsWith('HTTP/1.1 201 '), answer.split('\r\n')[0]);
  }

  {
    // The same body, but arriving in three segments: a parser that appends on every re-scan
    // would assemble it with its first chunks repeated, and the JSON would not parse.
    const payload = JSON.stringify({ name: 'http-check-chunked-split' });
    const half = Math.floor(payload.length / 2);
    const pieces = [
      `POST /api/v3/user/repos HTTP/1.1\r\n${host}${auth}content-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n`,
      `${half.toString(16)}\r\n${payload.slice(0, half)}\r\n`,
      `${(payload.length - half).toString(16)}\r\n${payload.slice(half)}\r\n0\r\n\r\n`,
    ];
    const socket = connect(PORT, '127.0.0.1');
    await new Promise((r) => socket.once('connect', r));
    const answer = await new Promise((resolve) => {
      const chunks = [];
      socket.on('data', (c) => {
        chunks.push(c);
        resolve(Buffer.concat(chunks).toString('latin1'));
      });
      pieces.forEach((piece, index) => setTimeout(() => socket.write(piece), index * 40));
      setTimeout(() => resolve(Buffer.concat(chunks).toString('latin1')), 1_500);
    });
    socket.destroy();
    check('a chunked body split across segments is assembled once', answer.startsWith('HTTP/1.1 201 '), answer.split('\r\n')[0]);
  }

  {
    const payload = JSON.stringify({ name: 'http-check-continue' });
    const answer = await speak(
      PORT,
      `POST /api/v3/user/repos HTTP/1.1\r\n${host}${auth}content-type: application/json\r\nexpect: 100-continue\r\ncontent-length: ${payload.length}\r\n\r\n${payload}`,
    );
    check('Expect: 100-continue gets its interim answer', answer.startsWith('HTTP/1.1 100 Continue\r\n\r\n'), answer.split('\r\n')[0]);
    check('and then the real one', answer.includes('HTTP/1.1 201 '), answer.split('\r\n').slice(0, 4).join(' | '));
  }

  {
    // The head, then the body in two more segments. A server that re-parses the head on every
    // read -- which is what the Go server did until the head was kept on the connection -- writes
    // one "100 Continue" per segment, and a strict client sees an unexpected interim answer.
    const payload = JSON.stringify({ name: 'http-check-continue-split' });
    const half = Math.floor(payload.length / 2);
    const pieces = [
      `POST /api/v3/user/repos HTTP/1.1\r\n${host}${auth}content-type: application/json\r\nexpect: 100-continue\r\ncontent-length: ${payload.length}\r\n\r\n`,
      payload.slice(0, half),
      payload.slice(half),
    ];
    const socket = connect(PORT, '127.0.0.1');
    await new Promise((r) => socket.once('connect', r));
    const answer = await new Promise((resolve) => {
      const chunks = [];
      socket.on('data', (c) => chunks.push(c));
      pieces.forEach((piece, index) => setTimeout(() => socket.write(piece), index * 60));
      setTimeout(() => resolve(Buffer.concat(chunks).toString('latin1')), 1_500);
    });
    socket.destroy();
    const interim = answer.split('HTTP/1.1 100 Continue').length - 1;
    check('a split 100-continue body gets exactly one interim answer', interim === 1, `${interim} interim answers`);
    check('and the request still lands', answer.includes('HTTP/1.1 201 '), answer.split('\r\n')[0]);
  }

  {
    const answer = await speak(PORT, `HEAD /healthz HTTP/1.1\r\n${host}${auth}\r\n`);
    check('HEAD sends the headers and no body', answer.startsWith('HTTP/1.1 200 ') && answer.includes('content-length: 11') && answer.endsWith('\r\n\r\n'), JSON.stringify(answer.slice(-20)));
  }

  {
    const answer = await speak(PORT, `GET /healthz HTTP/1.1\r\n${host}${auth}connection: close\r\n\r\n`);
    check('Connection: close is honoured', answer.includes('connection: close') && answer.includes('{"ok":true}'), answer.split('\r\n')[0]);
  }

  {
    const answer = await speak(PORT, `GET /healthz\r\n\r\n`);
    check('a malformed request line is a 400', answer.startsWith('HTTP/1.1 400 '), JSON.stringify(answer.slice(0, 40)));
  }

  {
    const answer = await speak(PORT, `POST /api/v3/user/repos HTTP/1.1\r\n${host}${auth}content-length: 999999999\r\n\r\n`);
    check('a body past the ceiling is a 413', answer.startsWith('HTTP/1.1 413 '), answer.split('\r\n')[0]);
  }

  {
    // The head arriving in pieces must not confuse the parser's incremental search.
    const socket = connect(PORT, '127.0.0.1');
    await new Promise((r) => socket.once('connect', r));
    const answer = await new Promise((resolve) => {
      const chunks = [];
      socket.on('data', (c) => {
        chunks.push(c);
        if (Buffer.concat(chunks).includes('{"ok":true}')) resolve(Buffer.concat(chunks).toString('latin1'));
      });
      socket.write('GET /heal');
      setTimeout(() => socket.write('thz HTTP/1.1\r\n' + host), 40);
      setTimeout(() => socket.write(auth + '\r'), 80);
      setTimeout(() => socket.write('\n'), 120);
      setTimeout(() => resolve(Buffer.concat(chunks).toString('latin1')), 1_500);
    });
    socket.destroy();
    check('a head split across segments still parses', answer.startsWith('HTTP/1.1 200 '), JSON.stringify(answer.slice(0, 40)));
  }

  {
    const answer = await speak(PORT, `GET /api/v3/repos/nobody/nothing HTTP/1.1\r\n${host}\r\n`);
    check('an unauthenticated request is a JSON 401', answer.startsWith('HTTP/1.1 401 ') && answer.includes('"message"'), answer.split('\r\n')[0]);
  }
} finally {
  forge.stop();
}

console.log(failures === 0 ? '\nall wire checks passed' : `\n${failures} wire check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
