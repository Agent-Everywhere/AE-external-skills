import { test } from "node:test";
import assert from "node:assert/strict";
import { filterAgents, parseDuration, resolveAgent, resolveMany, sortAgents } from "../src/agents.js";

const roster = [
  { id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Researcher", createdAt: 1000, lastActivityAt: 5000, isHiddenFromSidebar: false },
  { id: "11112222-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Writer", createdAt: 2000, lastActivityAt: 9000, isHiddenFromSidebar: true, unreadCount: 3 },
  { id: "33333333-cccc-4ccc-8ccc-cccccccccccc", name: "Research Lead", createdAt: 3000, lastActivityAt: 1000, isGroup: true, isRunningTurn: true },
];

test("resolve by id, prefix, exact name, unique substring", () => {
  assert.equal(resolveAgent(roster, roster[1].id).name, "Writer");
  assert.equal(resolveAgent(roster, "3333").name, "Research Lead");
  assert.throws(() => resolveAgent(roster, "1111"), /matches 2 agents/);
  assert.equal(resolveAgent(roster, "researcher").id, roster[0].id);
  assert.equal(resolveAgent(roster, "writ").name, "Writer");
  assert.throws(() => resolveAgent(roster, "research"), /matches 2 agents/);
  assert.throws(() => resolveAgent(roster, "zzz"), /No agent matches/);
  assert.equal(resolveMany(roster, ["Writer", "writ"]).length, 1);
});

test("filters", () => {
  assert.equal(filterAgents(roster).length, 2, "hidden excluded by default");
  assert.equal(filterAgents(roster, { includeHidden: true }).length, 3);
  assert.equal(filterAgents(roster, { hidden: true })[0].name, "Writer");
  assert.equal(filterAgents(roster, { groups: true })[0].name, "Research Lead");
  assert.equal(filterAgents(roster, { name: "Research*" }).length, 2);
  assert.equal(filterAgents(roster, { includeHidden: true, unread: true })[0].name, "Writer");
  assert.equal(filterAgents(roster, { running: true })[0].name, "Research Lead");
  const sections = [{ id: "s1", name: "S", agentIds: [roster[0].id] }];
  assert.equal(filterAgents(roster, { section: "s1" }, sections).length, 1);
  assert.equal(filterAgents(roster, { section: "none" }, sections)[0].name, "Research Lead");
  assert.equal(filterAgents(roster, { ids: [roster[2].id] }).length, 1);
});

test("sort + duration", () => {
  assert.deepEqual(sortAgents(roster, "name").map((a) => a.name), ["Research Lead", "Researcher", "Writer"]);
  assert.equal(sortAgents(roster, "activity")[0].name, "Writer");
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.throws(() => parseDuration("soon"), /Bad duration/);
});
