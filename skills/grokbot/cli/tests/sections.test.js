import { test } from "node:test";
import assert from "node:assert/strict";
import { assignAgents, createSection, deleteSection, findSection, moveSection, normalizeSections, pruneSections, renameSection, sectionIdByAgent, sectionsDiff } from "../src/sections.js";

const base = () => normalizeSections([
  { id: "section-a-1", name: "Swarm", agentIds: ["a1", "a2"] },
  { id: "section-b-2", name: "Clients", agentIds: ["b1"] },
]);

test("normalize drops malformed entries and duplicate agent ids", () => {
  const s = normalizeSections([{ id: "x", name: "X", agentIds: ["1", "1", 2] }, { id: 5 }, null, { id: "y", name: "Y", agentIds: ["1"] }]);
  assert.deepEqual(s, [{ id: "x", name: "X", agentIds: ["1"] }, { id: "y", name: "Y", agentIds: [] }]);
});

test("create detaches agents from other sections and appends", () => {
  const { sections, section } = createSection(base(), "New", ["a2", "c9"], { id: "section-c-3" });
  assert.equal(section.id, "section-c-3");
  assert.deepEqual(sections.map((s) => s.agentIds), [["a1"], ["b1"], ["a2", "c9"]]);
  assert.throws(() => createSection(sections, "swarm"), /already exists/);
  assert.throws(() => createSection(sections, "  "), /blank/);
});

test("rename / delete / move / assign", () => {
  let s = renameSection(base(), "Swarm", "Bots").sections;
  assert.equal(s[0].name, "Bots");
  assert.throws(() => renameSection(s, "Bots", "clients"), /already exists/);
  const del = deleteSection(s, "section-b-2");
  assert.deepEqual(del.released, ["b1"]);
  assert.equal(del.sections.length, 1);
  s = assignAgents(base(), "Clients", ["a1", "z1"]);
  assert.deepEqual(s.map((x) => x.agentIds), [["a2"], ["b1", "a1", "z1"]]);
  s = assignAgents(s, null, ["b1"]);
  assert.deepEqual(s[1].agentIds, ["a1", "z1"]);
  s = moveSection(base(), "Clients", 0);
  assert.equal(s[0].name, "Clients");
});

test("find by id, exact name, substring; ambiguity throws", () => {
  const s = base();
  assert.equal(findSection(s, "section-a-1").name, "Swarm");
  assert.equal(findSection(s, "clients").id, "section-b-2");
  assert.equal(findSection(s, "war").id, "section-a-1");
  assert.equal(findSection(s, "nope"), null);
  assert.equal(findSection([...s, { id: "q", name: "Swarm2", agentIds: [] }], "swarm").id, "section-a-1", "exact name beats partial");
  assert.throws(() => findSection([...s, { id: "q", name: "Swarm2", agentIds: [] }], "swar"), /matches 2/);
});

test("prune removes dead ids and optionally empty sections", () => {
  const { sections, removed, droppedSections } = pruneSections(base(), ["a1"], { dropEmpty: true });
  assert.equal(removed, 2);
  assert.deepEqual(sections, [{ id: "section-a-1", name: "Swarm", agentIds: ["a1"] }]);
  assert.equal(droppedSections[0].name, "Clients");
});

test("sectionIdByAgent first wins; diff describes changes", () => {
  const m = sectionIdByAgent(base());
  assert.equal(m.get("b1"), "section-b-2");
  const after = createSection(base(), "Third", ["a1"], { id: "t" }).sections;
  const d = sectionsDiff(base(), after);
  assert.ok(d.some((l) => l.includes('+ section "Third"')));
  assert.ok(d.some((l) => l.includes('"Swarm": +0 −1')));
});
