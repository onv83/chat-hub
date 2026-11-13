import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const source = readFileSync(new URL('../renderer.js', import.meta.url), 'utf8')
function extract(name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('))
  if (start < 0) return ''
  const end = source.slice(start + 1).search(/\n(?:async )?function /)
  return source.slice(start, end < 0 ? undefined : start + 1 + end)
}
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
function harness(ids = ['mm', 'max']) {
  let now = 100000, sequence = 0
  const timers = new Map(), badges = [], calls = {}, replies = {}, reloads = {}
  const state = { cfg: { services: ids.map(id => ({ id })), pinned: ids.map(id => ({ id, serviceId: id, url: 'https://fixture.invalid/channels/room' })) }, svcViews: {}, pinViews: {} }
  for (const key of ['pinAvatars','unreadTotals','unreadTotalsAt','unreadBaseC','unreadBaseM','prevUnread','rankAct','lastMsgAt','lastMsgText','lastMsgPreview','liveAct','tgPeerOf']) state[key] = {}
  const view = id => {
    const events = new Map()
    return { isConnected: true, addEventListener(n, fn) { events.set(n, fn) }, emit(n) { events.get(n)?.() }, reload() { reloads[id] = (reloads[id] || 0) + 1; events.get('did-start-loading')?.() }, executeJavaScript(js) {
      new vm.Script(js) // always compile the real serialized production script
      calls[id] = (calls[id] || 0) + 1
      return replies[id]()
    } }
  }
  for (const id of ids) { state.svcViews[id] = view(id); replies[id] = () => Promise.resolve(result(id, 2)) }
  const ctx = vm.createContext({ state, Date: class extends Date { static now() { return now } }, console,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id }, clearTimeout(id) { timers.delete(id) },
    favoritesOf: id => state.cfg.pinned.filter(p => p.serviceId === id), svcViewFor: id => state.svcViews[id],
    document: { querySelector() { return null } }, updateBadge2: (...args) => badges.push(args), updateBadge: (...args) => badges.push(args),
    sortFavoritesByActivity() {}, scheduleActSave() {}, mmTabCounts: async () => {}, mmLastPosts: async () => {},
    __chatHubGrabAvatar: function () {}, formatMaxPreview: function () {}, tgSearchResolve: async () => null,
    UNREAD_EXTRACTORS: Object.fromEntries(ids.map(id => [id, function () {}])) })
  for (const name of ['__chatHubScanRows','__chatHubBoundedAvatar','runUnreadJob','unreadViewState','unreadGuestCall','recoverStaleMmGuest','pollUnread','pollUnreadService','refreshUnreadPresentation','refreshSelectedUnread','queueSelectedUnread','unreadDeltaFor','shouldBumpLiveAct','mmTabCounts','mmLastPosts','fmtChatWhen','mergeLastMessageTime','restorePreviewAuthor']) {
    if (name.startsWith('mm')) continue
    vm.runInContext(extract(name), ctx)
  }
  return { ctx, state, calls, replies, reloads, badges, timers, view, loadMM() { for (const n of ['mmTabCounts','mmLastPosts']) vm.runInContext(extract(n), ctx) }, async tick(ms) {
    now += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() }
    await flush()
  } }
}
test('virtual partial service totals never replace a cached service badge with favourite subtotals', async () => {
  const h = harness(['max'])
  h.state.svcTabTotals = { max: { t: 20, m: 3 } }
  h.replies.max = async () => JSON.stringify({ favs: [{ id: 'max', found: false }], svcTotals: null,
    coverage: { complete: false }, observedTotals: { total: 1, mentions: 0 } })
  await h.ctx.pollUnread()
  assert.equal(h.badges.some(b => b[0] === 'max'), false)
  assert.deepEqual(h.state.svcTabTotals.max, { t: 20, m: 3 })
})

function result(id, count) { return JSON.stringify({ favs: [{ id, count, mentions: 0, found: true }], svcTotals: { total: count, mentions: 0 } }) }

// Synthetic HTTP only: execute the production-generated guest, never an account.
function mmFixture(h, override = () => undefined) {
  const requests = []
  const channel = { id: 'chan', team_id: 'team', type: 'O', name: 'room', last_post_at: 1000 }
  const defaults = {
    '/api/v4/users/me': { id: 'self' },
    '/api/v4/users/me/teams': [{ id: 'team', name: 'alpha' }],
    '/api/v4/users/self/teams': [{ id: 'team', name: 'alpha' }],
    '/api/v4/users/me/teams/team/channels': [channel],
    '/api/v4/users/self/channels': [channel],
    '/api/v4/users/me/teams/team/channels/members': [{ channel_id: 'chan', msg_count: 900, last_viewed_at: 100 }],
    '/api/v4/users/self/channels/chan/unread': { team_id: 'team', channel_id: 'chan', msg_count: 4, mention_count: 2, msg_count_root: 1, mention_count_root: 1 },
    '/api/v4/channels/chan/posts?per_page=1': { order: [], posts: {} },
    '/api/v4/channels/chan/posts?since=100&per_page=1000': { order: ['edited','own'], posts: { edited: { create_at: 1, update_at: 200 }, own: { create_at: 200, user_id: 'self' } } }
  }
  const guest = vm.createContext({ URL, location: { origin: 'https://fixture.invalid' }, fetch: async (url, opts) => {
    requests.push(url)
    assert.ok(!opts?.method || opts.method === 'GET', 'metadata requests must be read-only')
    let data = override(url)
    if (data === undefined) data = defaults[url]
    if (data instanceof Error) throw data
    if (data?.httpError) return { ok: false, status: 403, json: async () => data }
    if (data === undefined) throw Error('Unexpected fixture request: ' + url)
    return { ok: true, json: async () => data }
  } })
  h.state.svcViews.mm.executeJavaScript = script => new vm.Script(script).runInContext(guest)
  h.state.cfg.pinned[0].url = 'https://fixture.invalid/alpha/channels/room'
  return requests
}

test('MM exact last_post_at refines an imprecise same-day noon placeholder', async () => {
  const h = harness(['mm']); h.loadMM()
  h.state.lastMsgAt.mm = 5000
  h.state.lastMsgText.mm = '01.01'
  h.state.lastMsgDayOnly = {mm:true}
  mmFixture(h)
  await h.ctx.mmLastPosts()
  assert.equal(h.state.lastMsgAt.mm,1000)
  assert.equal(h.state.lastMsgDayOnly.mm,false)
})

test('MM post identity prevents legacy cached attribution of repeated body text', async () => {
  const h = harness(['mm']); h.loadMM()
  h.state.msgAuth = {mm:{text:'repeated body',out:true}}
  mmFixture(h, url => url.endsWith('/posts?per_page=1') ? {order:['new-post'],posts:{'new-post':{id:'new-post',message:'repeated body'}}} : undefined)
  await h.ctx.mmLastPosts()
  assert.equal(h.state.lastMsgPreview.mm,'repeated body')
})

for (const count of [0, 4]) test(`MM authoritative unread ${count}: ignores edited/own since-posts and read-position counters`, async () => {
  const h = harness(['mm']); h.loadMM()
  const requests = mmFixture(h, url => url.endsWith('/unread') ? { team_id: 'team', channel_id: 'chan', msg_count: count, mention_count: 0, msg_count_root: 0, mention_count_root: 0 } : undefined)
  await h.ctx.mmLastPosts()
  assert.equal(h.state.mmPinCounts?.mm?.count, count)
  assert.equal(h.state.mmPinCounts.mm.mentions, 0)
  assert.ok(requests.includes('/api/v4/users/self/channels/chan/unread'))
  assert.equal(requests.some(url => url.includes('since=') || url.endsWith('/members')), false)
})

test('MM identity: exact team, own DM pair, group name, duplicates and no-team accounts', async () => {
  const h = harness(['mm']); h.loadMM()
  const channels = [
    { id: 'wrong-team', team_id: 'beta', type: 'O', name: 'room', last_post_at: 1000 },
    { id: 'chan', team_id: 'team', type: 'P', name: 'room', last_post_at: 0 },
    { id: 'foreign-dm', team_id: '', type: 'D', name: 'other__peer', last_post_at: 1000 },
    { id: 'dm', team_id: '', type: 'D', name: 'peer__self', last_post_at: 1000 },
    { id: 'group', team_id: '', type: 'G', name: 'group-name', last_post_at: 1000 }
  ]
  const requests = mmFixture(h, url => {
    if (url.endsWith('/teams')) return [{ id: 'team', name: 'alpha' }, { id: 'beta', name: 'beta' }]
    if (url.endsWith('/channels')) return [...channels, channels[3]]
    if (url.endsWith('/username/peer')) return { id: 'peer', username: 'peer' }
    const m = url.match(/channels\/([^/]+)\/unread$/)
    if (m) return { channel_id: m[1], team_id: channels.find(c => c.id === m[1]).team_id, msg_count: 4, mention_count: 2, msg_count_root: 1, mention_count_root: 1 }
  })
  h.state.cfg.pinned.push(...[
    ['dm', 'alpha/messages/@peer'], ['dm-alias', 'beta/messages/@peer'],
    ['group', 'alpha/messages/group-name'], ['wrong-origin', 'alpha/channels/room'],
    ['unknown-team', 'missing/channels/room'], ['no-team', 'channels/room']
  ].map(([id,path]) => ({ id, serviceId: 'mm', url: `https://${id === 'wrong-origin' ? 'other.invalid' : 'fixture.invalid'}/${path}` })))
  await h.ctx.mmLastPosts()
  assert.equal(h.state.mmPinCounts?.mm?.count, 4, 'empty channel still has authoritative unread snapshot')
  assert.equal(h.state.mmPinCounts?.dm?.count, 4)
  assert.equal(h.state.mmPinCounts?.group?.count, 4)
  assert.equal(requests.filter(u => u.endsWith('/dm/unread')).length, 1, 'duplicate pins/channel listings share one unread request')
  assert.equal(requests.some(u => /\/(wrong-team|foreign-dm)\/unread$/.test(u)), false)
  for (const id of ['wrong-origin','unknown-team','no-team']) assert.equal(h.state.mmPinCounts?.[id], undefined)
  assert.equal(h.state.mmPinCounts.mm.rootCount, 1, 'root-only count stays separate, never added to total')
  assert.equal(h.state.mmPinCounts.mm.rootMentions, 1)

  await h.tick(31000)
  mmFixture(h, url => url.endsWith('/teams') ? [] : url.endsWith('/channels') ? [channels[3]] : url.endsWith('/username/peer') ? { id: 'peer', username: 'peer' } : url.endsWith('/dm/unread') ? { channel_id: 'dm', team_id: '', msg_count: 0, mention_count: 0 } : undefined)
  await h.ctx.mmLastPosts('dm')
  assert.equal(h.state.mmPinCounts.dm.count, 0, 'DM lookup does not require a team membership')
})

for (const failure of ['http','network','missing-mentions','wrong-channel','wrong-team','negative','string-count','account-changed']) test(`MM ${failure} keeps unread snapshot and freshness`, async () => {
  const h = harness(['mm']); h.loadMM()
  h.state.mmPinCounts = { mm: { count: 7, mentions: 1, observedAt: 90000 } }
  let meReads = 0
  mmFixture(h, url => {
    if (url === '/api/v4/users/me' && failure === 'account-changed') return { id: ++meReads === 1 ? 'self' : 'different' }
    if (!url.endsWith('/unread')) return undefined
    if (failure === 'http') return { httpError: true }
    if (failure === 'network') return Error('offline')
    const d = { channel_id: 'chan', team_id: 'team', msg_count: 0, mention_count: 0 }
    if (failure === 'missing-mentions') delete d.mention_count
    if (failure === 'wrong-channel') d.channel_id = 'another'
    if (failure === 'wrong-team') d.team_id = 'another'
    if (failure === 'negative') d.msg_count = -1
    if (failure === 'string-count') d.msg_count = '0'
    return d
  })
  await h.ctx.mmLastPosts()
  assert.deepEqual(h.state.mmPinCounts.mm, { count: 7, mentions: 1, observedAt: 90000 })
})

test('MM pin matching rejects same slug in different team, origin or route kind', () => {
  const ctx = vm.createContext({ URL })
  vm.runInContext(extract('pinMatches'), ctx)
  const svc = { id: 'mm' }, pin = { serviceId: 'mm', url: 'https://fixture.invalid/alpha/channels/room' }
  assert.equal(ctx.pinMatches(pin, svc, pin.url + '?x=1'), true)
  for (const url of ['https://fixture.invalid/beta/channels/room', 'https://other.invalid/alpha/channels/room', 'https://fixture.invalid/alpha/messages/room', 'https://fixture.invalid/channels/room']) {
    assert.equal(ctx.pinMatches(pin, svc, url), false, url)
  }
  assert.equal(ctx.pinMatches({ ...pin, url: 'https://fixture.invalid/alpha/messages/@peer' }, svc, 'https://fixture.invalid/beta/messages/@peer'), true, 'DM identity is account-wide within an origin')
})

for (const failure of ['http', 'missing-count', 'duplicate-team']) test(`MM totals ${failure} is unknown, not a partial fresh aggregate`, async () => {
  const h = harness(['mm']); h.loadMM()
  h.state.svcTabTotals = { mm: { t: 7, m: 1 } }; h.state.mmTabCountsAt = 50000
  const guest = vm.createContext({ fetch: async () => ({ ok: failure !== 'http', json: async () => failure === 'missing-count' ? [{ team_id: 'a', mention_count: 0 }] : [{ team_id: 'a', msg_count: 0, mention_count: 0 }, { team_id: 'a', msg_count: 0, mention_count: 0 }] }) })
  h.state.svcViews.mm.executeJavaScript = script => new vm.Script(script).runInContext(guest)
  await h.ctx.mmTabCounts()
  assert.deepEqual(h.state.svcTabTotals.mm, { t: 7, m: 1 })
  assert.equal(h.state.mmTabCountsAt, 50000)
})

test('MM partial batch publishes only verified channels, preserving failed/missing pins', async () => {
  const h = harness(['mm']); h.loadMM()
  h.state.mmPinCounts = { failed: { count: 8, mentions: 1, observedAt: 90000 }, missing: { count: 6, mentions: 0, observedAt: 90000 } }
  const requests = mmFixture(h, url => {
    if (url.endsWith('/channels')) return [
      { id: 'chan', team_id: 'team', name: 'room', type: 'O', last_post_at: 1000 },
      { id: 'failed', team_id: 'team', name: 'failed', type: 'P', last_post_at: 1000 }
    ]
    if (url.endsWith('/failed/unread')) return { httpError: true }
  })
  for (const id of ['failed','missing']) h.state.cfg.pinned.push({ id, serviceId: 'mm', url: `https://fixture.invalid/alpha/channels/${id}` })
  await h.ctx.mmLastPosts()
  assert.equal(h.state.mmPinCounts.mm.count, 4)
  assert.equal(h.state.mmPinCounts.mm.accountId, 'self')
  assert.equal(h.state.mmPinCounts.mm.channelId, 'chan')
  assert.deepEqual(h.state.mmPinCounts.failed, { count: 8, mentions: 1, observedAt: 90000 })
  assert.deepEqual(h.state.mmPinCounts.missing, { count: 6, mentions: 0, observedAt: 90000 })
  assert.equal(requests.some(url => url.endsWith('/missing/unread')), false)
})

for (const count of [0, 5]) test(`MM totals verified ${count} publishes the documented team aggregate`, async () => {
  const h = harness(['mm']); h.loadMM()
  const guest = vm.createContext({ fetch: async url => {
    assert.equal(url, '/api/v4/users/me/teams/unread')
    return { ok: true, json: async () => [{ team_id: 'team', msg_count: count, mention_count: 0 }] }
  } })
  h.state.svcViews.mm.executeJavaScript = script => new vm.Script(script).runInContext(guest)
  await h.ctx.mmTabCounts()
  assert.equal(h.state.svcTabTotals.mm.t, count)
  assert.equal(h.state.mmTabCountsAt, 100000)
})

test('poll: stalled first service cannot block healthy service; repeated ticks do not overlap', async () => {
  const h = harness(), stuck = deferred()
  h.replies.mm = () => stuck.promise
  const first = h.ctx.pollUnread()
  await flush()
  assert.equal(h.state.unreadTotals.max?.c, 2, 'healthy service publishes without waiting for stalled MM')
  const second = h.ctx.pollUnread()
  await flush()
  assert.equal(h.calls.mm, 1, 'coalesce active service job')
  await h.tick(5000)
  await Promise.all([first, second])
  await h.ctx.pollUnread()
  assert.equal(h.calls.mm, 1, 'timed-out unresolved guest must not accumulate executions')
  stuck.resolve(result('mm', 9)); await flush()
  assert.equal(h.state.unreadTotals.mm, undefined, 'late timed-out reply is discarded')
  assert.equal(h.timers.size, 0)
})

test('100 stalled-service ticks retain one physical call and no scheduler timers', async () => {
  const h = harness(), stuck = deferred()
  h.replies.mm = () => stuck.promise
  const first = h.ctx.pollUnread(); await flush(); await h.tick(5000); await first
  for (let i = 0; i < 100; i++) { await h.tick(5000); await h.ctx.pollUnread() }
  assert.equal(h.calls.mm, 1)
  assert.equal(h.state.unreadJobs.size, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(h.state.unreadViews.get(h.state.svcViews.mm).pending.size, 1)
  stuck.reject(Error('late failure')); await flush()
  assert.equal(h.state.unreadViews.get(h.state.svcViews.mm).pending.size, 0)
})

for (const service of ['tg','max','ydx','mm']) {
  test(`${service}: priority read refresh bypasses stalled sweep; only confirmed zero clears, stale reply cannot resurrect`, async () => {
    const h = harness([service]), old = deferred(), read = deferred()
    h.state.unreadTotals[service] = { c: 7, m: 0 }
    h.state.unreadTotalsAt[service] = 90000
    h.state.mmPinCounts = { mm: { count: 7, mentions: 0, observedAt: 90000 } }
    h.replies[service] = () => old.promise
    const poll = h.ctx.pollUnread(); await flush()
    h.state.activePinId = service
    let fastCalls = 0
    if (service === 'mm') {
      h.ctx.mmLastPosts = async pinId => {
        if (!pinId) return
        fastCalls++; await read.promise
        h.state.mmPinCounts.mm = { count: 0, mentions: 0, observedAt: 100000 }
      }
    } else {
      h.state.pinViews[service] = { executeJavaScript: async code => {
        new vm.Script(code)
        fastCalls++
        assert.ok(code.includes('false'), 'priority extraction must not scroll')
        return read.promise
      } }
    }
    const fast = h.ctx.refreshSelectedUnread(service)
    await flush()
    assert.equal(fastCalls, 1, 'priority probe starts before sweep resolves')
    assert.equal(h.state.unreadTotals[service].c, 7, 'opening alone never zeroes unread')
    read.resolve(result(service, 0)); await fast
    assert.equal(h.state.unreadTotals[service].c, 0, 'confirmed read clears immediately without 5s tick')
    old.resolve(result(service, 7)); await poll
    assert.equal(h.state.unreadTotals[service].c, 0, 'older sweep cannot restore cleared badge')
  })
}

test('switching selected pins supersedes old priority work immediately', async () => {
  const h = harness(['max']), old = deferred()
  h.state.cfg.pinned.push({ id: 'second', serviceId: 'max', url: 'https://fixture.invalid/-456' })
  h.state.activePinId = 'max'
  h.state.pinViews.max = { executeJavaScript: () => old.promise }
  h.state.pinViews.second = { executeJavaScript: async () => result('second',0) }
  const first = h.ctx.refreshSelectedUnread('max'); await flush()
  h.state.activePinId = 'second'
  const second = h.ctx.refreshSelectedUnread('second'); await flush()
  assert.equal(h.state.unreadTotals.second?.c, 0)
  old.resolve(result('max',7)); await Promise.all([first,second])
  assert.equal(h.state.unreadTotals.max, undefined)
})

test('priority queue retries confirmed state with bounded timers and stops after selection changes', async () => {
  const h = harness(['max'])
  h.state.activePinId = 'max'
  await h.ctx.queueSelectedUnread('max')
  assert.equal(h.calls.max, 1)
  assert.equal(h.timers.size, 1)
  await h.tick(1000)
  assert.equal(h.calls.max, 2)
  await h.tick(1000)
  assert.equal(h.calls.max, 3)
  assert.equal(h.timers.size, 0)
  await h.ctx.queueSelectedUnread('max')
  h.state.activePinId = ''
  await h.tick(1000)
  assert.equal(h.calls.max, 4)
  assert.equal(h.timers.size, 0)
})

for (const outcome of ['absent','unread','failure']) {
  test(`priority ${outcome} never invents a read acknowledgment`, async () => {
    const h = harness(['tg'])
    h.state.activePinId = 'tg'
    h.state.unreadTotals.tg = { c: 7, m: 1 }; h.state.unreadTotalsAt.tg = 90000
    h.replies.tg = () => outcome === 'failure' ? Promise.reject(Error('offline')) : Promise.resolve(JSON.stringify({ favs: [
      { id: 'tg', found: outcome !== 'absent', count: outcome === 'unread' ? 7 : 0, mentions: outcome === 'unread' ? 1 : 0 }
    ] }))
    await h.ctx.refreshSelectedUnread('tg')
    assert.equal(h.state.unreadTotals.tg.c, 7)
    assert.equal(h.state.unreadTotals.tg.m, 1)
    if (outcome !== 'unread') assert.equal(h.state.unreadTotalsAt.tg, 90000)
  })
}

test('selected chat keeps verified pin read state while service DOM is still stale', async () => {
  const h = harness(['max'])
  h.state.activePinId = 'max'
  h.state.pinViews.max = { executeJavaScript: async () => result('max', 0) }
  h.replies.max = () => Promise.resolve(result('max', 7))
  await h.ctx.pollUnread()
  assert.equal(h.state.unreadTotals.max.c, 0)
})

test('active-chat fast probe does not starve normal metadata collection', async () => {
  const h = harness(['max'])
  h.state.activePinId = 'max'
  h.state.pinViews.max = { executeJavaScript: async () => result('max', 0) }
  h.replies.max = () => Promise.resolve(JSON.stringify({ favs: [{ id: 'max', found: true, count: 0, mentions: 0, preview: 'metadata' }] }))
  await h.ctx.pollUnread()
  assert.equal(h.state.lastMsgPreview.max, 'metadata')
})

test('MM hidden stale physical guest reloads once and next poll publishes current unread', async () => {
  const h = harness(['mm']); h.loadMM()
  const stuck = deferred()
  h.replies.mm = () => stuck.promise
  const first = h.ctx.mmLastPosts()
  await flush()
  assert.equal(h.calls.mm, 1)
  await h.tick(46000)
  await first
  await h.tick(61000)
  h.replies.mm = () => Promise.resolve(JSON.stringify({ res: [{ id: 'mm', accountId: 'self', channelId: 'chan', at: 200000, count: 3, mentions: 3, rootCount: 3, rootMentions: 3 }] }))
  await h.ctx.mmLastPosts()
  assert.equal(h.reloads.mm, 1, 'only hidden service view is reloaded to retire its stuck physical guest')
  await h.ctx.mmLastPosts()
  assert.equal(h.calls.mm, 2)
  assert.equal(h.state.mmPinCounts.mm.count, 3)
  assert.equal(h.state.mmPinCounts.mm.mentions, 3)
})

test('MM normal metadata batch may exceed 15 seconds and still publish', async () => {
  const h = harness(['mm']); h.loadMM()
  const slow = deferred()
  h.replies.mm = () => slow.promise
  const task = h.ctx.mmLastPosts()
  await flush()
  await h.tick(16000)
  slow.resolve(JSON.stringify({ res: [{ id: 'mm', accountId: 'self', channelId: 'chan', at: 200000, count: 3, mentions: 0, rootCount: 3, rootMentions: 0 }] }))
  await task
  await flush()
  assert.equal(h.state.mmPinCounts.mm.count, 3)
  assert.equal(h.state.lastMsgAt.mm, 200000)
})

for (const task of ['mmTabCounts', 'mmLastPosts']) {
  test(`${task}: single-flight, deadline and late-reply rejection`, async () => {
    const h = harness(['mm']); h.loadMM()
    const old = deferred()
    h.replies.mm = () => old.promise
    const a = h.ctx[task](), b = h.ctx[task]()
    await flush()
    assert.equal(h.calls.mm, 1)
    await h.tick(task === 'mmLastPosts' ? 46000 : 16000)
    await Promise.all([a,b])
    await h.ctx[task]()
    assert.equal(h.calls.mm, 1, 'no repeated execution on stuck guest')
    h.state.svcViews.mm = h.view('mm')
    h.replies.mm = () => Promise.resolve(task === 'mmTabCounts' ? '{"t":0,"m":0}' : '{"res":[{"id":"mm","count":0,"mentions":0}]}')
    await h.ctx[task]()
    old.resolve(task === 'mmTabCounts' ? '{"t":7,"m":0}' : '{"res":[{"id":"mm","count":7,"mentions":0}]}')
    await flush()
    assert.equal(task === 'mmTabCounts' ? h.state.svcTabTotals.mm.t : h.state.mmPinCounts.mm.count, 0)
    assert.equal(h.timers.size, 0)
  })
}

test('MM priority executes the real targeted guest, bypasses throttle and rejects older full API snapshot', async () => {
  const h = harness(['mm']); h.loadMM()
  h.state.cfg.pinned.push({ id: 'other', serviceId: 'mm', url: 'https://fixture.invalid/channels/other' })
  const old = deferred(), scripts = []
  const requests = mmFixture(h, url => {
    if (url.endsWith('/posts?per_page=1')) return { order: ['latest'], posts: { latest: { id: 'latest', user_id: 'self', message: 'fresh preview' } } }
    if (url.endsWith('/unread')) return { team_id: 'team', channel_id: 'chan', msg_count: 0, mention_count: 0 }
  })
  const execute = h.state.svcViews.mm.executeJavaScript
  h.state.svcViews.mm.executeJavaScript = script => {
    scripts.push(script)
    return scripts.length === 1 ? old.promise : execute(script)
  }
  const full = h.ctx.mmLastPosts(); await flush()
  h.state.mmChannelsAt = 100000 // ordinary jobs would be throttled
  h.state.activePinId = 'mm'
  await h.ctx.refreshSelectedUnread('mm')
  assert.equal(scripts.length, 2)
  assert.ok(requests.some(url => url.endsWith('?per_page=1')), 'priority refreshes the selected chat preview')
  assert.ok(!scripts[1].includes('"id":"other"'), 'priority guest gets only selected pin')
  assert.equal(h.state.lastMsgPreview.mm, 'fresh preview')
  assert.equal(h.state.unreadTotals.mm.c, 0)
  old.resolve('{"res":[{"id":"mm","count":7,"mentions":0}]}'); await full
  assert.equal(h.state.mmPinCounts.mm.count, 0)
  assert.equal(h.state.unreadTotals.mm.c, 0)
})

for (const failure of ['unread', 'channels']) {
  test(`MM guest ${failure} failure is unknown, not fresh zero`, async () => {
    const h = harness(['mm']); h.loadMM()
    h.state.mmPinCounts = { mm: { count: 7, mentions: 1, observedAt: 90000 } }
    h.state.unreadTotals.mm = { c: 7, m: 1 }; h.state.unreadTotalsAt.mm = 90000
    mmFixture(h, url => url.endsWith('/' + failure) ? Error('offline') : undefined)
    await h.ctx.mmLastPosts()
    assert.equal(h.state.mmPinCounts.mm.count, 7)
    assert.equal(h.state.mmPinCounts.mm.observedAt, 90000)
    // Re-reading cached MM data must not advance the observation timestamp.
    h.state.svcViews.mm.executeJavaScript = async () => result('mm', 0)
    h.ctx.mmLastPosts = async () => {}; h.ctx.mmTabCounts = async () => {}
    await h.ctx.pollUnread()
    assert.equal(h.state.unreadTotals.mm.c, 7)
    assert.equal(h.state.unreadTotalsAt.mm, 90000)
  })
}

for (const failure of ['throw', 'reject', 'invalid', 'error-object']) {
  test(`poll: ${failure} preserves prior totals, timestamps and combined count`, async () => {
    const h = harness(['max','ydx'])
    await h.ctx.pollUnread()
    const at = h.state.unreadTotalsAt.max
    h.replies.max = () => { if (failure === 'throw') throw Error('sync'); return failure === 'reject' ? Promise.reject(Error('async')) : Promise.resolve(failure === 'error-object' ? '{"error":"offline"}' : 'not-json') }
    await h.tick(5000)
    await h.ctx.pollUnread()
    assert.equal(h.state.unreadTotals.max.c, 2)
    assert.equal(h.state.unreadTotalsAt.max, at)
    assert.equal(h.state.svcTabTotals.max.t, 2)
    assert.equal(h.badges.some(b => b[0] === 'max' && b[1] === ''), false, 'failed extraction must not clear the service badge')
    assert.deepEqual(h.badges.at(-1), ['combined', 4, 0])
  })
}

test('sorting favourites during a pending poll does not invalidate its unchanged identities', async () => {
  const h = harness(['max']), response = deferred()
  h.state.cfg.pinned.push({ id: 'second', serviceId: 'max', url: 'https://fixture.invalid/-456' })
  h.replies.max = () => response.promise
  const poll = h.ctx.pollUnread(); await flush()
  h.state.cfg.pinned.reverse()
  response.resolve(result('max',4)); await poll
  assert.equal(h.state.unreadTotals.max?.c, 4)
})

for (const change of ['replace', 'navigate', 'remove-pin', 'config']) {
  test(`poll: ${change} invalidates old generation`, async () => {
    const h = harness(['max']), old = deferred()
    h.replies.max = () => old.promise
    const first = h.ctx.pollUnread(); await flush()
    if (change === 'replace') h.state.svcViews.max = h.view('max')
    if (change === 'navigate') h.state.svcViews.max.emit('did-start-loading')
    if (change === 'remove-pin') h.state.cfg.pinned = []
    if (change === 'config') h.state.cfg.services[0].url = 'https://different.invalid/'
    if (change === 'replace' || change === 'navigate') {
      h.replies.max = () => Promise.resolve(result('max',0))
      await h.ctx.pollUnread()
    }
    old.resolve(result('max',7)); await first
    assert.equal(h.state.unreadTotals.max?.c, change === 'replace' || change === 'navigate' ? 0 : undefined)
  })
}
