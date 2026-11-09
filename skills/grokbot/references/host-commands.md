# Host gateway command catalog (host version 00b0aa1, app 0.79.3)

`POST {baseUrl}/api/<command>` · JSON body · headers: `authorization: Bearer <gatewayToken>`,
`x-anyrun-network-token: <routing token>` (both from the app's gateway descriptor).
Also `GET /health` → `{ok,pid,isBusy,activeAgentId,startedAt,lastBusyAtMs}` and `GET /events` (SSE).

Extracted from the desktop app's renderer command catalog and the node-agent-coordinator's gateway edge schema
(174 commands in 0.79.3; the host answers `404 unknown gateway method` for anything it does not serve, even when the
coordinator lists it, e.g. `getMainAgent`). Argument shapes marked ✓ were confirmed live by this CLI. Argument
**names differ per command** (`id` vs `agentId`); the host validates them (`400 args.id: must be agent id`).

## Changes since app 0.47.0 / host 48cbefa
- **Removed or never served** (404 or absent from the 0.79 schema): `deleteAgent` (use bulk `deleteAgents`),
  `setAgentNotificationsEnabled` (only `setAgentNotifyOnUpdates` remains), `getAgentMemories` / `clearAgentMemories` /
  `deleteAgentMemory`, `broadcastToAgents`, `getServerAgentRoster`, `resolveAgentCreation`,
  `restoreTemporalAgentRouting`, the shared-room commands (`createSharedRoom`, `joinSharedRoom`, ...; rooms are
  `CreateGrokBotRoom` / `SetGrokBotRoomMembers` / `AddGrokBotRoomPeople` on the control plane now), and the box-store
  commands (`getBoxStoreStatus`, `snapshotBoxStoreNow`, `clearBoxStoreNow`; the store is control-plane `*SandBoxStore*` RPCs now). Per-agent memories are no longer a host command; `ListGrokBotUserBotMemories` is team-memory only
  (403 unless you own or manage a Team Bot).
- **New and used by the CLI** (all read-only, ✓ live): `getAgentTodos {id}`, `getAgentTasks {agentId}`,
  `searchConversation {agentId, query, limit?}` (per-agent search: `agents search --agent`), plus the existing
  `getSubagents {id}` / `getAsyncTasks {id}` now reachable through `agents tasks`.
- **New, not exposed**: cloud-agent app publishing (`getCloudAgent*`, `*CloudAgentPublish*`, `*CloudAgentAppSecrets`,
  `createCloudAgentAppsGateTicket`), voice calls (`getVoiceCall`, `recordVoiceCall`, `nudgeVoiceCall`,
  `setVoiceCallPresence`, `readVoiceCallSentMessages`), messages grants (`requestMessagesGrants`, `awaitMessagesGrants`,
  `cancelMessagesGrants`), `requestWebAuthnCeremony`, `storeSecret`, attachments (`uploadAttachment*`,
  `readAttachment*`), `createAgentFromTemplate`, `createThreadFromMessage`, `searchConversation`,
  `startFreshConversation`, `rollBackConversation`, `seedConversationName`, `setAgentDraftingDisabled {id,...}`,
  `getAgentTasks` / `markAgentTask{Done,Read}` / `setAgentTaskPinned` / `dismissAgentSuggestions`, `getAgentTodos`,
  `runAutomationWebhook`, `rerunAutomationFromCard`, `isGlobalSearchEnabled` (✓ `true`), `setBoxSecrets`,
  `carryBoxSecretsToBot`, `listBoxMcpServers`, `refreshMcp`, `completeMcpOAuth`, `updateForeverBox`,
  `setWindowFocused`, `generateAgentAvatarImage`, `transcribeAudio`, MCP account/app commands
  (`renameMcpAccount`, `removeMcpAccount`, `readMcpAppResource`, `callMcpAppTool`, `getMcpPluginLogo`),
  `unpublishPluginListing`, `hasRestorablePluginListingCopy`.

## Roster
| command | args | notes |
|---|---|---|
| `listAgents` | `{allowEmptyRoster?}` | ✓ array of roster rows (see below) |
| `countAgents` | – | ✓ number |
| `searchAgents` | `{query, limit?}` | ✓ |
| `createAgent` | `{name, description, title?, purpose?, avatarShape?, avatarColor?, isIntroductionSuppressed?, isKickstartRequested?}` | ✓ |
| `updateAgent` | `{id, profile:{name, description, title?, avatarShape?, avatarColor?}}` | ✓ |
| `deleteAgents` | `{ids:[…], allowEmptyRoster?}` | bulk; **silent no-op for server-hosted agents since 0.79** (replies success, the agent stays on the control plane). `agents delete` uses control-plane `DeleteGrokBotAgent` and only mirrors here best effort |
| `deleteAgent` | – | **removed in 0.79**; the CLI always uses `deleteAgents` |
| `duplicateAgent` | `{id}` | clones store + profile, clears conversation |
| `setAgentHiddenFromSidebar` | `{id, isHidden}` | ✓ |
| `setAgentUnread` | `{id, isUnread, atMs?}` | |
| `setAgentNotifyOnUpdates` | `{id, isEnabled}` | `setAgentNotificationsEnabled` was removed in 0.79 (`agents update --notify` is gone) |
| `setAgentVoice`, `setAgentAvatarBytes`, `getAgentAvatar` | | |
| `interruptAgentRun` | `{id, sessionId?}` | |
| `kickstartAgent` | `{id}` | |
| `createGroup` | `{name, description?, memberAgentIds:[…], clientNonce?}` | |
| `setGroupMembers` | `{id, memberAgentIds:[…]}` | |
| `requestDiskSaverAudit` | | |
| `broadcastToAgents`, `getServerAgentRoster`, `resolveAgentCreation`, `restoreTemporalAgentRouting` | | removed in 0.79 |

## Conversation
| command | args |
|---|---|
| `sendPrompt` | `{agentId, prompt, clientNonce, replyToId?, richText?, attachmentPaths?, attachmentNames?, isFork?}` → `{accepted}`. **Host 00b0aa1 answers a non-box (Mac) caller `502 A Sand box session may not make this request on this endpoint`**; operators send with the control-plane `SendGrokBotUserMessage` instead (below) |
| `promptAcceptanceStatus` | `{clientNonce}` |
| `getAgentTranscriptTail` | `{id, limit}` |
| `getAgentTranscriptPage` | `{id, limit, beforeSeq?}` |
| `getAgentTranscript`, `getAgentTranscriptWindow`, `openAgentTail`, `openAgentWindowed`, `openAgent` | |
| `searchConversation` | `{agentId, query, limit?}` ✓ → `{matches:[{entryId, seq, role, timestampMs, snippet}], …}` |
| `getAgentTodos`, `getAgentTasks` | `{id}` ✓ / `{agentId}` ✓ (`[]` for server-hosted agents; the control plane holds those) |
| `getAgentThread` | `{id, rootId}` |
| `getConversationOutline` | `{id}` |
| `reactToMessage`, `voteFeedback`, `respondToWidget`, `dismissWidget`, `submitSecret`, `submitUserForm`, `dismissUserForm`, `sendDraft`, `discardDraft` | |
| `resolveAutoReviewApproval`, `resolveLocalToolPermission`, `resolveMessagesGrants`, `resolveVirtualCardApproval` | |
| `searchMedia` | `{query, limit?}` |
| `getSubagents`, `getAsyncTasks` | `{id}` ✓ |
| `getAgentMemories`, `clearAgentMemories`, `deleteAgentMemory` | removed in 0.79 (404) |

## Host settings (sections, pins, models)
| command | args |
|---|---|
| `getHostSettings` | – ✓ → `{notifications, selectedTeam, mcp*, autoReviewInstructions, localToolPermission(ByMachineId), featureFlagOverrides, experimentOverrides, webauthnProxyEnabled, messagesEnabled, userTimeZone, osLocale, pinnedAgentIds, sidebarSections, hasSeenOnboarding(AccountScope)}` |
| `setHostSettings` | partial patch, e.g. `{sidebarSections:[{id,name,agentIds,isCollapsed?}]}` ✓ → merged settings |

**Host settings are a mirror now.** The app reads and writes the Cursor runtime store
(`GetGrokBotUserRuntimeSettings` / `UpdateGrokBotUserRuntimeSettings`): `pinnedAgents.agentIds`,
`sidebarSections.sections`, `autoReviewInstructions`, `mainAgentId`, `hasSeenOnboarding`, `termsSeenAtMs`,
`emailProvider`, `userTimeZoneOverride`. Pins are read from there first and from host `pinnedAgentIds` only when the
server holds none; the host list is no longer written by the app and drifts (29 vs 26 ids on the live account).
`grokbot pins` follows the app (runtime first, host mirrored best-effort; box = host only, which the app may ignore).

`autoReviewInstructions` is **structured** since 0.79: `{isEnabled, allowInstructions:[…], blockInstructions:[…]}` (the 0.47
host setting was a free-form string, and a string no longer validates). The CLI exposes it through a narrow
command that is allowed under agent policy (raw `settings set` stays denied); each write sends exactly
`{autoReviewInstructions:{isEnabled, allowInstructions, blockInstructions}}`:

```
grokbot auto-review get
grokbot auto-review set "<rules, one per line>" [--list allow|block]   # or: --file rules.md | --stdin (exactly one source)
grokbot auto-review set --clear [--list block]                         # the only way to empty a list
grokbot auto-review append "<rule>" [--list allow|block]               # no-op if the rule is already in the list
```

`set` replaces only the chosen list (the other list and `isEnabled` are kept; `isEnabled` defaults to true when the
server had none) and rejects empty input without `--clear`. `append` is a single-writer read-modify-write, not atomic.
Operators write the Cursor runtime store and mirror host settings; a box writes host settings only. Each write adds an
audit record `{path, sha256, length}` of the new rule list (JSON) to the audit log under every policy, including operator.

## Automations / workflows / skills / MCP / channels
`listAllAutomations`, `getAgentAutomations`, `createAgentAutomation`, `updateAgentAutomation`, `deleteAgentAutomation`, `runAgentAutomationNow`, `setAgentAutomationEnabled`, `getAutomationWebhookCredential`;
`getAgentWorkflows`, `createAgentWorkflow`, `updateAgentWorkflow`, `deleteAgentWorkflow`, `runAgentWorkflowNow`, `importAgentWorkflowText`, `importAgentWorkflowUrl`, `portAgentLocalSkills`;
`skillsCatalog`, `syncPluginSkills`, `getPluginSyncStatus`, `getSkillPublishTargets`, `publishSkill`, `resyncPublishedSkill`, `unpublishSkill`;
`getMcpState`, `getMcpCatalog`, `getEffectiveMcpPlugins`, `installMcpEntry`, `updateMcpPluginInstall`, `removeMcpServer`, `uninstallMcpPlugin`, `authenticateMcpServer`, `listMcpServerTools`, `toggleMcpToolDisabled`, `setMcpCustomInstructions`;
`getAgentChannels`, `connectChannel`, `disconnectChannel`, `refreshChannel`; `getListenerIntegrations`, `getListenerConnectUrl`, `completeGithubConnect`.

## Box / host
`getHostStatus` ✓ → `{hostVersion, latestHostVersion, hostUpdateAvailable, isBusy, capabilities}` (host 00b0aa1 capabilities: `attachmentStoreSizedV1`, `orderedReplicasV1`, `sendAcceptanceV1`, `voiceSettingsV1`);
`getForeverBoxStatus`, `ensureForeverBox`, `handBackForeverBox`, `isEgressTunnelAvailable`, `updateHostNow`, `getBoxSecretsStatus`, `getCloudAgentInfo {bcId}`, `stopCloudAgent {bcId}`, `getTrays`, `dismissTray`, `clearTrays`, `startTeachRecording`, `stopTeachRecording`, `getTeachRecordingStatus`.

## Sharing
`publishBotTemplate`, `listBotTemplates`, `getBotTemplateVersion`, `getBotTemplateForSourceAgent`, `getBotTemplateExportPolicy`, `deleteBotTemplate`, `setBotTemplateVisibility`, `createAgentFromTemplate`. The shared-room commands of 0.47 are gone from the gateway (rooms are control-plane RPCs now: `CreateGrokBotRoom`, `SetGrokBotRoomMembers`, `AddGrokBotRoomPeople`, `RemoveGrokBotRoomPeople`).

## Roster row fields (listAgents)
`id name description title avatarDataUrl avatarVersion avatarShape avatarColor createdAt updatedAt path
isActive isRunning isRunningTurn isComposingMessage lastEntry lastMessageId lastMessagePreview
lastMessagePreviewSource lastMessageAuthorId pushMessageContent newestEntryId hasUnread unreadCount
lastViewedAt lastActivityAt awaitingUserResponse lastTurnSettlement notificationsEnabled
notifyOnUpdatesEnabled isHiddenFromSidebar voiceId voiceSpeed voiceLanguage origin namedBy isGroup
memberIds snapshotEpoch snapshotSeq`

## Cursor RPC (aiserver.v1.GrokBotService on api2.cursor.sh)
Headers: `connect-protocol-version: 1`, `authorization: Bearer <cursor access token>`,
`x-cursor-client-type: sand`, `x-cursor-client-version: <app version>`, `x-sand-box-namespace: prod`.
The 0.79.3 service has **464 methods** (0.47: ~134), extracted from `electron-main/proto.cjs`; six are server-streaming
(`WatchSandBoxMigration`, `WatchGrokBotTranscripts`, `WatchGrokBotUserComputerRequests`,
`OpenGrokBotUserComputerRequest`, `WatchGrokBotCalendarEvents`, `AdminWatchSandBoxMigration`), the rest unary.
About 128 are `Admin*` / `*Internal` (operator-of-the-service tools; not usable with a normal account).

Confirmed live and used by the CLI (read-only unless noted):
`EnsureSandBox {}` → `{gatewayUrl, gatewayToken, …}`, `ListGrokBotAgents {includeTeamAgents}`, `ListSandBoxes`,
`GetSandBoxRunState`, `ListGrokBotAgentSessions {agentId}`, `GetGrokBotUserRuntimeSettings {}` →
`{settings:{updatedAtMs, pinnedAgents:{agentIds}, sidebarSections:{sections}, hasSeenOnboarding, mainAgentId, termsSeenAtMs,
autoReviewInstructions:{isEnabled, allowInstructions, blockInstructions, approvalMode, effectiveApprovalMode}, emailProvider}}`,
`ListGrokBotAgentTodos {agentId}` → `{todos:[{id, content, status:TODO_STATUS_*, createdAt, updatedAt}]}`,
`ListGrokBotAgentTasks {agentId, includeRecentlyDone?}`, `ListGrokBotAccountAutomations`, `ListGrokBotTranscriptEntries`,
`GetGrokBotRuntimeCapabilities`, `ListGrokBotTemplates`/`GetGrokBotTemplateExportPolicy`, `ListGrokBotUserComputers`,
Dashboard `GetSandUsageStatus` etc. Writes the CLI makes: `UpdateGrokBotUserRuntimeSettings` with exactly one of
`{sidebarSections, sidebarSectionsBase}` (sections), `{pinnedAgents:{agentIds}}` (pins), or
`{autoReviewInstructions:{isEnabled, allowInstructions, blockInstructions}}` (auto-review); `SetGrokBotAgentAutomationEnabled`;
`DeleteGrokBotAgent {id}` → `{}` (`cursor delete-agent`, `agents delete`; the host's `deleteAgents` does not delete server-hosted agents, and the host roster mirror lags the control plane by minutes); `SetGrokBotAgentVisibility`.

Present but not exposed (candidates for later; none are needed by an existing command group): `SearchGrokBotTranscripts
{target, query, limit, agentId?, beforeSeq?, continuation?}` (server-side search across transcripts),
`ListGrokBotAgentStatuses {agentIds}`, `ListGrokBotSubagents`, `ListGrokBotTasks {agentId, sessionId}`,
`ListGrokBotAgentRoutines` / `SetGrokBotAgentRoutineEnabled` / `SetGrokBotAgentRoutineForTeam` (present next to the automation RPCs; not probed),
`ListGrokBotServerMeetings`, `ListGrokBotEmailInboxes`, `GetGrokBotUserProfile`, `GetGrokBotEgressPolicy`,
`SetGrokBotMainAgent`, `SetGrokBotAgentDraftingDisabled`, `DuplicateGrokBotAgent`, `CreateGrokBotRoom` /
`SetGrokBotRoomMembers`, `ListDeletedGrokBotAgentIds`, `GetGrokBotAgentAnalytics`, `ListGrokBotUserBotMemories`
(team memories; 403 for a non-owner), vault / secrets / passkeys / 1Password / Slack / Teams install flows, marketplace
and template publishing, email inbox admin. Use `grokbot cursor rpc <Method> '{…}'` for any of them.

## Slack and routine writes (control plane, operator-only in the CLI)
Request/response shapes are from the 0.79.3 protos; the reads were confirmed live, the writes were not run (unit tests only).

| RPC (service) | request | response | CLI |
|---|---|---|---|
| `ListGrokBotAgents` (GrokBot) | `{includeTeamAgents}` | `{agents, slackConnections:[{agentId, installUrl, pendingAdminApproval}]}` ✓ | `slack status` |
| `GetGrokBotSlackInstallState` (GrokBot) | `{agentId}` | `{status: …INSTALL_STATUS_{NOT_CONNECTED,APP_CREATED,CONNECTED,UNSUPPORTED_HARNESS}, slackTeamId?, workspaceName?, workspaces[{slackTeamId, slackTeamName, managerAuthUpdatedAtMs}], needsManifestUpdate, pendingReinstallApproval, oauthAuthorizeUrl?, approvalRequestFiled?, appUnreachable, removedInSlack, …}` ✓ (the server records a workspace here once the connect URL is completed in a browser signed in to Slack and cursor.com; no client-side claim) | `slack status`, `slack workspaces` (app section), `slack connect --wait` |
| `ListSlackLinkedWorkspaces` (Dashboard) | `{}` | `{workspaces:[{slackTeamId, displayName, linkedAtMs, status, sandAutomationCount, sandAutomationCountTruncated}], canLinkAnotherWorkspace}` ✓ (the routine-trigger link only; stays empty when just an agent app workspace is linked) | `slack workspaces` (routine-trigger section) |
| `GetSlackUserSettings` (Dashboard) | `{}` (`teamId` is the Cursor team) | `{hasSlackAuth, defaultRepo, …, slackCursorTeamLocked}` ✓ | `slack workspaces` (routine-trigger section) |
| `GetSlackInstallUrl` (Dashboard) | `{reconnectSlackTeamId?}` | `{url, source, attemptId}` ✓ (mints an install attempt) | `slack link-url` |
| `StartGrokBotSlackConnect` | `{agentId}` | `{url, outcome: STARTED\|UNSUPPORTED_HARNESS\|NOT_PUBLISHED}` | `slack connect [--wait] [--install --yes]` |
| `ClaimGrokBotSlackConnect` **write** | `{claim}` | `{outcome: CLAIMED\|INVALID\|WRONG_CURSOR_ACCOUNT, slackTeamId?, slackTeamName?}` (rarely needed: the server completes the connect itself) | `slack claim --yes` |
| `InstallGrokBotSlackApp` **write** | `{agentId, slackTeamId?, replaceExistingApp?}` | `{outcome: INSTALLED\|PENDING_ADMIN_APPROVAL\|NOT_CONNECTED\|WORKSPACE_REQUIRED\|MANAGER_REAUTH_REQUIRED\|INSUFFICIENT_SCOPES\|INSTALL_CONFLICT\|RATELIMITED\|SLACK_REJECTED\|UNSUPPORTED_HARNESS\|NOT_PUBLISHED\|WORKSPACE_NOT_ALLOWED, workspaces[], oauthAuthorizeUrl?, slackError?, retryAfterSeconds?, approvalRequestFiled?, previousWorkspaceName?, …}` | `slack install --yes`, `slack connect --install --yes` |
| `ReinstallGrokBotSlackApp` **write** | `{agentId}` (`automatic` is the app's own retry flag) | `{outcome: UPDATED\|UP_TO_DATE\|RECREATE_REQUIRED\|PENDING_ADMIN_APPROVAL\|NOT_CONNECTED\|MANAGER_REAUTH_REQUIRED\|INSUFFICIENT_SCOPES\|RATELIMITED\|SLACK_REJECTED\|UNSUPPORTED_HARNESS\|THROTTLED, …}` | `slack reinstall --yes` |
| `UninstallGrokBotSlackApp` **write** | `{agentId, forgetIfUnreachable?}` | `{outcome: REMOVED\|NOT_CONNECTED\|MANAGER_REAUTH_REQUIRED\|RATELIMITED\|SLACK_REJECTED\|UNSUPPORTED_HARNESS, forgotten?, …}` | `slack uninstall --yes` |
| `UnlinkSlackAccess` (Dashboard) **write** | `{slackTeamId}` (`allWorkspaces` exists; not exposed) | `{success}` | `slack unlink --yes` |
| `SetSandAutomationSlackWorkspace` (Dashboard) **write** | `{automationId, slackTeamId}` | the refreshed `ListSlackLinkedWorkspaces` body | `automations slack-workspace --yes` |
| `DeleteGrokBotAgentAutomation` **write** | `{agentId, automationId, timeZone?}` | `{automations}` (the agent's remaining rows) | `automations delete --yes` |
| `SendGrokBotUserMessage` **write** | `{agentId, messageId (uuid), text, sentAtMs (int64 as string), replyToId?}` (more optional fields: `richText`, `attachmentPaths`, `isFork`, `sessionId`, …) | `{dispatched, mode: …ACCEPTED_TEMPORAL, workflowId?, delivery?, refusal?}` ✓ (live, to a scratch agent) | `agents send` (operator) |
| `SetGrokBotAgentAutomationEnabled` **write** | `{agentId, automationId, isEnabled, timeZone?}` | `{automations}` | `automations enable\|disable`, `resume-guard` |

Enum values arrive as full proto names (`GROK_BOT_SLACK_INSTALL_OUTCOME_PENDING_ADMIN_APPROVAL`); a default (`UNSPECIFIED`)
value is omitted from the JSON, which the CLI treats as a failure rather than a success. On the live account (2026-11-08) the agent app workspace `Agent Everywhere` (T0B7GAT9JQ6) shows under `GetGrokBotSlackInstallState.workspaces` while `ListSlackLinkedWorkspaces` is empty. The gateway's `deleteAgentAutomation` is a silent no-op for control-plane routines.

## `window.desktop` over CDP (app 0.79+)
The 0.47 namespaces (`desktop.agent.*`, `desktop.cursorAccount.*`, `desktop.getBoxHostPhase`) are gone. The bridge is now
`window.desktop.{main, boot, environment, local}`; nearly everything is `window.desktop.main.<call>` (438 keys), and calls
validate their argument objects (`edge/invalid-args`). The ones the CLI and runbooks use:
`main.getHostSidebarSections({accountSlot})` (accountSlot = the signed-in principal, `main.getCursorAuthStatus().authId`;
`null` is rejected with `account/changed`), `main.setHostSidebarSections({sections, base, accountSlot})`,
`main.getHostPinnedAgents()` / `main.getServerPinnedAgents()` / `main.setHostPinnedAgents({pinnedAgentIds})` (all hit the
runtime store), `main.getCursorAuthStatus()`, `main.getBoxHostPhase()` (✓ `"following"`),
`main.getAutoReviewInstructions()` / `setAutoReviewInstructions`, `main.getCursorWeeklyUsage()`, `main.getSandAccess()`,
`main.getUpdateStatus()`. `grokbot cdp desktop` still accepts the four legacy *read* paths and rewrites them.
