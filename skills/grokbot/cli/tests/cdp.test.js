import "./_isolate.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cdp, SIDEBAR_SECTIONS_EXPR, resolveDesktopCall } from "../src/cdp.js";

test("legacy window.desktop read paths are aliased onto the 0.79 main.* bridge; explicit args win; writes are not aliased", () => {
  assert.deepEqual(resolveDesktopCall("cursorAccount.getStatus", []), { path: "main.getCursorAuthStatus", args: [] });
  assert.deepEqual(resolveDesktopCall("agent.getPinnedAgents", []), { path: "main.getHostPinnedAgents", args: [] });
  assert.deepEqual(resolveDesktopCall("getBoxHostPhase", []), { path: "main.getBoxHostPhase", args: [] });
  const sections = resolveDesktopCall("agent.getSidebarSections", []);
  assert.equal(sections.expr, SIDEBAR_SECTIONS_EXPR);
  assert.match(SIDEBAR_SECTIONS_EXPR, /getCursorAuthStatus\(\)\.then\(.*getHostSidebarSections\(\{ accountSlot: s\.authId \?\? null \}\)/, "the account slot is the signed-in principal");
  assert.deepEqual(resolveDesktopCall("cursorAccount.getStatus", [1]).args, [1]);
  assert.deepEqual(resolveDesktopCall("agent.setSidebarSections", [[]]), { path: "agent.setSidebarSections", args: [[]] });
  assert.deepEqual(resolveDesktopCall("main.getTimeZone", []), { path: "main.getTimeZone", args: [] });
});

test("callDesktop evaluates the aliased expression and explains a missing legacy namespace", async () => {
  const seen = [];
  const cdp = Object.create(Cdp.prototype);
  cdp.evaluate = async (expr) => {
    seen.push(expr);
    if (expr.includes("agent.setSidebarSections")) throw new Error("renderer threw: TypeError: Cannot read properties of undefined (reading 'setSidebarSections')");
    return "ok";
  };
  assert.equal(await cdp.callDesktop("cursorAccount.getStatus"), "ok");
  assert.equal(seen[0], "window.desktop.main.getCursorAuthStatus(...[])");
  assert.equal(await cdp.callDesktop("agent.getSidebarSections"), "ok");
  assert.equal(seen[1], SIDEBAR_SECTIONS_EXPR);
  await assert.rejects(cdp.callDesktop("agent.setSidebarSections", [[]]), /namespaced under main\.\* since app 0\.79/);
  await assert.rejects(Object.assign(Object.create(Cdp.prototype), { evaluate: async () => { throw new Error("boom"); } }).callDesktop("main.x"), /^Error: boom$/);
});
