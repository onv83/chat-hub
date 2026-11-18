'use strict'

// Service pages never receive browser or device permissions implicitly. A future
// feature that needs camera/microphone must add an explicit user-consent flow.
function installGuestNotificationPolicy(ses) {
  ses.setPermissionCheckHandler(() => false)
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
}
module.exports = { installGuestNotificationPolicy }
