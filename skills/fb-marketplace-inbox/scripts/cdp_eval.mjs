// Usage: node cdp_eval.mjs '<js expression>' [urlSubstring=facebook.com] [navigateUrl]
// Evaluates JS in the slot-4 Chrome tab (CDP port 9224) and prints the result. Read-only helper.
const [,, expr, match = 'facebook.com', nav] = process.argv;
const port = process.env.CDP_PORT || 9224;
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const tab = tabs.find(t => t.type === 'page' && t.url.includes(match)) || tabs.find(t => t.type === 'page');
if (!tab) { console.error('no page tab'); process.exit(2); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise(r => ws.onopen = r);
if (nav) { await send('Page.navigate', { url: nav }); await new Promise(r => setTimeout(r, 6000)); }
const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const v = res.result?.result?.value;
console.log(typeof v === 'string' ? v : JSON.stringify(v ?? res.result, null, 1));
ws.close(); process.exit(0);
