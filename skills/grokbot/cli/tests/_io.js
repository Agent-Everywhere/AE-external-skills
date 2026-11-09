// stdout/stderr capture for CLI tests. The node:test runner writes through process.stdout.write asynchronously (TAP text
// when a file runs directly, binary v8-serialized frames when it runs under `node --test`), so a blanket swallow loses
// reports of tests that finished around the capture window and the summary under-counts. Non-string chunks and anything
// that looks like TAP are passed through; the CLI's own output (JSON, tables, notes) is plain strings and is captured.
const RUNNER_LINE = /^(TAP version|# |ok \d|not ok \d|\d+\.\.\d+|\s+---|\s+\.\.\.|\s+(duration_ms|type|location|failureType|error|code|name|expected|actual|operator|stack|skip|todo):)/;
export const isRunnerOutput = (chunk) => typeof chunk !== "string" || RUNNER_LINE.test(chunk);

export function captureIo() {
  const out = [];
  const err = [];
  const o = process.stdout.write;
  const e = process.stderr.write;
  process.stdout.write = function (chunk, ...rest) {
    if (isRunnerOutput(chunk)) return o.call(process.stdout, chunk, ...rest);
    out.push(String(chunk));
    return true;
  };
  process.stderr.write = function (chunk, ...rest) {
    if (isRunnerOutput(chunk)) return e.call(process.stderr, chunk, ...rest);
    err.push(String(chunk));
    return true;
  };
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = o;
      process.stderr.write = e;
    },
  };
}
