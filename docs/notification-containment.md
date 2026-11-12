# Guest notification containment

## Current state

The main process installs request and check handlers on the configured ChatHub service sessions before creating the first window. Saving a changed service list installs the same policy before proxy setup. Both handlers deny `notifications`, including calls with null webContents from worker paths. The policy stays attached to the session when guest views are reloaded or recreated.

This temporarily blocks **all guest system notifications, including favorites**. It does not modify messenger account preferences, other browsers/native clients, unread state, or Windows notification history. Changes to main.js take effect on the next application launch; the integration did not restart the running app. There is no new toggle that would imply favorites delivery is available.

Unlike the original proposed patch, this integration does not apply an allow-all handler to the default session or every `session-created` event. Only sessions named by configured services are touched. Existing request grants for other permissions stay unchanged. The check handler preserves Electron 33.4.11's default denial of `deprecated-sync-clipboard-read`; returning true for every non-notification check would broaden clipboard access.

Reference source inspected for the installed Electron 33.4.11:
- `electron/electron`, tag `v33.4.11`, `shell/browser/electron_permission_manager.cc`, `CheckPermissionWithDetails`: default check denies `DEPRECATED_SYNC_CLIPBOARD_READ` and grants other checks.
- Same tag, `shell/common/gin_converters/content_converter.cc`: the permission is exposed as `deprecated-sync-clipboard-read`.
- Prepared official Electron session documentation: both permission hooks are needed, and notification checks may have null webContents.

Recheck this compatibility exception when changing Electron versions. No other permission policy hardening is included in this batch.

## Inert broker foundation

`notification-broker.js` and `notification-ledger.js` are not imported by main, preload, or renderer. No production stream, timer, IPC entrypoint, ledger file, or synthetic message is created. Unit tests inject fake notifications and synthetic events; they do not show OS toasts.

The broker accepts explicit incoming live message events only, with exact service/account/chat favorite bindings. It rejects self, replay, bootstrap and unread-delta observations. Stream retirement and favorite removal/rebinding revoke pending click routes. Its single-writer ledger stores SHA-256 event-key hashes separately from config.json and claims before display. This means at-most-once **attempt**, not guaranteed delivery: a crash between claim and show loses the notification. The return value `shown` means show() returned, not that Windows confirmed delivery. The ledger has no pruning/compaction yet.

## Remaining work before favorites delivery

1. Supply and validate real message-event adapters for each service. MM/TG/MAX/Telemost are all blocked pending verified feeds, stable event IDs, current account/self identity, a post-bootstrap watermark and canonical favorite bindings. Do not infer messages from unread deltas or match chats by title. Do not invent a MAX/Telemost user API.
2. Keep openStream/setFavorites in trusted main-process code. Do not expose them directly to guests. Retire streams on logout/reconnect and revalidate current favorites/account at delivery and click.
3. Connect the exact trusted pinId/serviceId/accountId/chatId/url click route to shell selection. Review pending-toast lifetime, Action Center behavior, disposal and ledger size limits before enabling production.
4. Verify Windows attribution separately from content branding. The broker requests title `Chat Hub` and an injected local icon; it is not proof of the Windows sender name/logo. Existing sources use productName `ChatHub`, `BrowserWindow.icon` = `build/icon.ico`, and a dev-only AppUserModelID `ChatHub.Dev`. Existing Windows-branding instructions concern executable/window/taskbar resources. The stable app's shortcut/package identity and AppUserModelID still need an agreed, tested notification branding plan. Reuse `build/icon_256.png` or `build/icon.ico`; no rcedit, executable changes, shortcut changes or real OS toasts were performed here.
5. With authorization, launch the changed app and verify containment with a controlled real-message test. Favorites delivery and Windows click/branding acceptance remain open until their separate end-to-end test passes.

The existing Telemost popup/navigation guard is unchanged. Its subframe/OAuth behavior is a separate known follow-up, not fixed by notification containment.

## Offline verification

`npm test` includes the session-policy integration harness, broker and ledger suites, alongside existing config/startup/navigation/renderer regressions. The harness executes the real main.js with fake Electron sessions and temporary filesystem fixtures. It checks all four partitions, null/undefined contents, non-notification semantics, untouched unrelated/default sessions, startup order and service additions.

No account settings, personal messages or real OS notification APIs are accessed by these tests.
