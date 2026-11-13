// Offline lifecycle regressions: execute actual renderer functions, no Electron/network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const source = readFileSync(new URL('../renderer.js', import.meta.url), 'utf8')
function fn(name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'))
  assert.ok(start >= 0, name)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, name)
  return source.slice(start, end + 2)
}
function context(names, extra = {}) {
  const ctx = vm.createContext({ console, ...extra })
  for (const name of names) vm.runInContext(fn(name), ctx)
  return ctx
}
function clock() {
  let id = 0
  const timers = new Map(), frames = new Map(), intervals = new Map()
  const fire = (map, key) => { const cb = map.get(key); map.delete(key); if (cb) cb() }
  return {
    timers, frames, intervals,
    setTimeout: cb => { timers.set(++id, cb); return id },
    clearTimeout: key => timers.delete(key),
    setInterval: cb => { intervals.set(++id, cb); return id },
    clearInterval: key => intervals.delete(key),
    requestAnimationFrame: cb => { frames.set(++id, cb); return id },
    cancelAnimationFrame: key => frames.delete(key),
    tick: () => { for (const key of [...timers.keys()]) fire(timers, key) },
    frame: () => { for (const key of [...frames.keys()]) fire(frames, key) }
  }
}
class EventNode {
  constructor() { this.listeners = new Map(); this.dataset = {}; this.isConnected = true; this.attributes = {} }
  addEventListener(type, cb, options) { if (!this.listeners.has(type)) this.listeners.set(type, new Map()); this.listeners.get(type).set(cb, options) }
  removeEventListener(type, cb) { this.listeners.get(type)?.delete(cb) }
  emit(type) { for (const [cb, opts] of [...(this.listeners.get(type) || [])]) { if (opts?.once) this.removeEventListener(type, cb); cb() } }
  listenerCount() { return [...this.listeners.values()].reduce((n, handlers) => n + handlers.size, 0) }
  setAttribute(key, value) { this.attributes[key] = value }
  remove() { this.isConnected = false }
}
for (const outcome of ['load', 'error', 'timeout']) test('lifecycle: avatar ' + outcome + ' releases both listeners and timer', async () => {
  const time = clock()
  const img = Object.assign(new EventNode(), { complete: false, src: 'data:image/png;base64,synthetic', className: 'avatar' })
  const el = { querySelector: () => null, querySelectorAll: () => [img] }
  const ctx = context(['__chatHubGrabAvatar'], time)
  for (let i = 0; i < 20; i++) {
    const result = ctx.__chatHubGrabAvatar(el)
    if (outcome === 'timeout') time.tick(); else img.emit(outcome)
    assert.equal(await result, img.src)
  }
  console.log('RESOURCE avatar ' + outcome + ':', JSON.stringify({ listeners: img.listenerCount(), timers: time.timers.size }))
  assert.equal(img.listenerCount(), 0)
  assert.equal(time.timers.size, 0)
})
for (const outcome of ['load', 'error', 'timeout']) test('lifecycle: fallback Image ' + outcome + ' releases callbacks and timer', async () => {
  const time = clock()
  let image
  const ctx = context(['__chatHubGrabAvatar'], {
    ...time,
    fetch: async () => { throw new Error('synthetic CORS rejection') },
    Image: class { constructor() { image = this } },
    document: { createElement: () => ({ getContext: () => ({ drawImage: input => { if (input !== image) throw new Error('synthetic taint') } }), toDataURL: () => 'data:synthetic' }) }
  })
  const img = { complete: true, src: 'https://synthetic.invalid/avatar', className: 'avatar' }
  const pending = ctx.__chatHubGrabAvatar({ querySelector: () => null, querySelectorAll: () => [img] })
  for (let i = 0; i < 5; i++) await Promise.resolve()
  assert.ok(image, 'actual fallback branch reached')
  const late = image.onload
  if (outcome === 'timeout') time.tick(); else image['on' + outcome]()
  assert.equal(await pending, outcome === 'load' ? 'data:synthetic' : null)
  console.log('RESOURCE fallback ' + outcome + ':', JSON.stringify({ callbacks: Number(!!image.onload) + Number(!!image.onerror), timers: time.timers.size }))
  assert.equal(image.onload, null)
  assert.equal(image.onerror, null)
  assert.equal(time.timers.size, 0)
  late() // already queued callback cannot restart work or retain resources
  assert.equal(time.timers.size, 0)
})
test('lifecycle: lazy same-origin avatar fetches without waiting for viewport load', async () => {
  let next = 0, scheduled = 0
  const timers = new Map()
  const setTimeout = fn => { const id = ++next; scheduled++; timers.set(id, fn); queueMicrotask(() => { if (timers.has(id)) { timers.delete(id); fn() } }); return id }
  const clearTimeout = id => timers.delete(id)
  const img = Object.assign(new EventNode(), { complete: false, naturalWidth: 0, loading: 'lazy', src: 'https://fixture.invalid/avatar', className: 'avatar' })
  class Reader { readAsDataURL() { this.result = 'data:image/png;base64,eager'; queueMicrotask(() => this.onload && this.onload()) } }
  let fetches = 0
  const ctx = context(['__chatHubGrabAvatar'], { setTimeout, clearTimeout, URL, location: { origin: 'https://fixture.invalid', href: 'https://fixture.invalid/chat' },
    fetch: async () => { fetches++; return { blob: async () => ({ size: 1 }) } }, FileReader: Reader })
  const result = await ctx.__chatHubGrabAvatar({ querySelector: () => null, querySelectorAll: () => [img] })
  assert.equal(result, 'data:image/png;base64,eager')
  assert.equal(fetches, 1)
  assert.equal(scheduled, 0, 'same-origin lazy image must not wait for viewport-driven load')
  assert.equal(img.listenerCount(), 0)
})
test('lifecycle: bounded same-origin lazy avatar gets fetch budget', async () => {
  let delay = 0, resolveWork
  const img = { loading: 'lazy', src: 'https://fixture.invalid/avatar' }
  const ctx = context(['__chatHubBoundedAvatar'], { window: {}, URL, location: { origin: 'https://fixture.invalid', href: 'https://fixture.invalid/chat' },
    setTimeout: (_fn, ms) => { delay = ms; return 1 }, clearTimeout() {}, __grabAvatar: () => new Promise(resolve => { resolveWork = resolve }) })
  const task = ctx.__chatHubBoundedAvatar({ querySelector: () => img }, { attempts: 0 })
  await Promise.resolve()
  assert.equal(delay, 700)
  resolveWork('data:image/png;base64,eager')
  assert.equal(await task, 'data:image/png;base64,eager')
})
function cssContext() {
  const time = clock()
  let applies = 0
  const observers = []
  const ctx = context(['__chatHubApplyCss'], {
    ...time, window: {},
    document: { documentElement: {}, querySelectorAll: () => [{ style: { setProperty: () => applies++ } }] },
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this) } observe() {} disconnect() { this.disconnected = true } }
  })
  const install = () => ctx.__chatHubApplyCss('.synthetic { display: none }')
  return { ctx, time, observers, install, applies: () => applies }
}
test('lifecycle: hidden CSS observer never accumulates pending frames', () => {
  const c = cssContext(); c.install()
  let maxFrames = 0
  for (let i = 0; i < 100; i++) {
    c.observers[0].cb(); c.observers[0].cb()
    maxFrames = Math.max(maxFrames, c.time.frames.size)
    c.time.tick()
  }
  console.log('RESOURCE hidden CSS:', JSON.stringify({ maxFrames, pendingFrames: c.time.frames.size, pendingTimers: c.time.timers.size }))
  assert.equal(maxFrames, 1)
  assert.equal(c.time.frames.size, 0)
  assert.equal(c.time.timers.size, 0)
  assert.equal(c.applies(), 101)
})
test('lifecycle: CSS frame cancels fallback and reinstall cancels old work', () => {
  const c = cssContext(); c.install(); c.observers[0].cb()
  c.time.frame()
  assert.equal(c.time.timers.size, 0)
  assert.equal(c.applies(), 2)
  c.time.tick(); assert.equal(c.applies(), 2)
  c.observers[0].cb()
  const stale = [...c.time.frames.values()][0]
  c.install()
  assert.equal(c.observers[0].disconnected, true)
  assert.equal(c.time.frames.size, 0)
  assert.equal(c.time.timers.size, 0)
  assert.equal(c.time.intervals.size, 1)
  c.observers[1].cb()
  stale()
  assert.equal(c.time.frames.size, 1, 'old callback must not cancel new observer work')
  assert.equal(c.applies(), 3)
  c.time.tick()
  assert.equal(c.applies(), 4)
})
function watchdogContext() {
  const time = clock(), pending = [], repairs = []
  const state = { cfg: { services: ['mm', 'tg', 'max', 'ydx'].map(id => ({ id, partition: 'fixture' })), columnCss: { tg: '.fixture{}' }, selectedPinId: 'p' }, activePinId: 'p', pinViews: {}, lastUsed: {}, svcViews: { tg: {} } }
  let calls = 0, physical = 0, peak = 0, syncError = false
  const ctx = context(['ensurePinView', 'destroyPinView', 'enqueueLoad', 'pumpPreload'], {
    ...time, state,
    document: { getElementById: () => ({ appendChild() {} }), createElement: () => Object.assign(new EventNode(), {
      executeJavaScript(code) {
        assert.equal(code, '!!window.__chatHubCssTimer')
        calls++
        if (syncError) { syncError = false; throw new Error('synthetic unavailable guest') }
        physical++; peak = Math.max(peak, physical)
        return new Promise((resolve, reject) => pending.push({ resolve: value => { physical--; resolve(value) }, reject: () => { physical--; reject(new Error('synthetic guest failure')) } }))
      }
    }) },
    applyColumnTweaks: (...args) => repairs.push(args), captureSvcIcon() {}
  })
  vm.runInContext('const preloadQueue = []; let preloadBusy = false', ctx)
  const pin = { id: 'p', serviceId: 'tg', url: 'https://synthetic.invalid/p' }
  const view = ctx.ensurePinView(pin)
  const tick = time.intervals.get(view.__hubTimer)
  return { ctx, state, time, pin, view, tick, pending, repairs, throwNext: () => { syncError = true }, stats: () => ({ calls, physical, peak }) }
}
test('CSS watchdog: frozen guest has one physical evaluation across 100 ticks', async () => {
  const c = watchdogContext()
  const first = c.tick()
  for (let i = 1; i < 100; i++) { c.tick(); c.time.tick() }
  console.log('RESOURCE frozen CSS watchdog:', JSON.stringify(c.stats()))
  assert.deepEqual(c.stats(), { calls: 1, physical: 1, peak: 1 })
  c.pending[0].resolve(true); await first
  assert.equal(c.stats().physical, 0)
  assert.equal(c.repairs.length, 0)
})
for (const change of ['destroy', 'replace', 'detach']) test('CSS watchdog: ' + change + ' blocks late repair and stale ticks', async () => {
  const c = watchdogContext(), first = c.tick()
  if (change === 'destroy') c.ctx.destroyPinView(c.pin.id, c.view)
  if (change === 'replace') c.state.pinViews.p = new EventNode()
  if (change === 'detach') c.view.remove()
  c.pending[0].resolve(false); await first
  assert.equal(c.repairs.length, 0, 'settled response from retired view must not repair')
  await c.tick()
  assert.equal(c.stats().calls, 1, 'already queued timer callback must not launch work')
  if (change === 'destroy') {
    assert.equal(c.time.intervals.size, 0)
    assert.equal(c.time.timers.size, 0)
    assert.equal(c.state.pinViews.p, undefined)
    assert.equal(c.state.activePinId, 'p')
    assert.equal(c.state.cfg.selectedPinId, 'p')
    assert.ok(c.state.svcViews.tg)
    console.log('RESOURCE destroyed CSS watchdog:', JSON.stringify({ ...c.stats(), intervals: c.time.intervals.size, timers: c.time.timers.size, repairs: c.repairs.length }))
  }
})
for (const failure of ['reject', 'throw']) test('CSS watchdog: ' + failure + ' releases slot only on settlement and permits retry', async () => {
  const c = watchdogContext()
  if (failure === 'throw') c.throwNext()
  const first = c.tick()
  if (failure === 'reject') c.pending[0].reject()
  await first
  assert.equal(c.repairs.length, 0)
  const second = c.tick()
  assert.equal(c.stats().calls, 2)
  c.pending.at(-1).resolve(false); await second
  assert.deepEqual(c.repairs, [[c.view, c.pin, 4]])
  assert.equal(c.stats().peak, 1)
})
test('CSS watchdog: current CSS configuration controls repair; healthy guest does not repair', async () => {
  const c = watchdogContext()
  for (const [ok, css, expected] of [[true, '.fixture{}', 0], [false, '  ', 0], [false, '.changed{}', 1]]) {
    const task = c.tick()
    c.state.cfg.columnCss.tg = css
    c.pending.at(-1).resolve(ok); await task
    assert.equal(c.repairs.length, expected)
  }
  assert.equal(c.stats().calls, 3)
  assert.equal(c.ctx.ensurePinView(c.pin), c.view)
  assert.equal(c.time.intervals.size, 1, 'ensure existing view does not duplicate watchdog')
})
test('CSS watchdog: navigation and dom-ready preserve physical slot and existing CSS hooks', async () => {
  const c = watchdogContext(), task = c.tick()
  c.view.emit('dom-ready')
  c.view.emit('did-navigate-in-page')
  c.time.tick()
  assert.deepEqual(c.repairs, [[c.view, c.pin], [c.view, c.pin]])
  for (let i = 0; i < 100; i++) c.tick()
  assert.deepEqual(c.stats(), { calls: 1, physical: 1, peak: 1 })
  c.pending[0].resolve(true); await task
  const next = c.tick()
  c.pending[1].resolve(false); await next
  assert.deepEqual(c.repairs.at(-1), [c.view, c.pin, 4])
})
test('CSS watchdog: 100 create/destroy cycles release timers; late settlements cannot repair replacements', async () => {
  const c = watchdogContext(), tasks = []
  for (let i = 0; i < 100; i++) {
    const view = c.ctx.ensurePinView(c.pin)
    const tick = c.time.intervals.get(view.__hubTimer)
    tasks.push(tick())
    for (let n = 0; n < 100; n++) tick()
    c.ctx.destroyPinView(c.pin.id, view)
    assert.equal(c.time.intervals.size, 0)
    assert.equal(c.time.timers.size, 0)
  }
  assert.equal(c.stats().calls, 100, 'one unavoidable physical call per retired guest, not per tick')
  c.ctx.ensurePinView(c.pin)
  for (const pending of c.pending) pending.resolve(false)
  await Promise.all(tasks)
  assert.equal(c.repairs.length, 0)
  c.ctx.destroyPinView(c.pin.id, c.state.pinViews.p)
  console.log('RESOURCE 100 CSS watchdog lifecycles:', JSON.stringify({ ...c.stats(), intervals: c.time.intervals.size, timers: c.time.timers.size, repairs: c.repairs.length }))
  assert.equal(c.stats().physical, 0)
})
function queueContext() {
  const time = clock()
  const state = { pinViews: {}, lastUsed: {} }
  const ctx = context(['enqueueLoad', 'pumpPreload', 'destroyPinView', 'trimPinViews'], { ...time, state })
  vm.runInContext(source.match(/^function maxLiveViews\(\).*$/m)[0], ctx)
  vm.runInContext(source.slice(source.indexOf('const preloadQueue = []'), source.indexOf('function enqueueLoad(')), ctx)
  const add = id => {
    const view = new EventNode()
    view.__hubTimer = time.setInterval(() => {})
    state.pinViews[id] = view; state.lastUsed[id] = 1
    ctx.enqueueLoad(view, 'https://synthetic.invalid/' + id)
    return view
  }
  return { ctx, time, state, add, busy: () => vm.runInContext('preloadBusy', ctx), queued: () => vm.runInContext('preloadQueue.length', ctx) }
}
test('lifecycle: destroying active load immediately releases queue; stale callback cannot settle next', () => {
  const q = queueContext(), a = q.add('a'), b = q.add('b'), c = q.add('c')
  const staleReady = [...a.listeners.get('dom-ready').keys()][0]
  const staleTimeout = [...q.time.timers.values()][0]
  q.ctx.destroyPinView('a', a)
  console.log('RESOURCE removed active load:', JSON.stringify({ listeners: a.listenerCount(), connected: a.isConnected, nextStarted: !!b.attributes.src, timers: q.time.timers.size }))
  assert.equal(a.listenerCount(), 0)
  assert.equal(a.isConnected, false)
  assert.ok(b.attributes.src, 'next starts without waiting 8 seconds')
  assert.equal(q.time.timers.size, 1, 'only next job timeout survives')
  assert.equal(q.time.intervals.size, 2)
  assert.equal(q.state.pinViews.a, undefined)
  assert.equal(q.state.lastUsed.a, undefined)
  staleReady(); staleTimeout(); a.emit('dom-ready')
  assert.equal(q.busy(), true)
  assert.equal(c.attributes.src, undefined, 'stale callbacks cannot pump past current load')
  b.emit('dom-ready'); assert.ok(c.attributes.src)
  assert.equal(b.listenerCount(), 0)
  q.ctx.destroyPinView('c', c)
  assert.equal(q.busy(), false)
  assert.equal(q.time.timers.size, 0)
  assert.equal(q.queued(), 0)
})
test('lifecycle: timed out load removes listener and late readiness cannot skip next', () => {
  const q = queueContext(), a = q.add('a'), b = q.add('b'), c = q.add('c')
  const late = [...a.listeners.get('dom-ready').keys()][0]
  q.time.tick()
  assert.equal(a.listenerCount(), 0)
  assert.ok(b.attributes.src)
  late(); assert.equal(c.attributes.src, undefined)
  b.emit('dom-ready'); c.emit('dom-ready')
  assert.equal(q.time.timers.size, 0)
  assert.equal(q.busy(), false)
})
test('lifecycle: removal of queued view preserves active load and queue order', () => {
  const q = queueContext(), a = q.add('a'), b = q.add('b'), c = q.add('c')
  q.ctx.destroyPinView('b', b)
  assert.equal(q.queued(), 1)
  assert.equal(q.busy(), true)
  assert.equal(q.time.timers.size, 1)
  a.emit('dom-ready')
  assert.equal(b.attributes.src, undefined)
  assert.ok(c.attributes.src)
  c.emit('dom-ready')
  assert.equal(q.busy(), false)
})
test('lifecycle: failed src assignment releases listener, timer and serial loader', () => {
  const q = queueContext()
  const view = new EventNode()
  view.setAttribute = () => { throw new Error('synthetic detached guest') }
  q.ctx.enqueueLoad(view, 'https://synthetic.invalid/failed')
  assert.equal(view.listenerCount(), 0)
  assert.equal(view.__hubPreloadDone, undefined)
  assert.equal(q.time.timers.size, 0)
  assert.equal(q.busy(), false)
  const next = q.add('next')
  assert.ok(next.attributes.src)
  next.emit('dom-ready')
  assert.equal(q.busy(), false)
})
test('lifecycle: 100 active load cancellations leave zero owned resources', () => {
  const q = queueContext(), removed = []
  for (let i = 0; i < 100; i++) {
    const id = 'synthetic-' + i, view = q.add(id)
    removed.push(view)
    q.ctx.destroyPinView(id, view)
  }
  const resources = {
    views: Object.keys(q.state.pinViews).length, timers: q.time.timers.size,
    intervals: q.time.intervals.size, listeners: removed.reduce((n, view) => n + view.listenerCount(), 0),
    callbacks: removed.filter(view => view.__hubPreloadDone).length, queued: q.queued(), busy: q.busy()
  }
  console.log('RESOURCE 100 load cancellations:', JSON.stringify(resources))
  assert.deepEqual(resources, { views: 0, timers: 0, intervals: 0, listeners: 0, callbacks: 0, queued: 0, busy: false })
})
test('memory bound: ten priority pins trim to two, preserving active chat and four collectors', () => {
  const q = queueContext()
  q.state.cfg = { maxLiveViews: 2, pinned: [] }
  q.state.activePinId = 'pin-0'
  q.state.svcViews = Object.fromEntries(['mm', 'tg', 'max', 'ydx'].map(id => [id, new EventNode()]))
  const collectors = { ...q.state.svcViews }
  for (let i = 0; i < 10; i++) {
    const id = 'pin-' + i
    q.state.cfg.pinned.push({ id, priority: true })
    q.add(id).emit('dom-ready')
    q.state.lastUsed[id] = i
  }
  q.ctx.trimPinViews()
  assert.deepEqual(Object.keys(q.state.pinViews).sort(), ['pin-0', 'pin-9'])
  assert.deepEqual(q.state.svcViews, collectors)
  assert.ok(Object.values(collectors).every(v => v.isConnected))
  assert.equal(q.time.intervals.size, 2)
  assert.equal(q.time.timers.size, 0)
  assert.equal(q.queued(), 0)
  assert.equal(q.state.cfg.pinned.length, 10, 'eviction is not unpinning')
  assert.ok(q.state.cfg.pinned.every(p => p.priority), 'priority still controls UI order')
  console.log('RESOURCE priority bound:', JSON.stringify({ pinViews: 2, serviceViews: 4, intervals: q.time.intervals.size, timers: q.time.timers.size, queued: q.queued() }))
})
test('memory bound: trimming never starts queued victims while releasing active loader', () => {
  const q = queueContext(), views = []
  q.state.cfg = { maxLiveViews: 2, pinned: [] }
  q.state.activePinId = 'pin-9'
  for (let i = 0; i < 10; i++) {
    views.push(q.add('pin-' + i))
    q.state.lastUsed['pin-' + i] = i
  }
  const late = [...views[0].listeners.get('dom-ready').keys()][0]
  q.ctx.trimPinViews()
  assert.deepEqual(Object.keys(q.state.pinViews), ['pin-8', 'pin-9'])
  for (const view of views.slice(1, 8)) assert.equal(view.attributes.src, undefined, 'do not navigate an evicted queued chat')
  assert.ok(views[8].attributes.src)
  late()
  assert.equal(views[9].attributes.src, undefined)
  views[8].emit('dom-ready'); views[9].emit('dom-ready')
  assert.equal(q.time.timers.size, 0)
  assert.equal(q.queued(), 0)
  assert.equal(q.busy(), false)
  for (const view of views.slice(0, 8)) assert.equal(view.listenerCount(), 0)
})
test('memory bound: 100 priority open/close cycles keep resources bounded', () => {
  const q = queueContext(), views = []
  q.state.cfg = { maxLiveViews: 2, pinned: [] }
  let peak = 0
  for (let i = 0; i < 100; i++) {
    const id = 'pin-' + i
    q.state.cfg.pinned.push({ id, priority: true })
    q.state.activePinId = id
    views.push(q.add(id))
    q.state.lastUsed[id] = i
    q.ctx.trimPinViews(id)
    peak = Math.max(peak, Object.keys(q.state.pinViews).length)
    assert.ok(q.state.pinViews[id])
    assert.ok(q.time.intervals.size <= 2)
    assert.ok(q.time.timers.size <= 1)
    assert.ok(q.queued() <= 1)
  }
  for (const [id, view] of Object.entries(q.state.pinViews)) q.ctx.destroyPinView(id, view)
  const resources = { peak, views: Object.keys(q.state.pinViews).length, timers: q.time.timers.size, intervals: q.time.intervals.size, listeners: views.reduce((n, v) => n + v.listenerCount(), 0), queued: q.queued(), busy: q.busy() }
  console.log('RESOURCE 100 priority cycles:', JSON.stringify(resources))
  assert.deepEqual(resources, { peak: 2, views: 0, timers: 0, intervals: 0, listeners: 0, queued: 0, busy: false })
})
const pinMaps = ['liveAct', 'rankAct', 'prevUnread', 'lastUsed', 'lastMsgAt', 'lastMsgDayOnly', 'lastMsgText', 'tgPeerOf', 'tgSearchedAt', 'pinAvatars', 'lastMsgPreview', 'msgAuth', 'unreadBaseC', 'unreadBaseM', 'unreadTotals', 'unreadTotalsAt', 'mmPinCounts', '__prevLastMsgAt']
test('lifecycle: 100 removed pins leave no cache keys or persisted activity', async () => {
  const state = { cfg: { pinned: [], activity: {}, selectedPinId: '' }, pinViews: {}, svcIcons: { tg: 'keep-icon' }, mmUserIds: { user: 'keep-user' } }
  for (const key of pinMaps) { state[key] = { keep: 'retained' }; state.cfg.activity[key] = { keep: 'persisted' } }
  const ctx = context(['removePin', 'activitySnapshot'], {
    state, tgScrollDone: false, window: { hub: { saveConfig: async () => {} } },
    renderChatList() {}, updateSvcBar() {}, toast() {}
  })
  for (let i = 0; i < 100; i++) {
    const id = 'synthetic-' + i
    state.cfg.pinned.push({ id, serviceId: 'tg' })
    for (const key of pinMaps) { state[key][id] = 'synthetic'; state.cfg.activity[key][id] = 'synthetic' }
    await ctx.removePin(id)
  }
  const retained = Object.fromEntries(pinMaps.map(key => [key, Object.keys(state[key]).filter(id => id !== 'keep').length]))
  console.log('RESOURCE cache keys after 100 removals:', JSON.stringify(retained))
  assert.equal(state.cfg.pinned.length, 0)
  assert.deepEqual(retained, Object.fromEntries(pinMaps.map(key => [key, 0])))
  for (const key of pinMaps) { assert.equal(state[key].keep, 'retained'); assert.deepEqual(state.cfg.activity[key], { keep: 'persisted' }) }
  for (const values of Object.values(ctx.activitySnapshot())) if (values && typeof values === 'object') assert.ok(Object.keys(values).every(id => id === 'keep'))
  assert.equal(state.svcIcons.tg, 'keep-icon')
  assert.equal(state.mmUserIds.user, 'keep-user')
})
