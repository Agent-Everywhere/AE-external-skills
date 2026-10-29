# Grok Bot internals the CLI depends on

- **App**: `/Applications/Grok Bot.app`, Electron 42, bundle id `com.anysphere.sand`, renderer at
  `app.asar/dist/renderer/index.html`. Fuses leave `EnableNodeCliInspectArguments` on, so
  `--remote-debugging-port=<n> --remote-allow-origins=http://127.0.0.1:<n>` works.
- **Children**: `local-exec-daemon` (gives the cloud agent shell/screen access to this Mac; log at
  `~/.grokbot/local-exec-daemon.log`) and `node-agent-coordinator`.
- **Gateway descriptor**: `~/Library/Application Support/Grok Bot/gateway-descriptor.json` →
  `{version:2, entries:{<accountScope>:{savedAtMs, encrypted}}}`; `encrypted` is Electron safeStorage
  (Chromium OSCrypt v10: AES-128-CBC, key = PBKDF2-SHA1("Grok Bot Safe Storage" Keychain password,
  "saltysalt", 1003, 16), IV = 16×0x20). Plaintext `{baseUrl, token, headers:{x-anyrun-network-token}, vncProxy}`.
  The app rewrites it on connect and treats entries older than 7 days as stale.
- **Secret store**: `sand-secrets.json` → `cursor-accounts` is plain JSON
  `{active, accounts:{<scope>:{"cursor-access-token","cursor-refresh-token","cursor-account-profile"}}}`;
  each inner value is safeStorage ciphertext, optionally prefixed `scoped:v1:<scope>:`; legacy
  top-level keys may carry `plaintext:v1:<base64>`. The access token is a WorkOS-issued JWT
  (`type: session`, ~2 month expiry). `local-exec-file-key` seals `~/.grokbot/*.json` (AES-256-GCM).
- **Client persistence**: `sand-client-persistence/<base32(key)>.blob` with keys
  `sand.client.slice.account.<accountId>.<slice>`; slices: `roster.last-roster`, `sidebar.last-sections`,
  `transcript.replicas.<agentId>`, `composer-drafts`, `send-journal`, `selection.last-agent`, `ui-agent-refs`.
- **Renderer bridge**: `window.desktop` (contextBridge). Sections/pins: `desktop.agent.getSidebarSections()`,
  `setSidebarSections(sections)`, `getPinnedAgents()`, `setPinnedAgents(ids)`; account:
  `desktop.cursorAccount.getStatus()`; host: `desktop.getBoxHostPhase()`. Host commands themselves flow
  through a MessagePort to the coordinator, not through `window.desktop`.
- **Sections storage**: primary store is Cursor runtime settings (`GetGrokBotUserRuntimeSettings` /
  `UpdateGrokBotUserRuntimeSettings`, `settings.sidebarSections.sections`; updates send `sidebarSectionsBase`
  for optimistic concurrency, using the list `getSections()` read). Host settings key `sidebarSections`
  (`desktop` bridge → main `syncHostSettingsToBox` → gateway `setHostSettings`) is a best-effort mirror for
  older apps, skipped when the server list is empty and the host list is not. The renderer slice is
  `scope:"host-durable"` and reconciles on reconnect / window focus.
- **Two agent id spaces**: the box roster id (uuid, used everywhere in this CLI) vs. the Cursor control-plane
  `GrokBotAgent.id` (numeric) whose `agentId` field points back at the roster uuid. Only named/shared/room
  agents exist on the control plane; plain chats are box-only.
