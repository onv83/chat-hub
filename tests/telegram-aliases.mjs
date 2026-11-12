import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { element } from './synthetic-dom.mjs'
const source = readFileSync(new URL('../renderer.js', import.meta.url), 'utf8')
function load(ctx, name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('))
  if (start < 0) return
  const end = source.slice(start + 1).search(/\n(?:async )?function /)
  vm.runInContext(source.slice(start, start + end + 1), ctx)
}
function harness() {
  const peers = { 1: { _: 'user', id: 1 }, 22: { _: 'user', id: 22, username: 'Work_User', photo: {} }, 33: { _: 'user', id: 33, username: 'Other_User' } }
  const apiManagerProxy = { mirrors: { peers, state: { userId: 1, authState: { _: 'authStateSignedIn' } } } }
  const rootScope = { myId: 1 }
  const rows = [22, 33].map(id => {
    const row = element('a', 'row-clickable', '', [element('span', 'peer-title', 'Same name'), element('span', 'dialog-subtitle-badge-unread', String(id))])
    row.getAttribute = key => key === 'data-peer-id' ? String(id) : key === 'href' ? '#' + id : ''
    const clone = row.cloneNode.bind(row)
    row.cloneNode = deep => Object.assign(clone(deep), { getAttribute: row.getAttribute })
    return row
  })
  const document = { querySelector: () => null, querySelectorAll: () => rows }
  const ctx = vm.createContext({ apiManagerProxy, rootScope, document, window: {}, URL, setTimeout, clearTimeout,
    getComputedStyle: () => ({ backgroundColor: 'rgb(112,117,121)' }),
    __chatHubScanRows: async collect => collect(), __chatHubBoundedAvatar: async row => 'avatar:' + row.getAttribute('data-peer-id') })
  load(ctx, '__chatHubTgUnread')
  const favs = [{ id: 'p', title: 'Same name', url: 'https://web.telegram.org/k/#@Work_User', pid: '33', needAvatar: true }]
  return { ctx, peers, rows, apiManagerProxy, rootScope, favs, run: async () => JSON.parse(await ctx.__chatHubTgUnread(favs, false)) }
}
function dialogHarness() {
  const h = harness()
  h.rows.length = 0
  h.favs[0].needAvatar = false
  h.favs[0].needDialogMetadata = true
  h.dialog = { _: 'dialog', peer: { _: 'peerUser', user_id: 22 }, unread_count: 0, unread_mentions_count: 0, pFlags: {} }
  h.dialogCalls = []
  h.rootScope.managers = { dialogsStorage: { getDialogOnly: async id => { h.dialogCalls.push(id); return h.dialog } } }
  return h
}
test('TG verified dialog zero is an offscreen unread observation, not missing-row zero', async () => {
  const h = dialogHarness(), r = (await h.run()).favs[0]
  assert.equal(r.found, true)
  assert.equal(r.count, 0)
  assert.equal(r.mentions, 0)
  assert.equal(r.unread, false)
  assert.equal(r.unreadSource.source, 'webk-dialogsStorage')
  assert.equal(r.unreadSource.accountId, '1')
  assert.equal(r.unreadSource.peerId, '22')
  assert.deepEqual(h.dialogCalls, [22])
})
test('TG numeric user without DOM publishes verified unread and clears only on verified zero through scheduler', async () => {
  const h = dialogHarness()
  h.favs[0].url = 'https://web.telegram.org/k/#22'
  delete h.peers[22].username
  const host = dialogHost(h)
  h.dialog.unread_count = 5
  await host.ctx.pollUnread()
  assert.equal(host.guestResults.at(-1).favs[0].found, true)
  assert.equal(host.guestResults.at(-1).favs[0].unreadSource.peerId, '22')
  assert.equal(host.state.unreadTotals.p.c, 5)
  const at = host.state.unreadTotalsAt.p
  const valid = h.dialog
  h.dialog = undefined
  await host.ctx.pollUnread()
  assert.equal(host.guestResults.at(-1).favs[0].found, false)
  assert.equal(host.state.unreadTotals.p.c, 5)
  assert.equal(host.state.unreadTotalsAt.p, at)
  h.dialog = { ...valid, unread_count: 0 }
  host.state.activePinId = 'p'
  await host.ctx.refreshSelectedUnread('p')
  assert.equal(host.state.unreadTotals.p.c, 0)
  assert.ok(host.state.unreadTotalsAt.p >= at)
})
test('TG numeric authority refuses stale DOM and pin fallback on missing or failed service, including selected lane', async () => {
  for (const failure of ['missing', 'throw']) {
    const h = dialogHarness()
    h.favs[0].url = 'https://web.telegram.org/k/#22'
    const host = dialogHost(h), pinGuest = harness()
    h.rows.push(harness().rows[0])
    h.dialog = undefined
    if (failure === 'throw') host.state.svcViews.tg.executeJavaScript = async () => { throw Error('unavailable') }
    let pinCalls = 0
    host.state.pinViews.p = { isConnected: true, executeJavaScript: script => { pinCalls++; return new vm.Script(script).runInContext(pinGuest.ctx) } }
    await host.ctx.pollUnread()
    host.state.activePinId = 'p'
    await host.ctx.refreshSelectedUnread('p')
    assert.equal(host.state.unreadTotals.p.c, 7, failure)
    assert.equal(host.state.unreadTotalsAt.p, 123, failure)
    assert.equal(pinCalls, 0, failure)
  }
})
test('TG numeric metadata cannot scroll and rebinding invalidates prior account counters even when dialog unloaded', async () => {
  const h = dialogHarness()
  h.favs[0].url = 'https://web.telegram.org/k/#22'
  h.favs[0].needUnread = true
  let allowed
  h.ctx.__chatHubScanRows = async (collect, selector, key, allow) => { allowed = allow; return collect() }
  await h.ctx.__chatHubTgUnread(h.favs, true)
  assert.equal(allowed, false)
  const host = dialogHost(h)
  h.dialog.unread_count = 5
  await host.ctx.pollUnread()
  h.rootScope.myId = 2
  h.apiManagerProxy.mirrors = { state: { userId: 2, authState: { _: 'authStateSignedIn' } }, peers: { 2: { _: 'user', id: 2 }, 22: { _: 'user', id: 22 } } }
  h.dialog = undefined
  host.state.activePinId = 'p'
  await host.ctx.refreshSelectedUnread('p')
  assert.equal(host.state.unreadTotals.p, undefined)
  assert.equal(host.state.unreadTotalsAt.p, undefined)
  assert.equal(host.state.tgIdentityKeys.p, '2::22')
})
for (const reverse of [false, true]) test(`TG numeric and username same peer share one verified dialog read (reverse=${reverse})`, async () => {
  const h = dialogHarness()
  h.favs.push({ ...h.favs[0], id: 'numeric', url: 'https://web.telegram.org/k/#22' })
  if (reverse) h.favs.reverse()
  h.dialog.unread_count = 4
  const result = await h.run()
  assert.deepEqual(h.dialogCalls, [22])
  assert.ok(result.favs.every(r => r.found && r.count === 4 && r.unreadSource.peerId === '22'))
})
for (const invalid of ['0', '022', '+22', '22.0', '22e0', '9007199254740993', '-22', '-0', '--22', 'missing', 'wrongType', 'wrongId']) test(`TG numeric unread rejects ${invalid} without guessed dialog semantics`, async () => {
  const h = dialogHarness()
  h.favs[0].url = 'https://web.telegram.org/k/#' + (['missing','wrongType','wrongId'].includes(invalid) ? '22' : invalid)
  if (invalid === 'missing') delete h.peers[22]
  if (invalid === 'wrongType') h.peers[22]._ = 'channel'
  if (invalid === 'wrongId') h.peers[22].id = 33
  h.peers[-22] = { _: 'channel', id: 22, pFlags: { forum: true } }
  const r = (await h.run()).favs[0]
  assert.equal(r.found, false)
  assert.equal(r.unreadSource, null)
  assert.equal(h.dialogCalls.length, 0)
})
for (const change of ['account','reset','logout','manager','peer','generation']) test(`TG numeric dialog rejects stale ${change} across await`, async () => {
  const h = dialogHarness()
  h.favs[0].url = 'https://web.telegram.org/k/#22'
  h.rootScope.managers.dialogsStorage.getDialogOnly = async () => {
    if (change === 'account') h.rootScope.myId = 2
    if (change === 'reset') h.apiManagerProxy.mirrors.peers = { ...h.peers }
    if (change === 'logout') h.apiManagerProxy.mirrors.state.authState._ = 'signedOut'
    if (change === 'manager') h.rootScope.managers.dialogsStorage = {}
    if (change === 'peer') h.peers[22].id = 33
    if (change === 'generation') h.ctx.window.__hubTgDialogs.generation++
    return h.dialog
  }
  const r = (await h.run()).favs[0]
  assert.equal(r.found, false)
  assert.equal(r.unreadSource, null)
  assert.ok(!r.dialogIdentity)
})
test('TG numeric late generation after row/avatar collection cannot publish a stale positive', async () => {
  const h = dialogHarness()
  h.favs[0].url = 'https://web.telegram.org/k/#22'
  h.rows.push(harness().rows[1])
  h.favs.push({ id: 'later', url: 'https://web.telegram.org/k/#33', needAvatar: true })
  h.ctx.__chatHubBoundedAvatar = async () => { h.ctx.window.__hubTgDialogs.generation++; return null }
  const r = (await h.run()).favs[0]
  assert.equal(r.found, false)
  assert.equal(r.unreadSource, null)
})
test('TG numeric large safe user ID projects only dialog scalars, including manual unread mark', async () => {
  const h = dialogHarness(), id = 8123456789
  h.favs[0].url = 'https://web.telegram.org/k/#' + id
  h.peers[id] = { _: 'user', id }
  h.dialog = new Proxy({ _: 'dialog', peer: { _: 'peerUser', user_id: id }, unread_count: 0, unread_mentions_count: 0, pFlags: { unread_mark: true } }, {
    get(target, key) { assert.ok(['_', 'peer', 'unread_count', 'unread_mentions_count', 'pFlags', 'then'].includes(key), String(key)); return target[key] }
  })
  const r = (await h.run()).favs[0]
  assert.equal(r.found, true)
  assert.equal(r.unread, true)
  assert.equal(r.manualUnread, true)
  assert.equal(r.unreadSource.peerId, String(id))
  assert.deepEqual(h.dialogCalls, [id])
})
test('TG numeric malformed/error dialog preserves prior observation through real scheduler', async () => {
  for (const invalid of ['count', 'flags', 'peer', 'rejected']) {
    const h = dialogHarness()
    h.favs[0].url = 'https://web.telegram.org/k/#22'
    const host = dialogHost(h)
    if (invalid === 'count') h.dialog.unread_count = -1
    if (invalid === 'flags') delete h.dialog.pFlags
    if (invalid === 'peer') h.dialog.peer.user_id = 33
    if (invalid === 'rejected') h.rootScope.managers.dialogsStorage.getDialogOnly = async () => { throw Error('unavailable') }
    await host.ctx.pollUnread()
    assert.equal(host.guestResults.at(-1).favs[0].found, false, invalid)
    assert.equal(host.state.unreadTotals.p.c, 7, invalid)
    assert.equal(host.state.unreadTotalsAt.p, 123, invalid)
  }
})
function dialogHost(h) {
  const pins = h.favs.map(p => ({ ...p, serviceId: 'tg' }))
  const state = { cfg: { services: [{ id: 'tg' }], pinned: pins }, svcViews: {}, pinViews: {}, tgIdentityKeys: { p: h.favs[0].url === 'https://web.telegram.org/k/#22' ? '1::22' : '1:work_user:22' } }
  for (const key of ['pinAvatars','unreadTotals','unreadTotalsAt','unreadBaseC','unreadBaseM','prevUnread','rankAct','lastMsgAt','lastMsgText','lastMsgPreview','liveAct','tgPeerOf']) state[key] = {}
  state.pinAvatars.p = 'existing-avatar'
  state.unreadTotals.p = { c: 7, m: 0 }; state.unreadTotalsAt.p = 123
  const guestResults = []
  state.svcViews.tg = { isConnected: true, executeJavaScript: async script => {
    const raw = await new vm.Script(script).runInContext(h.ctx)
    guestResults.push(JSON.parse(raw)); return raw
  } }
  const ctx = vm.createContext({ state, setTimeout, clearTimeout, console, document: { querySelector: () => null },
    window: { hub: { isWinFocused: async () => true } }, favoritesOf: () => pins, svcViewFor: () => state.svcViews.tg,
    updateBadge2() {}, updateBadge() {}, sortFavoritesByActivity() {}, scheduleActSave() {}, tgSearchResolve: async () => null,
    __chatHubGrabAvatar: async function() { return null } })
  for (const name of ['runUnreadJob','unreadViewState','unreadGuestCall','pollUnread','pollUnreadService','refreshUnreadPresentation','refreshSelectedUnread','unreadDeltaFor','shouldBumpLiveAct','tgPidSafe','restorePreviewAuthor','__chatHubScanRows','__chatHubBoundedAvatar','formatMaxPreview','__chatHubTgUnread','applyTgIdentityObservation']) load(ctx, name)
  ctx.UNREAD_EXTRACTORS = { tg: ctx.__chatHubTgUnread }
  return { ctx, state, guestResults }
}
test('TG actual serialized dialog collector clears prior seven, preserves unknown, and publishes manual mark', async () => {
  const h = dialogHarness(), host = dialogHost(h)
  await host.ctx.pollUnread()
  assert.equal(host.guestResults.length, 1)
  assert.equal(host.guestResults[0].favs[0].found, true)
  assert.equal(host.state.unreadTotals.p.c, 0)
  const at = host.state.unreadTotalsAt.p
  assert.ok(at > 123)
  assert.equal(host.state.pinAvatars.p, 'existing-avatar')
  h.dialog = undefined
  await host.ctx.pollUnread()
  assert.equal(host.guestResults.at(-1).favs[0].found, false)
  assert.equal(host.state.unreadTotals.p.c, 0)
  assert.equal(host.state.unreadTotalsAt.p, at)
  h.dialog = { _: 'dialog', peer: { _: 'peerUser', user_id: 22 }, unread_count: 0, unread_mentions_count: 0, pFlags: { unread_mark: true } }
  await host.ctx.pollUnread()
  assert.equal(host.state.unreadDots.p, true)
})
test('TG selected read refresh uses service dialog metadata, never pin-view manager or avatar', async () => {
  const h = dialogHarness(), host = dialogHost(h), pinGuest = dialogHarness()
  host.state.activePinId = 'p'
  host.state.pinViews.p = { isConnected: true, executeJavaScript: script => new vm.Script(script).runInContext(pinGuest.ctx) }
  await host.ctx.refreshSelectedUnread('p')
  assert.equal(host.state.unreadTotals.p.c, 0)
  assert.equal(h.dialogCalls.length, 1)
  assert.equal(pinGuest.dialogCalls.length, 0)
})
test('TG service dialog collector cannot enable virtualized scrolling', async () => {
  const h = dialogHarness()
  h.favs[0].needUnread = true
  let allowed
  h.ctx.__chatHubScanRows = async (collect, selector, key, allow) => { allowed = allow; return collect() }
  await h.ctx.__chatHubTgUnread(h.favs, true)
  assert.equal(allowed, false)
})
test('TG newer dialog generation invalidates earlier output during later avatar await', async () => {
  const h = dialogHarness()
  h.rows.push(harness().rows[1])
  h.favs.push({ id: 'later', url: 'https://web.telegram.org/k/#33', needAvatar: true })
  h.ctx.__chatHubBoundedAvatar = async () => { h.ctx.window.__hubTgDialogs.generation++; return null }
  const r = (await h.run()).favs[0]
  assert.equal(r.found, false)
  assert.equal(r.unreadSource, null)
})
test('TG unavailable authoritative dialog preserves prior seven despite a stale DOM zero and pin-view fallback', async () => {
  const h = dialogHarness(), host = dialogHost(h), pinGuest = harness()
  h.dialog = undefined
  const staleRow = harness().rows[0]
  staleRow.querySelector('.dialog-subtitle-badge-unread').text = ''
  h.rows.push(staleRow)
  host.state.pinViews.p = { isConnected: true, executeJavaScript: script => new vm.Script(script).runInContext(pinGuest.ctx) }
  await host.ctx.pollUnread()
  assert.equal(host.state.unreadTotals.p.c, 7)
  assert.equal(host.state.unreadTotalsAt.p, 123)
  host.state.activePinId = 'p'
  await host.ctx.refreshSelectedUnread('p')
  assert.equal(host.state.unreadTotals.p.c, 7)
  assert.equal(host.state.unreadTotalsAt.p, 123)
})
test('TG selected metadata account rebind clears prior avatar and identity caches', async () => {
  const h = dialogHarness(), host = dialogHost(h)
  host.state.activePinId = 'p'
  h.rootScope.myId = 2
  h.apiManagerProxy.mirrors = { state: { userId: 2, authState: { _: 'authStateSignedIn' } }, peers: { 2: { _: 'user', id: 2 }, 22: { _: 'user', id: 22, username: 'work_user' } } }
  await host.ctx.refreshSelectedUnread('p')
  assert.equal(host.state.tgIdentityKeys.p, '2:work_user:22')
  assert.equal(host.state.pinAvatars.p, undefined)
  assert.equal(host.state.unreadTotals.p.c, 0)
})
for (const invalid of ['missing','count','mentions','negative','fraction','flags','mark','peer','type','rejected','unavailable']) test(`TG dialog ${invalid} remains unknown without advancing host timestamp`, async () => {
  const h = dialogHarness(), host = dialogHost(h)
  if (invalid === 'missing') h.dialog = undefined
  if (invalid === 'count') delete h.dialog.unread_count
  if (invalid === 'mentions') delete h.dialog.unread_mentions_count
  if (invalid === 'negative') h.dialog.unread_count = -1
  if (invalid === 'fraction') h.dialog.unread_count = 1.5
  if (invalid === 'flags') delete h.dialog.pFlags
  if (invalid === 'mark') h.dialog.pFlags.unread_mark = 1
  if (invalid === 'peer') h.dialog.peer.user_id = 33
  if (invalid === 'type') h.dialog._ = 'savedDialog'
  if (invalid === 'rejected') h.rootScope.managers.dialogsStorage.getDialogOnly = () => Promise.reject(Error('offline'))
  if (invalid === 'unavailable') delete h.rootScope.managers.dialogsStorage
  await host.ctx.pollUnread()
  assert.equal(host.guestResults.at(-1).favs[0].found, false)
  assert.equal(host.state.unreadTotals.p.c, 7)
  assert.equal(host.state.unreadTotalsAt.p, 123)
})
for (const change of ['account','reset','rename','logout','manager']) test(`TG dialog await rejects stale ${change}`, async () => {
  const h = dialogHarness()
  h.rootScope.managers.dialogsStorage.getDialogOnly = async () => {
    if (change === 'account') h.rootScope.myId = 2
    if (change === 'reset') h.apiManagerProxy.mirrors.peers = { ...h.peers }
    if (change === 'rename') h.peers[22].username = 'different'
    if (change === 'logout') h.apiManagerProxy.mirrors.state.authState._ = 'signedOut'
    if (change === 'manager') h.rootScope.managers.dialogsStorage = {}
    return h.dialog
  }
  const r = (await h.run()).favs[0]
  assert.equal(r.found, false)
  assert.equal(r.unreadSource, null)
})
test('TG two hanging dialog calls remain physically bounded across 100 polls and account resets', async () => {
  const h = dialogHarness()
  h.favs.push({ ...h.favs[0], id: 'second', url: 'https://web.telegram.org/k/#@Other_User' })
  let calls = 0
  const resolvers = []
  h.rootScope.managers.dialogsStorage.getDialogOnly = () => { calls++; return new Promise(resolve => resolvers.push(resolve)) }
  const start = Date.now()
  const first = await h.run()
  assert.ok(Date.now() - start < 1600)
  assert.ok(first.favs.every(r => !r.found))
  for (let i = 0; i < 100; i++) {
    h.apiManagerProxy.mirrors.peers = { ...h.peers }
    assert.ok((await h.run()).favs.every(r => !r.found))
  }
  assert.equal(calls, 2)
  assert.equal(h.ctx.window.__hubTgDialogs.pending.size, 2)
  for (const resolve of resolvers) resolve(h.dialog)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.ctx.window.__hubTgDialogs.pending.size, 0)
  assert.deepEqual(Object.keys(h.ctx.window.__hubTgDialogs).sort(), ['generation','pending'])
})
test('TG dialog adapter deduplicates peers, caps each round, and never reads message/profile fields', async () => {
  const h = dialogHarness()
  for (let i = 100; i < 180; i++) {
    h.peers[i] = { _: 'user', id: i, username: `user_${i}` }
    h.favs.push({ ...h.favs[0], id: String(i), url: `https://web.telegram.org/k/#@user_${i}` })
  }
  h.favs.push({ ...h.favs[0], id: 'duplicate' })
  let pending = 0, max = 0, calls = 0
  h.rootScope.managers.dialogsStorage.getDialogOnly = async id => {
    calls++; max = Math.max(max, ++pending)
    await Promise.resolve(); pending--
    return new Proxy({ _: 'dialog', peer: { _: 'peerUser', user_id: id }, unread_count: 3, unread_mentions_count: 1, pFlags: {} }, {
      get(target, key) { assert.ok(['_', 'peer','unread_count','unread_mentions_count','pFlags','then'].includes(key), String(key)); return target[key] }
    })
  }
  const result = await h.run()
  assert.equal(calls, 64)
  assert.ok(max <= 2)
  assert.equal(result.favs.at(-1).count, 3)
  assert.equal(result.favs[0].mentions, 1)
  assert.equal(result.favs.filter(r => r.found).length, 65)
})
test('TG non-service guests cannot start unverified dialog reads', async () => {
  const h = dialogHarness()
  h.favs.push({ ...h.favs[0], id: 'numeric', url: 'https://web.telegram.org/k/#22' })
  for (const f of h.favs) f.needDialogMetadata = false
  const result = await h.run()
  assert.equal(h.dialogCalls.length, 0)
  assert.ok(result.favs.every(r => !r.found))
})
test('TG failed service execution cannot fall back to stale pin-view username unread', async () => {
  const h = dialogHarness(), host = dialogHost(h), pinGuest = harness()
  host.state.svcViews.tg.executeJavaScript = async () => { throw Error('service unavailable') }
  host.state.pinViews.p = { isConnected: true, executeJavaScript: script => new vm.Script(script).runInContext(pinGuest.ctx) }
  await host.ctx.pollUnread()
  assert.equal(host.state.unreadTotals.p.c, 7)
  assert.equal(host.state.unreadTotalsAt.p, 123)
  host.state.activePinId = 'p'
  await host.ctx.refreshSelectedUnread('p')
  assert.equal(host.state.unreadTotals.p.c, 7)
  assert.equal(host.state.unreadTotalsAt.p, 123)
})
test('TG serialized priority zero supersedes older pending dialog seven without resurrection', async () => {
  const h = dialogHarness(), host = dialogHost(h)
  let resolveOld, calls = 0
  h.rootScope.managers.dialogsStorage.getDialogOnly = () => ++calls === 1
    ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve(h.dialog)
  const poll = host.ctx.pollUnread()
  while (!resolveOld) await new Promise(resolve => setImmediate(resolve))
  host.state.activePinId = 'p'
  await host.ctx.refreshSelectedUnread('p')
  assert.equal(host.state.unreadTotals.p.c, 0)
  resolveOld({ ...h.dialog, unread_count: 7 })
  await poll
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(host.state.unreadTotals.p.c, 0)
  assert.equal(h.ctx.window.__hubTgDialogs.pending.size, 0)
})
function previewHarness() {
  const h = timestampHarness()
  h.favs[0].needMessagePreview = true
  h.message = { _: 'message', mid: 42, peerId: 22, date: 1794410337, pFlags: {}, fromId: 33, message: 'synthetic latest' }
  h.apiManagerProxy.mirrors.messages['0_history'][42] = h.message
  h.peers[33].first_name = 'Fixture Sender'
  return h
}
test('TG pinned cache preview uses exact latest sender, not dialog title', async () => {
  const h = previewHarness(), r = (await h.run()).favs[0]
  assert.equal(r.preview, 'Fixture Sender: synthetic latest')
  assert.equal(r.messagePreview?.messageId, '42')
  assert.equal(r.messagePreview?.senderId, '33')
  assert.equal(r.messagePreview?.out, false)
})

test('TG cache preview reaches serialized scheduler and ignores stale author learning', async () => {
  const h = previewHarness(), host = dialogHost(h)
  host.state.msgAuth = { p: {text:'synthetic latest',out:true} }
  await host.ctx.pollUnread()
  assert.equal(host.state.lastMsgPreview.p, 'Fixture Sender: synthetic latest')
  assert.equal(host.state.msgAuth.p.messageId, '42')
  assert.equal(host.state.msgAuth.p.out, false)
})

for (const [body, flags, sender, expected] of [
  ['12345', {}, 33, 'Fixture Sender: 12345'],
  ['https://fixture.invalid/a: b', {}, 33, 'Fixture Sender: https://fixture.invalid/a: b'],
  ['sent', {out:true}, 22, 'Вы: sent'],
  ['unknown', {}, 99, 'unknown'],
]) test('TG cache preview literal text and outgoing evidence '+body, async () => {
  const h=previewHarness(); Object.assign(h.message,{message:body,pFlags:flags,fromId:sender})
  assert.equal((await h.run()).favs[0].preview,expected)
})
for (const kind of ['peer','mid','account','mirror','top','alias','generation']) test('TG cache preview zero body reads for rejected '+kind,async()=>{
  const h=previewHarness(); let reads=0
  Object.defineProperty(h.message,'message',{get(){reads++; return 'must not read'}})
  if(kind==='peer') h.message.peerId=99
  if(kind==='mid') h.message.mid=43
  if(kind==='account') h.rootScope.myId=2
  if(['mirror','top','alias','generation'].includes(kind)) h.ctx.__chatHubScanRows=async()=>{
    if(kind==='mirror') h.apiManagerProxy.mirrors.messages={}
    if(kind==='top') h.dialog.top_message=43
    if(kind==='alias') h.peers[22].username='changed'
    if(kind==='generation') h.ctx.window.__hubTgDialogs.generation++
    return []
  }
  const r=(await h.run()).favs[0]
  assert.equal(reads,0)
  assert.ok(!r.messagePreview)
})
test('TG cache preview distinguishes service/media/empty and never reads drafts or media payload',async()=>{
  for(const [message,expected,kind] of [
    [{_: 'messageService'}, '[Служебное сообщение]', 'service'],
    [{message:'',media:{_:'messageMediaPhoto'}}, '[Фото]', 'media'],
    [{message:'',media:{_:'messageMediaDocument'}}, '[Документ]', 'media'],
    [{message:'',media:{_:'messageMediaEmpty'}}, '[Пустое сообщение]', 'empty'],
  ]) {
    const h=previewHarness(); Object.assign(h.message,message)
    Object.defineProperty(h.dialog,'draft',{get(){throw Error('draft forbidden')}})
    if(h.message.media) Object.defineProperty(h.message.media,'photo',{get(){throw Error('payload forbidden')}})
    const r=(await h.run()).favs[0]
    assert.equal(r.preview,'Fixture Sender: '+expected)
    assert.equal(r.messagePreview.kind,kind)
  }
})
test('TG cache preview bounds long sender/text, does not read unrelated fields',async()=>{
  const h=previewHarness(); h.peers[33].first_name='Long '.repeat(1000); h.message.message='x'.repeat(1000000)
  for(const k of ['phone','access_hash','password']) Object.defineProperty(h.peers[33],k,{get(){throw Error('private')}})
  Object.defineProperty(h.message,'entities',{get(){throw Error('entities')}})
  const r=(await h.run()).favs[0]
  assert.equal(r.messagePreview.author.length,128); assert.equal(r.messagePreview.text.length,240)
  assert.ok(r.preview.length<=370)
})

test('TG cache preview only reads requested pinned cache, never DOM drafts/unrelated previews',async()=>{
  const h=previewHarness(); let reads=0
  const row=element('a','row-clickable','',[element('span','peer-title','Fixture')])
  row.getAttribute=k=>k==='data-peer-id'?'999':k==='href'?'#999':''
  const query=row.querySelector.bind(row)
  row.querySelector=s=>s==='.dialog-subtitle'?{get textContent(){reads++;return 'private'}}:query(s)
  row.cloneNode=()=>{throw Error('non-pinned row must not be cloned')}
  h.rows.push(row)
  await h.run()
  assert.equal(reads,0)
})
test('TG cache preview never deep-clones sidebar message contents',async()=>{
  const h=previewHarness()
  const row=element('a','row-clickable','',[element('span','peer-title','Fixture')])
  row.getAttribute=k=>k==='data-peer-id'?'22':k==='href'?'#22':''
  row.cloneNode=deep=>{assert.equal(deep,false);return element('a','row-clickable')}
  h.rows.push(row)
  assert.ok((await h.run()).favs[0].messagePreview)
})

test('TG cache preview deleted or unavailable entry cannot retain old text or author',async()=>{
  const h=previewHarness(),host=dialogHost(h)
  await host.ctx.pollUnread()
  h.apiManagerProxy.mirrors.messages['0_history'][42]={_:'messageEmpty',mid:42,peerId:22}
  await host.ctx.pollUnread()
  assert.ok(!host.state.lastMsgPreview.p)
  assert.ok(!host.state.msgAuth.p)
})
test('TG cache preview unknown sender cannot inherit identical old text author',async()=>{
  const h=previewHarness(),host=dialogHost(h)
  await host.ctx.pollUnread()
  h.message.fromId=99
  host.state.msgAuth.p={text:'synthetic latest',out:true,messageId:'42'}
  await host.ctx.pollUnread()
  assert.equal(host.state.lastMsgPreview.p,'synthetic latest')
  assert.equal(host.state.msgAuth.p.author,'')
})
test('TG structured row author supports long names and unknown numeric/URL bodies',async()=>{
  const h=previewHarness(),host=dialogHost(h)
  h.peers[33].first_name='Long Sender '.repeat(10)
  await host.ctx.pollUnread()
  load(host.ctx,'setRowPreview'); host.ctx.escapeHtml=s=>s.replaceAll('<','&lt;')
  const el={dataset:{},closest:()=>({dataset:{pin:'p'}})}
  host.ctx.setRowPreview(el,host.state.lastMsgPreview.p)
  assert.ok(el.innerHTML?.startsWith('<b>Long Sender'))
  for(const body of ['12: 34','https://fixture.invalid/a: b']) {
    h.message.message=body; h.message.fromId=99
    await host.ctx.pollUnread()
    el.dataset={};el.innerHTML='';el.textContent=''
    host.ctx.setRowPreview(el,host.state.lastMsgPreview.p)
    assert.equal(el.textContent,body); assert.equal(el.innerHTML,'')
  }
})

test('TG structured row removes stale bold author when identical text becomes unknown body',async()=>{
  const h=previewHarness(),host=dialogHost(h)
  await host.ctx.pollUnread();load(host.ctx,'setRowPreview');host.ctx.escapeHtml=s=>s
  const el={dataset:{},closest:()=>({dataset:{pin:'p'}})}
  host.ctx.setRowPreview(el,host.state.lastMsgPreview.p)
  h.message.message=host.state.lastMsgPreview.p;h.message.fromId=99
  await host.ctx.pollUnread()
  host.ctx.setRowPreview(el,host.state.lastMsgPreview.p)
  assert.equal(el.textContent,'Fixture Sender: synthetic latest')
})

test('TG cache preview keeps media classification with a caption',async()=>{
  const h=previewHarness();h.message.media={_:'messageMediaPhoto'}
  const r=(await h.run()).favs[0]
  assert.equal(r.messagePreview.kind,'media')
  assert.equal(r.messagePreview.text,'synthetic latest')
})

test('TG cache preview same-ID edit refreshes body and current sender',async()=>{
  const h=previewHarness(),host=dialogHost(h)
  await host.ctx.pollUnread()
  h.message.message='edited fixture';h.message.pFlags.out=true
  await host.ctx.pollUnread()
  assert.equal(host.state.lastMsgPreview.p,'Вы: edited fixture')
})
for(const pid of ['22','-55']) test('TG cache preview signed numeric peer and channel sender '+pid,async()=>{
  const h=previewHarness(); h.favs[0].url='https://web.telegram.org/k/#'+pid
  if(pid==='-55') {
    h.peers[-55]={_:'channel',id:55,title:'Fixture channel'};h.message.peerId=-55;h.message.fromId=-55
    h.dialog.peer={_:'peerChannel',channel_id:55}
  }
  const r=(await h.run()).favs[0]
  assert.equal(r.messagePreview.peerId,pid)
  assert.equal(r.messagePreview.author,pid==='-55'?'Fixture channel':'Fixture Sender')
})
test('TG cache preview metadata-only/selected lane reads no message body',async()=>{
  const h=previewHarness();delete h.favs[0].needMessagePreview
  let reads=0;Object.defineProperty(h.message,'message',{get(){reads++;return 'forbidden'}})
  await h.run();assert.equal(reads,0)
  const host=dialogHost(h);host.state.activePinId='p'
  await host.ctx.refreshSelectedUnread('p');assert.equal(reads,0)
})
test('TG cache preview after late confirmation account reset reads no body',async()=>{
  const h=previewHarness();let calls=0,reads=0
  h.rootScope.managers.dialogsStorage.getDialogOnly=async()=>{if(++calls===3)h.rootScope.myId=2;return h.dialog}
  Object.defineProperty(h.message,'message',{get(){reads++;return 'forbidden'}})
  const r=(await h.run()).favs[0]
  assert.ok(!r.messagePreview);assert.equal(reads,0)
  assert.ok(!r.messageTime);assert.ok(!r.unreadSource)
})
test('TG cache preview blocked confirmation keeps physical slot across timeout',async()=>{
  const h=previewHarness();let calls=0,finish
  h.rootScope.managers.dialogsStorage.getDialogOnly=()=>++calls===3?new Promise(r=>finish=r):Promise.resolve(h.dialog)
  assert.ok(!(await h.run()).favs[0].messagePreview)
  assert.equal(h.ctx.window.__hubTgDialogs.pending.size,1)
  finish(h.dialog);await new Promise(r=>setImmediate(r))
  assert.equal(h.ctx.window.__hubTgDialogs.pending.size,0)
})

for(const mutation of ['deleted','unknown-type']) test('TG cache preview rejects in-place unsupported type before body '+mutation,async()=>{
  const h=previewHarness();let reads=0
  h.ctx.__chatHubScanRows=async()=>{h.message._=mutation==='deleted'?'messageEmpty':'futureMessage';return []}
  Object.defineProperty(h.message,'message',{get(){reads++;return 'forbidden'}})
  assert.ok(!(await h.run()).favs[0].messagePreview);assert.equal(reads,0)
})

function timestampHarness() {
  const h = dialogHarness()
  h.favs[0].needMessageMetadata = true
  h.dialog.top_message = 42
  h.message = { _: 'message', mid: 42, peerId: 22, peer_id: { _: 'peerUser', user_id: 22 }, date: 1794410337 }
  for (const key of ['message','media','entities','from_id']) Object.defineProperty(h.message,key,{get(){throw Error('body access forbidden')}})
  h.apiManagerProxy.mirrors.messages = { '0_history': { 42: h.message } }
  h.apiManagerProxy.getHistoryMessagesStorage = id => `${id}_history`
  h.apiManagerProxy.getMessageFromStorage = (key,mid) => h.apiManagerProxy.mirrors.messages['0_history']?.[mid]
  return h
}
test('TG offscreen top-message cache projects exact UTC seconds without body access',async()=>{
  const h=timestampHarness(),r=(await h.run()).favs[0]
  assert.equal(r.messageTime?.at,1794410337000)
  assert.equal(r.messageTime?.dayOnly,false)
  assert.equal(r.messageTime?.source,'webk-top-message-cache')
  assert.equal(r.messageTime?.accountId,'1')
  assert.equal(r.messageTime?.peerId,'22')
  assert.equal(r.messageTime?.messageId,'42')
})
test('TG timestamp serialized scheduler restores missing Dmitry/Sasha-like times and retains them on missing observations',async()=>{
  const h=timestampHarness(),host=dialogHost(h)
  for(const n of ['mergeLastMessageTime','fmtChatWhen','parseChatTime','activitySnapshot','ensureKeys'])load(host.ctx,n)
  await host.ctx.pollUnread()
  assert.equal(host.guestResults.at(-1).favs[0].messageTime?.at,1794410337000)
  assert.equal(host.state.lastMsgAt.p,1794410337000)
  assert.equal(host.state.lastMsgDayOnly.p,false)
  assert.equal(host.state.lastMsgSource.p?.peerId,'22')
  h.apiManagerProxy.getMessageFromStorage=()=>undefined
  await host.ctx.pollUnread()
  assert.equal(host.state.lastMsgAt.p,1794410337000)
})
for(const peerId of [22,-44,-55])test(`TG canonical numeric ${peerId} timestamp uses exact peer-local cache, not shared message IDs`,async()=>{
  const h=timestampHarness()
  const kind=peerId>0?'user':peerId===-44?'chat':'channel'
  h.peers[peerId]={_:kind,id:Math.abs(peerId)}
  h.favs[0].url=`https://web.telegram.org/k/#${peerId}`
  h.dialog.peer=peerId>0?{_:'peerUser',user_id:peerId}:kind==='chat'?{_:'peerChat',chat_id:-peerId}:{_:'peerChannel',channel_id:-peerId}
  h.message.peerId=peerId
  h.message.peer_id=h.dialog.peer
  h.apiManagerProxy.getMessageFromStorage=(key,mid)=>key===`${peerId}_history`&&mid===42?h.message:undefined
  assert.equal((await h.run()).favs[0].messageTime?.at,1794410337000)
  h.message.peerId=peerId+1
  assert.equal((await h.run()).favs[0].messageTime,null)
})
for(const failure of ['mid','peer','date','type','missing','error','account','mirror','changed-top'])test(`TG cached top timestamp fails closed on ${failure}`,async()=>{
  const h=timestampHarness()
  if(failure==='mid')h.message.mid=41
  if(failure==='peer')h.message.peerId=33
  if(failure==='date')h.message.date=NaN
  if(failure==='type')h.message._='messageEmpty'
  if(failure==='missing')h.apiManagerProxy.getMessageFromStorage=()=>null
  if(failure==='error')h.apiManagerProxy.getMessageFromStorage=()=>{throw Error('unavailable')}
  if(['account','mirror','changed-top'].includes(failure)){
    let calls=0
    h.rootScope.managers.dialogsStorage.getDialogOnly=async()=>{
      if(++calls===2){
        if(failure==='account')h.rootScope.myId=2
        if(failure==='mirror')h.apiManagerProxy.mirrors.messages={...h.apiManagerProxy.mirrors.messages}
        if(failure==='changed-top')return {...h.dialog,top_message:43}
      }
      return h.dialog
    }
  }
  assert.ok(!(await h.run()).favs[0].messageTime)
})
test('TG timestamp never uses logs fallback or starts reads without explicit service permission',async()=>{
  const h=timestampHarness()
  h.favs[0].needMessageMetadata=false
  h.apiManagerProxy.getMessageFromStorage=()=>{throw Error('must not access messages')}
  assert.ok(!(await h.run()).favs[0].messageTime)
})
test('TG verified timestamp provenance survives cold restart and first same-account alias binding',async()=>{
  const h=timestampHarness(),host=dialogHost(h)
  for(const n of ['mergeLastMessageTime','fmtChatWhen','parseChatTime','activitySnapshot','ensureKeys'])load(host.ctx,n)
  host.ctx.tgScrollDone=false
  await host.ctx.pollUnread()
  const saved=JSON.parse(JSON.stringify(host.ctx.activitySnapshot()))
  assert.equal(saved.lastMsgSource?.p?.messageId,'42')
  const restored=dialogHost(h)
  for(const n of ['mergeLastMessageTime','fmtChatWhen','parseChatTime','activitySnapshot','ensureKeys'])load(restored.ctx,n)
  Object.assign(restored.state.cfg,{activity:saved,actReset1:true,actReset2:true,actReset3:true,actReset4:true,actReset5:true})
  restored.state.tgIdentityKeys={}
  restored.ctx.ensureKeys(restored.state.cfg)
  h.apiManagerProxy.getMessageFromStorage=()=>undefined
  await restored.ctx.pollUnread()
  assert.equal(restored.state.lastMsgAt.p,1794410337000)
  assert.equal(restored.state.lastMsgDayOnly.p,false)
  assert.equal(restored.state.lastMsgSource.p.messageId,'42')
})
test('TG numeric account switch invalidates prior timestamp even when new top message is not cached',async()=>{
  const h=timestampHarness(),host=dialogHost(h)
  h.favs[0].url='https://web.telegram.org/k/#22'
  host.state.cfg.pinned[0].url=h.favs[0].url
  for(const n of ['mergeLastMessageTime','fmtChatWhen','parseChatTime'])load(host.ctx,n)
  await host.ctx.pollUnread()
  assert.equal(host.state.lastMsgAt.p,1794410337000)
  h.rootScope.myId=2;h.apiManagerProxy.mirrors.state={userId:2,authState:{_:'authStateSignedIn'}};h.peers[2]={_:'user',id:2}
  h.apiManagerProxy.getMessageFromStorage=()=>undefined
  await host.ctx.pollUnread()
  assert.equal(host.state.lastMsgAt.p,undefined)
  assert.equal(host.state.lastMsgSource.p,undefined)
})
test('TG optional timestamp cache failure cannot suppress authoritative unread zero',async()=>{
  const h=timestampHarness()
  h.apiManagerProxy.getMessageFromStorage=()=>{throw Error('cache unavailable')}
  const r=(await h.run()).favs[0]
  assert.equal(r.found,true)
  assert.equal(r.count,0)
  assert.equal(r.unreadSource.source,'webk-dialogsStorage')
})
test('TG repeated message ID across two channels retains each peer-local date',async()=>{
  const h=timestampHarness()
  h.peers[-44]={_:'channel',id:44};h.peers[-55]={_:'channel',id:55}
  h.favs.splice(0,1,...[-44,-55].map(peerId=>({id:String(peerId),url:`https://web.telegram.org/k/#${peerId}`,needMessageMetadata:true})))
  const messages={ '-44_history':{_: 'message',mid:42,peerId:-44,date:1794410337}, '-55_history':{_: 'messageService',mid:42,peerId:-55,date:1794389824} }
  h.rootScope.managers.dialogsStorage.getDialogOnly=async peerId=>({_:'dialog',peer:{_:'peerChannel',channel_id:-peerId},top_message:42})
  h.apiManagerProxy.getMessageFromStorage=(key,mid)=>mid===42?messages[key]:null
  const result=(await h.run()).favs
  assert.deepEqual(result.map(r=>r.messageTime?.at),[1794410337000,1794389824000])
  assert.deepEqual(result.map(r=>r.messageTime?.peerId),['-44','-55'])
  assert.ok(result.every(r=>!r.found),'timestamp does not invent group unread semantics')
})
test('TG serialized exact top timestamp refines a stored same-day noon bucket downward',async()=>{
  const h=timestampHarness(),host=dialogHost(h)
  for(const n of ['mergeLastMessageTime','fmtChatWhen','parseChatTime'])load(host.ctx,n)
  const exact=new Date(2026,10,11,8,17,23).getTime()
  h.message.date=exact/1000
  host.state.lastMsgAt.p=new Date(2026,10,11,12).getTime()
  host.state.lastMsgDayOnly={p:true}
  host.state.lastMsgText.p='11.11'
  await host.ctx.pollUnread()
  assert.equal(host.state.lastMsgAt.p,exact)
  assert.equal(host.state.lastMsgDayOnly.p,false)
})
function photoHarness() {
  const h = harness()
  h.rows.length = 0
  h.favs[0].needMetadataAvatar = true
  h.peers[22].photo = { _: 'userProfilePhoto', photo_id: '42', dc_id: 2 }
  h.peers[22].pFlags = {}
  h.ctx.AbortController = AbortController
  h.ctx.btoa = s => Buffer.from(s, 'binary').toString('base64')
  h.ctx.fetch = async () => ({ ok: true, blob: async () => ({ type: 'image/jpeg', size: 3, arrayBuffer: async () => Uint8Array.from([1,2,3]).buffer }) })
  h.calls = []
  h.apiManagerProxy.loadAvatar = (...args) => { h.calls.push(args); return Promise.resolve('blob:https://web.telegram.org/test') }
  h.flush = () => new Promise(resolve => setImmediate(resolve))
  return h
}
test('TG offscreen photo uses verified small-avatar API without granting unread coverage', async () => {
  const h = photoHarness()
  await h.run(); await h.flush()
  const r = (await h.run()).favs[0]
  assert.equal(r.avatar, 'data:image/jpeg;base64,AQID')
  assert.equal(r.found, false, 'photo is not proof of an unread observation')
  assert.deepEqual(h.calls, [[22, h.peers[22].photo, 'photo_small']])
})
test('TG unresolved photo holds its physical slot beyond cooldown across 100 polls', async () => {
  const h = photoHarness()
  let now = 1000
  h.ctx.Date = { now: () => now }
  h.apiManagerProxy.loadAvatar = (...args) => { h.calls.push(args); return new Promise(() => {}) }
  for (let i = 0; i < 100; i++) { await h.run(); now += 61000 }
  assert.equal(h.calls.length, 1)
})
test('TG cached photo is revalidated after later asynchronous row work', async () => {
  const h = photoHarness()
  const row = harness().rows[1]
  await h.run(); await h.flush()
  h.rows.push(row)
  h.favs.push({ id: 'later', url: 'https://web.telegram.org/k/#33', needAvatar: true })
  h.ctx.__chatHubBoundedAvatar = async () => { h.peers[22].photo.photo_id = '99'; return null }
  assert.equal((await h.run()).favs[0].avatar, null)
})
for (const change of ['reset','account','rename','logout','photo']) test(`TG background photo rejects stale ${change}`, async () => {
  const h = photoHarness(); let resolve
  h.apiManagerProxy.loadAvatar = () => new Promise(r => { resolve = r })
  await h.run()
  if (change === 'reset') h.apiManagerProxy.mirrors.peers = { ...h.peers }
  if (change === 'account') h.rootScope.myId = 2
  if (change === 'rename') h.peers[22].username = 'different'
  if (change === 'logout') h.apiManagerProxy.mirrors.state.authState._ = 'signedOut'
  if (change === 'photo') h.peers[22].photo.photo_id = '99'
  resolve('blob:https://web.telegram.org/test'); await h.flush()
  assert.ok([...h.ctx.window.__hubTgPhotos.entries.values()].every(e => !e.data))
})
for (const invalid of ['url','mime','oversize','rejected','min','missing','selected']) test(`TG photo fails closed for ${invalid}`, async () => {
  const h = photoHarness()
  if (invalid === 'url') h.apiManagerProxy.loadAvatar = () => 'https://untrusted.invalid/avatar'
  if (invalid === 'mime') h.ctx.fetch = async () => ({ ok: true, blob: async () => ({ type: 'text/html', size: 3 }) })
  if (invalid === 'oversize') h.ctx.fetch = async () => ({ ok: true, blob: async () => ({ type: 'image/jpeg', size: 65537 }) })
  if (invalid === 'rejected') h.apiManagerProxy.loadAvatar = () => Promise.reject(Error('offline'))
  if (invalid === 'min') h.peers[22].pFlags.min = true
  if (invalid === 'missing') delete h.peers[22].photo
  if (invalid === 'selected') h.favs[0].needAvatar = false
  await h.run(); await h.flush()
  assert.equal((await h.run()).favs[0].avatar, null)
  if (['min','missing','selected'].includes(invalid)) assert.equal(h.calls.length, 0)
})
test('TG photo reset cannot multiply two frozen physical requests', async () => {
  const h = photoHarness()
  h.apiManagerProxy.loadAvatar = (...args) => { h.calls.push(args); return new Promise(() => {}) }
  for (let i = 0; i < 100; i++) {
    h.apiManagerProxy.mirrors.peers = { ...h.peers }
    await h.run()
  }
  assert.equal(h.calls.length, 2)
  assert.equal(h.ctx.window.__hubTgPhotos.pending.size, 2)
})
test('TG bounded offscreen photos pass through the actual serialized scheduler without zeroing unread', async () => {
  const h = photoHarness(), pins = h.favs.map(p => ({ ...p, serviceId: 'tg' }))
  const state = { cfg: { services: [{ id: 'tg' }], pinned: pins }, svcViews: {}, pinViews: {}, tgIdentityKeys: { p: '1:work_user:22' } }
  for (const key of ['pinAvatars','unreadTotals','unreadTotalsAt','unreadBaseC','unreadBaseM','prevUnread','rankAct','lastMsgAt','lastMsgText','lastMsgPreview','liveAct','tgPeerOf']) state[key] = {}
  state.unreadTotals.p = { c: 7, m: 0 }; state.unreadTotalsAt.p = 123
  state.svcViews.tg = { isConnected: true, executeJavaScript: script => new vm.Script(script).runInContext(h.ctx) }
  const ctx = vm.createContext({ state, setTimeout, clearTimeout, console, document: { querySelector: () => null },
    window: { hub: { isWinFocused: async () => true } }, favoritesOf: () => pins, svcViewFor: () => state.svcViews.tg,
    updateBadge2() {}, updateBadge() {}, sortFavoritesByActivity() {}, scheduleActSave() {}, tgSearchResolve: async () => null,
    __chatHubGrabAvatar: async function() { return null } })
  for (const name of ['runUnreadJob','unreadViewState','unreadGuestCall','pollUnread','pollUnreadService','refreshUnreadPresentation','refreshSelectedUnread','unreadDeltaFor','shouldBumpLiveAct','tgPidSafe','restorePreviewAuthor','__chatHubScanRows','__chatHubBoundedAvatar','formatMaxPreview','__chatHubTgUnread','applyTgIdentityObservation']) load(ctx, name)
  ctx.UNREAD_EXTRACTORS = { tg: ctx.__chatHubTgUnread }
  await ctx.pollUnread(); await h.flush(); await ctx.pollUnread()
  assert.equal(state.pinAvatars.p, 'data:image/jpeg;base64,AQID')
  assert.equal(state.unreadTotals.p.c, 7)
  assert.equal(state.unreadTotalsAt.p, 123)
  assert.equal(h.calls.length, 1)
})
test('TG bounded photo cache never evicts a still-pending key to start it twice', async () => {
  const h = photoHarness(), original = h.favs[0]
  h.apiManagerProxy.loadAvatar = (...args) => {
    h.calls.push(args)
    return args[0] === 22 ? new Promise(() => {}) : Promise.resolve('blob:https://web.telegram.org/test')
  }
  for (let i = 100; i < 150; i++) {
    h.peers[i] = { _: 'user', id: i, username: `work_${i}`, pFlags: {}, photo: { _: 'userProfilePhoto', photo_id: String(i), dc_id: 2 } }
    h.favs.splice(0, h.favs.length, original, { id: String(i), url: `https://web.telegram.org/k/#@work_${i}`, needAvatar: true, needMetadataAvatar: true })
    await h.run(); await h.flush()
    assert.ok(h.ctx.window.__hubTgPhotos.entries.size <= 32)
  }
  assert.equal(h.calls.filter(args => args[0] === 22).length, 1)
})
test('TG logout purges photo bytes even when no pin can start a new photo request', async () => {
  const h = photoHarness()
  await h.run(); await h.flush()
  assert.ok(h.ctx.window.__hubTgPhotos.entries.size > 0)
  h.apiManagerProxy.mirrors.state.authState._ = 'signedOut'
  await h.run()
  assert.equal(h.ctx.window.__hubTgPhotos.entries.size, 0)
  assert.equal(h.ctx.window.__hubTgPhotos.peers, null)
})
test('TG pin-view fallback cannot start metadata photo RPCs', async () => {
  const h = photoHarness()
  h.favs[0].needMetadataAvatar = false
  await h.run(); await h.flush()
  assert.equal(h.calls.length, 0)
})
test('TG account-owned username resolves canonical numeric row, never same-name stale cache', async () => {
  const h = harness(), r = (await h.run()).favs[0]
  assert.equal(r.found, true)
  assert.equal(r.pid, '22')
  assert.equal(r.count, 22)
  assert.equal(r.avatar, 'avatar:22')
  assert.deepEqual(r.identity, { source: 'webk-account-peer', accountId: '1', username: 'work_user', peerId: '22', photoPresent: true })
})
for (const change of ['account', 'reset', 'rename', 'logout', 'conflict']) test(`TG drops in-flight alias observations after ${change}`, async () => {
  const h = harness()
  h.ctx.__chatHubBoundedAvatar = async () => {
    if (change === 'account') { h.rootScope.myId = 2; h.apiManagerProxy.mirrors.state.userId = 2 }
    if (change === 'reset') h.apiManagerProxy.mirrors.peers = { ...h.peers }
    if (change === 'rename') h.peers[22].username = 'Renamed'
    if (change === 'logout') h.apiManagerProxy.mirrors.state.authState._ = 'authStateSignIn'
    if (change === 'conflict') h.peers[33].username = 'WORK_USER'
    return 'stale-avatar'
  }
  const r = (await h.run()).favs[0]
  assert.equal(r.found, false)
  assert.equal(r.identity, null)
  assert.equal(r.avatar, null)
  assert.equal(r.pid, null)
})
test('TG conflicting direct link and mirror alias stays unknown', async () => {
  const h = harness()
  h.rows[1].getAttribute = key => key === 'href' ? '#@work_user' : key === 'data-peer-id' ? '33' : ''
  assert.equal((await h.run()).favs[0].found, false)
})
test('TG conflicting mirror aliases cannot fall back to direct link', async () => {
  const h = harness()
  h.peers[33].username = 'WORK_USER'
  h.rows[0].getAttribute = key => key === 'href' ? '#@work_user' : key === 'data-peer-id' ? '22' : ''
  assert.equal((await h.run()).favs[0].found, false)
})
test('TG duplicate links to one peer are not ambiguous; duplicate pins keep exact identity', async () => {
  const h = harness()
  h.rows.push(h.rows[0])
  h.favs.push({ ...h.favs[0], id: 'second' })
  const r = await h.run()
  assert.ok(r.favs.every(f => f.found && f.pid === '22'))
})
test('TG changed username between polls ignores legacy pid and previous alias', async () => {
  const h = harness()
  assert.equal((await h.run()).favs[0].pid, '22')
  h.peers[22].username = 'New_Name'
  const missing = (await h.run()).favs[0]
  assert.equal(missing.found, false)
  assert.equal(missing.identity, null)
  h.peers[33].username = 'Work_User'
  assert.equal((await h.run()).favs[0].pid, '33')
})
test('TG different signed-in account uses only its mirror, never retained aliases', async () => {
  const h = harness()
  await h.run()
  h.rootScope.myId = 2
  h.apiManagerProxy.mirrors = { state: { userId: 2, authState: { _: 'authStateSignedIn' } }, peers: { 2: { _: 'user', id: 2 }, 33: { _: 'user', id: 33, username: 'work_user' } } }
  const r = (await h.run()).favs[0]
  assert.equal(r.pid, '33')
  assert.equal(r.identity.accountId, '2')
})
test('TG unverified account and malformed mirror identity never grant numeric alias', async () => {
  for (const change of ['missing', 'mismatch', 'not-user', 'bad-id', 'wrong-origin']) {
    const h = harness()
    if (change === 'missing') delete h.ctx.apiManagerProxy
    if (change === 'mismatch') h.apiManagerProxy.mirrors.state.userId = 2
    if (change === 'not-user') h.peers[22]._ = 'channel'
    if (change === 'bad-id') h.peers[22].id = 33
    if (change === 'wrong-origin') h.favs[0].url = 'https://untrusted.invalid/k/#@Work_User'
    assert.equal((await h.run()).favs[0].found, false, change)
  }
})
test('TG alias cannot leak through another pin to an untrusted origin', async () => {
  const h = harness()
  h.favs.push({ ...h.favs[0], id: 'bad', url: 'https://untrusted.invalid/k/#@Work_User' })
  assert.equal((await h.run()).favs[1].found, false)
})
test('TG invalid current account cannot resurrect a stale direct username link', async () => {
  const h = harness()
  h.apiManagerProxy.mirrors.state.userId = 2
  h.rows[0].getAttribute = key => key === 'href' ? '#@work_user' : key === 'data-peer-id' ? '22' : ''
  assert.equal((await h.run()).favs[0].found, false)
})
test('TG scoped projection never accesses private fields or methods', async () => {
  const h = harness()
  for (const peer of Object.values(h.peers)) for (const key of ['phone', 'access_hash', 'first_name', 'last_name', 'status']) Object.defineProperty(peer, key, { get() { throw Error('private read') } })
  h.peers[99] = { username: 'unrelated' }
  for (const key of ['id', 'photo', '_']) Object.defineProperty(h.peers[99], key, { get() { throw Error('unrelated profile read') } })
  h.apiManagerProxy.getUser = () => { throw Error('no methods allowed') }
  assert.equal((await h.run()).favs[0].pid, '22')
})
test('TG changed identity invalidates host metadata; same binding preserves missing-row caches', () => {
  const pin = { id: 'p', serviceId: 'tg', url: 'https://web.telegram.org/k/#@work_user' }
  const state = { cfg: { pinned: [pin] }, pinAvatars: { p: 'old-avatar' }, unreadTotals: { p: { c: 7 } }, lastMsgPreview: { p: 'old' }, tgPeerOf: { p: '33' } }
  const ctx = vm.createContext({ state, document: { querySelector: () => null } })
  load(ctx, 'applyTgIdentityObservation')
  const identity = { source: 'webk-account-peer', accountId: '1', username: 'work_user', peerId: '22' }
  assert.equal(typeof ctx.applyTgIdentityObservation, 'function', 'host invalidator required')
  ctx.applyTgIdentityObservation(pin, { identityScoped: true, identity })
  assert.equal(state.pinAvatars.p, undefined)
  assert.equal(state.unreadTotals.p, undefined)
  assert.equal(state.lastMsgPreview.p, undefined)
  assert.equal(state.tgPeerOf.p, undefined, 'numeric legacy cache is not identity evidence')
  state.pinAvatars.p = 'right-avatar'; state.unreadTotals.p = { c: 4 }
  ctx.applyTgIdentityObservation(pin, { identityScoped: true, identity, found: false })
  assert.equal(state.pinAvatars.p, 'right-avatar')
  assert.equal(state.unreadTotals.p.c, 4)
  ctx.applyTgIdentityObservation(pin, { identityScoped: true, identity: { ...identity, accountId: '2' } })
  assert.equal(state.pinAvatars.p, undefined)
  state.pinAvatars.p = 'account2-avatar'
  ctx.applyTgIdentityObservation(pin, { identityScoped: true, identity: null })
  assert.equal(state.pinAvatars.p, undefined)
})
test('TG actual serialized guest and scheduler publish verified aliases and replace stale account metadata', async () => {
  const h = harness()
  // Service unread now requires the verified dialog source, not row badge color.
  h.rootScope.managers = { dialogsStorage: { getDialogOnly: async id => ({ _: 'dialog', peer: { _: 'peerUser', user_id: id }, unread_count: id, unread_mentions_count: 0, pFlags: {} }) } }
  const pins = h.favs.map(p => ({ ...p, serviceId: 'tg' }))
  const state = { cfg: { services: [{ id: 'tg' }], pinned: pins }, svcViews: {}, pinViews: {} }
  for (const key of ['pinAvatars','unreadTotals','unreadTotalsAt','unreadBaseC','unreadBaseM','prevUnread','rankAct','lastMsgAt','lastMsgText','lastMsgPreview','liveAct','tgPeerOf']) state[key] = {}
  state.pinAvatars.p = 'poisoned-avatar'
  let executions = 0
  state.svcViews.tg = { isConnected: true, executeJavaScript(script) { executions++; return new vm.Script(script).runInContext(h.ctx) } }
  const ctx = vm.createContext({ state, setTimeout, clearTimeout, console, document: { querySelector: () => null },
    window: { hub: { isWinFocused: async () => true } }, favoritesOf: () => pins, svcViewFor: () => state.svcViews.tg,
    updateBadge2() {}, updateBadge() {}, sortFavoritesByActivity() {}, scheduleActSave() {}, tgSearchResolve: async () => null,
    __chatHubGrabAvatar: async function(row) { return 'avatar:' + row.getAttribute('data-peer-id') } })
  for (const name of ['runUnreadJob','unreadViewState','unreadGuestCall','pollUnread','pollUnreadService','refreshUnreadPresentation','refreshSelectedUnread','unreadDeltaFor','shouldBumpLiveAct','tgPidSafe','restorePreviewAuthor','__chatHubScanRows','__chatHubBoundedAvatar','formatMaxPreview','__chatHubTgUnread','applyTgIdentityObservation']) load(ctx, name)
  ctx.UNREAD_EXTRACTORS = { tg: ctx.__chatHubTgUnread }
  await ctx.pollUnread()
  assert.equal(executions, 1)
  assert.equal(state.unreadTotals.p?.c, 22)
  assert.equal(state.pinAvatars.p, 'avatar:22')
  assert.equal(state.tgIdentityKeys.p, '1:work_user:22')
  h.peers[22].username = 'Renamed'
  h.peers[33].username = 'Work_User'
  await ctx.pollUnread()
  assert.equal(state.unreadTotals.p?.c, 33)
  assert.equal(state.pinAvatars.p, 'avatar:33')
  assert.equal(state.tgIdentityKeys.p, '1:work_user:33')
  h.peers[33].username = 'RenamedAgain'
  await ctx.pollUnread()
  assert.equal(state.unreadTotals.p, undefined)
  assert.equal(state.pinAvatars.p, undefined)
})
