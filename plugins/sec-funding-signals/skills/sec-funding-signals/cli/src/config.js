// Local config: the user's own contact email for the SEC User-Agent, kept in their working folder. Never hardcoded.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";

export const CONFIG_NAME = "sec-funding-signals.config.json";
export const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export const defaultConfigPath = (cwd) => join(cwd, CONFIG_NAME);
export const cacheDirFor = (configPath) => join(dirname(resolve(configPath)), ".sec-funding-cache");

export async function loadConfig(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw new Error(`could not read ${path}: ${e.message}`); }
}

export async function saveConfig(path, { email }) {
  if (!EMAIL_RE.test(email || "")) throw new Error(`"${email}" does not look like an email address`);
  await writeFile(path, JSON.stringify({ contact_email: email }, null, 2) + "\n");
}

/** Precedence: --email flag (this run only), SEC_FUNDING_CONTACT_EMAIL, then the config file. */
export function resolveEmail({ flag, env, config }) {
  for (const [source, v] of [["--email flag", flag], ["SEC_FUNDING_CONTACT_EMAIL", env && env.SEC_FUNDING_CONTACT_EMAIL], ["config file", config && config.contact_email]]) {
    if (v) {
      if (!EMAIL_RE.test(String(v))) throw new Error(`contact email from ${source} does not look like an email address`);
      return { email: String(v), source };
    }
  }
  return null;
}
