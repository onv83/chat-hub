'use strict'
const SERVICES = Object.freeze(['mm', 'tg', 'max', 'ydx'])
const keyOf = p => JSON.stringify([p.serviceId, p.accountId, p.chatId])

// Main-process only. Never expose openStream/setFavorites directly to a guest.
function createNotificationBroker({ Notification, icon, ledger, route, now = Date.now }) {
  let favorites = new Map()
  const streams = new Map(), active = new Set()
  const text = s => typeof s === 'string' && s.length > 0 && s.length <= 2048
  function revoke(record) {
    record.valid = false
    active.delete(record)
    try { record.notification.close() } catch {}
  }
  function setFavorites(pins) {
    const next = new Map()
    for (const p of pins) {
      if (!SERVICES.includes(p.serviceId) || !['pinId','accountId','chatId','url'].every(k => text(p[k]))) continue
      const key = keyOf(p), old = favorites.get(key)
      next.set(key, old && old.pinId === p.pinId && old.url === p.url ? old : Object.freeze({
        pinId:p.pinId, serviceId:p.serviceId, accountId:p.accountId, chatId:p.chatId, url:p.url
      }))
    }
    favorites = next
    for (const r of active) if (favorites.get(r.key) !== r.pin) revoke(r)
  }
  function closeStream(serviceId) {
    streams.delete(serviceId)
    for (const r of active) if (r.pin.serviceId === serviceId) revoke(r)
  }
  function openStream({ serviceId, accountId, selfId, liveAfter }) {
    if (!SERVICES.includes(serviceId) || !text(accountId) || !text(selfId) || !Number.isFinite(liveAfter) || liveAfter > now()) throw new TypeError('Invalid trusted stream')
    closeStream(serviceId)
    const token = Symbol(serviceId)
    streams.set(serviceId, token)
    return { close() { if (streams.get(serviceId) === token) closeStream(serviceId) }, accept(event) {
      if (streams.get(serviceId) !== token) return { status:'stale-stream' }
      if (!event || event.kind !== 'message' || event.phase !== 'live' || event.outgoing !== false || event.replayed !== false ||
          !text(event.eventId) || !text(event.chatId) || !text(event.authorId) || event.authorId === selfId ||
          !Number.isFinite(event.occurredAt) || event.occurredAt <= liveAfter || event.occurredAt > now()) return { status:'ineligible' }
      const key = keyOf({serviceId, accountId, chatId:event.chatId}), p = favorites.get(key)
      if (!p) return { status:'not-favorite' }
      if (!Notification.isSupported()) return { status:'unsupported' }
      try {
        if (!ledger.claim(JSON.stringify([serviceId, accountId, event.chatId, event.eventId]))) return { status:'duplicate' }
      } catch { return { status:'storage-error' } }
      // Claim BEFORE display: at-most-once attempt, not guaranteed delivery after a crash.
      let r
      try {
        const n = new Notification({ title:'Chat Hub', body:typeof event.body === 'string' ? event.body.slice(0,500) : 'Новое сообщение', icon })
        r = {key, pin:p, notification:n, valid:true}
        active.add(r)
        n.on('click', () => {
          if (!r.valid || favorites.get(key) !== p || streams.get(serviceId) !== token) return
          r.valid = false
          active.delete(r)
          try { route({ ...p }) } catch {}
        })
        n.on('close', () => { r.valid = false; active.delete(r) })
        n.on('failed', () => { r.valid = false; active.delete(r) })
        n.show()
        return { status:'shown' }
      } catch { if(r) revoke(r); return { status:'display-error' } }
    } }
  }
  return { setFavorites, openStream, closeStream, dispose() { for(const s of streams.keys()) closeStream(s); favorites.clear() } }
}
module.exports = { SERVICES, createNotificationBroker }
