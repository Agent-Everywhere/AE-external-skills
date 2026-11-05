import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRESETS, getPreset, presetNames } from "../src/presets.js";
import { ProfileError, loadProfile, resolveKeywords, saveProfile, validateProfile } from "../src/profile.js";
import { tmpDir } from "./helpers.js";

const good = () => ({
  name: "mine", offer: "We sell widgets", icp: { description: "x" }, keywords: ["robot*", "humanoid"], excludes: { terms: ["fund"], companies: ["Acme"] },
  min_amount: 1000000, max_amount: null, states: ["CA", "tx"], qualify_rules: { strong: ["a"], maybe: ["b"], no: ["c"] }, buyer_titles: ["CEO"],
});

test("a complete profile validates cleanly", () => {
  assert.deepEqual(validateProfile(good()), { errors: [], warnings: [] });
});

test("bad shapes are reported, each with its field name", () => {
  const { errors } = validateProfile({ keywords: [], excludes: { terms: "x" }, min_amount: -1, states: ["California"], qualify_rules: [], buyer_titles: "CEO", icp: "x" });
  for (const field of ["keywords", "excludes.terms", "min_amount", "states", "qualify_rules", "buyer_titles", "icp"]) assert.ok(errors.some((e) => e.includes(field)), field);
  assert.ok(validateProfile({ ...good(), min_amount: 5, max_amount: 1 }).errors.some((e) => /min_amount is greater/.test(e)));
  assert.ok(validateProfile(null).errors.length);
});

test("an unfilled offer and unknown keys only warn", () => {
  const w = validateProfile({ ...good(), offer: "FILL IN: what you sell", extra: 1 }).warnings.join("|");
  assert.match(w, /placeholder/);
  assert.match(w, /unknown key "extra"/);
});

test("save then load round-trips; saving refuses to overwrite unless asked", async () => {
  const path = join(tmpDir(), "profile.json");
  await saveProfile(path, good());
  const { profile, warnings } = await loadProfile(path);
  assert.deepEqual(profile, good());
  assert.deepEqual(warnings, []);
  await assert.rejects(() => saveProfile(path, good()), /already exists/);
  await saveProfile(path, { ...good(), name: "v2" }, { overwrite: true });
  assert.equal((await loadProfile(path)).profile.name, "v2");
});

test("loading a missing, malformed or invalid profile is a ProfileError", async () => {
  const dir = tmpDir();
  await assert.rejects(() => loadProfile(join(dir, "nope.json")), ProfileError);
  writeFileSync(join(dir, "bad.json"), "{not json");
  await assert.rejects(() => loadProfile(join(dir, "bad.json")), /not valid JSON/);
  writeFileSync(join(dir, "inv.json"), JSON.stringify({ keywords: [] }));
  await assert.rejects(() => loadProfile(join(dir, "inv.json")), /keywords/);
  await assert.rejects(() => saveProfile(join(dir, "x.json"), { keywords: [] }), /invalid/);
});

test("keywords come from a file, a preset name or a comma list; duplicates collapse", async () => {
  const dir = tmpDir();
  const file = join(dir, "kw.txt");
  writeFileSync(file, "# my terms\nrobot*\nembodied AI, humanoid\n\nROBOT*\n");
  assert.deepEqual(await resolveKeywords(file, { presets: PRESETS }), ["robot*", "embodied AI", "humanoid"]);
  assert.deepEqual(await resolveKeywords("ai-data", { presets: PRESETS }), PRESETS["ai-data"].keywords);
  assert.deepEqual(await resolveKeywords("alpha, beta gamma", { presets: PRESETS }), ["alpha", "beta gamma"]);
  await assert.rejects(() => resolveKeywords("", { presets: PRESETS }), ProfileError);
  await assert.rejects(() => resolveKeywords(" , ", { presets: PRESETS }), ProfileError);
});

test("a keyword like C# survives; # comments are dropped only in files", async () => {
  assert.deepEqual(await resolveKeywords("C#, F#, .NET", { presets: PRESETS }), ["C#", "F#", ".NET"]);
  const file = join(tmpDir(), "kw.txt");
  writeFileSync(file, "# comment\nC#\nrust # trailing comment\n");
  assert.deepEqual(await resolveKeywords(file, { presets: PRESETS }), ["C#", "rust"]);
});

test("a bare word is a keyword, never a file name; files need an explicit path or file: true", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "robotics"), "from-the-file\n");
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.deepEqual(await resolveKeywords("robotics", { presets: PRESETS }), ["robotics"]);
    assert.deepEqual(await resolveKeywords("./robotics", { presets: PRESETS }), ["from-the-file"]);
    assert.deepEqual(await resolveKeywords("robotics", { presets: PRESETS, file: true }), ["from-the-file"]);
    await assert.rejects(() => resolveKeywords("./missing.txt", { presets: PRESETS }), /not found/);
    await assert.rejects(() => resolveKeywords("missing.txt", { presets: PRESETS, file: true }), /not found/);
  } finally { process.chdir(cwd); }
});

test("the two example presets ship as profiles/*.json that match the code, and carry no seller pitch", () => {
  assert.deepEqual(presetNames().sort(), ["ai-data", "physical-ai"]);
  for (const name of presetNames()) {
    const onDisk = JSON.parse(readFileSync(new URL(`../../profiles/${name}.json`, import.meta.url), "utf8"));
    assert.deepEqual(onDisk, getPreset(name), name);
    assert.deepEqual(validateProfile(onDisk).errors, [], name);
    assert.match(onDisk.offer, /^FILL IN/, "presets must not hardcode what the user sells");
  }
  assert.deepEqual(PRESETS["physical-ai"].keywords.slice(0, 2), ["robot*", "humanoid"]);
  assert.ok(PRESETS["ai-data"].keywords.includes("data annotation"));
});
