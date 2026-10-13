#!/usr/bin/env node
import { run } from "../src/cli.js";
import { redact } from "../src/session.js";

run(process.argv).catch((err) => {
  const text = process.env.GROKBOT_DEBUG && err?.stack ? err.stack : `grokbot: ${err?.message ?? err}`;
  process.stderr.write(redact(text) + "\n");
  process.exit(typeof err?.exitCode === "number" ? err.exitCode : 1);
});
