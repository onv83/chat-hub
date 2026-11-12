'use strict'

// Local ChatHub service-session containment. No account preference changes.
// Do not use on every session-created event: unrelated/default sessions must
// retain their policy. Install on configured partitions before loading guests.
function installGuestNotificationPolicy(ses) {
  // Electron 33.4.11's no-handler check denies synchronous clipboard reads.
  // Preserve that exception rather than broadening it with an allow-all hook.
  ses.setPermissionCheckHandler((_contents, permission) =>
    permission !== 'notifications' && permission !== 'deprecated-sync-clipboard-read')
  // Preserve ChatHub's existing request grants for all OTHER permissions.
  // Neither hook dereferences contents: notification/SW checks may pass null.
  ses.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission !== 'notifications'))
}
module.exports = { installGuestNotificationPolicy }
