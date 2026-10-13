# Runtime: local (the user's own browser)

Runs the same page snippets in the user's own signed-in browser, on their machine. No cloud
browser, no connector, no per-minute billing, nothing to claim, and no CDP or Playwright when the
browser has a JavaScript tool. **This is the default runtime for Claude Desktop users**: Cowork's
built-in browser and Claude in Chrome both expose a JavaScript tool that runs async JS in the
signed-in page, and a Sales Navigator search call returns in about a second.

> **Warning to give the user before the first call.** A local run uses the user's **own seat,
> session and home IP**. It is the same account they use by hand, so the platform sees one person
> working fast. Keep the pacing in `guardrails-common.md`, and ask them not to use the same
> login in another browser while it runs. If they would rather keep their own browser out of it,
> use the Agent Browser runtime.

## Option 1: a browser JavaScript tool (the default)

The tool is called something like `javascript_tool` / `javascript_exec` (Cowork's built-in browser)
or "run JavaScript" (Claude in Chrome). It runs your code in the **active tab**. It needs no
code execution, but code execution makes building the calls and saving results easier.

### Setup, once per run

1. The user opens the target site in that browser (for Sales Navigator, any
   `linkedin.com/sales/...` page), signed in. Never ask for or type a password or 2FA code.
2. Wait for the page to finish loading **plus about 3 seconds**, then make the first call with
   `csrf_ready.js`. It must return `{"ready":true,"path":"/sales/..."}`. Anything else: stop and
   look (wrong tab, signed out, still loading).

### Per call: one snippet, one tool call

Each `page/*.js` file is one `async (params) => {...}` function. A call is that function wrapped
as an async IIFE with its params inline:

```
(
async (params) => { ... }
)({"query":"(filters:List(...))","count":25})
```

Build it, then paste it as the tool's whole code:

```
# with code execution (compact drops comments and blank lines; add --form return, see below)
python3 runtime/session.py --emit lead_search.js --params '{"query":"...","count":25}' --compact

# without code execution: read page/lead_search.js, put "(" before it and ")({...params})" after it
```

- **Expression form (default).** Works when the tool evaluates the code and returns the last
  value (awaiting a promise).
- **Return form.** If the tool returns nothing or `undefined`, it is running your code as a
  function body: add `--form return` (the output starts with `return await (`).

Read the JSON that comes back. Do not run two snippets in one call and do not loop in the tool
(the skill's gotchas, section "Browser JS tool").

### After every call: write it down before the next one

Keep results out of the chat. After each call, save the returned object as its own file in the
user's folder, then rebuild the CSV from everything saved so far with the skill's converter (the
conversion is idempotent). Sales Navigator example:

```
results/<shard>/<call id>.json        # the JSON the tool returned, exactly as returned
python3 scripts/salesnav_rows.py accounts results/<shard>/*.json -o accounts.csv --mode B --shard "<shard>"
```

(`salesnav_rows.py leads ...` for people.) A stop, a closed app or a lost context then loses at
most the one call in flight. To resume, list `results/` and continue from the next page.

### Pace and stop

- **3 to 5 seconds between calls by hand**, randomized, no parallel calls, and a longer pause
  (30 to 90 seconds) every few dozen calls.
- Stop on `status` 403 or 429 after `csrf_ready` was true, on a sign-in or checkpoint page, or on
  a limit banner. Do not retry in a loop.
- The snippets never return the cookie or token; never ask the tool to.
- **Fetching other websites in Cowork prompts the user once per site** ("Allow Claude to fetch
  pages from <site>?"). Reading dozens of sites stacks the prompts and blocks the task. Read the
  fewest sites you can, state the count first, and offer the user one choice up front: Auto
  approval mode for the task, "Allow all for this website" per prompt, or Allow once per site
  (`references/qualify.md` in the skill).

The disadvantage: every call is a tool round trip, so a large pull costs more context and time
than a script. Prefer option 2 or the Agent Browser runtime when you can run code and the job is
big, or when it must run with the laptop closed.

### Scheduled runs

A scheduled local run works only while the Mac is awake and the app (with the signed-in browser)
is open. Anything that must run with the laptop off needs the Agent Browser runtime.

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

`session.py` reuses an open tab on the target site if there is one; if there is none it opens a
NEW tab and never navigates one of the user's other tabs. Add `--no-goto` to run on the tab exactly
as it is (open the target site first). It disconnects without closing the user's browser.

Heartbeats, claims and the 40-minute ceiling do not apply locally. `--max-seconds` still works if
you want a checkpoint.

## Which option

| Situation | Use |
|---|---|
| A browser JS tool (Cowork built-in browser, Claude in Chrome) | **Option 1, the default** |
| Large pull, code execution, and a Chrome you can restart with a debugging port | Option 2 |
| Must run with the laptop closed, or on a schedule | the Agent Browser runtime |
| None of these | the skill's slow page-reading path |
