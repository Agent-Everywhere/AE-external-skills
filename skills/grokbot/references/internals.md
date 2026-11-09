# Grok Bot internals the CLI depends on

- **App**: `/Applications/Grok Bot.app` (documented against 0.79.3, host 00b0aa1; the first version of these docs was 0.47.0 / 48cbefa), Electron 42, bundle id `com.anysphere.sand`, renderer at
  `app.asar/dist/renderer/index.html`. Fuses leave `EnableNodeCliInspectArguments` on, so
  `--remote-debugging-port=<n> --remote-allow-origins=http://127.0.0.1:<n>` works.
- **Children**: `local-exec-daemon` (gives the cloud agent shell/screen access to this Mac; log at
  `~/.grokbot/local-exec-daemon.log`) and `node-agent-coordinator`.
- **Gateway descriptor**: `~/Library/Application Support/Grok Bot/gateway-descriptor.json` →
  `{version:3, entries:{<accountScope>:{savedAtMs, encrypted}}}` (the file `version` was 2 in 0.47 and is 3 in 0.79; the
  per-entry shape and the plaintext are unchanged, but the app itself rejects any version other than its own, so the CLI
  accepts any numeric `version >= 2` that carries an `entries` map instead of pinning one — a pinned `=== 2` check made
  `doctor` report `host undefined` / `no descriptor` and silently fall back to `EnsureSandBox`); `encrypted` is Electron safeStorage
  (Chromium OSCrypt v10: AES-128-CBC, key = PBKDF2-SHA1("Grok Bot Safe Storage" Keychain password,
  "saltysalt", 1003, 16), IV = 16×0x20). Plaintext `{baseUrl, token, headers:{x-anyrun-network-token}, vncProxy}`.
  The app rewrites it on connect (the live host moved from `us10` to `us14` cursorvm.com between runs) and treats entries older
  than 7 days as stale.
- **Secret store**: `sand-secrets.json` (`{version:1, cursor-machine-id, cursor-accounts, local-exec-file-key}`) → `cursor-accounts` is plain JSON
  `{active, accounts:{<scope>:{"cursor-access-token","cursor-refresh-token","cursor-account-profile"}}}`;
  each inner value is safeStorage ciphertext, optionally prefixed `scoped:v1:<scope>:`; legacy
  top-level keys may carry `plaintext:v1:<base64>`. The access token is a WorkOS-issued JWT
  (`type: session`, ~2 month expiry). `local-exec-file-key` seals `~/.grokbot/*.json` (AES-256-GCM).
- **Client persistence**: `sand-client-persistence/<base32(key)>.blob` with keys
  `sand.client.slice.account.<accountId>.<slice>`; slices: `roster.last-roster`, `sidebar.last-sections`,
  `transcript.replicas.<agentId>`, `composer-drafts`, `send-journal`, `selection.last-agent`, `ui-agent-refs`, and (new
  by 0.79) `cloud-agents.infos`, `weekly-usage.cache`, `mcp.connected-app-count`, `connection.last-host-capabilities`,
  `bot-templates.export-policy`, `roster.agent-avatars`. Transcript replicas are `{entries, epochHint, acceptedSequenceHint,
  persistedAt}`; the CLI's `local` readers still work unchanged. There is no cached pins slice: pins are server-side.
- **Renderer bridge**: `window.desktop` (contextBridge). 0.47 had `desktop.agent.*` / `desktop.cursorAccount.*`; 0.79 exposes
  only `{main, boot, environment, local}` and almost everything is `desktop.main.<call>` (438 calls; see `host-commands.md`).
  Sections/pins: `main.getHostSidebarSections({accountSlot})`, `main.setHostSidebarSections({sections, base, accountSlot})`,
  `main.getHostPinnedAgents()`, `main.getServerPinnedAgents()`, `main.setHostPinnedAgents({pinnedAgentIds})`; account:
  `main.getCursorAuthStatus()` (its `authId` is the accountSlot); host: `main.getBoxHostPhase()`. Calls validate their args
  (`edge/invalid-args`); a stale `accountSlot` fails with `account/changed`. Host commands themselves flow through a
  MessagePort to the coordinator, not through `window.desktop`.
- **Sections storage**: primary store is Cursor runtime settings (`GetGrokBotUserRuntimeSettings` /
  `UpdateGrokBotUserRuntimeSettings`, `settings.sidebarSections.sections`; updates send `sidebarSectionsBase`
  for optimistic concurrency, using the list `getSections()` read). Host settings key `sidebarSections`
  (`desktop` bridge → main `syncHostSettingsToBox` → gateway `setHostSettings`) is a best-effort mirror (it writes the list the server returned, so server-side amendments never make host and server diverge) for
  older apps, skipped (with a stderr warning) whenever the host holds a non-empty layout that differs from the
  server list; reads warn when the server list is empty but the host holds a layout. The renderer slice is
  `scope:"host-durable"` and reconciles on reconnect / window focus.
- **Pins and auto-review moved to the same runtime store (0.79)**: `settings.pinnedAgents.agentIds` and
  `settings.autoReviewInstructions` (`{isEnabled, allowInstructions[], blockInstructions[]}`, protobuf
  `GrokBotUserAutoReviewInstructions`, plus server-derived `approvalMode`/`effectiveApprovalMode` on read). The app reads
  pins from the runtime store and falls back to host `pinnedAgentIds` only when the server holds none; the host copy is
  not written by the app any more and has drifted. Host `autoReviewInstructions` is the same structured object, not the
  old free-form string (a string fails schema validation). The CLI therefore reads the runtime store first and, as an
  operator, writes it and mirrors host settings; from a box it can only write host settings (no Cursor auth), so a box pin
  write may never show in the app (the CLI says so on stderr) and a box auto-review write depends on the app's own
  host-to-server reconcile. `getHostSettings` also now returns `selectedTeam`, `localToolPermissionByMachineId`,
  `featureFlagOverrides`, `experimentOverrides`, `osLocale`, `mcpHeldAccountScopes`, `hasSeenOnboardingAccountScope`.
- **Two agent id spaces**: the box roster id (uuid, used everywhere in this CLI) vs. the Cursor control-plane
  `GrokBotAgent.id` (numeric) whose `agentId` field points back at the roster uuid. Only named/shared/room
  agents exist on the control plane; plain chats are box-only.
- **Routines (automations)**: for server-hosted (`harness: temporal`) agents they live on the control plane, not the
  box gateway (`listAllAutomations` / `getAgentAutomations` return `[]` for them). `grokbot automations` reads them with
  `ListGrokBotAccountAutomations {agentIds:[<roster uuid>…]}` (one call for all agents; per-agent fallback
  `ListGrokBotAgentAutomations {agentId}` when a group reports `unavailable`/`readIndividually`). Rows are
  `{automationId, recordJson, viewerPermissions}`; `recordJson` is a JSON string with `name`, `prompt`, `isEnabled`,
  `trigger` (`cron` | `webhook` | `group{listeners[]}`), `schedule`, `triggerDescription`, `runs`, timestamps. Webhook
  triggers carry no secret in the record; the credential RPC (`getAutomationWebhookCredential`) is never called. An empty
  `agentIds` returns nothing, so the agent list is always passed. Read-only: no create/update/delete/run/setEnabled.
- **Usage** (`grokbot usage`, read-only, allowed under the agent policy): `DashboardService` `GetSandUsageStatus`
  (`usagePercent` is the weekly allowance window, clamped 0..100 by the app; `nextResetTimestampUtc`),
  `GetCurrentPeriodUsage` (`planUsage`/`spendLimitUsage` amounts are US **cents**: limit 40000 = the $400 included on
  Ultra, `individualLimit` 500 = a $5 personal cap; the `totalPercentUsed`/`autoPercentUsed` fields do not match
  spend/limit and are ignored), `GetSandAccessStatus`, `GetMonthlyBillingCycle`. At 100% the app keeps working while
  on-demand is enabled, spending against the personal cap.
- **Backup exports** (operator-only): `agents export` = `ListGrokBotAgents` row (the `description` is the agent's full
  instruction text) + `ListGrokBotAgentSkills`, `GetGrokBotAgentPlugins` (`includeMcpConfig:false`; custom MCP is never
  requested), `GetGrokBotAgentAccess`, (per-agent memories are gone: gateway `getAgentMemories` is a 404 on host 00b0aa1, so
  the export no longer requests it). Gateway `getAgentWorkflows` is account-level (identical for every agent; `source` =
  `managed` | `plugin` | `workflow`): user-authored `workflow` rows are written to `workflows/<id>.md` once, the rest are
  only listed in `workflows/INDEX.json`. Object keys matching token/secret/key/password/credential/authorization/cookie,
  plus `env` and `headers`, are replaced by `<redacted>`; string content is verbatim.
  `transcripts export` pages `ListGrokBotTranscriptEntries {agentId, limit:200, beforeSeq}` backwards until an empty
  page (seqs have gaps, so a short page is not the end); entries are base64-JSON `body` (kept) plus a decoded `bodyJson`.
- **Routine toggle** (`automations enable|disable`): `SetGrokBotAgentAutomationEnabled {agentId, automationId, isEnabled}`;
  prints the target and needs `--yes`; control-plane routines only.

- **Todos / tasks** (`agents todos|tasks`, read-only): control-plane `ListGrokBotAgentTodos {agentId}` /
  `ListGrokBotAgentTasks {agentId}` hold them for server-hosted agents while the gateway's `getAgentTodos {id}` /
  `getAgentTasks {agentId}` return `[]` for those, so an operator reads the control plane first and a box (agent policy,
  no Cursor auth) reads the host. `agents tasks` also lists `getAsyncTasks` and `getSubagents`. `agents search --agent`
  is the host's per-agent `searchConversation {agentId, query, limit}`.
- **Box gateway discovery**: unchanged. The app still names the data-root files `gateway.json`, `host-secrets.json`,
  `settings.json`, `agents/`, `host.lock`, `.grokbot-data-root-v1`, and the box constants are still `/home/box/sand-data`
  and `/home/box/agent-data` (new in 0.79: `/home/box/reference` docs). On a Mac the same data-root layout lives in
  `~/.grokbot` (`settings.json`, `local-exec-*.json`, no `gateway.json`), which is deliberately **not** a box-descriptor
  candidate: it would turn the Mac into an `agent`-policy session. The `gateway.json` field set (`scheme, host, port, token,
  pid, startedAt`) could not be re-verified from the app bundle (the host bundle lives on the box); the parser still only
  requires `token` and `port`.
- **Transient `fetch failed`**: undici hides the reason on `err.cause`; the gateway client now appends it (`ECONNRESET`, ...).
- **Sending** (`agents send`): the gateway's `sendPrompt` is host-restricted to box sessions as of 00b0aa1 (502 for a Mac caller),
  so an operator sends with `SendGrokBotUserMessage` on the control plane and polls the roster/transcript for `--wait`. Under the
  agent policy the CLI keeps `sendPrompt` and explains the 502. The agent policy also never builds a Cursor client (`runtimeClientFor`),
  so a box-side edit of sections, pins or auto-review cannot use the Mac's token.
