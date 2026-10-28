// Same-origin Marketplace reads for VERIFIED rows only. Exit 4 → use scripts/read_inbox.mjs.
// Never prints cookies, fb_dtsg, lsd, or jazoest. Never sends a message.
// Usage: node read_inbox_graphql.mjs [--all]
// Default rows: selling_inbox, thread_messages, listing_context.
// --all also reads VERIFIED buying_inbox and selling_listings rows.
import { readFileSync } from 'node:fs';
import {
  PAGE_RECORDER_JS,
  buildReadExpression,
  isDocId,
  localDebugUrl,
  parseVerifiedRows,
  pickFacebookTab,
  projectResponseText,
  renderOutput,
} from './graphql_redact.mjs';
import {
  attachGraphqlTap,
  cdpPort,
  clickTab,
  connectCdp,
  evalInPage,
  gotoFacebook,
  listTabs,
  loginWall,
  openFirstThread,
  pageRecorderLog,
  preparePage,
  responseText,
  sleep,
} from './cdp_page.mjs';

const ENDPOINTS = new URL('../references/fb-marketplace-endpoints.md', import.meta.url);

function emit(obj, code) {
  const rendered = renderOutput(obj);
  console.log(rendered.text);
  process.exit(rendered.leaked ? 4 : code);
}

function matches(row, op) {
  if (!op?.replay) return false;
  if (row.friendly_name && op.friendly_name === row.friendly_name) return true;
  if (row.doc_id && op.doc_id === row.doc_id) return true;
  return false;
}

const args = process.argv.slice(2);
const KNOWN = new Set(['--help', '--all']);
if (args.includes('--help')) {
  emit({
    usage: 'node read_inbox_graphql.mjs [--all]',
    note: 'VERIFIED selling inbox, thread, and listing-context rows. --all adds Buying and your listings. Otherwise exit 4 and use read_inbox.mjs',
  }, 0);
}
if (args.some(arg => !KNOWN.has(arg))) emit({ error: 'unknown_arg' }, 2);
const includeOptional = args.includes('--all');
const POLL = new Set(['selling_inbox', 'thread_messages', 'listing_context']);

let endpointsMd = '';
try {
  endpointsMd = readFileSync(ENDPOINTS, 'utf8');
} catch {
  emit({ fallback: true, reason: 'no_endpoints_map', ui: 'scripts/read_inbox.mjs' }, 4);
}
const rows = parseVerifiedRows(endpointsMd).filter(row => includeOptional || POLL.has(row.capability));
if (!rows.length) {
  emit({
    fallback: true,
    reason: 'no_verified_rows',
    ui: 'scripts/read_inbox.mjs',
    discover: 'scripts/discover_graphql.mjs',
  }, 4);
}
if (rows.some(row => row.text_keys.length === 0)) {
  emit({
    fallback: true,
    reason: 'need_text_keys',
    ui: 'scripts/read_inbox.mjs',
    discover: 'scripts/discover_graphql.mjs',
  }, 4);
}

const port = cdpPort();
let tabs;
try {
  tabs = await listTabs(port);
} catch {
  emit({ fallback: true, error: 'cdp_unreachable', port, ui: 'scripts/read_inbox.mjs' }, 2);
}
const tab = pickFacebookTab(tabs);
if (!tab) emit({ fallback: true, error: 'no_page_tab', port, ui: 'scripts/read_inbox.mjs' }, 2);
if (!localDebugUrl(tab.webSocketDebuggerUrl)) emit({ fallback: true, error: 'cdp_url_refused', port, ui: 'scripts/read_inbox.mjs' }, 2);

const groups = new Map();
for (const row of rows) {
  const key = `${row.page}|${row.tab}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

const conn = connectCdp(tab.webSocketDebuggerUrl);
const reads = [];
try {
  await conn.ready;
  const tap = attachGraphqlTap(conn);
  await preparePage(conn.send, PAGE_RECORDER_JS);
  let first = true;
  for (const group of groups.values()) {
    if (!first) await sleep(4000);
    first = false;
    const page = group[0].page;
    await gotoFacebook(conn.send, page);
    await sleep(7000);
    const wall = await loginWall(conn.send);
    if (wall?.login_wall) emit({ error: 'login_or_checkpoint' }, 3);
    if (page.includes('/inbox/')) await clickTab(conn.send, group[0].tab);
    await sleep(3000);
    if (group.some(row => row.capability === 'thread_messages')) {
      const click = await openFirstThread(conn.send);
      if (click?.clicked) await sleep(3500);
    }
    for (const row of group) {
      const found = [...tap.ops.values()].find(op => matches(row, op) && op.status === 200)
        || [...tap.ops.values()].find(op => matches(row, op));
      let projected = null;
      let status = found?.status ?? null;
      let docId = found?.doc_id || row.doc_id;
      if (found && found.status === 200) {
        const requestId = [...tap.ops.entries()].find(([, op]) => op === found)?.[0];
        projected = projectResponseText(await responseText(conn.send, requestId), { textKeys: row.text_keys });
        status = projected.has_errors ? 400 : 200;
      }
      const failed = !projected || !projected.usable_for_ledger || status !== 200;
      if (failed && row.friendly_name && row.doc_id && Object.keys(row.variables).length) {
        await sleep(4000);
        const logged = (await pageRecorderLog(conn.send).catch(() => [])) || [];
        const fresh = logged.find(item => item?.friendly_name === row.friendly_name && isDocId(item.doc_id || '') && item.doc_id !== row.doc_id);
        docId = fresh?.doc_id || docId;
        const expression = buildReadExpression({
          docId,
          friendlyName: row.friendly_name,
          variables: row.variables,
          textKeys: row.text_keys,
        });
        if (expression) {
          const fetched = await evalInPage(conn.send, expression);
          status = fetched?.status ?? null;
          projected = {
            texts: fetched?.texts || [],
            ids: fetched?.ids || [],
            top_keys: fetched?.top_keys || [],
            has_errors: !!fetched?.has_errors || fetched?.error === 'missing_tokens',
            messages_in_graphql: !!fetched?.messages_in_graphql,
            usable_for_ledger: !!fetched?.usable_for_ledger && !fetched?.has_errors && status === 200,
          };
        }
      }
      reads.push({
        capability: row.capability,
        friendly_name: row.friendly_name,
        doc_id: docId,
        status,
        texts: projected?.texts || [],
        ids: projected?.ids || [],
        top_keys: projected?.top_keys || [],
        messages_in_graphql: !!projected?.messages_in_graphql,
        usable_for_ledger: !!projected?.usable_for_ledger,
      });
    }
  }
} catch (error) {
  emit({
    fallback: true,
    reason: 'graphql_failed',
    detail: String(error?.message || 'error').slice(0, 240),
    ui: 'scripts/read_inbox.mjs',
  }, 4);
} finally {
  try { conn.ws.close(); } catch { /* already closed */ }
}

const usable = reads.length > 0 && reads.every(row => row.usable_for_ledger);
if (!usable) {
  emit({
    checked_at: new Date().toISOString(),
    fallback: true,
    reason: 'graphql_failed',
    ui: 'scripts/read_inbox.mjs',
    discover: 'scripts/discover_graphql.mjs',
    reads: reads.map(row => ({
      capability: row.capability,
      friendly_name: row.friendly_name,
      doc_id: row.doc_id,
      status: row.status,
      messages_in_graphql: row.messages_in_graphql,
      usable_for_ledger: false,
    })),
  }, 4);
}
emit({
  checked_at: new Date().toISOString(),
  mode: 'graphql',
  fallback: false,
  usable_for_ledger: true,
  untrusted_text: true,
  reads,
}, 0);
