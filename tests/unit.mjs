// tests/unit.mjs — юнит-тесты чистых функций renderer.js.
// Функции извлекаются из renderer.js по исходнику (brace-matching) и исполняются
// в vm-контексте: тестируем РЕАЛЬНЫЙ код, не копию. Запуск: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { element, listFixture } from './synthetic-dom.mjs'
import './lifecycle.mjs'
import './polling.mjs'
import './virtualized.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(path.join(ROOT, 'renderer.js'), 'utf8')

function extractFunction(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{')
  const m = re.exec(SRC)
  if (!m) throw new Error('функция не найдена в renderer.js: ' + name)
  let i = m.index + m[0].length - 1
  let depth = 0
  let j = i
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (depth === 0) break }
  }
  return SRC.slice(m.index, j + 1)
}
function sandbox(names, extra = {}) {
  const ctx = { Date, Math, JSON, String, Number, parseInt, parseFloat, RegExp, console, ...extra }
  vm.createContext(ctx)
  for (const n of names) vm.runInContext(extractFunction(n), ctx)
  return ctx
}

// Startup integration: real init/buildSection/activateTab/renderChatList/queue,
// with only DOM, timers and unrelated UI/IPC effects replaced. No Electron launch.
function startupSandbox(interactive = false) {
  const loads = []
  const createdViews = []
  const timers = new Map()
  const intervals = []
  const readRefreshes = []
  let timerId = 0
  class Element {
    constructor(tag) {
      this.tagName = tag
      this.dataset = {}
      this.style = {}
      this.children = []
      this.attributes = {}
      this.listeners = new Map()
      this.parts = new Map()
      const classes = new Set()
      this.classList = {
        toggle(name, on) { if (on) classes.add(name); else classes.delete(name) },
        add(name) { classes.add(name) },
        remove(name) { classes.delete(name) },
        contains(name) { return classes.has(name) }
      }
    }
    get isConnected() { return this === content || !!this.parentElement?.isConnected }
    set innerHTML(value) { this.html = value; this.children = [] }
    get innerHTML() { return this.html || '' }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child }
    querySelector(selector) {
      const tab = /^section\[data-tab="([^"]+)"\]$/.exec(selector)
      if (tab) return this.children.find(c => c.dataset.tab === tab[1]) || null
      if (!this.parts.has(selector)) this.parts.set(selector, new Element('div'))
      return this.parts.get(selector)
    }
    setAttribute(name, value) {
      this.attributes[name] = value
      if (name === 'src') {
        assert.equal(this.isConnected, true, 'src must be assigned after attachment')
        loads.push({ view: this, url: value })
      }
    }
    addEventListener(name, fn, options) {
      const entries = this.listeners.get(name) || []
      entries.push({ fn, once: !!options?.once })
      this.listeners.set(name, entries)
    }
    removeEventListener(name, fn) {
      this.listeners.set(name, (this.listeners.get(name) || []).filter(entry => entry.fn !== fn))
    }
    emit(name) {
      for (const entry of [...(this.listeners.get(name) || [])]) {
        if (entry.once) this.listeners.set(name, this.listeners.get(name).filter(e => e !== entry))
        entry.fn({})
      }
    }
    insertCSS() {}
    getURL() { return this.attributes.src || '' }
    loadURL(url) { this.setAttribute('src', url); return Promise.resolve() }
    executeJavaScript() { return Promise.resolve(0) }
    remove() { this.parentElement.children = this.parentElement.children.filter(c => c !== this); this.parentElement = null }
  }
  const content = new Element('main')
  const elements = new Map([['content', content]])
  const document = {
    createElement(tag) {
      const el = new Element(tag)
      if (tag === 'webview') createdViews.push(el)
      return el
    },
    getElementById(id) {
      if (!elements.has(id)) {
        const el = new Element('div')
        el.parentElement = content
        elements.set(id, el)
      }
      return elements.get(id)
    },
    querySelector: selector => content.querySelector(selector),
    querySelectorAll: selector => selector === '.chat-row' ? (elements.get('chat-list')?.children || []) : [],
    addEventListener() {}
  }
  const services = ['mm', 'tg', 'max', 'ydx'].map(id => ({
    id, name: id, url: `https://${id}.example/`, partition: `persist:${id}`
  }))
  const pinned = services.map(s => ({ id: 'pin-' + s.id, serviceId: s.id, url: s.url + '#chat' }))
  const state = { svcViews: {}, pinViews: {}, combinedBuilt: false,
    lastUsed: {}, svcIcons: {}, lastMsgPreview: {}, lastMsgAt: {} }
  const noop = () => {}
  const ctx = sandbox(['init', 'activateTab', 'buildSection', 'initialSvcUrl',
    'renderChatList', 'syncChatSelection', 'enqueueLoad', 'pumpPreload', 'openInServiceTab'], {
    state, document,
    window: { hub: { getConfig: async () => ({ services, pinned, selectedPinId: pinned[0].id }), saveConfig: async () => {} } },
    ensureKeys: noop, sortFavoritesByActivity: noop, buildTabs: noop, applyTheme: noop, applyLayout: noop,
    applyBadgeVisibility: noop, refreshTabIcons: noop, initListSplitter: noop,
    badgeColor: () => '#000', captureSvcIcon: noop, updateSvcBar: noop,
    makeChatRow: () => new Element('div'), applyFavFilter: noop, trimPinViews: noop,
    ensurePinView: () => assert.fail('startup must not preload pin views'),
    selectChat: () => assert.fail('startup must not auto-select a chat'),
    tgSearchBusy: false, tgBusyAt: 0, queueSelectedUnread: async id => { readRefreshes.push(id) },
    setInterval(fn, delay) { intervals.push({ fn, delay }) },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) }
  })
  if (interactive) {
    Object.assign(ctx, { setRowAvatar: noop, setRowPreview: noop, toast: noop, clearInterval: noop, applyColumnTweaks: noop })
    for (const name of ['setRowBadge', 'makeChatRow', 'selectChat', 'ensurePinView', 'renderViewHead', 'removePin', 'destroyPinView']) {
      vm.runInContext(extractFunction(name), ctx)
    }
  }
  vm.runInContext('const preloadQueue = []; let preloadBusy = false', ctx)
  return { ctx, state, services, loads, createdViews, timers, intervals, readRefreshes,
    queueSize: () => vm.runInContext('preloadQueue.length', ctx),
    busy: () => vm.runInContext('preloadBusy', ctx),
    timeout() {
      const [id, timer] = timers.entries().next().value
      assert.equal(timer.delay, 8000)
      timers.delete(id)
      timer.fn()
    }
  }
}

test('memory bound: explicit selections enforce limit; priority refresh does not reopen or mark read', async () => {
  const h = startupSandbox(true)
  for (const name of ['maxLiveViews', 'trimPinViews']) vm.runInContext(extractFunction(name), h.ctx)
  await h.ctx.init()
  for (const svc of h.services) h.state.svcViews[svc.id].emit('dom-ready')
  const collectors = { ...h.state.svcViews }
  h.state.cfg.maxLiveViews = 2
  for (let i = 0; i < 6; i++) {
    const svc = h.services[i % h.services.length]
    h.state.cfg.pinned.push({ id: 'extra-' + i, serviceId: svc.id, url: svc.url + '#extra-' + i })
  }
  for (const pin of h.state.cfg.pinned) pin.priority = true
  for (const pin of h.state.cfg.pinned) {
    h.ctx.selectChat(pin.id)
    h.state.pinViews[pin.id].emit('dom-ready')
    assert.equal(h.state.activePinId, pin.id)
    assert.ok(Object.keys(h.state.pinViews).length <= 2)
    assert.equal(h.state.pinViews[pin.id].classList.contains('active'), true)
  }
  const loads = h.loads.length, reads = h.readRefreshes.length
  for (let i = 0; i < 20; i++) h.ctx.renderChatList()
  assert.equal(h.loads.length, loads, 'refresh cannot reopen evicted priority pins')
  assert.equal(h.readRefreshes.length, reads, 'refresh cannot initiate read verification')
  assert.deepEqual(h.state.svcViews, collectors)
  assert.ok(Object.values(collectors).every(v => v.isConnected))
  assert.equal(h.state.activePinId, 'extra-5')
  assert.equal(h.queueSize(), 0)
  assert.equal(h.busy(), false)
})

test('empty state: saved selection is not active on init or service/list refresh', async () => {
  const h = startupSandbox()
  await h.ctx.init()
  assert.equal(h.state.cfg.selectedPinId, 'pin-mm', 'fixture includes a saved selection')
  assert.equal(h.state.activePinId, '', 'selection must start empty for each launch')
  const empty = h.ctx.document.getElementById('chat-placeholder')
  assert.equal(empty.classList.contains('hidden'), false)
  assert.equal(h.ctx.document.getElementById('view-head').classList.contains('hidden'), true)
  const section = h.ctx.document.querySelector('section[data-tab="combined"]')
  assert.match(section.innerHTML, /src="build\/icon_256\.png"/)
  assert.match(section.innerHTML, />ChatHub</)
  assert.match(section.innerHTML, /Все чаты\. Одно окно\./)
  for (const svc of h.services) {
    h.state.svcViews[svc.id].emit('dom-ready')
    h.ctx.renderChatList()
    assert.equal(empty.classList.contains('hidden'), false)
    assert.equal(h.state.activePinId, '')
    assert.equal(Object.keys(h.state.pinViews).length, 0)
  }
  assert.equal(h.loads.length, 4)
})

for (const selectedService of ['mm', 'tg', 'max', 'ydx']) {
  test(`empty state: explicit ${selectedService} click and refresh preserve selection; next launch clears it`, async () => {
    const h = startupSandbox(true)
    await h.ctx.init()
    for (const svc of h.services) h.state.svcViews[svc.id].emit('dom-ready')
    const selectedId = 'pin-' + selectedService
    const rows = () => h.ctx.document.querySelectorAll('.chat-row')
    const row = rows().find(r => r.dataset.pin === selectedId)
    row.onclick({ target: { closest: () => null } })
    assert.deepEqual(h.readRefreshes, [selectedId], 'explicit selection requests immediate read verification')
    assert.equal(h.state.activePinId, selectedId)
    assert.equal(h.ctx.document.getElementById('chat-placeholder').classList.contains('hidden'), true)
    assert.equal(h.ctx.document.getElementById('view-head').classList.contains('hidden'), false)
    const view = h.state.pinViews[selectedId]
    assert.equal(view.classList.contains('active'), true)
    assert.equal(h.loads.length, 5)
    assert.equal(h.loads[4].url, h.state.cfg.pinned.find(p => p.id === selectedId).url)
    const head = h.ctx.document.getElementById('view-head').innerHTML
    // A remembered preference changing (e.g. adding a favourite) is not a click.
    h.state.cfg.selectedPinId = 'pin-max'
    h.state.cfg.pinned.reverse()
    h.ctx.renderChatList()
    h.ctx.renderChatList()
    assert.equal(h.state.pinViews[selectedId], view)
    assert.equal(h.state.activePinId, selectedId)
    assert.equal(view.classList.contains('active'), true)
    assert.equal(h.ctx.document.getElementById('view-head').innerHTML, head)
    assert.equal(h.ctx.document.getElementById('chat-placeholder').classList.contains('hidden'), true)
    assert.equal(h.loads.length, 5, 'refresh must not navigate or reload')
    assert.deepEqual(rows().filter(r => r.classList.contains('selected')).map(r => r.dataset.pin), [selectedId])

    const nextLaunch = startupSandbox()
    nextLaunch.ctx.window.hub.getConfig = async () => structuredClone(h.state.cfg)
    await nextLaunch.ctx.init()
    assert.equal(nextLaunch.state.activePinId, '')
    assert.equal(Object.keys(nextLaunch.state.pinViews).length, 0)
    assert.equal(nextLaunch.ctx.document.getElementById('chat-placeholder').classList.contains('hidden'), false)
  })
}

for (const service of ['mm', 'tg', 'max', 'ydx']) {
  test(`active highlight: ${service} row construction follows session selection, never saved preference`, async () => {
    const h = startupSandbox(true)
    await h.ctx.init()
    const pin = h.state.cfg.pinned.find(p => p.serviceId === service)
    h.state.cfg.selectedPinId = pin.id
    assert.equal(h.ctx.makeChatRow(pin).classList.contains('selected'), false, 'startup preference is not an open chat')
    const beforeActivity = JSON.stringify([h.state.lastMsgAt, h.state.liveAct])
    h.ctx.selectChat(pin.id)
    assert.equal(JSON.stringify([h.state.lastMsgAt, h.state.liveAct]), beforeActivity, 'opening never changes latest-message activity')
    assert.equal(h.ctx.makeChatRow(pin).classList.contains('selected'), true, 'a rebuilt active row must carry its own selected state')
    h.state.cfg.selectedPinId = 'saved-but-not-active'
    assert.equal(h.ctx.makeChatRow(pin).classList.contains('selected'), true)
    const other = h.state.cfg.pinned.find(p => p.id !== pin.id)
    assert.equal(h.ctx.makeChatRow(other).classList.contains('selected'), false)
  })
}

test('empty state: no favourites or invalid selection keeps the right pane visible', async () => {
  const h = startupSandbox(true)
  h.ctx.window.hub.getConfig = async () => ({ services: h.services, pinned: [], selectedPinId: 'deleted-pin' })
  await h.ctx.init()
  h.ctx.selectChat('deleted-pin')
  h.ctx.renderChatList()
  assert.equal(h.state.activePinId, '')
  assert.equal(h.ctx.document.getElementById('combined-layout').classList.contains('hidden'), false)
  assert.equal(h.ctx.document.getElementById('combined-empty').classList.contains('hidden'), false)
  assert.equal(h.ctx.document.getElementById('chat-placeholder').classList.contains('hidden'), false)
  assert.equal(h.createdViews.length, 4)
})

test('empty state: removing active pin clears selection without choosing a neighbour', async () => {
  const h = startupSandbox(true)
  await h.ctx.init()
  for (const svc of h.services) h.state.svcViews[svc.id].emit('dom-ready')
  h.ctx.selectChat('pin-tg')
  await h.ctx.removePin('pin-mm')
  assert.equal(h.state.activePinId, 'pin-tg', 'removing another pin preserves selection')
  const view = h.state.pinViews['pin-tg']
  h.state.unreadDots = { 'pin-tg': true }
  await h.ctx.removePin('pin-tg')
  assert.equal(h.state.unreadDots['pin-tg'], undefined)
  assert.equal(h.state.cfg.selectedPinId, '', 'no fallback to the first remaining pin')
  assert.equal(h.state.activePinId, '')
  assert.equal(view.isConnected, false)
  assert.equal(h.ctx.document.getElementById('chat-placeholder').classList.contains('hidden'), false)
  assert.equal(h.ctx.document.getElementById('view-head').classList.contains('hidden'), true)
  assert.equal(h.ctx.document.getElementById('view-head').innerHTML, '')
  assert.equal(h.loads.length, 5)
  for (const p of [...h.state.cfg.pinned]) await h.ctx.removePin(p.id)
  assert.equal(h.ctx.document.getElementById('combined-layout').classList.contains('hidden'), false)
  assert.equal(h.ctx.document.getElementById('combined-empty').classList.contains('hidden'), false)
  assert.equal(h.ctx.document.getElementById('chat-placeholder').classList.contains('hidden'), false)
  assert.equal(Object.keys(h.state.pinViews).length, 0)
})

for (const completion of ['dom-ready', 'timeout']) {
  test(`startup: four attached services load sequentially via ${completion}, without pin views`, async () => {
    const h = startupSandbox()
    await h.ctx.init()
    assert.equal(h.loads.length, 1, 'first service must start, not be discarded while detached')
    assert.equal(h.queueSize(), 3)
    assert.equal(h.createdViews.length, 4)
    assert.equal(Object.keys(h.state.pinViews).length, 0)
    assert.equal(h.state.combinedBuilt, true)
    for (let i = 0; i < h.services.length; i++) {
      assert.equal(h.loads.length, i + 1, 'only one additional service may start per completion')
      assert.equal(h.busy(), true)
      const svc = h.services[i]
      const view = h.state.svcViews[svc.id]
      assert.equal(h.loads[i].view, view)
      assert.equal(h.loads[i].url, svc.url, 'startup must use the service landing URL, never a pin')
      assert.equal(view.dataset.loadedSrc, h.loads[i].url)
      if (completion === 'dom-ready') view.emit('dom-ready')
      else {
        h.timeout()
        // A late dom-ready must not settle the next service's active job.
        const count = h.loads.length
        view.emit('dom-ready')
        assert.equal(h.loads.length, count)
      }
    }
    assert.equal(h.loads.length, 4)
    assert.equal(h.queueSize(), 0)
    assert.equal(h.busy(), false)
    assert.equal(h.timers.size, 0)
    assert.equal(Object.keys(h.state.pinViews).length, 0)
    assert.equal(h.createdViews.length, 4)
  })
}

test('startup queue: detached views are still discarded without blocking attached jobs', () => {
  const h = startupSandbox()
  const detached = h.ctx.document.createElement('webview')
  h.ctx.enqueueLoad(detached, 'https://detached.example/')
  assert.equal(h.loads.length, 0)
  assert.equal(h.queueSize(), 0)
  assert.equal(h.busy(), false)
  const attached = h.ctx.document.createElement('webview')
  h.ctx.document.getElementById('content').appendChild(attached)
  h.ctx.enqueueLoad(attached, 'https://attached.example/')
  assert.equal(h.loads.length, 1)
  attached.emit('dom-ready')
  assert.equal(h.busy(), false)
})

test('TG automatic startup URL strips configured chat hash', () => {
  const h = startupSandbox()
  h.state.cfg = { pinned: [{ serviceId: 'tg', url: 'https://web.telegram.org/k/#123' }] }
  assert.equal(h.ctx.initialSvcUrl({ id: 'tg', url: 'https://web.telegram.org/k/#456' }), 'https://web.telegram.org/k/')
})

for (const currentHash of ['', '#123']) {
  test(`TG auto-heal uses landing URL from ${currentHash || 'root'}, explicit pin click retains deep link`, async () => {
    const h = startupSandbox()
    await h.ctx.init()
    for (const svc of h.services) h.state.svcViews[svc.id].emit('dom-ready')
    const tg = h.services.find(s => s.id === 'tg')
    h.state.svcViews.tg.attributes.src = tg.url + currentHash
    const start = h.loads.length
    h.intervals.find(t => t.delay === 20000).fn()
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(h.loads.length > start, 'empty service view must recover')
    for (const load of h.loads.slice(start)) assert.equal(load.url, tg.url)
    const pin = h.state.cfg.pinned.find(p => p.serviceId === 'tg')
    h.ctx.openInServiceTab(pin)
    assert.equal(h.loads.at(-1).url, pin.url, 'explicit user navigation remains a deep link')
  })
}

test('rebuilt tabs immediately redraw saved service and favourite badges', async () => {
  const h = startupSandbox()
  await h.ctx.init()
  h.state.svcTabTotals = { max: { t: 25, m: 2 } }
  h.state.unreadTotals = { 'pin-max': { c: 7, m: 1 } }
  h.state.unreadDots = { 'pin-tg': true }
  const badges = []
  h.ctx.updateBadge2 = (...args) => badges.push(args)
  vm.runInContext(extractFunction('buildTabs'), h.ctx)
  h.ctx.buildTabs()
  assert.ok(badges.some(b => b[0] === 'max' && b[1] === 25 && b[2] === 2))
  assert.ok(badges.some(b => b[0] === 'combined' && b[1] === 8 && b[2] === 1))
})

test('rebuilt rows immediately redraw cached count, mention and dot without a successful poll', async () => {
  const h = startupSandbox(true)
  await h.ctx.init()
  const pin = h.state.cfg.pinned[0]
  for (const [c, m, dot, expected] of [[7,0,false,'7'],[0,2,false,'@2'],[0,0,true,'•'],[0,0,false,'']]) {
    h.state.unreadTotals = { [pin.id]: { c, m } }
    h.state.unreadDots = { [pin.id]: dot }
    const badge = h.ctx.makeChatRow(pin).querySelector('.row-badge')
    assert.equal(badge.textContent, expected)
    assert.equal(badge.classList.contains('hidden'), !expected)
  }
})

// Execute the actual pollUnread-generated script in a separate guest VM. This
// covers serialization/closure dependencies as well as the extractor/merge seam.
function unreadFixture(service, document) {
  const pin = { id: 'synthetic', serviceId: service, title: 'Synthetic room', url: service === 'ydx' ? 'https://telemost.yandex.ru/chats/0%2F0%2F00000000-0000-4000-8000-000000000123' : 'https://fixture.invalid/-123' }
  const results = [], scripts = [], badges = []
  const guest = vm.createContext({ document, window: {}, URL })
  const view = { async executeJavaScript(source) {
    scripts.push(source)
    const output = await new vm.Script(source).runInContext(guest)
    results.push(JSON.parse(output))
    return output
  } }
  const state = { cfg: { services: [{ id: service }], pinned: [pin] }, svcViews: { [service]: view }, pinViews: {},
    pinAvatars: { synthetic: 'already-cached' }, unreadTotals: {}, unreadTotalsAt: {},
    unreadBaseC: {}, unreadBaseM: {}, prevUnread: {}, rankAct: {}, lastMsgAt: {}, lastMsgText: {}, lastMsgPreview: {}, liveAct: {} }
  const ctx = sandbox(['pollUnread', '__chatHubMaxUnread', '__chatHubYdxUnread', '__chatHubGrabAvatar',
    '__chatHubScanRows', '__chatHubBoundedAvatar', 'formatMaxPreview', 'unreadDeltaFor', 'shouldBumpLiveAct', 'runUnreadJob',
    'unreadViewState', 'unreadGuestCall', 'restorePreviewAuthor', 'pollUnreadService', 'refreshUnreadPresentation', 'refreshSelectedUnread'], {
    setTimeout, clearTimeout,
    state, favoritesOf: () => [pin], svcViewFor: () => view,
    document: { querySelector: () => null },
    updateBadge2: (...args) => badges.push(args),
    sortFavoritesByActivity() {}, scheduleActSave() {}
  })
  ctx.UNREAD_EXTRACTORS = { max: ctx.__chatHubMaxUnread, ydx: ctx.__chatHubYdxUnread }
  // Prevent optional scrolling: exercise metadata, not the separate sweep bug.
  guest.window.__hubMaxSweepAt = Date.now() + 60000
  guest.window.__hubYdxSweepAt = Date.now() + 60000
  return { ctx, state, results, scripts, badges, guest, async poll() {
    const before = results.length
    await ctx.pollUnread()
    assert.equal(results.length, before + 1, 'generated guest script must execute, not be swallowed by poll catch')
    return results.at(-1)
  } }
}

test('ydx: exact microsecond row date reaches activity through the serialized scheduler', async () => {
  const doc = listFixture('ydx', { badge: 2 })
  const row = doc.children[0].children[0]
  row.__reactFiber$fixture.return.memoizedProps.date = 1700000000123456
  row.__reactFiber$fixture.return.memoizedProps.isDraft = undefined
  const h = unreadFixture('ydx', doc)
  vm.runInContext(extractFunction('mergeLastMessageTime'), h.ctx)
  const result = await h.poll()
  assert.equal(result.favs[0].messageTime?.at, 1700000000123)
  assert.equal(result.favs[0].messageTime?.dayOnly, false)
  assert.equal(h.state.lastMsgAt.synthetic, 1700000000123)
})

for (const scenario of ['draft', 'pending', 'failed', 'future', 'seconds', 'milliseconds', 'unsafe', 'string', 'missing-date', 'date-getter', 'draft-getter', 'status-getter', 'unknown-status', 'alternate-date', 'alternate-draft', 'owner-date']) {
  test(`ydx: ${scenario} cannot supply exact activity or fall back to displayed draft date`, async () => {
    const doc = listFixture('ydx', { badge: 2 })
    const row = doc.children[0].children[0], fiber = row.__reactFiber$fixture
    const props = fiber.return.memoizedProps
    props.date = 1700000000123456
    if (scenario === 'draft') props.isDraft = true
    if (['pending', 'failed', 'unknown-status'].includes(scenario)) props.status = scenario
    if (scenario === 'future') props.date = (Date.now() + 3600000) * 1000
    if (scenario === 'seconds') props.date = 1700000000
    if (scenario === 'milliseconds') props.date = 1700000000123
    if (scenario === 'unsafe') props.date = Number.MAX_SAFE_INTEGER + 1
    if (scenario === 'string') props.date = String(props.date)
    if (scenario === 'missing-date') delete props.date
    if (scenario.endsWith('-getter')) Object.defineProperty(props, scenario === 'date-getter' ? 'date' : scenario === 'draft-getter' ? 'isDraft' : 'status', { get() { throw Error('accessor must not run') } })
    if (scenario.startsWith('alternate-')) fiber.alternate = { stateNode: row, return: { memoizedProps: { ...props, ...(scenario === 'alternate-date' ? { date: props.date - 1000 } : { isDraft: true }) } } }
    if (scenario === 'owner-date') fiber.return.return = { memoizedProps: { ...props, date: props.date - 1000 } }
    const h = unreadFixture('ydx', doc)
    vm.runInContext(extractFunction('mergeLastMessageTime'), h.ctx)
    h.state.lastMsgAt.synthetic = 1600000000000
    const result = await h.poll()
    assert.equal(result.favs[0].found, true)
    assert.equal(result.favs[0].messageTime, null)
    assert.equal(result.favs[0].time, null)
    assert.equal(h.state.lastMsgAt.synthetic, 1600000000000)
    assert.equal(h.state.unreadTotals.synthetic.c, 2, 'timestamp failure does not suppress unread')
  })
}

test('ydx: serialized guest selects stable no-href chat identity despite identical titles', async () => {
  const first = listFixture('ydx', { badge: 7 })
  const second = listFixture('ydx', { badge: 2 }).children[0].children[0]
  const ids = ['0/0/00000000-0000-4000-8000-000000000001', '0/0/00000000-0000-4000-8000-000000000002']
  for (const [row, id] of [[first.children[0].children[0], ids[0]], [second, ids[1]]]) {
    row.__reactFiber$fixture = { stateNode: row, memoizedProps: {}, return: { memoizedProps: { chatId: id }, return: { type: 'div', memoizedProps: {} } } }
  }
  first.children[0].children.push(second)
  const h = unreadFixture('ydx', first)
  h.state.cfg.pinned[0].url = 'https://telemost.yandex.ru/chats/' + encodeURIComponent(ids[0])
  const result = await h.poll()
  assert.equal(result.favs[0].found, true)
  assert.equal(result.favs[0].count, 7, 'same title is not identity; no-href rows remain supported')
})

test('MAX: duplicate no-href titles remain unknown instead of overwriting cached metadata', async () => {
  const doc = listFixture('max', { badge: 7 })
  doc.children[0].children.push(listFixture('max', { badge: 2 }).children[0].children[0])
  const h = unreadFixture('max', doc)
  h.state.unreadTotals.synthetic = { c: 9, m: 0 }
  h.state.unreadTotalsAt.synthetic = 12345
  const result = await h.poll()
  assert.equal(result.favs[0].found, false)
  assert.equal(h.state.unreadTotals.synthetic.c, 9)
  assert.equal(h.state.unreadTotalsAt.synthetic, 12345)
})

test('ydx: unknown identity preserves cached rank as well as unread observation', async () => {
  const doc = listFixture('ydx', { badge: 2 })
  delete doc.children[0].children[0].__reactFiber$fixture
  const h = unreadFixture('ydx', doc)
  h.state.rankAct.synthetic = 3
  h.state.unreadTotals.synthetic = { c: 9, m: 0 }
  h.state.unreadTotalsAt.synthetic = 12345
  const result = await h.poll()
  assert.equal(result.favs[0].found, false)
  assert.equal(h.state.rankAct.synthetic, 3)
  assert.equal(h.state.unreadTotals.synthetic.c, 9)
  assert.equal(h.state.unreadTotalsAt.synthetic, 12345)
})

for (const scenario of ['missing', 'alternate-conflict', 'owner-conflict', 'duplicate-id', 'wrong-origin', 'bad-encoding', 'wrong-namespace', 'substring', 'wrong-owner']) {
  test(`ydx: generated guest rejects ${scenario} without title fallback or cache erasure`, async () => {
    const doc = listFixture('ydx', { badge: 2, preview: 'foreign preview' })
    const row = doc.children[0].children[0]
    const h = unreadFixture('ydx', doc)
    const fiber = row.__reactFiber$fixture
    if (scenario === 'missing') delete row.__reactFiber$fixture
    if (scenario === 'alternate-conflict') fiber.alternate = { stateNode: row, return: { memoizedProps: { chatId: '0/0/00000000-0000-4000-8000-000000000999' } } }
    if (scenario === 'owner-conflict') fiber.return.return = { memoizedProps: { chatId: '0/0/00000000-0000-4000-8000-000000000999' } }
    if (scenario === 'duplicate-id') doc.children[0].children.push(listFixture('ydx', { badge: 8 }).children[0].children[0])
    if (scenario === 'wrong-owner') fiber.stateNode = {}
    if (scenario === 'wrong-origin') h.state.cfg.pinned[0].url = h.state.cfg.pinned[0].url.replace('telemost.yandex.ru', 'evil.invalid')
    if (scenario === 'bad-encoding') h.state.cfg.pinned[0].url = 'https://telemost.yandex.ru/chats/%ZZ'
    if (scenario === 'wrong-namespace') h.state.cfg.pinned[0].url = 'https://telemost.yandex.ru/user/00000000-0000-4000-8000-000000000123'
    if (scenario === 'substring') h.state.cfg.pinned[0].url += '4'
    Object.assign(h.state, { unreadTotals: { synthetic: { c: 9, m: 1 } }, unreadTotalsAt: { synthetic: 12345 }, rankAct: { synthetic: 3 }, lastMsgAt: { synthetic: 12000 }, lastMsgPreview: { synthetic: 'cached preview' } })
    const result = await h.poll()
    assert.equal(result.favs[0].found, false)
    assert.equal(result.favs[0].preview, '')
    assert.equal(h.state.unreadTotals.synthetic.c, 9)
    assert.equal(h.state.unreadTotalsAt.synthetic, 12345)
    assert.equal(h.state.rankAct.synthetic, 3)
    assert.equal(h.state.lastMsgAt.synthetic, 12000)
    assert.equal(h.state.lastMsgPreview.synthetic, 'cached preview')
    assert.equal(h.state.pinAvatars.synthetic, 'already-cached')
  })
}

for (const reverse of [false, true]) test(`ydx: exact DM participant UUID works without title or href (reverse=${reverse})`, async () => {
  const self = '00000000-0000-4000-8000-000000000001', peer = '00000000-0000-4000-8000-000000000002'
  const doc = listFixture('ydx', { title: 'Renamed contact', badge: 4, chatId: (reverse ? [peer, self] : [self, peer]).join('_') })
  const h = unreadFixture('ydx', doc)
  h.state.cfg.pinned[0].url = 'https://telemost.yandex.ru/user/' + peer
  const result = await h.poll()
  assert.equal(result.favs[0].found, true)
  assert.equal(h.state.unreadTotals.synthetic.c, 4)
})

test('MAX: duplicate favorite titles cannot bind the one visible no-href row twice', async () => {
  const h = unreadFixture('max', listFixture('max', { badge: 4 }))
  const pin = h.state.cfg.pinned[0]
  const second = { ...pin, id: 'second', url: 'https://fixture.invalid/-124' }
  h.state.cfg.pinned.push(second)
  h.ctx.favoritesOf = () => h.state.cfg.pinned
  const result = await h.poll()
  assert.ok(result.favs.every(r => r.found === false))
  h.state.activePinId = pin.id
  h.state.unreadTotals[pin.id] = { c: 9, m: 0 }
  h.state.unreadTotalsAt[pin.id] = 12345
  await h.ctx.refreshSelectedUnread(pin.id)
  assert.equal(h.state.unreadTotals[pin.id].c, 9, 'single-pin priority request must not bypass duplicate favorite guard')
  assert.equal(h.state.unreadTotalsAt[pin.id], 12345)
})

for (const service of ['max', 'ydx']) {
  test(`${service}: serialized priority probe preserves absent row and clears confirmed read without scrolling`, async () => {
    const h = unreadFixture(service, listFixture(service, { badge: 7 }))
    await h.poll()
    h.state.activePinId = 'synthetic'
    h.guest.document = element('document')
    await h.ctx.refreshSelectedUnread('synthetic')
    assert.equal(h.state.unreadTotals.synthetic.c, 7)
    h.guest.document = listFixture(service, { badge: null })
    await h.ctx.refreshSelectedUnread('synthetic')
    assert.equal(h.state.unreadTotals.synthetic.c, 0)
    assert.equal(h.results.length, 3, 'real generated priority guests execute')
    assert.deepEqual(h.badges.at(-1), ['combined', 0, 0])
  })
  test(`${service}: absent virtualized row is found=false and preserves count/timestamp`, async () => {
    const h = unreadFixture(service, listFixture(service, { badge: 7 }))
    const present = await h.poll()
    assert.equal(present.favs[0].count, 7)
    assert.equal(h.state.unreadTotals.synthetic.c, 7)
    h.state.unreadTotalsAt.synthetic = 12345
    const prevUnread = h.state.prevUnread.synthetic
    h.guest.document = element('document')
    const absent = await h.poll()
    assert.equal(absent.favs[0].found, false)
    assert.equal(h.state.unreadTotals.synthetic.c, 7)
    assert.equal(h.state.unreadTotalsAt.synthetic, 12345)
    assert.equal(h.state.prevUnread.synthetic, prevUnread)
    assert.deepEqual(h.badges.at(-1), ['combined', 7, 0])
    h.guest.document = listFixture(service)
    const read = await h.poll()
    assert.equal(read.favs[0].found, true)
    assert.equal(h.state.unreadTotals.synthetic.c, 0, 'visible row without badge is a fresh zero')
    assert.notEqual(h.state.unreadTotalsAt.synthetic, 12345)
  })
}

for (const fixture of [
  { preview: '123', badge: null, heart: true, expected: 0 },
  { preview: '123', badge: 2, heart: true, expected: 2 },
  { preview: '123', badge: null, expected: 0 },
  { preview: '123', badge: 7, expected: 7 },
  { preview: '123456789012', badge: null, expected: 0 },
  { title: '123', preview: '', badge: null, expected: 0 },
  { preview: '', badge: 0, expected: 0 }
]) {
  test(`MAX badge-only count: ${JSON.stringify(fixture)}`, async () => {
    const h = unreadFixture('max', listFixture('max', fixture))
    const result = await h.poll()
    assert.equal(result.favs[0].count, fixture.expected)
    assert.equal(result.favs[0].unread, fixture.expected > 0)
    assert.equal(result.observedTotals.total, fixture.expected, 'nested badge spans count once; other numbers never count')
    if (!fixture.title) assert.equal(result.favs[0].preview, fixture.preview)
  })
}

// ---------- parseChatTime ----------
const pt = sandbox(['parseChatTime'])

test('parseChatTime: «10:24» — сегодняшние часы/минуты', () => {
  const r = pt.parseChatTime('10:24')
  const d = new Date(r.at)
  const n = new Date()
  assert.equal(r.dayOnly, false)
  assert.equal(d.getHours(), 10)
  assert.equal(d.getMinutes(), 24)
  assert.equal(d.getDate(), n.getDate())
})

test('parseChatTime: «вчера» — вчерашний день, отметка dayOnly', () => {
  const r = pt.parseChatTime('вчера')
  const d = new Date(r.at)
  const y = new Date(); y.setDate(y.getDate() - 1)
  assert.equal(r.dayOnly, true)
  assert.equal(d.getDate(), y.getDate())
})

test('parseChatTime: «пн» — прошлый понедельник, не сегодня', () => {
  const r = pt.parseChatTime('пн')
  const d = new Date(r.at)
  const n = new Date()
  assert.equal(r.dayOnly, true)
  assert.equal(d.getDay(), 1)
  assert.ok(r.at < n.getTime(), 'понедельник должен быть в прошлом')
})

test('parseChatTime: пустая строка → 0', () => {
  const r = pt.parseChatTime('')
  assert.equal(r.at, 0)
  assert.equal(r.dayOnly, false)
})

// ---------- fmtChatWhen ----------
const fw = sandbox(['fmtChatWhen'])

test('fmtChatWhen: дата+время в текущем году → ДД.ММ ЧЧ:ММ', () => {
  const y = new Date().getFullYear()
  const s = fw.fmtChatWhen(new Date(y, 10, 10, 9, 40, 0).getTime(), false)
  assert.equal(s, '10.11 09:40')
})

test('fmtChatWhen: dayOnly → только ДД.ММ', () => {
  const y = new Date().getFullYear()
  const s = fw.fmtChatWhen(new Date(y, 2, 5, 18, 7, 0).getTime(), true)
  assert.equal(s, '05.03')
})

test('fmtChatWhen: другой год → ДД.ММ.ГГ', () => {
  const s = fw.fmtChatWhen(new Date(2025, 2, 5, 18, 7, 0).getTime(), true)
  assert.equal(s, '05.03.25')
})

// ---------- badgeColor ----------
const bc = sandbox(['badgeColor'])

test('badgeColor: детерминированный hsl и различие имён', () => {
  const a1 = bc.badgeColor('Анна Петрова')
  const a2 = bc.badgeColor('Анна Петрова')
  const b = bc.badgeColor('Олег Смирнов')
  assert.equal(a1, a2)
  assert.notEqual(a1, b)
  const m = /^hsl\((\d+) 55% 42%\)$/.exec(a1)
  assert.ok(m, 'формат hsl(N 55% 42%)')
  assert.ok(Number(m[1]) >= 0 && Number(m[1]) < 360)
})

// ---------- escapeHtml ----------
const eh = sandbox([], {})
{
  const start = SRC.indexOf('const escapeHtml')
  const end = SRC.indexOf('\n))', start)
  if (start < 0 || end < 0) throw new Error('escapeHtml не найден в renderer.js')
  vm.runInContext(SRC.slice(start, end + 3) + '; globalThis.escapeHtml = escapeHtml;', eh)
}

test('escapeHtml: экранирует <>&"\'', () => {
  assert.equal(eh.escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  assert.equal(eh.escapeHtml(null), '')
})

// ---------- tgPidSafe ----------
const tp = sandbox(['tgPidSafe'])

test('tgPidSafe: pid из URL пина совпадает → true', () => {
  assert.equal(tp.tgPidSafe({ url: 'https://web.telegram.org/k/#-5064616793', title: 'X' }, '-5064616793', 'Y'), true)
})

test('tgPidSafe: @username-пин не принимает чужой pid', () => {
  assert.equal(tp.tgPidSafe({ url: 'https://web.telegram.org/k/#@zema152', title: 'Анна' }, '-999', 'Анна'), false)
})

test('tgPidSafe: совпадение по словам названия (≥4 симв., стоп-слова отброшены)', () => {
  assert.equal(tp.tgPidSafe({ url: 'https://web.telegram.org/k/', title: 'EXT | Метро | TM Profile' }, '-5', 'Метро — рабочий чат'), true)
  assert.equal(tp.tgPidSafe({ url: 'https://web.telegram.org/k/', title: 'EXT | Метро' }, '-5', 'Совсем другой чат'), false)
})

test('tgPidSafe: пустые аргументы → false', () => {
  assert.equal(tp.tgPidSafe(null, '-1', 'x'), false)
  assert.equal(tp.tgPidSafe({ url: '', title: '' }, '', 'x'), false)
})

// ---------- pinMatches ----------
const pm = sandbox(['pinMatches'], { URL })

test('pinMatches: MM — совпадение по origin/team/kind/slug', () => {
  const svc = { id: 'mm', url: 'https://im.astralinux.ru' }
  assert.equal(pm.pinMatches({ serviceId: 'mm', url: 'https://im.astralinux.ru/astralinux/channels/abc' }, svc, 'https://im.astralinux.ru/astralinux/channels/abc', ''), true)
  assert.equal(pm.pinMatches({ serviceId: 'mm', url: 'https://im.astralinux.ru/astralinux/channels/abc' }, svc, 'https://im.astralinux.ru/astralinux/channels/xyz', ''), false)
})

test('pinMatches: TG — совпадение по hash', () => {
  const svc = { id: 'tg', url: 'https://web.telegram.org/k/' }
  assert.equal(pm.pinMatches({ serviceId: 'tg', url: 'https://web.telegram.org/k/#@zema152' }, svc, 'https://web.telegram.org/k/#@zema152', ''), true)
  assert.equal(pm.pinMatches({ serviceId: 'tg', url: 'https://web.telegram.org/k/#@zema152' }, svc, 'https://web.telegram.org/k/#@other', ''), false)
})

test('pinMatches: чужой сервис → false; MAX deep-link по URL', () => {
  const svc = { id: 'max', url: 'https://web.max.ru/' }
  assert.equal(pm.pinMatches({ serviceId: 'tg', url: 'https://web.max.ru/-7672' }, svc, 'https://web.max.ru/-7672', ''), false)
  assert.equal(pm.pinMatches({ serviceId: 'max', url: 'https://web.max.ru/-76728609770887' }, svc, 'https://web.max.ru/-76728609770887', ''), true)
  assert.equal(pm.pinMatches({ serviceId: 'max', url: 'https://web.max.ru/-1111' }, svc, 'https://web.max.ru/-2222', ''), false)
})

// ---------- maxLiveViews ----------
test('maxLiveViews: значение из конфига, дефолт 8, мусор → 8', () => {
  const c1 = sandbox(['maxLiveViews'], { state: { cfg: { maxLiveViews: '5' } } })
  assert.equal(c1.maxLiveViews(), 5)
  const c2 = sandbox(['maxLiveViews'], { state: { cfg: {} } })
  assert.equal(c2.maxLiveViews(), 8)
  const c3 = sandbox(['maxLiveViews'], { state: { cfg: { maxLiveViews: 'abc' } } })
  assert.equal(c3.maxLiveViews(), 8)
  const c4 = sandbox(['maxLiveViews'], { state: { cfg: { maxLiveViews: '0' } } })
  assert.equal(c4.maxLiveViews(), 8)
})

// ---------- unreadDeltaFor ----------
test('unreadDeltaFor: прирост новых сообщений от сохранённой базы', () => {
  const c = sandbox(['unreadDeltaFor'], { state: { unreadBaseC: { chat1: 5 }, unreadBaseM: { chat1: 1 } } })
  assert.deepEqual(JSON.parse(JSON.stringify(c.unreadDeltaFor('chat1', 9, 2))), { dC: 4, dM: 1, dU: true })
})

test('unreadDeltaFor: без базы первый замер не считается новым', () => {
  const c = sandbox(['unreadDeltaFor'], { state: { unreadBaseC: {}, unreadBaseM: {} } })
  assert.deepEqual(JSON.parse(JSON.stringify(c.unreadDeltaFor('chat1', 9, 2))), { dC: 0, dM: 0, dU: false })
})

test('unreadDeltaFor: уменьшение запаса не даёт отрицательной дельты', () => {
  const c = sandbox(['unreadDeltaFor'], { state: { unreadBaseC: { chat1: 10 }, unreadBaseM: { chat1: 3 } } })
  assert.deepEqual(JSON.parse(JSON.stringify(c.unreadDeltaFor('chat1', 4, 0))), { dC: 0, dM: 0, dU: false })
})

// ---------- shouldBumpLiveAct ----------
test('shouldBumpLiveAct: старый чат с ростом непрочитанных не поднимается', () => {
  const c = sandbox(['shouldBumpLiveAct'])
  assert.equal(c.shouldBumpLiveAct(0, 5, 1000, 1000), false)
})

test('shouldBumpLiveAct: новое сообщение с ростом времени поднимает', () => {
  const c = sandbox(['shouldBumpLiveAct'])
  assert.equal(c.shouldBumpLiveAct(0, 5, 1000, 2000), true)
})

// ---------- isUsernameFallbackName ----------
test('isUsernameFallbackName: username-фолбэк не считается именем чата', () => {
  const c = sandbox(['isUsernameFallbackName'])
  assert.equal(c.isUsernameFallbackName('https://web.telegram.org/k/#@Astra_lin', 'Astra lin'), true)
  assert.equal(c.isUsernameFallbackName('https://web.telegram.org/k/#@Astra_lin', 'Астра Кам Александр Абдурахимов'), false)
  assert.equal(c.isUsernameFallbackName('https://web.telegram.org/k/#-123', 'Astra lin'), false)
})

// ---------- shouldAutoRenameTitle ----------
test('shouldAutoRenameTitle: пользовательское название TG не перезаписывается', () => {
  const c = sandbox(['shouldAutoRenameTitle', 'isUsernameFallbackName'])
  assert.equal(c.shouldAutoRenameTitle('tg', 'Astra Linux', 'https://web.telegram.org/k/#@Astra_lin'), false)
  assert.equal(c.shouldAutoRenameTitle('tg', 'Astra lin', 'https://web.telegram.org/k/#@Astra_lin'), true)
  assert.equal(c.shouldAutoRenameTitle('mm', 'Любое', 'https://im.astralinux.ru/astralinux/channels/x'), true)
})

// ---------- formatMaxPreview ----------
test('formatMaxPreview: отдельный span.author становится префиксом', () => {
  const c = sandbox(['formatMaxPreview'])
  assert.equal(c.formatMaxPreview('Илья М:   привет всем', 'Илья М:'), 'Илья М: привет всем')
})

test('formatMaxPreview: автор вшит в текст — нормализуется', () => {
  const c = sandbox(['formatMaxPreview'])
  assert.equal(c.formatMaxPreview('Любовь:   Здравствуйте', ''), 'Любовь: Здравствуйте')
})

test('formatMaxPreview: URL не считается автором', () => {
  const c = sandbox(['formatMaxPreview'])
  assert.equal(c.formatMaxPreview('https://example.com/page', ''), 'https://example.com/page')
})

test('parseChatTime: «10 нояб.» — ноябрь текущего года, не декабрь прошлого', () => {
  const r = pt.parseChatTime('10 нояб.')
  const d = new Date(r.at)
  assert.equal(d.getMonth(), 10)
  assert.equal(d.getDate(), 10)
})

test('parseChatTime: «10 дек.» — декабрь прошлого года, а не январь', () => {
  const r = pt.parseChatTime('10 дек.')
  const d = new Date(r.at)
  assert.equal(d.getMonth(), 11)
  assert.equal(d.getDate(), 10)
})

test('parseChatTime: «10 мая» — май, без сдвига месяцев', () => {
  const r = pt.parseChatTime('10 мая')
  const d = new Date(r.at)
  assert.equal(d.getMonth(), 4)
  assert.equal(d.getDate(), 10)
})

test('new MM favourite sorts by authoritative last post without restart', async () => {
  const older = { id: 'older', serviceId: 'mm', title: 'Older', url: 'https://fixture.invalid/team/messages/@older' }
  const state = { cfg: { services: [{ id: 'mm', url: 'https://fixture.invalid' }], pinned: [older] },
    svcViews: {}, pinViews: {}, rankAct: {}, lastMsgAt: { older: 100 }, lastUsed: {} }
  const calls = [], rendered = []
  const view = { getURL: () => 'https://fixture.invalid/team/messages/@new', executeJavaScript: async () => 'https://fixture.invalid/team/messages/@new' }
  state.svcViews.mm = view
  const ctx = sandbox(['pinKeyOf', 'sortFavoritesByActivity', 'pinCurrentChat'], {
    state, Date, document: { querySelector: () => null },
    window: { hub: { saveConfig: async () => {} } },
    getChatNameFor: async () => 'New', updateSvcBar() {}, toast() {},
    renderChatList: () => rendered.push(true),
    mmLastPosts: async id => { calls.push(id); state.lastMsgAt[id] = 200 },
    refreshUnreadPresentation() {}
  })
  await ctx.pinCurrentChat({ id: 'mm', url: 'https://fixture.invalid' })
  assert.equal(calls.length, 1)
  assert.equal(state.cfg.pinned[0].title, 'New')
  assert.equal(state.cfg.pinned[0].serviceId, 'mm')
  assert.ok(rendered.length)
})

test('source label visibility is configurable independently of service icons', () => {
  const toggles = {}
  const state = { cfg: { badgeVisible: true, svcBadgeVisible: true, favBadgeAlways: false, svcNameVisible: false } }
  const ctx = sandbox(['applyBadgeVisibility'], {
    state,
    document: { body: { classList: { toggle(name, value) { toggles[name] = value } } } }
  })
  ctx.applyBadgeVisibility()
  assert.equal(toggles['hide-chat-source'], true)
  assert.equal(toggles['hide-svc-badge'], false)
  state.cfg.svcNameVisible = true
  ctx.applyBadgeVisibility()
  assert.equal(toggles['hide-chat-source'], false)
})
