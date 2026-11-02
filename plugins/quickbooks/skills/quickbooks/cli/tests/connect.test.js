import test from "node:test";
import assert from "node:assert/strict";
import { resolveWsUrl, Page } from "../src/cdp.js";
import { redact, stats } from "../src/output.js";

test("resolveWsUrl passes ws urls and reads /json/version", async () => {
  assert.equal(await resolveWsUrl("ws://a/b"), "ws://a/b");
  assert.equal(await resolveWsUrl("http://h:9", async (u) => { assert.equal(u, "http://h:9/json/version"); return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://h/x" }) }; }), "ws://h/x");
});

test("redact and stats", () => {
  assert.equal(redact("at wss://secret/host intuit_apikey=abc,"), "at <cdp-url> intuit_apikey=<redacted>,");
  assert.deepEqual(stats([5, 1, 3, 2, 4]), { n: 5, median: 3, p95: 5, min: 1, max: 5 });
});

function fakeCdp(targetInfos) {
  const sent = [];
  return {
    sent,
    async send(method, params) {
      sent.push([method, params]);
      if (method === "Target.getTargets") return { targetInfos };
      if (method === "Target.createTarget") return { targetId: "new-tab" };
      if (method === "Target.attachToTarget") return { sessionId: "sess-" + params.targetId };
      return {};
    },
  };
}
const tab = (targetId, url) => ({ targetId, type: "page", url });

test("Page.open reuses a QuickBooks tab and leaves the others alone", async () => {
  const cdp = fakeCdp([tab("mail", "https://mail.example.com/"), tab("qbo", "https://qbo.intuit.com/app/homepage")]);
  const p = await Page.open(cdp, { reuse: true });
  assert.equal(p.targetId, "qbo");
  assert.ok(!cdp.sent.some(([m]) => m === "Target.createTarget" || m === "Page.navigate"));
});

test("Page.open with no QuickBooks tab opens a new target and never touches the user's other tabs", async () => {
  const cdp = fakeCdp([tab("mail", "https://mail.example.com/"), tab("bank", "https://bank.example.com/")]);
  const p = await Page.open(cdp, { reuse: true });
  assert.equal(p.targetId, "new-tab");
  assert.ok(cdp.sent.some(([m]) => m === "Target.createTarget"));
  const attached = cdp.sent.filter(([m]) => m === "Target.attachToTarget").map(([, a]) => a.targetId);
  assert.deepEqual(attached, ["new-tab"]);
});

test("Page.open may reuse a blank tab", async () => {
  const cdp = fakeCdp([tab("mail", "https://mail.example.com/"), tab("blank", "about:blank")]);
  const p = await Page.open(cdp, { reuse: true });
  assert.equal(p.targetId, "blank");
  assert.ok(!cdp.sent.some(([m]) => m === "Target.createTarget"));
});
