# Host gateway command catalog (host version 48cbefa, app 0.47.0)

`POST {baseUrl}/api/<command>` · JSON body · headers: `authorization: Bearer <gatewayToken>`,
`x-anyrun-network-token: <routing token>` (both from the app's gateway descriptor).
Also `GET /health` → `{ok,pid,isBusy,activeAgentId,startedAt,lastBusyAtMs}` and `GET /events` (SSE).

Extracted from the desktop app's renderer command catalog and main-process bridge schemas.
Argument shapes marked ✓ were confirmed live by this CLI.

## Roster
| command | args | notes |
|---|---|---|
| `listAgents` | `{allowEmptyRoster?}` | ✓ array of roster rows (see below) |
| `countAgents` | – | ✓ number |
| `searchAgents` | `{query, limit?}` | ✓ |
| `createAgent` | `{name, description, title?, purpose?, avatarShape?, avatarColor?, isIntroductionSuppressed?, isKickstartRequested?}` | ✓ |
| `updateAgent` | `{id, profile:{name, description, title?, avatarShape?, avatarColor?}}` | ✓ |
| `deleteAgents` | `{ids:[…], allowEmptyRoster?}` | ✓ bulk |
| `deleteAgent` | `{id}` | |
| `duplicateAgent` | `{id}` | clones store + profile, clears conversation |
| `setAgentHiddenFromSidebar` | `{id, isHidden}` | ✓ |
| `setAgentUnread` | `{id, isUnread, atMs?}` | |
| `setAgentNotificationsEnabled` / `setAgentNotifyOnUpdates` | `{id, isEnabled}` | |
| `setAgentVoice`, `setAgentAvatarBytes`, `getAgentAvatar` | | |
| `interruptAgentRun` | `{id, sessionId?}` | |
| `kickstartAgent` | `{id}` | |
| `createGroup` | `{name, description?, memberAgentIds:[…], clientNonce?}` | |
| `setGroupMembers` | `{id, memberAgentIds:[…]}` | |
| `broadcastToAgents` | `{targets:"all"|[ids], message}` | **not exposed by the CLI** |
| `getServerAgentRoster`, `resolveAgentCreation`, `restoreTemporalAgentRouting`, `requestDiskSaverAudit` | | |

## Conversation
| command | args |
|---|---|
| `sendPrompt` | `{agentId, prompt, clientNonce, replyToId?, richText?, attachmentPaths?, attachmentNames?, isFork?}` → `{accepted}` |
| `promptAcceptanceStatus` | `{clientNonce}` |
| `getAgentTranscriptTail` | `{id, limit}` |
| `getAgentTranscriptPage` | `{id, limit, beforeSeq?}` |
| `getAgentTranscript`, `getAgentTranscriptWindow`, `openAgentTail`, `openAgentWindowed`, `openAgent` | |
| `getAgentThread` | `{id, rootId}` |
| `getConversationOutline` | `{id}` |
| `reactToMessage`, `voteFeedback`, `respondToWidget`, `dismissWidget`, `submitSecret`, `submitUserForm`, `dismissUserForm`, `sendDraft`, `discardDraft` | |
| `resolveAutoReviewApproval`, `resolveLocalToolPermission`, `resolveMessagesGrants`, `resolveVirtualCardApproval` | |
| `searchMedia` | `{query, limit?}` |
| `getSubagents`, `getAsyncTasks` | `{id}` |
| `getAgentMemories`, `clearAgentMemories`, `deleteAgentMemory` | `{id}`, `{id}`, `{id, memoryId}` |

## Host settings (sections, pins, models)
| command | args |
|---|---|
| `getHostSettings` | – ✓ → `{sidebarSections, pinnedAgentIds, agentDefaultModel?, computerUseModel?, notifications, mcp*, autoReviewInstructions, localToolPermission, messagesEnabled, userTimeZone, webauthnProxyEnabled, hasSeenOnboarding}` |
| `setHostSettings` | partial patch, e.g. `{sidebarSections:[{id,name,agentIds}]}` ✓ → merged settings |

`autoReviewInstructions` is a free-form string. The CLI exposes it through a narrow command that is
allowed under agent policy (raw `settings set` stays denied); `set` and `append` send exactly
`{autoReviewInstructions: <string>}` to `setHostSettings`:

```
grokbot auto-review get
grokbot auto-review set "<text>"          # or: --file rules.md | --stdin (exactly one source)
grokbot auto-review set --clear           # the only way to set an empty value
grokbot auto-review append "<line>"       # appends a line; no-op if it is already the last line
```

`set` rejects empty/whitespace-only values (any source) without `--clear`, and prints the previous
value's length to stderr. `append` is a single-writer read-modify-write (get then set), not atomic:
concurrent writers can lose each other's lines. Each write appends an audit record `{path, sha256,
length}` of the new value to the audit log under every policy, including operator.

## Automations / workflows / skills / MCP / channels
`listAllAutomations`, `getAgentAutomations`, `createAgentAutomation`, `updateAgentAutomation`, `deleteAgentAutomation`, `runAgentAutomationNow`, `setAgentAutomationEnabled`, `getAutomationWebhookCredential`;
`getAgentWorkflows`, `createAgentWorkflow`, `updateAgentWorkflow`, `deleteAgentWorkflow`, `runAgentWorkflowNow`, `importAgentWorkflowText`, `importAgentWorkflowUrl`, `portAgentLocalSkills`;
`skillsCatalog`, `syncPluginSkills`, `getPluginSyncStatus`, `getSkillPublishTargets`, `publishSkill`, `resyncPublishedSkill`, `unpublishSkill`;
`getMcpState`, `getMcpCatalog`, `getEffectiveMcpPlugins`, `installMcpEntry`, `updateMcpPluginInstall`, `removeMcpServer`, `uninstallMcpPlugin`, `authenticateMcpServer`, `listMcpServerTools`, `toggleMcpToolDisabled`, `setMcpCustomInstructions`;
`getAgentChannels`, `connectChannel`, `disconnectChannel`, `refreshChannel`; `getListenerIntegrations`, `getListenerConnectUrl`, `completeGithubConnect`.

## Box / host
`getHostStatus` ✓ → `{hostVersion, latestHostVersion, hostUpdateAvailable, isBusy, capabilities}`;
`getForeverBoxStatus`, `ensureForeverBox`, `handBackForeverBox`, `isEgressTunnelAvailable`, `updateHostNow`, `getBoxSecretsStatus`, `getBoxStoreStatus`, `snapshotBoxStoreNow`, `clearBoxStoreNow`, `getCloudAgentInfo {bcId}`, `stopCloudAgent {bcId}`, `getTrays`, `dismissTray`, `clearTrays`, `startTeachRecording`, `stopTeachRecording`, `getTeachRecordingStatus`.

## Sharing
`publishBotTemplate`, `listBotTemplates`, `getBotTemplateVersion`, `getBotTemplateForSourceAgent`, `getBotTemplateExportPolicy`, `deleteBotTemplate`, `setBotTemplateVisibility`; rooms: `createSharedRoom`, `joinSharedRoom`, `leaveSharedRoom`, `createRoomInvite`, `respondToRoomJoinRequest`, `addOwnAgentToSharedRoom`, `removeOwnAgentFromSharedRoom`, `setSharedRoomTyping`.

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
Confirmed live: `EnsureSandBox {}` → `{gatewayUrl, gatewayToken, …}`, `ListGrokBotAgents {includeTeamAgents}`,
`ListSandBoxes`, `GetSandBoxRunState`, `ListGrokBotAgentSessions {agentId}`.
Also present: `CreateGrokBotAgent`, `UpdateGrokBotAgent`, `DeleteGrokBotAgent {id}`, `SetGrokBotAgentVisibility`,
`SetGrokBotAgentClientState`, `ListGrokBotTemplates`, `ListGrokBotUserComputers`, `GetGrokBotRuntimeCapabilities`,
`SendGrokBotUserMessage`, `InterruptGrokBotAgentRun`, `ListGrokBotTranscriptEntries`, `WatchGrokBotTranscripts`,
`AdminListGrokBotTeamAgents`, plus 130 more (see `grokbot cursor rpc`).
