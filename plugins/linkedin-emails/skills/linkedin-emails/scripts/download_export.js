// download_export.js: optional. Once LinkedIn has emailed "your data archive is ready" (Settings > Data privacy >
// Get a copy of your data > Connections, done by hand), run this in the logged-in linkedin.com tab to save the
// archive zip through the browser's normal download. Run it as: (<this file>)({})
// Returns {ok, http, filename, bytes}. Never returns the csrf token or any cookie.
async function (params) {
  const m = /(?:^|;\s*)JSESSIONID=([^;]*)/.exec((typeof document !== 'undefined' && document.cookie) || '');
  const csrf = m ? m[1].replace(/^"+|"+$/g, '') : '';
  if (!csrf) return { ok: false, http: 0, error: 'no_session' };
  let res;
  try {
    res = await fetch('/mysettings-api/settingsApiArchivedMemberDataDownload/', {
      method: 'GET',
      credentials: 'include',
      headers: { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0' },
    });
  } catch (e) {
    return { ok: false, http: 0, error: 'network_error' };
  }
  if (res.status !== 200) return { ok: false, http: res.status, error: 'http_' + res.status };
  const cd = (res.headers && res.headers.get && res.headers.get('content-disposition')) || '';
  const fm = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  let filename = 'linkedin-data-export.zip';
  if (fm) { try { filename = decodeURIComponent(fm[1]); } catch (e) { filename = fm[1]; } }
  filename = filename.replace(/[\\/:*?"<>|]/g, '_');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { ok: true, http: 200, filename, bytes: blob.size };
}
