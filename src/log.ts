// The forge's one way of writing a diagnostic line, and the reason it exists.
//
// A write to a stderr whose reader has gone away throws EPIPE. Thrown from inside the
// uncaughtException handler, that EPIPE is caught by the same handler, which writes again: one log
// line becomes a loop that burns a whole core for the rest of the trial. So every line goes
// through here, nothing it does can throw, and the first failure switches logging off for good --
// the forge keeps serving, which is the half of its job that scores.

/** Set once a write has failed: the log is gone and asking again only costs CPU. */
let broken = false;

/** Write one tagged line to stderr, swallowing any failure. */
export function note(tag: string, line: string): void {
  if (broken) return;
  try {
    process.stderr.write(`${tag} ${line}\n`);
  } catch {
    broken = true;
  }
}
