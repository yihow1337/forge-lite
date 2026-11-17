// main.ts -- the entry's lifecycle, and the handover to the Go forge.
//
// THE HANDOVER
//   The forge was ported to Go (./go, built to ./bin/forge by tools/build-go.sh). The harness runs
//   `node /bot/main.ts`, so this file's first job is to hand the trial to that binary: spawn it
//   with our stdio and our environment, forward SIGTERM, and exit with its code. The binary speaks
//   the same wire and owns the same lifecycle, so from the env's side nothing changed.
//
//   If the binary cannot run -- it is absent, not executable, or the wrong format -- the Node forge
//   below takes the trial instead, so a bad build costs some wall time rather than the whole score.
//
// THE LIFECYCLE, which both forges implement
//   1. bind an ephemeral port -- listen(0), never 8080, which the env owns on the one-pod layout;
//   2. announce that port with POST $MAKEFUN_ENV_URL/register {"port": N};
//   3. poll GET $MAKEFUN_ENV_URL/done until the body carries done === true;
//   4. close the listener and exit 0.
//
// The env is dialled over node:http with a single keep-alive agent rather than fetch: the done poll
// runs for the whole trial alongside a 2000-request benchmark, so it must not cost a fresh socket
// and a fresh DNS lookup every time. It must also never hold a request open -- the env answers a
// poll at once, and the waiting happens here, between calls.

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { RequestOptions } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import type { ForgeServer } from './src/http/server.ts';
import { note } from './src/log.ts';

/** Every line this file writes to stderr starts with this. */
const TAG = '[entry]';

/** The env's own port: an ephemeral bind must never land on it. */
const ENV_PORT = 8080;

/** How long a single register attempt may take before it is retried. */
const REGISTER_TIMEOUT_MS = 5_000;
/** The first wait between register attempts, and the longest one. */
const REGISTER_WAIT_MS = 100;
const REGISTER_WAIT_MAX_MS = 2_000;

/** How long a single done poll may take. The env answers inside a second; this is the panic rope. */
const DONE_TIMEOUT_MS = 10_000;
/** The first wait between done polls, and the longest one. */
const DONE_WAIT_MS = 250;
const DONE_WAIT_MAX_MS = 2_000;

function log(line: string): void {
  note(TAG, line);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** An exponential wait, doubled per attempt and capped. */
function backoff(attempt: number, first: number, cap: number): number {
  return Math.min(cap, first * 2 ** Math.max(0, attempt));
}

/**
 * Whether a repeated failure is worth a line. An env that never answers would otherwise fill the
 * trial's log with one line every two seconds for fifteen minutes; the first few attempts and then
 * every tenth say the same thing in a readable amount of space.
 */
function worthLogging(attempt: number): boolean {
  return attempt < 3 || attempt % 10 === 0;
}

/** What one env call came back with. A thrown error means the call never got an answer. */
interface Answer {
  readonly status: number;
  readonly body: string;
}

/**
 * The env's origin, with any trailing slashes trimmed. An unset MAKEFUN_ENV_URL is fatal at once:
 * there is nothing to register with, so staying up would only burn the trial's wall clock.
 */
function envOrigin(): URL {
  const raw = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');
  if (raw === '') {
    log('MAKEFUN_ENV_URL is unset: no env to register with');
    process.exit(1);
  }
  try {
    return new URL(raw);
  } catch {
    log(`MAKEFUN_ENV_URL is not a URL: ${raw}`);
    process.exit(1);
  }
}

/** One request to the env, with its own timeout, over the shared keep-alive agent. */
function call(
  origin: URL,
  agent: http.Agent,
  method: string,
  path: string,
  payload: string | null,
  timeoutMs: number,
): Promise<Answer> {
  const secure = origin.protocol === 'https:';
  const options: RequestOptions = {
    agent,
    protocol: origin.protocol,
    hostname: origin.hostname,
    port: origin.port !== '' ? origin.port : secure ? 443 : 80,
    method,
    path: `${origin.pathname.replace(/\/+$/, '')}${path}`,
    headers:
      payload === null
        ? { accept: 'application/json' }
        : {
            accept: 'application/json',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
  };

  return new Promise<Answer>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, answer?: Answer): void => {
      if (settled) return;
      settled = true;
      if (err !== null) reject(err);
      else resolve(answer as Answer);
    };

    const req = (secure ? https.request : http.request)(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        finish(null, { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (err: Error) => {
        res.destroy();
        finish(err);
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`${method} ${path} timed out after ${timeoutMs} ms`));
    });
    req.on('error', (err: Error) => finish(err));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** Parse an env answer, tolerating the trailing newline it writes. Null when the body is not JSON. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/**
 * Bind an ephemeral port. listen(0) picks one from the local range, which is far above 8080, but the
 * rebind keeps the promise the contract makes rather than trusting sysctl.
 */
function bind(server: ForgeServer): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const attempt = (left: number): void => {
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen(0, '0.0.0.0', () => {
        server.removeListener('error', onError);
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('the listener has no numeric address'));
          return;
        }
        if (address.port === ENV_PORT && left > 0) {
          log(`listen(0) handed out ${ENV_PORT}, which is the env's: rebinding`);
          server.close(() => attempt(left - 1));
          return;
        }
        resolve(address.port);
      });
    };
    attempt(4);
  });
}

/**
 * Tell the env where we listen. A 2xx is the first register; a 409 means a register already landed
 * for this entry (a retry whose answer we missed), which counts as registered just the same.
 * Anything else -- a refused connection while the env is still binding, a 5xx, a timeout -- is worth
 * another attempt: the boot budget is the only real deadline and giving up early scores nothing.
 */
async function announce(origin: URL, agent: http.Agent, port: number): Promise<void> {
  const payload = JSON.stringify({ port });
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await call(origin, agent, 'POST', '/register', payload, REGISTER_TIMEOUT_MS);
      if (answer.status >= 200 && answer.status < 300) {
        log(`registered port ${port} with the env`);
        return;
      }
      if (answer.status === 409) {
        log(`the env already has a register for this entry (409); port ${port} stands`);
        return;
      }
      if (worthLogging(attempt)) log(`register answered ${answer.status}: ${answer.body.trim().slice(0, 200)}`);
    } catch (err) {
      if (worthLogging(attempt)) {
        log(`register attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await wait(backoff(attempt, REGISTER_WAIT_MS, REGISTER_WAIT_MAX_MS));
  }
}

/**
 * Poll until the suite is over. Each request carries its own timeout and is never held open; the
 * wait between polls grows to a couple of seconds so the poll stays invisible next to the benchmark.
 * A failed poll is not fatal: the env may be busy exporting, and the trial is only over when it says
 * so, so the loop keeps asking.
 */
async function awaitDone(origin: URL, agent: http.Agent): Promise<void> {
  let quiet = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await call(origin, agent, 'GET', '/done', null, DONE_TIMEOUT_MS);
      if (answer.status >= 200 && answer.status < 300) {
        const parsed = parseJson(answer.body);
        if (typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).done === true) {
          log('the env reports the suite is done');
          return;
        }
        quiet = 0;
      } else if (quiet === 0) {
        quiet = 1;
        log(`done answered ${answer.status}: ${answer.body.trim().slice(0, 200)}`);
      }
    } catch (err) {
      if (quiet === 0) {
        quiet = 1;
        log(`done poll failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await wait(backoff(attempt, DONE_WAIT_MS, DONE_WAIT_MAX_MS));
  }
}

/** Stop listening, hang up on whatever is still parked on a keep-alive socket, and leave. */
function leave(server: ForgeServer, agent: http.Agent, code: number): void {
  try {
    server.close();
    server.closeIdleConnections();
    server.closeAllConnections();
    agent.destroy();
  } catch (err) {
    log(`shutdown complained: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(code);
}

// ---------------------------------------------------------------- the Go forge

/** Where the committed binary lives, relative to this file rather than to the cwd. */
const FORGE_BINARY = join(dirname(fileURLToPath(import.meta.url)), 'bin', 'forge');

/**
 * How long after the binary starts an exit still counts as "it never got going". A binary that
 * dies in its first moments has not registered yet, so the Node forge can still take the trial;
 * one that dies an hour in has, and a second register would only confuse the env.
 */
const FORGE_STARTUP_MS = 3_000;

/**
 * Hand the trial to the Go forge. This resolves only when the binary could not take it -- it is
 * absent, not executable, the wrong format, or it died before it could have registered -- which is
 * the caller's signal to serve from Node instead. When the binary does take the trial this never
 * resolves: the binary owns the lifecycle, and this process exits with the binary's code.
 */
async function delegate(): Promise<void> {
  // tools/bench.mjs sets this to measure the Node forge against the Go one in the same tool.
  if (process.env.FORGE_NO_BINARY === '1') {
    log('FORGE_NO_BINARY=1: serving from Node');
    return;
  }
  try {
    accessSync(FORGE_BINARY, constants.X_OK);
  } catch (err) {
    log(`${FORGE_BINARY} is not runnable (${err instanceof Error ? err.message : String(err)}): serving from Node`);
    return;
  }

  const child = spawn(FORGE_BINARY, [], { stdio: 'inherit', env: process.env });

  const started = await new Promise<boolean>((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', (err: Error) => {
      log(`${FORGE_BINARY} would not start (${err.message}): serving from Node`);
      resolve(false);
    });
  });
  if (!started) return;

  const startedAt = Date.now();
  // A later error -- an EPERM on kill, say -- must not become an unhandled 'error' event.
  child.on('error', (err: Error) => log(`the Go forge reported ${err.message}`));

  // The harness SIGTERMs the entry when the trial ends. The binary shuts down on it by itself, so
  // all this has to do is pass it on and let the child's exit end this process.
  const forward = (signal: NodeJS.Signals) => (): void => {
    try {
      child.kill(signal);
    } catch {
      // The child is already gone; its exit handler is what ends this process.
    }
  };
  const handlers: Array<[NodeJS.Signals, () => void]> = [
    ['SIGTERM', forward('SIGTERM')],
    ['SIGINT', forward('SIGINT')],
  ];
  for (const [signal, handler] of handlers) process.on(signal, handler);

  return await new Promise<void>((resolve) => {
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      const elapsed = Date.now() - startedAt;
      if (code === 0) {
        log('the Go forge finished');
        process.exit(0);
      }
      if (elapsed < FORGE_STARTUP_MS) {
        // It cannot have registered yet, so nothing is lost by taking over.
        log(`the Go forge exited ${code ?? signal} after ${elapsed} ms without registering: serving from Node`);
        for (const [held, handler] of handlers) process.removeListener(held, handler);
        resolve();
        return;
      }
      log(`the Go forge exited ${code ?? signal} after ${elapsed} ms`);
      process.exit(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  await delegate();

  const origin = envOrigin();
  const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 4 });
  const server = createApp();

  // The harness SIGTERMs the entry when the trial ends; that is a clean finish, not a failure.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log(`${signal}: shutting down`);
      leave(server, agent, 0);
    });
  }

  const port = await bind(server);
  log(`the forge is listening on port ${port}`);

  // bind() watches for an error only while it binds. From here on a listener error -- EMFILE when
  // the benchmark's sockets pile up, say -- must be absorbed rather than thrown at the process: the
  // forge keeps serving everything it still holds, and a trial that loses its listener still ends
  // on the done poll rather than on a crash.
  server.on('error', (err: Error) => log(`the listener reported ${err.name}: ${err.message}`));

  await announce(origin, agent, port);
  await awaitDone(origin, agent);
  leave(server, agent, 0);
}

main().catch((err: unknown) => {
  log(`the lifecycle failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
