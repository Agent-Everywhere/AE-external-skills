// One-time discovery for Marketplace GraphQL. Prints doc_ids and key sketches, never tokens.
// Usage: node discover_graphql.mjs [--buying] [--listings] [--no-thread]
// Chrome: signed-in facebook.com tab, CDP on 127.0.0.1:$CDP_PORT (default 9224).
import {
  PAGE_RECORDER_JS,
  classifyOperation,
  dedupeOps,
  fromPerformanceEntries,
  localDebugUrl,
  keySketch,
  parseFbJsonChunks,
  pickFacebookTab,
  renderOutput,
} from './graphql_redact.mjs';
import {
  attachGraphqlTap,
  cdpPort,
  clickTab,
  connectCdp,
  gotoFacebook,
  listTabs,
  loginWall,
  openFirstThread,
  pageRecorderLog,
  performanceGraphql,
  preparePage,
  responseText,
  sleep,
  viewerFlags,
} from './cdp_page.mjs';

const INBOX = 'https://www.facebook.com/marketplace/inbox/';
const LISTINGS = 'https://www.facebook.com/marketplace/you/selling/';
const KNOWN = new Set(['--buying', '--listings', '--no-thread', '--help']);

function emit(obj, code) {
  const rendered = renderOutput(obj);
  console.log(rendered.text);
  process.exit(rendered.leaked ? 4 : code);
}

function tag(ops, phase) {
  for (const row of ops.values()) if (!row.phase) row.phase = phase;
}

async function drain(send, ops, bodyQueue) {
  const seen = new Set();
  for (const requestId of bodyQueue) {
    if (seen.has(requestId) || !ops.has(requestId)) continue;
    seen.add(requestId);
    if (seen.size > 15) break;
    try {
      const chunks = parseFbJsonChunks(await responseText(send, requestId));
      const row = ops.get(requestId);
      row.sketch = chunks.slice(0, 2).map(chunk => keySketch(chunk));
      row.top_keys = chunks
        .filter(chunk => chunk && typeof chunk === 'object' && !Array.isArray(chunk))
        .flatMap(chunk => Object.keys(chunk))
        .slice(0, 20);
    } catch {
      ops.get(requestId).sketch = { error: 'body_unavailable' };
    }
  }
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  emit({
    usage: 'node discover_graphql.mjs [--buying] [--listings] [--no-thread]',
    port: 'CDP_PORT (default 9224)',
  }, 0);
}
if (args.some(arg => !KNOWN.has(arg))) emit({ error: 'unknown_arg' }, 2);

const buying = args.includes('--buying');
const listings = args.includes('--listings');
const openThread = !args.includes('--no-thread');
const port = cdpPort();

let tabs;
try {
  tabs = await listTabs(port);
} catch {
  emit({ error: 'cdp_unreachable', port }, 2);
}
const tab = pickFacebookTab(tabs);
if (!tab) emit({ error: 'no_page_tab', port }, 2);
if (!localDebugUrl(tab.webSocketDebuggerUrl)) emit({ error: 'cdp_url_refused', port }, 2);

const conn = connectCdp(tab.webSocketDebuggerUrl);
try {
  await conn.ready;
  const tap = attachGraphqlTap(conn);
  await preparePage(conn.send, PAGE_RECORDER_JS);
  tag(tap.ops, 'ignore');
  await gotoFacebook(conn.send, INBOX);
  await sleep(7000);
  const wall = await loginWall(conn.send);
  if (wall?.login_wall) emit({ error: 'login_or_checkpoint' }, 3);
  await clickTab(conn.send, 'Selling');
  await sleep(3000);
  tag(tap.ops, 'selling_list');
  let opened = false;
  if (openThread) {
    const click = await openFirstThread(conn.send);
    opened = !!click?.clicked;
    await sleep(opened ? 3500 : 500);
    tag(tap.ops, 'thread');
  }
  if (buying) {
    await sleep(4000);
    await clickTab(conn.send, 'Buying');
    await sleep(3000);
    tag(tap.ops, 'buying_inbox');
  }
  if (listings) {
    await sleep(4000);
    await gotoFacebook(conn.send, LISTINGS);
    await sleep(7000);
    const again = await loginWall(conn.send);
    if (again?.login_wall) emit({ error: 'login_or_checkpoint' }, 3);
    tag(tap.ops, 'selling_listings');
  }
  await drain(conn.send, tap.ops, tap.bodyQueue);
  const performance = fromPerformanceEntries(await performanceGraphql(conn.send).catch(() => []));
  const recorded = (await pageRecorderLog(conn.send).catch(() => [])) || [];
  const viewer = await viewerFlags(conn.send).catch(() => ({ viewer_id: null, has_fb_dtsg: false, has_lsd: false }));
  const operations = dedupeOps([...tap.ops.values()].filter(row => row.phase && row.phase !== 'ignore').map(row => ({
    friendly_name: row.friendly_name,
    doc_id: row.doc_id,
    variable_keys: row.variable_keys,
    guess: row.guess,
    replay: row.replay,
    status: row.status,
    phase: row.phase,
    url: row.url,
    top_keys: row.top_keys || [],
    sketch: row.sketch,
  })));
  const seen = new Set(operations.map(op => `${op.friendly_name || ''}|${op.doc_id || ''}`));
  for (const row of recorded) {
    if (!row || (!row.doc_id && !row.friendly_name)) continue;
    const key = `${row.friendly_name || ''}|${row.doc_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const keys = Array.isArray(row.variable_keys) ? row.variable_keys.slice(0, 40) : [];
    const guess = classifyOperation({ friendly_name: row.friendly_name || '', variable_keys: keys });
    operations.push({
      friendly_name: row.friendly_name || null,
      doc_id: row.doc_id || null,
      variable_keys: keys,
      guess,
      replay: guess !== 'write_skip',
      status: null,
      phase: 'page_log',
      url: 'https://www.facebook.com/api/graphql/',
      top_keys: [],
      sketch: null,
    });
  }
  emit({
    checked_at: new Date().toISOString(),
    mode: 'discovery',
    port,
    viewer_id: viewer?.viewer_id || null,
    tokens_present: { fb_dtsg: !!viewer?.has_fb_dtsg, lsd: !!viewer?.has_lsd },
    opened_one_thread: opened,
    performance_graphql: performance,
    operations: dedupeOps(operations),
    note: 'Paste this JSON into references/fb-marketplace-endpoints.md. Leave every row UNTESTED until a read-only probe returns 200 and you have named text_keys. Opening a thread clears Facebook unread state.',
  }, 0);
} catch (error) {
  emit({ error: 'discovery_failed', detail: String(error?.message || 'error').slice(0, 240) }, 2);
} finally {
  try { conn.ws.close(); } catch { /* already closed */ }
}
