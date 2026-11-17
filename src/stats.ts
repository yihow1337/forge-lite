// Instrumentation for tools/bench.mjs, loaded only when FORGE_STATS=1.
//
// The grader runs on gVisor, where a write syscall costs many times what it costs on a normal
// kernel, so "how many stream writes did one response take" is the number worth watching. libuv's
// stream handle is the last place in the process where a write is still one write: every
// socket.write, every cork/uncork batch and every writev collapses into one of the handle methods
// wrapped below, and each of those is one syscall. Counting here therefore counts syscalls, not
// userland calls.
//
// Nothing in this file is imported unless FORGE_STATS=1, and the only cost it adds to the forge
// proper is one integer increment per response.

import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import type { Server } from 'node:net';
import { responsesWritten } from './http/server.ts';
import { note } from './log.ts';

/** The handle methods libuv turns into a write(2)/writev(2) on the socket. */
const HANDLE_WRITES = ['writeBuffer', 'writev', 'writeLatin1String', 'writeUtf8String', 'writeAsciiString', 'writeUcs2String'] as const;

let writes = 0;

/** Count the forge's stream writes and dump the counters on SIGUSR2 (bench.mjs reads the line). */
export function install(server: Server): void {
  server.on('connection', (socket: unknown) => {
    const handle = (socket as { _handle?: Record<string, unknown> })._handle;
    if (handle === undefined || handle === null || handle.__forgeStats === true) return;
    handle.__forgeStats = true;
    for (const name of HANDLE_WRITES) {
      const original = handle[name];
      if (typeof original !== 'function') continue;
      handle[name] = function wrapped(this: unknown, ...args: unknown[]): unknown {
        writes += 1;
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
    }
  });
  process.on('SIGUSR2', () => {
    note('[forge-stats]', JSON.stringify({ writes, responses: responsesWritten() }));
  });
  if (process.env.FORGE_PROF !== undefined && process.env.FORGE_PROF !== '') installProfiler(process.env.FORGE_PROF);
}

/**
 * Sample the forge's own CPU while it serves, and write the V8 profile on SIGUSR1. --cpu-prof
 * cannot be used here: main.ts ends the process with process.exit, which never flushes one.
 */
function installProfiler(path: string): void {
  const session = new Session();
  session.connect();
  session.post('Profiler.enable', () => {
    session.post('Profiler.setSamplingInterval', { interval: 100 }, () => {
      session.post('Profiler.start');
    });
  });
  process.on('SIGUSR1', () => {
    session.post('Profiler.stop', (_err: unknown, result: { profile: unknown }) => {
      writeFileSync(path, JSON.stringify(result.profile));
      note('[forge-stats]', `profile written to ${path}`);
      session.post('Profiler.start');
    });
  });
}
