# Runtime: local (the user's own browser)

Runs the same page snippets in the user's own Chrome, on their machine. No cloud browser, no
connector, no per-minute billing, and nothing to claim.

> **Warning to give the user before the first call.** A local run uses the user's **own seat,
> session and home IP**. It is the same account they use by hand, so the platform sees one person
> working fast. Keep the pacing in `guardrails-common.md`, and ask them not to use the same
> login in another browser while it runs. If they would rather keep their own browser out of it,
> use the Agent Browser runtime.

## Option 1: a browser JavaScript tool (no code execution needed)

Claude in Chrome, or Claude's built-in browser, exposes a "run JavaScript" tool that executes in
the current tab.

1. Have the user open the target site (for Sales Navigator, any `linkedin.com/sales/...` page),
   signed in, and wait for it to finish loading plus a few seconds.
2. Build the call. Each snippet file is one async function; call it with a params object:
   ```
   python3 runtime/session.py --emit lead_search.js --params '{"query":"...","count":25}'
   ```
   or paste the file's content in parentheses followed by the params:
   `await (async (params) => {...})({"query":"...","count":25})`.
3. Run it with the tool and read the JSON that comes back. Keep each result short (the snippets
   already return compact JSON).
4. **Pace yourself by hand**: 3 to 5 seconds between calls, no parallel calls. Write each result
   to the output file as it arrives.
5. Stop on `status` 403 or 429.

The disadvantage: every call is a tool round trip, so large pulls are slower than a script and
cost more context. Prefer option 2 when you can run code.

## Option 2: Playwright attached to the user's Chrome (code execution)

Chrome only exposes the debugging port when started with it, and since Chrome 136 it refuses to do
so on the default profile, so the user uses a **dedicated profile directory** and signs in once:

```
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.ae-browser-profile"
# Windows:  chrome.exe --remote-debugging-port=9222 --user-data-dir=%USERPROFILE%\.ae-browser-profile
# Linux:    google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.ae-browser-profile
```

The user signs in to the site in that window (never share the password or 2FA code with the
agent), then:

```
python3 -m pip install playwright
python3 runtime/session.py --runtime cdp --cdp-url http://127.0.0.1:9222 \
        --plan plan.json --out results.jsonl
```

`session.py` reuses an open tab on the target site if there is one. Add `--no-goto` to run on the
tab exactly as it is. It disconnects without closing the user's browser.

Heartbeats, claims and the 40-minute ceiling do not apply locally. `--max-seconds` still works if
you want a checkpoint.

## Which option

| Situation | Use |
|---|---|
| Code execution available | Option 2 (or the Agent Browser runtime) |
| Only a browser JS tool | Option 1 |
| Neither | the skill's slow page-reading path |
