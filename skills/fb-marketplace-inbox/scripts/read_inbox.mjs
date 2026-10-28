// Read-only: list Marketplace Selling inbox threads and the messages of the newest N.
// Usage: node read_inbox.mjs [N=8] [tab=Selling]   -> JSON on stdout
// Opening a thread marks it read on Facebook; dedupe uses ../ledger.json, not FB's unread dots. Never sends.
const N = +(process.argv[2] || 8), TAB = process.argv[3] || 'Selling';
const port = process.env.CDP_PORT || 9224;
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const tab = tabs.find(t => t.type === 'page' && t.url.includes('facebook.com')) || tabs.find(t => t.type === 'page');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async x => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
await new Promise(r => ws.onopen = r);
await send('Page.navigate', { url: 'https://www.facebook.com/marketplace/inbox/' }); await sleep(7000);
const pageText = await ev(`document.body.innerText.slice(0,400)`);
if (/log in|log into facebook|checkpoint|captcha|confirm your identity/i.test(pageText || '') && !/Marketplace/.test(pageText||'')) { console.log(JSON.stringify({ error: 'login_or_checkpoint', pageText })); process.exit(3); }
await ev(`(()=>{const t=[...document.querySelectorAll('[role=main] [role=tab],[role=main] a,[role=main] span')].find(e=>e.innerText.trim()==='${TAB}');t&&t.click();})()`); await sleep(3000);
// close any open chat popups first
await ev(`[...document.querySelectorAll('[aria-label="Close chat"]')].forEach(b=>b.click())`); await sleep(800);
const rows = await ev(`[...document.querySelector('[role=main]').querySelectorAll('[role=button]')].filter(e=>e.innerText.split('\\n').length>=3 && /\\d{1,2}:\\d{2}|[A-Z][a-z]{2} \\d{1,2}|\\d+[mhdw]$/.test(e.innerText.trim())).map((e,i)=>{const L=e.innerText.split('\\n').map(s=>s.trim()).filter(s=>s);const t=L.join(' ');const listing=(t.match(/· (.+?) (?=\\S+ (?:\\S+ )*sent you|.*$)/)||[])[1];return {i, lines:L, bold: getComputedStyle(e.querySelector('span')||e).fontWeight>=600 || !!e.querySelector('[aria-label*="nread" i]')}})`);
const out = [];
for (const r of (rows || []).slice(0, N)) {
  await ev(`(()=>{const rs=[...document.querySelector('[role=main]').querySelectorAll('[role=button]')].filter(e=>e.innerText.split('\\n').length>=3 && /\\d{1,2}:\\d{2}|[A-Z][a-z]{2} \\d{1,2}|\\d+[mhdw]$/.test(e.innerText.trim()));rs[${r.i}]&&rs[${r.i}].click();})()`);
  await sleep(3500);
  const thread = await ev(`(()=>{const h=[...document.querySelectorAll('[aria-label="Chat settings"]')].pop();let c=h;for(let i=0;i<14&&c;i++){c=c.parentElement;if(c.querySelector('[role=textbox]'))break;}if(!c)return null;const title=h.innerText.trim();const head=c.innerText.split('\\n').slice(0,6).join(' | ');const msgs=[...c.querySelectorAll('[aria-label^="Enter, Message sent"],[aria-label^="Enter, Message sent"]')].map(e=>e.getAttribute('aria-label').replace(/^Enter, /,''));return {title, head, msgs};})()`);
  out.push({ row: r.lines, thread });
  await ev(`[...document.querySelectorAll('[aria-label="Close chat"]')].forEach(b=>b.click())`); await sleep(1200);
}
console.log(JSON.stringify({ checked_at: new Date().toISOString(), tab: TAB, rows_seen: (rows||[]).length, threads: out }, null, 1));
ws.close(); process.exit(0);
