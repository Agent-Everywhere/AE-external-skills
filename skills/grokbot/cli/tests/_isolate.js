// Import this first in any test that reaches buildProgram()/gateway(): point the app-support dir at an empty temp dir so
// no test can discover the real signed-in Cursor account (a runtime client would turn a mocked write into a live one).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GROKBOT_APP_SUPPORT = mkdtempSync(join(tmpdir(), "grokbot-appsupport-"));
process.env.GROKBOT_HOME = mkdtempSync(join(tmpdir(), "grokbot-home-"));
