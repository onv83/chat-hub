import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { element, listFixture, ydxIdentity } from './synthetic-dom.mjs'
const source = readFileSync(new URL('../renderer.js', import.meta.url), 'utf8')
function load(ctx, name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('))
  if (start < 0) return
  const end = source.slice(start + 1).search(/\n(?:async )?function /)
  vm.runInContext(source.slice(start, end < 0 ? undefined : start + end + 1), ctx)
}
function fixture(service, { windows = 3, realTime = false, interrupt = '', hungAvatar = false } = {}) {
  let now = 100000, waits = 0, focused = false, top = 0
  const moves = [], root = element('document'), recycled = listFixture(service).children[0].children[0]
  const render = () => {
    const index = Math.min(windows - 1, Math.floor(top / 80))
    const fresh = service === 'tg'
      ? element('a', 'row-clickable', '', [element('span', 'peer-title', 'Room [' + String(index).padStart(3, '0') + ']'), element('span', 'dialog-subtitle', 'preview ' + index), element('span', 'dialog-subtitle-badge-unread', String(index + 1))])
      : listFixture(service, { title: 'Room [' + String(index).padStart(3, '0') + ']', preview: 'preview ' + index, badge: index + 1 }).children[0].children[0]
    recycled.getAttribute = name => service !== 'tg' ? '' : name === 'data-peer-id' ? String(index + 1) : name === 'href' ? '#' + (index + 1) : ''
    recycled.children = fresh.children
    if (service === 'ydx') ydxIdentity(recycled, '0/0/00000000-0000-4000-8000-' + String(index).padStart(12, '0'))
    for (const c of recycled.children) c.parent = recycled
  }
  const scroller = { isConnected: true, clientHeight: 100, scrollHeight: (windows - 1) * 80 + 100,
    get scrollTop() { return top }, set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - 100)); moves.push(top); render() },
    getBoundingClientRect() { return { width: 200, height: 100 } }, dispatchEvent() {} }
  root.children = [element('aside', '', '', [recycled])]; render()
  const query = root.querySelectorAll.bind(root)
  root.querySelectorAll = selector => selector === (service === 'tg' ? '.chatlist-parts' : service === 'max' ? '.scrollable.scrollListScrollable' : '.ui-scroller.ui-virtual-list__scroller') ? [scroller] : selector === 'a.row-clickable[href^="#"]' ? [recycled] : query(selector)
  root.hasFocus = () => focused
  const window = {}
  const ctx = vm.createContext({ document: root, window, URL, getComputedStyle: () => ({ backgroundColor: 'rgb(112,117,121)' }), Event: class {}, Date: realTime ? Date : class extends Date { static now() { return now } },
    setTimeout(fn, ms) {
      if (realTime) return setTimeout(fn, ms)
      const token = { cancelled: false }
      setImmediate(() => {
        if (token.cancelled) return
        now += ms; waits++
        if (waits === 1 && interrupt === 'focus') focused = true
        if (waits === 1 && interrupt === 'user') scroller.scrollTop = 37
        if (waits === 1 && interrupt === 'activate') window.__hubVirtualSweepBlocked = true
        if (waits === 1 && interrupt === 'disconnect') scroller.isConnected = false
        fn()
      })
      return token
    }, clearTimeout(token) { if (realTime) clearTimeout(token); else if (token) token.cancelled = true },
    __grabAvatar: async row => hungAvatar ? new Promise(() => {}) : 'avatar:' + row.querySelector(service === 'tg' ? '.peer-title' : service === 'max' ? 'span.name' : '.yamb-chat-list-item__name').textContent })
  for (const name of ['__chatHubScanRows', '__chatHubBoundedAvatar', 'formatMaxPreview', '__chatHubMaxUnread', '__chatHubYdxUnread', '__chatHubTgUnread']) load(ctx, name)
  const favs = Array.from({ length: windows }, (_, i) => ({ id: 'p' + i, title: 'Room [' + String(i).padStart(3, '0') + ']', url: service === 'tg' ? 'https://fixture.invalid/#' + (i + 1) : service === 'ydx' ? 'https://telemost.yandex.ru/chats/0%2F0%2F00000000-0000-4000-8000-' + String(i).padStart(12, '0') : 'https://fixture.invalid/-' + i, needUnread: true, needAvatar: true }))
  return { ctx, window, scroller, moves, favs, elapsed: () => now - 100000, advance: ms => { now += ms },
    run: allow => ctx[service === 'tg' ? '__chatHubTgUnread' : service === 'max' ? '__chatHubMaxUnread' : '__chatHubYdxUnread'](favs, allow).then(JSON.parse) }
}
for (const service of ['tg', 'max', 'ydx']) {
  test(`${service}: three disjoint recycled no-href windows retain every observation and restore original offset`, async () => {
    const h = fixture(service)
    h.scroller.scrollTop = 80
    const res = await h.run(true)
    assert.deepEqual(res.favs.map(r => r.count), [1, 2, 3])
    assert.ok(res.favs.every(r => r.found))
    assert.deepEqual(res.favs.map(r => r.preview), ['preview 0', 'preview 1', 'preview 2'])
    assert.equal(res.svcTotals, null, 'virtual windows do not prove whole-service totals')
    assert.equal(res.observedTotals.total, 6)
    assert.deepEqual(res.favs.map(r => r.avatar), ['avatar:Room [000]', 'avatar:Room [001]', 'avatar:Room [002]'])
    assert.equal(h.scroller.scrollTop, 80)
    assert.ok(h.elapsed() < 3500)
  })
  test(`${service}: bounded chunks resume rather than repeatedly scanning first windows`, async () => {
    const h = fixture(service, { windows: 90, hungAvatar: true })
    const seen = new Set()
    for (let i = 0; i < 12 && seen.size < 90; i++) {
      const before = h.elapsed(), res = await h.run(true)
      for (const r of res.favs) if (r.found) {
        seen.add(r.id)
        assert.equal(r.count, Number(r.id.slice(1)) + 1, 'snapshot must not borrow another recycled row count')
      }
      assert.ok(h.elapsed() - before < 3500, 'scan plus hung avatars fits scheduler deadline')
      assert.equal(h.scroller.scrollTop, 0)
      h.advance(16000)
    }
    assert.equal(seen.size, 90)
  })
  for (const interrupt of ['focus', 'user', 'activate', 'disconnect']) test(`${service}: ${interrupt} cancels further scroll writes`, async () => {
    const h = fixture(service, { interrupt })
    await h.run(true)
    assert.ok(h.moves.length <= (interrupt === 'user' ? 2 : 1), JSON.stringify(h.moves))
    if (interrupt === 'user') assert.equal(h.scroller.scrollTop, 37)
  })
  test(`${service}: collector exceptions restore offset and release the scan lock`, async () => {
    const h = fixture(service)
    h.scroller.scrollTop = 80
    let reads = 0
    const query = h.ctx.document.querySelectorAll
    h.ctx.document.querySelectorAll = selector => {
      if ((selector === 'aside div.item' || selector === '.yamb-chat-list-item' || selector === 'a.row-clickable[href^="#"]') && ++reads === 2) throw Error('synthetic render failure')
      return query(selector)
    }
    await assert.rejects(h.run(true), /synthetic render failure/)
    assert.equal(h.scroller.scrollTop, 80)
    assert.equal(h.window.__hubVirtualScans[service].busy, false)
  })
  test(`${service}: optional hung avatars cannot accumulate across polling chunks`, async () => {
    const h = fixture(service, { windows: 3, hungAvatar: true })
    let calls = 0
    h.ctx.__grabAvatar = () => { calls++; return new Promise(() => {}) }
    for (let i = 0; i < 10; i++) { await h.run(true); h.advance(16000) }
    assert.ok(calls <= 4, 'physical unresolved avatars=' + calls)
  })
  test(`${service}: overlapping calls do not start a concurrent sweep`, async () => {
    const h = fixture(service)
    await Promise.all([h.run(true), h.run(true)])
    assert.ok(h.moves.length <= 4, JSON.stringify(h.moves))
  })
}

test('cached unread observations survive activity save/restore exactly once', () => {
  const state = { cfg: { services: [{ id: 'max' }], pinned: [{ id: 'p', serviceId: 'max' }], actReset1: true, actReset2: true, actReset3: true, actReset4: true, actReset5: true } }
  for (const k of ['lastMsgAt','lastMsgText','lastMsgPreview','msgAuth','liveAct','tgPeerOf','prevUnread','unreadBaseC','unreadBaseM']) state[k] = {}
  Object.assign(state, { unreadTotals: { p: { c: 7, m: 2 } }, unreadTotalsAt: { p: 12345 }, unreadDots: { p: true }, svcTabTotals: { max: { t: 25, m: 2 } } })
  const ctx = vm.createContext({ state, tgScrollDone: false, console: { log() {} } })
  for (const n of ['activitySnapshot','ensureKeys','restorePreviewAuthor']) load(ctx, n)
  state.cfg.activity = JSON.parse(JSON.stringify(ctx.activitySnapshot()))
  for (const k of ['unreadTotals','unreadTotalsAt','unreadDots','svcTabTotals']) state[k] = {}
  ctx.ensureKeys(state.cfg)
  assert.equal(state.unreadTotals.p?.c, 7)
  assert.equal(state.unreadTotals.p.m, 2)
  assert.equal(state.unreadTotalsAt.p, 12345)
  assert.equal(state.unreadDots.p, true)
  assert.equal(state.svcTabTotals.max.t, 25)
  state.unreadTotals.p = { c: 0, m: 0 }
  ctx.ensureKeys(state.cfg)
  assert.equal(state.unreadTotals.p.c, 0, 'no stale rehydration during later renders')
})

test('mm: hung optional avatars cannot starve API unread publication or retain extraction slots', async t => {
  const favs = Array.from({ length: 6 }, (_, i) => ({ id: 'mm' + i, serviceId: 'mm', url: 'https://fixture.invalid/team/messages/room' + i }))
  const state = { cfg: { services: [{ id: 'mm' }], pinned: favs }, svcViews: {}, pinViews: {},
    mmPinCounts: Object.fromEntries(favs.map(p => [p.id, { count: 2, mentions: 1, observedAt: 1000 }])) }
  for (const key of ['pinAvatars','unreadTotals','unreadTotalsAt','unreadBaseC','unreadBaseM','prevUnread','rankAct','lastMsgAt','lastMsgText','lastMsgPreview','liveAct','tgPeerOf']) state[key] = {}
  const li = { classList: { contains: () => false }, querySelector: () => null }
  const root = { querySelectorAll: () => [], querySelector: () => ({ closest: () => li }) }
  const guest = vm.createContext({ window: { avatarCalls: 0 }, document: { querySelector: () => root }, setTimeout, clearTimeout })
  let executions = 0
  state.svcViews.mm = { isConnected: true, executeJavaScript(script) { executions++; return new vm.Script(script).runInContext(guest) } }
  const ctx = vm.createContext({ state, setTimeout, clearTimeout, console,
    document: { querySelector: () => null }, favoritesOf: () => favs, svcViewFor: () => state.svcViews.mm,
    updateBadge2() {}, updateBadge() {}, sortFavoritesByActivity() {}, scheduleActSave() {},
    mmTabCounts: async () => {}, mmLastPosts: async () => {},
    __chatHubGrabAvatar: async function () { window.avatarCalls++; return new Promise(() => {}) } })
  for (const name of ['runUnreadJob','unreadViewState','unreadGuestCall','pollUnread','pollUnreadService','refreshUnreadPresentation','refreshSelectedUnread','unreadDeltaFor','shouldBumpLiveAct','restorePreviewAuthor','__chatHubScanRows','__chatHubBoundedAvatar','formatMaxPreview','__chatHubMmUnread']) load(ctx, name)
  ctx.UNREAD_EXTRACTORS = { mm: ctx.__chatHubMmUnread }
  const start = performance.now()
  await ctx.pollUnread()
  t.diagnostic(`wall_ms=${Math.round(performance.now() - start)} published=${Object.keys(state.unreadTotals).length}`)
  assert.equal(Object.keys(state.unreadTotals).length, 6, 'optional avatar must not discard ready API counts at the 4.5s deadline')
  assert.ok(performance.now() - start < 2000)
  for (const pin of favs) { assert.equal(state.unreadTotals[pin.id].c, 2); assert.equal(state.unreadTotalsAt[pin.id], 1000) }
  for (let i = 0; i < 3; i++) await ctx.pollUnread()
  assert.equal(guest.window.avatarCalls, 4, 'physical image work remains bounded across polls')
  assert.equal(executions, 4, 'subsequent polls are not blocked by stale extraction')
  assert.equal(state.unreadJobs.size, 0)
  assert.equal(state.unreadViews.get(state.svcViews.mm).pending.size, 0)
})

// Actual host scheduler and actual serialized extractor under wall-clock timers.
for (const service of ['tg', 'max', 'ydx']) test(`${service}: real 4.5s scheduler publishes a slow virtual chunk before expiration`, async t => {
  const h = fixture(service, { windows: 45, realTime: true, hungAvatar: true })
  const state = { cfg: { services: [{ id: service }], pinned: h.favs.map(p => ({ ...p, serviceId: service })) }, svcViews: {}, pinViews: {} }
  for (const key of ['pinAvatars','unreadTotals','unreadTotalsAt','unreadBaseC','unreadBaseM','prevUnread','rankAct','lastMsgAt','lastMsgText','lastMsgPreview','liveAct','tgPeerOf']) state[key] = {}
  let executions = 0
  state.svcViews[service] = { isConnected: true, executeJavaScript(script) { executions++; return new vm.Script(script).runInContext(h.ctx) } }
  const ctx = vm.createContext({ state, setTimeout, clearTimeout, console,
    document: { querySelector: () => null }, window: { hub: { isWinFocused: async () => false } },
    favoritesOf: () => state.cfg.pinned, svcViewFor: () => state.svcViews[service],
    updateBadge2() {}, updateBadge() {}, sortFavoritesByActivity() {}, scheduleActSave() {},
    tgSearchResolve: async () => null, __chatHubGrabAvatar: async function () { return new Promise(() => {}) } })
  for (const name of ['runUnreadJob','unreadViewState','unreadGuestCall','pollUnread','pollUnreadService','refreshUnreadPresentation','refreshSelectedUnread','unreadDeltaFor','shouldBumpLiveAct','tgPidSafe','restorePreviewAuthor','__chatHubScanRows','__chatHubBoundedAvatar','formatMaxPreview','__chatHubMaxUnread','__chatHubYdxUnread','__chatHubTgUnread']) load(ctx, name)
  ctx.UNREAD_EXTRACTORS = { [service]: ctx[service === 'tg' ? '__chatHubTgUnread' : service === 'max' ? '__chatHubMaxUnread' : '__chatHubYdxUnread'] }
  const start = performance.now()
  await ctx.pollUnread()
  const elapsed = performance.now() - start
  t.diagnostic(`wall_ms=${Math.round(elapsed)} published=${Object.keys(state.unreadTotals).length} executions=${executions}`)
  assert.ok(elapsed < 4400)
  assert.ok(Object.keys(state.unreadTotals).length >= 3)
  assert.equal(state.unreadJobs.size, 0)
  assert.equal(state.unreadViews.get(state.svcViews[service]).pending.size, 0)
})
