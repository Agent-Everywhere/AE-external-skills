import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_NAME, cacheDirFor, defaultConfigPath, loadConfig, resolveEmail, saveConfig } from "../src/config.js";
import { tmpDir } from "./helpers.js";

test("config lives in the working folder and round-trips the user's email", async () => {
  const dir = tmpDir();
  const path = defaultConfigPath(dir);
  assert.equal(path, join(dir, CONFIG_NAME));
  assert.equal(await loadConfig(path), null);
  await saveConfig(path, { email: "rep@sales.test" });
  assert.deepEqual(await loadConfig(path), { contact_email: "rep@sales.test" });
  assert.equal(cacheDirFor(path), join(dir, ".sec-funding-cache"));
});

test("an address that is not an email is refused", async () => {
  await assert.rejects(() => saveConfig(join(tmpDir(), "c.json"), { email: "not-an-email" }), /email/);
  await assert.rejects(() => saveConfig(join(tmpDir(), "c.json"), { email: "" }), /email/);
});

test("email precedence: --email flag, then env, then config; none is null", () => {
  const config = { contact_email: "cfg@x.co" };
  const env = { SEC_FUNDING_CONTACT_EMAIL: "env@x.co" };
  assert.deepEqual(resolveEmail({ flag: "flag@x.co", env, config }), { email: "flag@x.co", source: "--email flag" });
  assert.equal(resolveEmail({ env, config }).email, "env@x.co");
  assert.equal(resolveEmail({ env: {}, config }).email, "cfg@x.co");
  assert.equal(resolveEmail({ env: {}, config: null }), null);
  assert.throws(() => resolveEmail({ flag: "bad", env: {}, config: null }), /email/);
});

test("the shipped source hardcodes no email address", async () => {
  const { readdirSync } = await import("node:fs");
  const src = new URL("../src/", import.meta.url).pathname;
  for (const f of readdirSync(src)) assert.doesNotMatch(readFileSync(join(src, f), "utf8"), /[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[a-z]{2,}/, f);
});
