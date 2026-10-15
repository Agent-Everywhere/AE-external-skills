// list_save_accounts.js: save accounts (company ids) to ONE existing account list, in batches. A seat WRITE: only to a
// list the user confirmed by name this run (create it with list_create.js); never touches any other list.
// Standalone (browser JS tool): run it as the async IIFE  (<this function>)({...params})  or build that with
//   python3 runtime/session.py --emit list_save_accounts.js --params '{...}' --compact   (add --form return if the tool needs `return`).
// Run on a loaded, signed-in linkedin.com/sales page, after csrf_ready.js reports ready.
// params: { listId: id of the account list (required), ids: [company ids or "urn:li:fs_salesCompany:<id>" strings;
//   anything else is counted in `invalid`], batch?: 50 (1..50), delayMs?: 3500 between batches }
// Verified: POST /sales-api/salesApiCompanies?action=save with JSON {"companyIds":[<int ids>],"lists":["<listId>"]};
// 25 and 50 ids per call return 200 with value.listEntityActionResponses[].status SUCCESS; 75 and 100 return 400, so
// batches are cut at 50. One call per batch: log each as a small call; saved accounts are paced, not
// quota-capped (run_log.py --saved-accounts).
// Stops at the first non-200 batch. A 200 batch counts only entries whose status is SUCCESS: with one entry per id
// the failures are mapped by position, otherwise a batch with any non-SUCCESS entry is reported failed whole.
// returns: { status, ms, saved, failed: [ids not saved, incl. batches not attempted], batches, invalid }
//   or { status, error|body, saved, failed, batches, invalid }
async (params) => {
  const p = params || {};
  const listId = String(p.listId === undefined || p.listId === null ? '' : p.listId).trim().replace(/^.*:/, '');
  if (!listId) return { status: 0, error: 'list_id_required' };
  const csrfMatch = (() => { try { return document.cookie; } catch (e) { return ''; } })().match(/JSESSIONID="?([^";]+)/);
  if (!csrfMatch) return { status: 0, error: 'csrf_missing' };
  const ids = [];
  let invalid = 0;
  for (const v of (Array.isArray(p.ids) ? p.ids : [])) {
    const id = String(v).trim().replace(/^.*:/, '');
    if (!/^\d+$/.test(id)) { invalid++; continue; }
    if (!ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return { status: 0, error: 'ids_required', invalid };
  const delay = Number.isFinite(p.delayMs) ? p.delayMs : 3500;
  const batch = Math.min(50, Math.max(1, Number.isInteger(p.batch) ? p.batch : 50));
  let saved = 0, batches = 0;
  const failed = [];
  const t0 = performance.now();
  for (let i = 0; i < ids.length; i += batch) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const chunk = ids.slice(i, i + batch);
    try {
      const r = await fetch('/sales-api/salesApiCompanies?action=save', {
        method: 'POST',
        credentials: 'include',
        headers: { 'csrf-token': csrfMatch[1], 'x-restli-protocol-version': '2.0.0', 'accept': 'application/json',
          'content-type': 'application/json' },
        body: JSON.stringify({ companyIds: chunk.map(Number), lists: [listId] }),
      });
      batches++;
      if (r.status !== 200) {
        return { status: r.status, ms: Math.round(performance.now() - t0), body: (await r.text()).slice(0, 200),
          saved, failed: failed.concat(ids.slice(i)), batches, invalid };
      }
      const j = await r.json();
      const resp = ((j || {}).value || {}).listEntityActionResponses;
      const entries = Array.isArray(resp) ? resp : [];
      const ok = (e) => e && e.status === 'SUCCESS';
      if (entries.length && entries.every(ok)) saved += chunk.length;
      else if (entries.length === chunk.length) {
        chunk.forEach((id, k) => { if (ok(entries[k])) saved++; else failed.push(id); });
      } else failed.push(...chunk);
    } catch (e) {
      return { status: 0, error: String(e).slice(0, 200), saved, failed: failed.concat(ids.slice(i)), batches, invalid };
    }
  }
  return { status: 200, ms: Math.round(performance.now() - t0), saved, failed, batches, invalid };
}
