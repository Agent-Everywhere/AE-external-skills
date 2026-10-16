import { SNIPPETS } from "../src/snippets.js";

/** Fake CDP page: answers ready.js, qbo_api.js (via handler) and ui_read.js. Records calls. */
export function fakePage({ state = "ready", api = () => ({ status: 200, data: {} }), ui = () => ({ tables: [] }) } = {}) {
  const calls = [];
  return {
    calls, sessionId: "s1",
    async run(src, params) {
      if (src === SNIPPETS["ready.js"]) return { state: typeof state === "function" ? state() : state, url: "https://qbo.intuit.com/app/homepage" };
      if (src === SNIPPETS["qbo_api.js"]) { calls.push(params); const r = api(params); return { realm: "123", ...r }; }
      if (src === SNIPPETS["ui_read.js"]) return ui(params);
      throw new Error("unexpected snippet");
    },
    async goto(url) { calls.push({ goto: url }); },
    async url() { return "https://qbo.intuit.com/app/customers"; },
    async waitForFunction() { return "https://qbo.intuit.com/app/customers"; },
    async send() { return {}; },
  };
}

export function queryHandler(tables) {
  return (p) => {
    if (p.path === "/query") {
      const sql = p.query.query;
      const ent = (sql.match(/from (\w+)/) || [])[1];
      if (/count\(\*\)/.test(sql)) return { status: 200, data: { QueryResponse: { totalCount: (tables[ent] || []).length } } };
      return { status: 200, data: { QueryResponse: { [ent]: tables[ent] || [] } } };
    }
    return { status: 404, data: { Fault: { Error: [{ Message: "nope", code: "1" }] } } };
  };
}
