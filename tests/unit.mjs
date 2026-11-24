// tests/unit.mjs — юнит-тесты чистых функций renderer.js.
// Функции извлекаются из renderer.js по исходнику (brace-matching) и исполняются
// в vm-контексте: тестируем РЕАЛЬНЫЙ код, не копию. Запуск: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { element, listFixture, ydxIdentity } from './synthetic-dom.mjs'
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
  const body = SRC.slice(m.index, j + 1)
  // Явная привязка к window сразу после объявления — часть контракта renderer.js:
  // main вызывает сборщик строкой через window. Грузим привязку вместе с функцией,
  // иначе харнесс тестировал бы не тот путь вызова, что в приложении.
  // Комментарии между объявлением и привязкой допустимы.
  const bindRe = new RegExp('^(?:\\s*//[^\\n]*\\n)*\\s*if \\(typeof window !== \'undefined\'\\) window\\.' + name + ' = ' + name + '\\b')
  const bind = bindRe.exec(SRC.slice(j + 1))
  return bind ? body + '\n' + bind[0].trim() : body
}
function sandbox(names, extra = {}) {
  const ctx = { Date, Math, JSON, String, Number, parseInt, parseFloat, RegExp, console, ...extra }
  // window — отдельный объект, как в renderer.js, загруженном модулем: объявления
  // верхнего уровня сами на него не попадают. Тест видит только явную привязку.
  // Если тест передал собственный window (MCP-панель) — не подменяем его.
  if (!ctx.window) ctx.window = {}
  vm.createContext(ctx)
  for (const n of names) {
    // A helper may not exist yet (e.g. a regression test written before its
    // production seam): its absence then surfaces as a behavioural assertion
    // failure instead of a fixture setup crash.
    let source
    try { source = extractFunction(n) } catch (e) { continue }
    vm.runInContext(source, ctx)
  }
  return ctx
}

test('taskbar badge mirrors unread only in favourites and clears at zero', () => {
  const calls = [], combined = []
  const state = {
    cfg: { pinned: [{ id: 'numbered' }, { id: 'dot' }, { id: 'none' }], services: [] },
    unreadTotals: { numbered: { c: 3, m: 2 }, dot: { c: 0, m: 0 } },
    unreadDots: { dot: true }
  }
  const ctx = sandbox(['refreshUnreadPresentation'], {
    state,
    navigator: {
      setAppBadge(value) { calls.push(['set', value]); return Promise.resolve() },
      clearAppBadge() { calls.push(['clear']); return Promise.resolve() }
    },
    document: { querySelector() { return null } },
    updateBadge2(id, total, mentions) { combined.push([id, total, mentions]) },
    sortFavoritesByActivity() {}, scheduleActSave() {}
  })
  ctx.refreshUnreadPresentation()
  assert.deepEqual(combined, [['combined', 4, 2]])
  assert.deepEqual(calls, [['set', 4]])
  state.unreadTotals = {}
  state.unreadDots = {}
  ctx.refreshUnreadPresentation()
  assert.deepEqual(calls, [['set', 4], ['clear']])
})

test('service favicons accept only raster data URLs and never enter an HTML sink', async () => {
  const icon = { textContent: '', child: null, appendChild(node) { this.child = node } }
  Object.defineProperty(icon, 'innerHTML', { set() { throw Error('HTML sink must not receive a guest favicon') } })
  const tab = { dataset: { tab: 'svc:mm' }, querySelector(selector) { return selector === '.tab-icon' ? icon : null } }
  const state = { cfg: { services: [{ id: 'mm', name: 'Mattermost' }] }, svcIcons: { mm: 'data:image/png;base64,AAAA' } }
  const ctx = sandbox(['isSafeSvcIconDataUrl', 'refreshTabIcons', 'captureSvcIcon'], {
    state,
    document: { querySelectorAll() { return [tab] }, createElement() { return { alt: '', src: '' } } },
    renderChatList() {}, refreshTabIcons() {}
  })
  ctx.refreshTabIcons()
  assert.equal(icon.child.src, 'data:image/png;base64,AAAA')
  state.svcIcons.mm = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
  icon.child = null
  ctx.refreshTabIcons()
  assert.equal(icon.child, null)
  assert.equal(icon.textContent, 'M')
  delete state.svcIcons.mm
  await ctx.captureSvcIcon('mm', { executeJavaScript: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })
  assert.equal(state.svcIcons.mm, undefined)
})

test('return-to-origin controls are shared by every messenger and pin without Telemost-only diagnostics', () => {
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  assert.match(SRC, /class="btn return-service"/)
  assert.match(SRC, /id="vh-return"/)
  assert.doesNotMatch(SRC, /ChatHubServiceHealth\.attach/)
  assert.doesNotMatch(html, /service-health\.js/)
})

test('return-to-origin waits for a reload finish and rejects failed navigation', async () => {
  const ctx = sandbox(['sameViewUrl', 'waitForViewReload', 'reloadOriginalView'], { URL, setTimeout, clearTimeout })
  const origin = 'https://im.astralinux.ru/astralinux/channels/general'
  const reloads = []
  const reloadEvents = new Map()
  const alreadyOpen = {
    getURL() { return origin },
    addEventListener(name, fn) { reloadEvents.set(name, fn) },
    removeEventListener(name, fn) { if (reloadEvents.get(name) === fn) reloadEvents.delete(name) },
    reload() { reloads.push('reload'); queueMicrotask(() => reloadEvents.get('did-finish-load')?.({ isMainFrame: true })) }
  }
  assert.equal(await ctx.reloadOriginalView(alreadyOpen, origin), true)
  assert.deepEqual(reloads, ['reload'])

  const failedEvents = new Map()
  const failedReload = {
    getURL() { return origin },
    addEventListener(name, fn) { failedEvents.set(name, fn) },
    removeEventListener(name, fn) { if (failedEvents.get(name) === fn) failedEvents.delete(name) },
    reload() { queueMicrotask(() => failedEvents.get('did-fail-load')?.({ isMainFrame: true, errorCode: -105 })) }
  }
  assert.equal(await ctx.reloadOriginalView(failedReload, origin), false)

  let finish
  const navigation = new Promise(resolve => { finish = resolve })
  const loads = [], navigationEvents = new Map()
  const newTarget = {
    getURL() { return 'https://im.astralinux.ru/astralinux/channels/other' },
    addEventListener(name, fn) { navigationEvents.set(name, fn) },
    removeEventListener(name, fn) { if (navigationEvents.get(name) === fn) navigationEvents.delete(name) },
    loadURL(url) { loads.push(url); return navigation }
  }
  let settled = false
  const pending = ctx.reloadOriginalView(newTarget, origin).then(result => { settled = true; return result })
  await Promise.resolve()
  assert.equal(settled, false)
  navigationEvents.get('did-finish-load')?.({ isMainFrame: true })
  finish()
  assert.equal(await pending, true)
  assert.deepEqual(loads, [origin])

  let current = 'https://im.astralinux.ru/astralinux/channels/other'
  const rejected = { getURL() { return current }, loadURL() { current = origin; return Promise.reject(new Error('blocked')) } }
  assert.equal(await ctx.reloadOriginalView(rejected, origin), false)
})

test('return-to-origin needs a main-frame load finish and has a deadline for a new target', async () => {
  const ctx = sandbox(['sameViewUrl', 'waitForViewReload', 'reloadOriginalView'], {
    URL,
    setTimeout(fn) { queueMicrotask(fn); return 1 },
    clearTimeout() {}
  })
  const origin = 'https://im.astralinux.ru/astralinux/channels/general'
  const events = new Map()
  const stalled = {
    getURL() { return 'https://im.astralinux.ru/astralinux/channels/other' },
    addEventListener(name, fn) { events.set(name, fn) },
    removeEventListener(name, fn) { if (events.get(name) === fn) events.delete(name) },
    loadURL() { return new Promise(() => {}) }
  }
  const result = await Promise.race([
    ctx.reloadOriginalView(stalled, origin),
    new Promise(resolve => globalThis.setTimeout(() => resolve('outside-deadline'), 50))
  ])
  assert.equal(result, false)
})

test('return-to-origin accepts a verified main-frame hash navigation to its requested URL', async () => {
  const ctx = sandbox(['sameViewUrl', 'waitForViewReload', 'reloadOriginalView'], {
    URL,
    setTimeout() { return 1 },
    clearTimeout() {}
  })
  const target = 'https://web.telegram.org/k/#target'
  let current = 'https://web.telegram.org/k/#other'
  const events = new Map()
  const view = {
    getURL() { return current },
    addEventListener(name, fn) { events.set(name, fn) },
    removeEventListener(name, fn) { if (events.get(name) === fn) events.delete(name) },
    loadURL(url) {
      current = url
      queueMicrotask(() => events.get('did-navigate-in-page')?.({ isMainFrame: true, url }))
      return new Promise(() => {})
    }
  }
  const result = await Promise.race([
    ctx.reloadOriginalView(view, target),
    new Promise(resolve => globalThis.setTimeout(() => resolve('outside-deadline'), 50))
  ])
  assert.equal(result, true)
})

test('return-to-origin actions use the saved service and pinned-chat URLs', async () => {
  const calls = [], notices = []
  const view = kind => {
    const events = new Map()
    return {
      getURL() { return '' },
      addEventListener(name, fn) { events.set(name, fn) },
      removeEventListener(name, fn) { if (events.get(name) === fn) events.delete(name) },
      loadURL(url) {
        calls.push([kind, url])
        queueMicrotask(() => events.get('did-finish-load')?.({ isMainFrame: true }))
        return Promise.resolve()
      }
    }
  }
  const state = { svcViews: { mm: view('service') }, pinViews: { p1: view('pin') } }
  const ctx = sandbox(['sameViewUrl', 'waitForViewReload', 'reloadOriginalView', 'returnServiceToOrigin', 'returnPinToOrigin'], { URL, setTimeout, clearTimeout, state, toast: message => notices.push(message) })
  assert.equal(await ctx.returnServiceToOrigin({ id: 'mm', url: 'https://im.astralinux.ru/astralinux' }), true)
  assert.equal(await ctx.returnPinToOrigin({ id: 'p1', url: 'https://web.telegram.org/k/#chat' }), true)
  assert.deepEqual(calls, [['service', 'https://im.astralinux.ru/astralinux'], ['pin', 'https://web.telegram.org/k/#chat']])
  assert.equal(notices.length, 2)
})

test('partial messenger totals are shown as lower bounds and an exact zero clears the tab', () => {
  const classes = () => {
    const values = new Set()
    return { toggle(name, on) { if (on) values.add(name); else values.delete(name) }, add(name) { values.add(name) }, remove(name) { values.delete(name) }, has(name) { return values.has(name) } }
  }
  const mention = { textContent: '', title: '', classList: classes() }
  const badge = { textContent: '', title: '', classList: classes(), parentElement: { querySelector() { return mention } } }
  const ctx = sandbox(['tabBadgeTotal', 'updateBadge2'], { document: { querySelector() { return badge } } })
  const observed = ctx.tabBadgeTotal({ observedTotals: { total: 26, mentions: 0 }, coverage: { complete: false } })
  assert.equal(JSON.stringify(observed), JSON.stringify({ t: 26, m: 0, partial: true }))
  assert.equal(ctx.tabBadgeTotal({ observedTotals: { total: 0, mentions: 0 }, coverage: { complete: false } }), null)
  assert.equal(JSON.stringify(ctx.tabBadgeTotal({ svcTotals: { total: 0, mentions: 0 } })), JSON.stringify({ t: 0, m: 0, partial: false }))
  ctx.updateBadge2('max', observed.t, observed.m, observed.partial)
  assert.equal(badge.textContent, '26+')
  assert.equal(badge.title, 'Не менее 26 непрочитанных')
  ctx.updateBadge2('max', 0, 0, false)
  assert.equal(badge.textContent, '')
})

test('MAX partial total omits ambiguous same-title virtual rows', async () => {
  const item = (name, count) => ({
    cloneNode() { return this },
    querySelector(selector) {
      if (selector === 'span.name' || selector === 'h3.title') return { textContent: name }
      return null
    },
    querySelectorAll(selector) { return selector === '.indicator' ? [{ textContent: String(count) }] : [] }
  })
  const first = item('Одинаковое имя', 4)
  const second = item('Одинаковое имя', 100)
  const recycledSecond = item('Одинаковое имя', 100)
  const ctx = sandbox(['__chatHubMaxUnread'], {
    document: { querySelectorAll(selector) { return selector === 'aside div.item' ? [first, second] : [] } },
    __chatHubScanRows: async collect => [...collect(), { key: 'recycled', el: recycledSecond }],
    __chatHubBoundedAvatar: async () => null,
    formatMaxPreview: () => ''
  })
  const out = JSON.parse(await ctx.__chatHubMaxUnread([], true))
  assert.equal(out.observedTotals.total, 0)
})

test('MAX cross-window same-title rows remain ambiguous instead of overwriting the first virtual observation', async () => {
  let phase = 0
  const item = (count, preview) => ({
    cloneNode() { return this },
    getBoundingClientRect() { return { width: 120, height: 42 } },
    querySelector(selector) {
      if (selector === 'span.name' || selector === 'h3.title') return { textContent: 'Same title' }
      if (selector === 'span.text.svelte-q2jdqb') return { textContent: preview }
      return null
    },
    querySelectorAll(selector) { return selector === '.indicator' ? [{ textContent: String(count) }] : [] }
  })
  const first = item(7, 'first window'), second = item(0, 'second window')
  const ctx = sandbox(['__chatHubMaxUnread'], {
    document: { querySelectorAll(selector) { return selector === 'aside div.item' ? [phase ? second : first] : [] } },
    __chatHubScanRows: async collect => {
      const rows = new Map()
      for (const row of collect()) rows.set(row.key, row)
      phase = 1
      for (const row of collect()) rows.set(row.key, row)
      return [...rows.values()]
    },
    __chatHubBoundedAvatar: async () => null,
    formatMaxPreview: () => ''
  })
  const out = JSON.parse(await ctx.__chatHubMaxUnread([{ id: 'same', title: 'Same title' }], true))
  assert.equal(out.favs[0].found, false)
})

test('MAX rounded and unsafe badge labels remain unknown rather than a verified read state', async () => {
  const run = async badge => {
    const row = {
      cloneNode() { return this },
      getBoundingClientRect() { return { width: 120, height: 42 } },
      querySelector(selector) {
        if (selector === 'span.name' || selector === 'h3.title') return { textContent: 'MAX room' }
        return null
      },
      querySelectorAll(selector) { return selector === '.indicator' ? [{ textContent: badge }] : [] }
    }
    const ctx = sandbox(['__chatHubMaxUnread'], {
      document: { querySelectorAll(selector) { return selector === 'aside div.item' ? [row] : [] } },
      __chatHubScanRows: async collect => collect(), __chatHubBoundedAvatar: async () => null, formatMaxPreview: () => ''
    })
    return JSON.parse(await ctx.__chatHubMaxUnread([{ id: 'max-room', title: 'MAX room' }], false))
  }
  for (const badge of ['1.2K', '99+', '9007199254740995']) {
    const out = await run(badge)
    assert.equal(out.favs[0].found, false, badge)
    assert.equal(out.observedTotals.total, 0, badge)
  }
})

test('Telegram lower-bound total deduplicates peers and omits rounded K badges', async () => {
  const row = (peerId, unread) => ({
    getAttribute(name) { return name === 'data-peer-id' ? peerId : name === 'href' ? '#' + peerId : '' },
    getBoundingClientRect() { return { width: 120, height: 42 } },
    querySelector(selector) {
      if (selector === '.peer-title') return { textContent: 'Чат ' + peerId, getAttribute() { return peerId } }
      if (selector === '.dialog-subtitle-badge-unread') return { textContent: unread, className: 'badge' }
      return null
    }
  })
  const rows = [row('1', '1.2K'), row('1', '1.2K'), row('2', '7')]
  const document = {
    querySelectorAll(selector) { return selector === 'a.row-clickable[href^="#"]' ? rows : [] },
    querySelector() { return null }
  }
  const ctx = sandbox(['__chatHubTgUnread'], {
    URL, document, window: {}, getComputedStyle: () => ({ backgroundColor: 'rgb(112,117,121)' }),
    __chatHubScanRows: async collect => collect()
  })
  const out = JSON.parse(await ctx.__chatHubTgUnread([], false))
  assert.equal(out.observedTotals.total, 7)
})

test('renderer contains no Telegram background-search or trusted-input remnants', () => {
  const forbidden = [
    /\btgBackgroundIndex\b/, /\btgSearchResolve\b/, /\btgEnsureClean\b/,
    /\btgSelectFolder\b/, /\btgScrollLoad\b/, /\btgSearch[A-Za-z0-9_]*\b/,
    /\btgBusyAt\b/, /\btgScroll[A-Za-z0-9_]*\b/, /\btgSearchedAt\b/,
    /\btrustedClick\b/, /\btrustedText\b/, /\btrustedKey\b/, /\btrustedWheel\b/,
    /\bevT\b/, /tg-bg-index/, /Даты сообщений Telegram/
  ]
  for (const pattern of forbidden) assert.equal(pattern.test(SRC), false, String(pattern))
})

test('Telemost lower-bound total omits conflicting duplicate IDs and non-integer labels', async () => {
  const run = async rows => {
    const ctx = sandbox(['__chatHubYdxUnread'], {
      URL, document: { querySelectorAll(selector) { return selector === '.yamb-chat-list-item' ? rows : [] } },
      __chatHubScanRows: async collect => collect(), __chatHubBoundedAvatar: async () => null
    })
    return JSON.parse(await ctx.__chatHubYdxUnread([], false)).observedTotals.total
  }
  const row = (badge, suffix = '000000000123') => {
    const chatId = '0/0/00000000-0000-4000-8000-' + suffix
    const root = listFixture('ydx', { badge, chatId })
    return ydxIdentity(root.children[0].children[0], chatId)
  }
  assert.equal(await run([row(7), row(0)]), 0)
  assert.equal(await run([row(0), row(7)]), 0)
  assert.equal(await run([row('1.2K', '000000000124')]), 0)
  assert.equal(await run([row('2 unread 3', '000000000125')]), 0)
})

test('lower-bound totals ignore hidden stale rows in MAX, Telegram and Telemost', async () => {
  const maxItem = (count, hidden) => ({
    hidden,
    cloneNode() { return this },
    getBoundingClientRect() { return { width: 120, height: 42 } },
    querySelector(selector) { return selector === 'span.name' ? { textContent: 'MAX' } : null },
    querySelectorAll(selector) { return selector === '.indicator' ? [{ textContent: String(count) }] : [] }
  })
  const maxRows = [maxItem(7, true), maxItem(0, false)]
  const max = sandbox(['__chatHubMaxUnread'], {
    document: { querySelectorAll(selector) { return selector === 'aside div.item' ? maxRows : [] } },
    getComputedStyle: row => ({ display: 'block', visibility: row.hidden ? 'hidden' : 'visible' }),
    __chatHubScanRows: async collect => collect(), __chatHubBoundedAvatar: async () => null, formatMaxPreview: () => ''
  })
  assert.equal(JSON.parse(await max.__chatHubMaxUnread([], false)).observedTotals.total, 0)

  const tgRow = (peerId, count, hidden) => ({
    hidden,
    getAttribute(name) { return name === 'data-peer-id' ? peerId : name === 'href' ? '#' + peerId : '' },
    getBoundingClientRect() { return { width: 120, height: 42 } },
    querySelector(selector) {
      if (selector === '.peer-title') return { textContent: 'TG ' + peerId, getAttribute() { return peerId } }
      if (selector === '.dialog-subtitle-badge-unread') return { textContent: String(count), className: 'badge' }
      return null
    }
  })
  const tgRows = [tgRow('1', 7, true), tgRow('2', 0, false)]
  const tg = sandbox(['__chatHubTgUnread'], {
    URL, document: { querySelectorAll(selector) { return selector === 'a.row-clickable[href^="#"]' ? tgRows : [] }, querySelector() { return null } }, window: {},
    getComputedStyle: row => ({ display: 'block', visibility: row.hidden ? 'hidden' : 'visible', backgroundColor: 'rgb(112,117,121)' }),
    __chatHubScanRows: async collect => collect()
  })
  assert.equal(JSON.parse(await tg.__chatHubTgUnread([], false)).observedTotals.total, 0)

  const ydxRow = (count, hidden) => {
    const root = listFixture('ydx', { badge: count, chatId: '0/0/00000000-0000-4000-8000-' + String(count).padStart(12, '0') })
    const value = ydxIdentity(root.children[0].children[0], '0/0/00000000-0000-4000-8000-' + String(count).padStart(12, '0'))
    value.hidden = hidden
    return value
  }
  const ydxRows = [ydxRow(7, true), ydxRow(0, false)]
  const ydx = sandbox(['__chatHubYdxUnread'], {
    URL, document: { querySelectorAll(selector) { return selector === '.yamb-chat-list-item' ? ydxRows : [] } },
    getComputedStyle: row => ({ display: 'block', visibility: row.hidden ? 'hidden' : 'visible' }),
    __chatHubScanRows: async collect => collect(), __chatHubBoundedAvatar: async () => null
  })
  assert.equal(JSON.parse(await ydx.__chatHubYdxUnread([], false)).observedTotals.total, 0)
})

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
    focus() { this.focusCalls = (this.focusCalls || 0) + 1 }
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
  const ctx = sandbox(['init', 'saveConfig', 'queueConfigSave', 'cloneConfigForSave', 'activateTab', 'buildSection', 'initialSvcUrl',
    'renderChatList', 'syncChatSelection', 'enqueueLoad', 'pumpPreload', 'openInServiceTab'], {
    state, document,
    window: { hub: { getConfig: async () => ({ services, pinned, selectedPinId: pinned[0].id }), saveConfig: async () => {} } },
    ensureKeys: noop, sortFavoritesByActivity: noop, buildTabs: noop, applyTheme: noop, applyLayout: noop,
    applyBadgeVisibility: noop, applyFavouriteDensity: noop, refreshTabIcons: noop, refreshUnreadPresentation: noop, initListSplitter: noop,
    badgeColor: () => '#000', captureSvcIcon: noop, updateSvcBar: noop,
    makeChatRow: () => new Element('div'), applyFavFilter: noop, trimPinViews: noop,
    ensurePinView: () => assert.fail('startup must not preload pin views'),
    selectChat: () => assert.fail('startup must not auto-select a chat'),
    queueSelectedUnread: async id => { readRefreshes.push(id) },
    setInterval(fn, delay) { intervals.push({ fn, delay }) },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) }
  })
  if (SRC.includes('async function tgSearchResolve(')) {
    ctx.tgSearchBusy = false
    ctx.tgBusyAt = 0
  }
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

test('favourite annotation is visible, searchable and persists from the row menu', async () => {
  const h = startupSandbox(true)
  vm.runInContext(extractFunction('applyFavFilter'), h.ctx)
  await h.ctx.init()
  const pin = h.state.cfg.pinned.find(p => p.id === 'pin-mm')
  pin.title = 'Филипп Асанов'
  pin.annotation = 'Инженер'
  const saved = []
  h.ctx.window.hub.saveConfig = async cfg => { saved.push(structuredClone(cfg)) }
  h.ctx.showAnnotationDialog = async () => 'Руководитель'
  h.ctx.renderChatList()
  let row = h.ctx.document.querySelectorAll('.chat-row').find(r => r.dataset.pin === pin.id)
  assert.equal(row.querySelector('.chat-row-title').textContent, 'Филипп Асанов')
  assert.equal(row.querySelector('.chat-row-comment').textContent, '(Инженер)')
  h.state.favQuery = 'инженер'
  h.ctx.applyFavFilter()
  assert.equal(row.classList.contains('filtered-out'), false)
  h.ctx.closeAllRowMenus = () => {}
  const comment = row.querySelector('.row-menu').querySelector('[data-act="annotation"]')
  assert.equal(typeof comment.onclick, 'function')
  await comment.onclick()
  assert.equal(pin.annotation, 'Руководитель')
  assert.equal(saved.length, 1)
  row = h.ctx.document.querySelectorAll('.chat-row').find(r => r.dataset.pin === pin.id)
  assert.equal(row.querySelector('.chat-row-title').textContent, 'Филипп Асанов')
  assert.equal(row.querySelector('.chat-row-comment').textContent, '(Руководитель)')
})

test('failed favourite annotation saves restore the prior local annotation', async () => {
  for (const entered of ['Руководитель', '']) {
    const h = startupSandbox(true)
    await h.ctx.init()
    const pin = h.state.cfg.pinned.find(p => p.id === 'pin-mm')
    pin.title = 'Филипп Асанов'
    pin.annotation = 'Инженер'
    h.ctx.window.hub.saveConfig = async () => { throw Error('save rejected') }
    h.ctx.showAnnotationDialog = async () => entered
    h.ctx.renderChatList()
    const row = h.ctx.document.querySelectorAll('.chat-row').find(r => r.dataset.pin === pin.id)
    h.ctx.closeAllRowMenus = () => {}
    const comment = row.querySelector('.row-menu').querySelector('[data-act="annotation"]')
    assert.equal(typeof comment.onclick, 'function')
    await comment.onclick()
    assert.equal(pin.annotation, 'Инженер', 'failed save must not change memory for ' + JSON.stringify(entered))
    const restored = h.ctx.document.querySelectorAll('.chat-row').find(r => r.dataset.pin === pin.id)
    assert.equal(restored.querySelector('.chat-row-title').textContent, 'Филипп Асанов')
    assert.equal(restored.querySelector('.chat-row-comment').textContent, '(Инженер)')
  }
})

test('annotation save serializes subsequent full-config writes after rollback', async () => {
  const h = startupSandbox(true)
  let rejectFirst
  const writes = []
  h.ctx.window.hub.saveConfig = cfg => {
    writes.push(structuredClone(cfg))
    if (writes.length === 1) return new Promise((resolve, reject) => { rejectFirst = reject })
    return Promise.resolve()
  }
  Object.freeze(h.ctx.window.hub)
  await h.ctx.init()
  const pin = h.state.cfg.pinned.find(p => p.id === 'pin-mm')
  pin.title = 'Филипп Асанов'
  pin.annotation = 'Инженер'
  let prompts = 0
  h.ctx.showAnnotationDialog = async () => { prompts++; return 'Руководитель' }
  h.ctx.closeAllRowMenus = () => {}
  h.ctx.renderChatList()
  const row = h.ctx.document.querySelectorAll('.chat-row').find(r => r.dataset.pin === pin.id)
  const comment = row.querySelector('.row-menu').querySelector('[data-act="annotation"]')
  const first = comment.onclick()
  for (let i = 0; i < 10 && !rejectFirst; i++) await Promise.resolve()
  assert.equal(typeof rejectFirst, 'function')
  const unrelated = h.ctx.saveConfig(h.state.cfg)
  rejectFirst(Error('save rejected'))
  await first
  await unrelated
  assert.equal(prompts, 1)
  assert.equal(writes.length, 2)
  assert.equal(writes[0].pinned.find(item => item.id === pin.id).annotation, 'Руководитель')
  assert.equal(writes[1].pinned.find(item => item.id === pin.id).annotation, 'Инженер', 'later saves must observe the rollback')
  assert.equal(pin.annotation, 'Инженер')
})

test('annotation prompt failure leaves the favourite untouched', async () => {
  const h = startupSandbox(true)
  await h.ctx.init()
  const pin = h.state.cfg.pinned.find(p => p.id === 'pin-mm')
  pin.title = 'Филипп Асанов'
  pin.annotation = 'Инженер'
  const notices = []
  h.ctx.window.hub.saveConfig = async () => { throw Error('must not save') }
  h.ctx.showAnnotationDialog = async () => { throw Error('dialog unavailable') }
  h.ctx.toast = message => notices.push(message)
  h.ctx.closeAllRowMenus = () => {}
  h.ctx.renderChatList()
  const row = h.ctx.document.querySelectorAll('.chat-row').find(r => r.dataset.pin === pin.id)
  const comment = row.querySelector('.row-menu').querySelector('[data-act="annotation"]')
  await comment.onclick()
  assert.equal(pin.annotation, 'Инженер')
  assert.deepEqual(notices, ['Не удалось открыть комментарий'])
})

async function settingsPinEditor() {
  const h = startupSandbox(true)
  await h.ctx.init()
  vm.runInContext(extractFunction('renderPinRows'), h.ctx)
  const pin = {
    id: 'local-pin', serviceId: 'mm', title: 'Persisted title',
    annotation: 'Persisted comment', remoteTitle: 'Remote title',
    url: 'https://fixture.invalid/team/channels/original'
  }
  h.state.cfg.services = [{ id: 'mm', name: 'Mattermost', url: 'https://fixture.invalid/team' }]
  h.state.cfg.pinned = [pin]
  h.state.cfg.selectedPinId = ''
  h.state.activePinId = ''
  h.state.pinViews = {}
  let guestCalls = 0
  for (const view of Object.values(h.state.svcViews)) {
    view.executeJavaScript = async () => { guestCalls++; return '' }
  }
  const facadeCalls = []
  const realSaveConfig = h.ctx.saveConfig
  h.ctx.saveConfig = (...args) => { facadeCalls.push(args); return realSaveConfig(...args) }
  h.ctx.renderChatList()
  const host = h.ctx.document.createElement('div')
  h.ctx.renderPinRows(host)
  const settingsRow = host.children[1]
  const titleInput = settingsRow.querySelector('.f-title')
  const commentInput = settingsRow.querySelector('.f-comment')
  const projectInput = settingsRow.querySelector('.f-mcp-project')
  const visible = () => h.ctx.document.querySelectorAll('.chat-row').find(row => row.dataset.pin === pin.id)
  return { h, pin, host, settingsRow, titleInput, commentInput, projectInput, facadeCalls, visible, guestCalls: () => guestCalls }
}

test('Settings favourite title and comment redraw immediately and blur persists normalized local values', async () => {
  const f = await settingsPinEditor()
  const writes = []
  f.h.ctx.window.hub.saveConfig = async cfg => { writes.push(structuredClone(cfg)) }
  const originalUrl = f.pin.url

  f.titleInput.value = 'Local edited title'
  f.titleInput.oninput({ target: f.titleInput })
  assert.equal(f.visible().querySelector('.chat-row-title').textContent, 'Local edited title')
  f.commentInput.value = '  Revised   local comment  '
  f.commentInput.oninput({ target: f.commentInput })
  assert.equal(f.visible().querySelector('.chat-row-comment').textContent, '(Revised local comment)')
  assert.equal(f.facadeCalls.length, 0, 'input alone must not persist')

  assert.equal(typeof f.titleInput.onblur, 'function')
  await f.titleInput.onblur({ target: f.titleInput })
  await f.commentInput.onblur({ target: f.commentInput })
  assert.equal(f.facadeCalls.length, 2, 'both blur handlers use the real saveConfig facade')
  assert.equal(writes.length, 2)
  const saved = writes.at(-1).pinned.find(pin => pin.id === f.pin.id)
  assert.equal(saved.title, 'Local edited title')
  assert.equal(saved.annotation, 'Revised local comment')
  assert.equal(f.pin.remoteTitle, 'Remote title')
  assert.equal(f.pin.url, originalUrl)
  assert.equal(saved.url, originalUrl)
  assert.equal(f.guestCalls(), 0, 'local editing never evaluates code in a messenger')
})

test('Settings favourite comment clearing redraws and persists property removal locally', async () => {
  const f = await settingsPinEditor()
  const writes = []
  f.h.ctx.window.hub.saveConfig = async cfg => { writes.push(structuredClone(cfg)) }
  const originalTitle = f.pin.title
  const originalUrl = f.pin.url
  f.commentInput.value = ''
  f.commentInput.oninput({ target: f.commentInput })
  assert.equal(f.visible().querySelector('.chat-row-comment').textContent, '')
  await f.commentInput.onblur({ target: f.commentInput })
  assert.equal(f.facadeCalls.length, 1)
  assert.equal(Object.prototype.hasOwnProperty.call(f.pin, 'annotation'), false)
  const saved = writes[0].pinned.find(pin => pin.id === f.pin.id)
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'annotation'), false)
  assert.equal(saved.title, originalTitle)
  assert.equal(saved.url, originalUrl)
  assert.equal(f.pin.remoteTitle, 'Remote title')
  assert.equal(f.guestCalls(), 0)
})

for (const kind of ['title', 'comment', 'comment-clear']) {
  test('Settings favourite ' + kind + ' rolls back a rejected save before later queued writes', async () => {
    const f = await settingsPinEditor()
    const writes = []
    let rejectFirst
    f.h.ctx.window.hub.saveConfig = cfg => {
      writes.push(structuredClone(cfg))
      if (writes.length === 1) return new Promise((resolve, reject) => { rejectFirst = reject })
      return Promise.resolve()
    }
    const input = kind === 'title' ? f.titleInput : f.commentInput
    input.value = kind === 'title' ? 'Unsaved title' : kind === 'comment' ? 'Unsaved comment' : ''
    input.oninput({ target: input })
    assert.equal(typeof input.onblur, 'function')
    const blurred = Promise.resolve(input.onblur({ target: input }))
    for (let i = 0; i < 20 && !rejectFirst; i++) await Promise.resolve()
    assert.equal(typeof rejectFirst, 'function', 'blur attempted the real persistence call')
    const laterSave = f.h.ctx.saveConfig(f.h.state.cfg)
    rejectFirst(Error('save rejected'))
    await blurred
    await laterSave

    assert.equal(writes.length, 2)
    const attempted = writes[0].pinned.find(pin => pin.id === f.pin.id)
    if (kind === 'title') assert.equal(attempted.title, 'Unsaved title')
    if (kind === 'comment') assert.equal(attempted.annotation, 'Unsaved comment')
    if (kind === 'comment-clear') assert.equal(Object.prototype.hasOwnProperty.call(attempted, 'annotation'), false)
    const later = writes[1].pinned.find(pin => pin.id === f.pin.id)
    assert.equal(later.title, 'Persisted title', 'later write observes title rollback')
    assert.equal(later.annotation, 'Persisted comment', 'later write observes comment rollback')
    assert.equal(f.pin.title, 'Persisted title')
    assert.equal(f.pin.annotation, 'Persisted comment')
    assert.equal(f.pin.remoteTitle, 'Remote title')
    assert.equal(f.titleInput.value, 'Persisted title')
    assert.equal(f.commentInput.value, 'Persisted comment')
    assert.equal(f.visible().querySelector('.chat-row-title').textContent, 'Persisted title')
    assert.equal(f.visible().querySelector('.chat-row-comment').textContent, '(Persisted comment)')
    assert.equal(f.guestCalls(), 0)
  })
}

test('Settings favourite manual title sets titleCustom and it survives persistence', async () => {
  const f = await settingsPinEditor()
  const writes = []
  f.h.ctx.window.hub.saveConfig = async cfg => { writes.push(structuredClone(cfg)) }
  assert.equal('titleCustom' in f.pin, false, 'старый конфиг без провенанса')
  f.titleInput.value = 'Astra Linux'
  f.titleInput.oninput({ target: f.titleInput })
  assert.equal(writes.length, 0, 'ввод сам по себе ничего не сохраняет')
  await f.titleInput.onblur({ target: f.titleInput })
  assert.equal(writes.length, 1)
  assert.equal(f.pin.title, 'Astra Linux')
  assert.equal(f.pin.titleCustom, true, 'ручная правка ставит признак в памяти')
  const attempted = writes.at(-1).pinned.find(pin => pin.id === f.pin.id)
  assert.equal(attempted.title, 'Astra Linux')
  assert.equal(attempted.titleCustom, true)
  // «save/get»: то, что ушло в config.json, читается обратно с флагом
  const readBack = JSON.parse(JSON.stringify(writes.at(-1))).pinned.find(pin => pin.id === f.pin.id)
  assert.deepEqual(readBack, attempted)
  assert.equal(readBack.titleCustom, true)
})

test('Settings favourite rejected title save rolls back the name and the custom flag together', async () => {
  const f = await settingsPinEditor()
  const writes = []
  let rejectFirst
  f.h.ctx.window.hub.saveConfig = cfg => {
    writes.push(structuredClone(cfg))
    if (writes.length === 1) return new Promise((resolve, reject) => { rejectFirst = reject })
    return Promise.resolve()
  }
  f.titleInput.value = 'Несохранённое имя'
  f.titleInput.oninput({ target: f.titleInput })
  const blurred = Promise.resolve(f.titleInput.onblur({ target: f.titleInput }))
  for (let i = 0; i < 20 && !rejectFirst; i++) await Promise.resolve()
  assert.equal(typeof rejectFirst, 'function', 'blur attempted the real persistence call')
  const laterSave = f.h.ctx.saveConfig(f.h.state.cfg)
  rejectFirst(Error('save rejected'))
  await blurred
  await laterSave
  assert.equal(writes.length, 2)
  assert.equal(writes[0].pinned.find(pin => pin.id === f.pin.id).titleCustom, true, 'попытка несла флаг')
  assert.equal(f.pin.title, 'Persisted title', 'откат вернул имя')
  assert.equal(Object.prototype.hasOwnProperty.call(f.pin, 'titleCustom'), false, 'откат убрал провенанс')
  const later = writes[1].pinned.find(pin => pin.id === f.pin.id)
  assert.equal(later.title, 'Persisted title')
  assert.ok(!('titleCustom' in later), 'несохранённый флаг не утёк в следующую запись')
  assert.equal(f.titleInput.value, 'Persisted title')
})

test('Settings favourite cleared title is not marked as a custom name', async () => {
  const f = await settingsPinEditor()
  const writes = []
  f.h.ctx.window.hub.saveConfig = async cfg => { writes.push(structuredClone(cfg)) }
  f.titleInput.value = '   '
  f.titleInput.oninput({ target: f.titleInput })
  await f.titleInput.onblur({ target: f.titleInput })
  assert.equal(f.pin.title, '')
  assert.ok(!('titleCustom' in f.pin), 'пустое имя не блокирует авто-переименование навсегда')
  assert.ok(!('titleCustom' in writes.at(-1).pinned.find(pin => pin.id === f.pin.id)))
})

/* ---------- auto-rename и titleCustom ---------- */

function autoRenameHarness(pin) {
  const saves = []
  const state = { cfg: { services: [{ id: 'ydx', name: 'Телемост' }], pinned: [pin], columnCss: {}, zoom: {}, selectedPinId: '' } }
  const ctx = sandbox(['applyColumnTweaks', 'shouldAutoRenameTitle', 'isUsernameFallbackName'], {
    state, setTimeout,
    getChatNameFor: async () => 'Удалённое имя',
    pinMatches: () => true,
    saveConfig: async cfg => { saves.push(JSON.parse(JSON.stringify(cfg))) },
    document: { querySelector: () => null }
  })
  const view = { executeJavaScript: async () => '', setZoomFactor() {}, getURL: () => pin.url }
  return { ctx, saves, run: () => ctx.applyColumnTweaks(view, pin) }
}

test('auto-rename never overwrites a title the user set by hand', async () => {
  const pin = { id: 'p1', serviceId: 'ydx', title: 'Astra Linux', titleCustom: true, url: 'https://telemost.yandex.ru/chats/x' }
  const h = autoRenameHarness(pin)
  await h.run()
  assert.equal(pin.title, 'Astra Linux', 'ручное имя пережило старт')
  assert.deepEqual(h.saves, [], 'ничего не пересохранено')
  assert.equal(pin.titleCustom, true)
})

test('auto-rename still adopts the remote name when the stored title is a generic placeholder', async () => {
  const pin = { id: 'p2', serviceId: 'ydx', title: 'чаты', url: 'https://telemost.yandex.ru/chats/x' }
  const h = autoRenameHarness(pin)
  await h.run()
  assert.equal(pin.title, 'Удалённое имя')
  assert.equal(h.saves.length, 1)
  assert.ok(!('titleCustom' in pin), 'auto-rename не ставит провенанс')
})

test('legacy pin without titleCustom keeps a manual-looking name on start', async () => {
  const pin = { id: 'p3', serviceId: 'ydx', title: 'Astra Linux', url: 'https://telemost.yandex.ru/chats/x' }
  const h = autoRenameHarness(pin)
  await h.run()
  assert.equal(pin.title, 'Astra Linux', 'старое ручное имя пережило авто-переименование')
  assert.deepEqual(h.saves, [], 'конфиг не переписан удалённым именем')
  assert.ok(!('titleCustom' in pin), 'легаси-пин не получает флаг задним числом')
})

/* ---------- «Комментарий 2 (проект для MCP)»: локальное служебное поле ---------- */

// Поле живёт только в таблице Настроек → Избранное и не участвует в списке чатов,
// превью и поиске. Стенд перерисовывает таблицу с нужными полями пина, чтобы
// baseline фиксировал именно их.
async function projectPinEditor(fields = {}) {
  const f = await settingsPinEditor()
  Object.assign(f.pin, fields)
  f.h.state.pinEditBaseline = {}
  f.h.state.pinEditSeq = {}
  f.h.state.pinCommitQueues = {}
  f.h.ctx.renderPinRows(f.host)
  const settingsRow = f.host.children[1]
  const projectInput = settingsRow.querySelector('.f-mcp-project')
  return { ...f, settingsRow, projectInput, head: f.host.children[0] }
}

test('Settings favourite row exposes «Комментарий 2 (проект для MCP)» without touching «Комментарий»', async () => {
  const f = await projectPinEditor()
  const head = f.head.innerHTML
  assert.match(head, /<span>Комментарий<\/span>/, 'the first comment column keeps its label')
  assert.match(head, /Комментарий 2 \(проект для MCP\)/, 'the project column has its own label')
  const markup = f.settingsRow.innerHTML
  assert.match(markup, /class="f-mcp-project"/, 'the row renders a separate project input')
  assert.match(markup, /aria-label="Комментарий 2 \(проект для MCP\)"/)
  assert.match(markup, /class="f-mcp-project"[^>]*maxlength="80"|maxlength="80"[^>]*class="f-mcp-project"/, 'the project input is capped at 80 characters')
  const projectTag = /<input[^>]*class="f-mcp-project"[^>]*>/.exec(markup)
  assert.ok(projectTag, 'project input markup is present')
  assert.match(projectTag[0], /placeholder="[^"]+"/, 'the project input has a project placeholder')
  assert.match(markup, /class="f-comment" placeholder="Комментарий \(локально\)" maxlength="80"/, 'the first comment input is unchanged')
})

test('Settings project typing stays local and blur persists a normalized mcpProject through saveConfig', async () => {
  const f = await projectPinEditor()
  const writes = []
  f.h.ctx.window.hub.saveConfig = async cfg => { writes.push(structuredClone(cfg)) }
  const input = f.projectInput
  assert.equal(typeof input.oninput, 'function')
  assert.equal(typeof input.onblur, 'function')

  input.value = '  Портал   Юг  '
  input.oninput({ target: input })
  assert.equal(f.pin.mcpProject, '  Портал   Юг  ')
  assert.equal(writes.length, 0, 'typing alone must not persist')

  await input.onblur({ target: input })
  assert.equal(f.pin.mcpProject, 'Портал Юг', 'blur trims and collapses whitespace')
  assert.equal(f.facadeCalls.length, 1, 'blur saves through the existing saveConfig facade')
  assert.equal(writes.length, 1)
  const saved = writes[0].pinned.find(pin => pin.id === f.pin.id)
  assert.equal(saved.mcpProject, 'Портал Юг')
  assert.equal(saved.annotation, 'Persisted comment', 'the first comment is untouched')
  assert.equal(saved.title, 'Persisted title')
  assert.equal(f.guestCalls(), 0, 'the project never reaches a messenger')

  input.value = 'x'.repeat(100)
  input.oninput({ target: input })
  assert.equal(f.pin.mcpProject.length, 80, 'input is capped at 80 characters')
  await input.onblur({ target: input })
  assert.equal(f.pin.mcpProject, 'x'.repeat(80))
  assert.equal(writes.at(-1).pinned.find(pin => pin.id === f.pin.id).mcpProject, 'x'.repeat(80))
})

test('Settings project clearing deletes the property instead of writing an empty string', async () => {
  const f = await projectPinEditor({ mcpProject: 'Портал-Юг' })
  const writes = []
  f.h.ctx.window.hub.saveConfig = async cfg => { writes.push(structuredClone(cfg)) }
  const input = f.projectInput
  assert.equal(input.value, 'Портал-Юг', 'the saved project is shown')

  input.value = '   '
  input.oninput({ target: input })
  await input.onblur({ target: input })
  assert.equal(Object.prototype.hasOwnProperty.call(f.pin, 'mcpProject'), false, 'empty project removes the key in memory')
  assert.equal(writes.length, 1)
  const saved = writes[0].pinned.find(pin => pin.id === f.pin.id)
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'mcpProject'), false, 'no "" mcpProject is written')
  assert.equal(saved.annotation, 'Persisted comment')
  assert.equal(saved.title, 'Persisted title')
  assert.equal(input.value, '')
})

test('Settings project rolls back only its own field when the save is rejected', async () => {
  const f = await projectPinEditor()
  const writes = []
  let rejectFirst
  f.h.ctx.window.hub.saveConfig = cfg => {
    writes.push(structuredClone(cfg))
    if (writes.length === 1) return new Promise((resolve, reject) => { rejectFirst = reject })
    return Promise.resolve()
  }
  const input = f.projectInput
  input.value = 'Проект X'
  input.oninput({ target: input })
  const blurred = Promise.resolve(input.onblur({ target: input }))
  for (let i = 0; i < 20 && !rejectFirst; i++) await Promise.resolve()
  assert.equal(typeof rejectFirst, 'function', 'blur attempted the real persistence call')
  const laterSave = f.h.ctx.saveConfig(f.h.state.cfg)
  rejectFirst(Error('save rejected'))
  await blurred
  await laterSave

  assert.equal(writes.length, 2)
  assert.equal(writes[0].pinned.find(pin => pin.id === f.pin.id).mcpProject, 'Проект X')
  const later = writes[1].pinned.find(pin => pin.id === f.pin.id)
  assert.equal(Object.prototype.hasOwnProperty.call(later, 'mcpProject'), false, 'the rejected project is rolled back')
  assert.equal(later.title, 'Persisted title', 'title survives a rejected project save')
  assert.equal(later.annotation, 'Persisted comment', 'comment survives a rejected project save')
  assert.equal(f.pin.title, 'Persisted title')
  assert.equal(f.pin.annotation, 'Persisted comment')
  assert.equal(Object.prototype.hasOwnProperty.call(f.pin, 'mcpProject'), false)
  assert.equal(input.value, '', 'the rejected project is reverted in the UI')
  assert.equal(f.visible().querySelector('.chat-row-title').textContent, 'Persisted title')
  assert.equal(f.visible().querySelector('.chat-row-comment').textContent, '(Persisted comment)')
  assert.equal(f.guestCalls(), 0)
})

test('Settings row without a stored project opens unchanged and saves nothing on an untouched blur', async () => {
  const f = await projectPinEditor()
  assert.equal(Object.prototype.hasOwnProperty.call(f.pin, 'mcpProject'), false, 'old configs have no project key')
  assert.equal(f.projectInput.value, '')
  await f.projectInput.onblur({ target: f.projectInput })
  assert.equal(f.facadeCalls.length, 0, 'an untouched empty project writes nothing')
  assert.equal(Object.prototype.hasOwnProperty.call(f.pin, 'mcpProject'), false, 'no empty key is created')
})

test('chat list, preview and search never show or match the MCP project', async () => {
  const h = startupSandbox(true)
  await h.ctx.init()
  const pin = h.state.cfg.pinned.find(p => p.id === 'pin-mm')
  pin.title = 'Филипп Асанов'
  pin.annotation = 'Инженер'
  pin.mcpProject = 'проекткубани'
  h.ctx.renderChatList()
  const row = h.ctx.document.querySelectorAll('.chat-row').find(r => r.dataset.pin === pin.id)
  assert.doesNotMatch(row.innerHTML, /проекткубани/, 'the project is not rendered in the chat row')
  assert.doesNotMatch(row.innerHTML, /chat-row-project|mcp-project|mcpProject/, 'no project node is created in the row')
  assert.equal(row.dataset.search, 'филипп асанов инженер mm', 'search string is title + comment 1 + service')
  assert.equal(row.querySelector('.chat-row-comment').textContent, '(Инженер)')

  // Сам фильтр читает только row.dataset.search: строка, у которой проект есть
  // в конфиге, но нет в search-строке, по проекту не находится.
  const filterRow = search => {
    const classes = new Set(['chat-row'])
    return {
      dataset: { search },
      classList: {
        toggle(name, on) { if (on) classes.add(name); else classes.delete(name) },
        contains(name) { return classes.has(name) }
      },
      querySelector() { return { textContent: '' } }
    }
  }
  const rows = [filterRow(row.dataset.search)]
  const filterState = { favQuery: 'проекткубани' }
  const filterCtx = sandbox(['applyFavFilter'], {
    state: filterState,
    document: { getElementById: id => (id === 'chat-list' ? { children: rows } : null) }
  })
  filterCtx.applyFavFilter()
  assert.equal(rows[0].classList.contains('filtered-out'), true, 'the project never filters the chat list')
  filterState.favQuery = 'инженер'
  filterCtx.applyFavFilter()
  assert.equal(rows[0].classList.contains('filtered-out'), false, 'comment 1 still filters')
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

test('explicit Telegram selection focuses the active pin webview before read verification', async () => {
  const h = startupSandbox(true)
  await h.ctx.init()
  for (const svc of h.services) h.state.svcViews[svc.id].emit('dom-ready')
  h.ctx.selectChat('pin-tg')
  const view = h.state.pinViews['pin-tg']
  assert.equal(view.focusCalls, 1)
  assert.deepEqual(h.readRefreshes, ['pin-tg'])
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
    '__chatHubScanRows', '__chatHubBoundedAvatar', 'formatMaxPreview', 'tabBadgeTotal', 'unreadDeltaFor', 'shouldBumpLiveAct', 'shouldMergeDomTime', 'runUnreadJob',
    'unreadViewState', 'unreadGuestCall', 'restorePreviewAuthor', 'pollUnreadService', 'refreshUnreadPresentation', 'refreshSelectedUnread',
    'parseChatTime', '__chatHubMaxSession'], {
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

function tgUnreadFixture(badge, options = {}) {
  const peerId = String(options.peerId || '123')
  const titleClass = String(options.titleClass || '')
  const badgeClass = String(options.badgeClass || 'badge')
  const badgeBackground = options.badgeBackground || 'rgb(112,117,121)'
  const row = {
    cloneNode() { return this },
    getAttribute(name) { return name === 'data-peer-id' ? peerId : name === 'href' ? '#' + peerId : '' },
    getBoundingClientRect() { return { width: 120, height: 42 } },
    querySelector(selector) {
      if (selector === '.peer-title') return { textContent: 'Synthetic room', className: titleClass, getAttribute() { return peerId }, cloneNode() { return this } }
      if (selector === '.dialog-subtitle-badge-unread') return badge === null ? null : { textContent: String(badge), className: badgeClass }
      return null
    }
  }
  const guest = vm.createContext({
    document: { querySelector() { return null }, querySelectorAll(selector) { return selector === 'a.row-clickable[href^="#"]' ? [row] : [] } },
    window: {}, URL, getComputedStyle: () => ({ backgroundColor: badgeBackground })
  })
  const pin = { id: 'synthetic', serviceId: 'tg', title: 'Synthetic room', url: options.url || 'https://fixture.invalid/-123' }
  const results = [], badges = [], scripts = [], searchFallbacks = []
  const view = { async executeJavaScript(source) {
    scripts.push(source)
    const output = await new vm.Script(source).runInContext(guest)
    results.push(JSON.parse(output))
    return output
  } }
  const state = { cfg: { services: [{ id: 'tg' }], pinned: [pin] }, svcViews: { tg: view }, pinViews: {},
    pinAvatars: { synthetic: 'already-cached' }, unreadTotals: {}, unreadTotalsAt: {}, unreadBaseC: {}, unreadBaseM: {},
    prevUnread: {}, rankAct: {}, lastMsgAt: {}, lastMsgText: {}, lastMsgPreview: {}, liveAct: {}, tgPeerOf: {} }
  const ctx = sandbox(['pollUnread', '__chatHubTgUnread', '__chatHubGrabAvatar', '__chatHubScanRows', '__chatHubBoundedAvatar',
    'formatMaxPreview', 'tabBadgeTotal', 'unreadDeltaFor', 'shouldBumpLiveAct', 'shouldMergeDomTime', 'runUnreadJob',
    'unreadViewState', 'unreadGuestCall', 'restorePreviewAuthor', 'pollUnreadService', 'refreshUnreadPresentation', 'tgPidSafe'], {
    setTimeout, clearTimeout, state, favoritesOf: () => [pin], svcViewFor: () => view,
    document: { querySelector: () => options.serviceVisible ? { classList: { contains: name => name === 'visible' } } : null },
    window: { hub: { isWinFocused: async () => options.windowFocused !== false } },
    updateBadge2: (...args) => badges.push(args), updateBadge: (...args) => badges.push(args),
    sortFavoritesByActivity() {}, scheduleActSave() {},
    __chatHubGrabAvatar: function () {}, formatMaxPreview: function () {}
  })
  if (SRC.includes('async function tgSearchResolve(')) {
    ctx.tgSearchResolve = async () => { searchFallbacks.push(1); return null }
  }
  ctx.UNREAD_EXTRACTORS = { tg: ctx.__chatHubTgUnread }
  return { ctx, state, results, badges, scripts, searchFallbacks, async poll() {
    const before = results.length
    await ctx.pollUnread()
    assert.equal(results.length, before + 1, 'generated Telegram guest script must execute')
    return results.at(-1)
  } }
}

test('Telegram polling executes the real extractor with hidden-tab scroll policy and no search fallback', async () => {
  const cases = [
    // скрытая вкладка скроллится независимо от фокуса окна
    { options: { windowFocused: false }, allowScroll: true },
    { options: { windowFocused: true }, allowScroll: true },
    { options: { windowFocused: false, serviceVisible: true }, allowScroll: false },
    { options: { windowFocused: true, serviceVisible: true }, allowScroll: false }
  ]
  for (const item of cases) {
    const fixture = tgUnreadFixture(7, item.options)
    const result = await fixture.poll()
    assert.equal(result.favs[0].found, true)
    assert.equal(result.favs[0].count, 7)
    const call = fixture.scripts[0].trim().match(/\]\s*,\s*(true|false)\);\s*\}\)\(\)$/)
    assert.ok(call, 'serialized script invokes the extractor with an explicit allowScroll boolean')
    assert.equal(call[1], String(item.allowScroll), JSON.stringify(item.options))
    assert.equal(fixture.searchFallbacks.length, 0, 'ordinary polling never invokes a search fallback')
  }
})

test('hidden Telegram list is swept while ChatHub itself is focused, a visible tab never is', async () => {
  const payloadCall = scripts => scripts.at(-1).trim().match(/\]\s*,\s*(true|false)\);\s*\}\)\(\)$/)
  const hidden = tgUnreadFixture(7, { windowFocused: true })
  await hidden.poll()
  assert.equal(payloadCall(hidden.scripts)[1], 'true', 'скрытая вкладка доскролливается при активном окне')
  const visible = tgUnreadFixture(7, { windowFocused: true, serviceVisible: true })
  await visible.poll()
  assert.equal(payloadCall(visible.scripts)[1], 'false', 'видимая вкладка не скроллится принудительно')
})

test('active favourite is re-observed every cycle while the rest refresh at most every 10 seconds', async () => {
  const fixture = tgUnreadFixture(7)
  const needUnreadOf = () => /"needUnread":(true|false)/.exec(fixture.scripts.at(-1))[1]
  await fixture.poll()
  fixture.state.unreadTotals.synthetic = { c: 7, m: 0 }
  fixture.state.activePinId = ''
  fixture.state.unreadTotalsAt.synthetic = Date.now()
  await fixture.poll()
  assert.equal(needUnreadOf(), 'false', 'свежие данные не перезапрашиваются')
  fixture.state.unreadTotalsAt.synthetic = Date.now() - 9000
  await fixture.poll()
  assert.equal(needUnreadOf(), 'false', 'порог обновления — 10 с, 9 с ещё рано')
  fixture.state.unreadTotalsAt.synthetic = Date.now() - 11000
  await fixture.poll()
  assert.equal(needUnreadOf(), 'true', 'после 10 с неактивный пин обновляется')
  fixture.state.unreadTotalsAt.synthetic = Date.now()
  fixture.state.activePinId = 'synthetic'
  // отдельная полоса активного чата (read-lane) здесь не измеряется
  fixture.ctx.refreshSelectedUnread = async () => {}
  await fixture.poll()
  assert.equal(needUnreadOf(), 'true', 'активный пин опрашивается каждый цикл, даже со свежим замером')
})

test('hidden virtual lists rescan no more often than every 10 seconds', async () => {
  const harness = age => {
    let moves = 0
    const scroller = {
      isConnected: true, clientHeight: 100, scrollHeight: 500, top: 0,
      get scrollTop() { return this.top },
      set scrollTop(value) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); moves++ },
      getBoundingClientRect() { return { width: 200, height: 100 } },
      dispatchEvent() {}
    }
    const now = 1000000
    const window = { __hubVirtualScans: { probe: { cursor: 0, at: now - age, busy: false } } }
    const ctx = sandbox(['__chatHubScanRows'], {
      Date: class extends Date { static now() { return now } },
      Event: class { constructor(type) { this.type = type } },
      window,
      document: { hasFocus: () => false, querySelectorAll: selector => selector === '.scroller' ? [scroller] : [] },
      setTimeout(fn) { setImmediate(fn); return 0 },
      clearTimeout() {}
    })
    return { ctx, moves: () => moves, window }
  }
  const fresh = harness(9000)
  await fresh.ctx.__chatHubScanRows(() => [{ key: 'a', el: null }], '.scroller', 'probe', true)
  assert.equal(fresh.moves(), 0, 'в пределах 10 с скрытый список не дёргаем')
  const stale = harness(11000)
  await stale.ctx.__chatHubScanRows(() => [{ key: 'a', el: null }], '.scroller', 'probe', true)
  assert.ok(stale.moves() > 0, 'после 10 с скрытый список доскролливается')
})

test('Telegram and Telemost keep malformed badges unknown and exact zero non-unread through publication', async () => {
  const fixture = (service, badge) => service === 'tg'
    ? tgUnreadFixture(badge)
    : unreadFixture('ydx', listFixture('ydx', { badge }))
  for (const service of ['tg', 'ydx']) {
    const zero = fixture(service, 0)
    zero.state.unreadTotals.synthetic = { c: 800, m: 0 }
    zero.state.unreadTotalsAt.synthetic = 123
    zero.state.unreadDots = { synthetic: true }
    const zeroResult = await zero.poll()
    assert.equal(zeroResult.favs[0].found, true, service + ' zero found')
    assert.equal(zeroResult.favs[0].count, 0, service + ' zero count')
    assert.equal(zeroResult.favs[0].unread, false, service + ' zero unread')
    assert.equal(zero.state.unreadTotals.synthetic.c, 0, service + ' zero clears count')
    assert.equal(zero.state.unreadDots.synthetic, false, service + ' zero clears dot')

    for (const badge of ['1.2K', '99+']) {
      const unknown = fixture(service, badge)
      unknown.state.unreadTotals.synthetic = { c: 800, m: 0 }
      unknown.state.unreadTotalsAt.synthetic = 123
      unknown.state.unreadDots = { synthetic: false }
      const unknownResult = await unknown.poll()
      assert.equal(unknownResult.favs[0].found, false, service + ' ' + badge + ' found')
      assert.equal(unknown.state.unreadTotals.synthetic.c, 800, service + ' ' + badge + ' preserves count')
      assert.equal(unknown.state.unreadTotalsAt.synthetic, 123, service + ' ' + badge + ' preserves timestamp')
      assert.equal(unknown.state.unreadDots.synthetic, false, service + ' ' + badge + ' does not invent dot')
    }
  }
})

test('Telegram exact zero overrides danger/title fallbacks and an explicit marker remains unread', async () => {
  const canonical = { peerId: '-123', url: 'https://web.telegram.org/k/#-123' }
  const zero = tgUnreadFixture(0, { ...canonical, badgeClass: 'badge danger', badgeBackground: 'rgb(200,0,0)', titleClass: 'unreadPeerTitle' })
  zero.state.unreadTotals.synthetic = { c: 800, m: 0 }
  zero.state.unreadTotalsAt.synthetic = 123
  zero.state.unreadDots = { synthetic: true }
  const zeroResult = await zero.poll()
  assert.deepEqual({ found: zeroResult.favs[0].found, count: zeroResult.favs[0].count, mentions: zeroResult.favs[0].mentions, unread: zeroResult.favs[0].unread }, { found: true, count: 0, mentions: 0, unread: false })
  assert.equal(zero.state.unreadTotals.synthetic.c, 0)
  assert.equal(zero.state.unreadTotals.synthetic.m, 0)
  assert.equal(zero.state.unreadDots.synthetic, false)

  const marker = tgUnreadFixture('•', canonical)
  marker.state.unreadTotals.synthetic = { c: 800, m: 0 }
  marker.state.unreadTotalsAt.synthetic = 123
  marker.state.unreadDots = { synthetic: false }
  const markerResult = await marker.poll()
  assert.deepEqual({ found: markerResult.favs[0].found, count: markerResult.favs[0].count, mentions: markerResult.favs[0].mentions, unread: markerResult.favs[0].unread }, { found: true, count: 0, mentions: 0, unread: true })
  assert.equal(marker.state.unreadTotals.synthetic.c, 0)
  assert.equal(marker.state.unreadTotals.synthetic.m, 0)
  assert.equal(marker.state.unreadDots.synthetic, true)
})

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

// ---------- live regression: an open pin-view is fresher than the service tab ----------
// Two separate webview guests (service tab + the chat the user actually has
// open). The row under test must take the newest time/preview from the open
// pin-view and must never borrow its unread counters.
const REF_NOW = new Date(2026, 10, 23, 12, 0, 0, 0).getTime()
const clockAt = (hours, minutes) => new Date(2026, 10, 23, hours, minutes, 0, 0).getTime()

function maxList({ preview = '', badge = null, time = '', title = 'Synthetic room' } = {}) {
  const doc = listFixture('max', { title, preview, badge })
  const row = doc.children[0].children[0]
  if (time) row.appendChild(element('span', 'meta', time))
  return doc
}

function tgRow(pid, { title = 'Synthetic room', time = '', badge = null, subtitle = '' } = {}) {
  const titleEl = element('span', 'peer-title', title)
  titleEl.getAttribute = () => String(pid)
  const children = [titleEl, element('span', 'message-time', time)]
  if (subtitle) children.push(element('span', 'dialog-subtitle', subtitle))
  if (badge !== null) children.push(element('span', 'dialog-subtitle-badge-unread', String(badge)))
  const row = element('a', 'row-clickable', '', children)
  row.getAttribute = key => key === 'data-peer-id' ? String(pid) : key === 'href' ? '#' + pid : ''
  row.getBoundingClientRect = () => ({ width: 220, height: 40 })
  const clone = row.cloneNode.bind(row)
  row.cloneNode = deep => Object.assign(clone(deep), { getAttribute: row.getAttribute })
  return row
}

const tgList = rows => ({
  querySelector: () => null,
  querySelectorAll: selector => selector === 'a.row-clickable[href^="#"]' ? rows : [],
  hasFocus: () => false
})

function activePinHost(service, { serviceDoc, pinDoc, pinUrl = '', windowFocused = true, serviceVisible = null } = {}) {
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [REF_NOW])) }
    static now() { return REF_NOW }
  }
  const guestGlobals = () => {
    const globals = { window: {}, URL, getComputedStyle: () => ({ backgroundColor: 'rgb(112,117,121)' }), setTimeout, clearTimeout }
    if (service === 'tg') {
      globals.apiManagerProxy = { mirrors: {
        peers: { 1: { _: 'user', id: 1 }, 22: { _: 'user', id: 22, username: 'Work_User' } },
        state: { userId: 1, authState: { _: 'authStateSignedIn' } } } }
      globals.rootScope = { myId: 1 }
    }
    return globals
  }
  const viewFor = doc => {
    const guest = vm.createContext({ ...guestGlobals(), document: doc })
    return { guest, view: { isConnected: true,
      async executeJavaScript(source) { return await new vm.Script(source).runInContext(guest) } } }
  }
  const serviceGuest = viewFor(serviceDoc), pinGuest = viewFor(pinDoc)
  const pin = { id: 'synthetic', serviceId: service, title: 'Synthetic room',
    url: pinUrl || (service === 'tg' ? 'https://web.telegram.org/k/#@Work_User' : 'https://fixture.invalid/-123') }
  const state = { cfg: { services: [{ id: service }], pinned: [pin] },
    svcViews: { [service]: serviceGuest.view }, pinViews: { synthetic: pinGuest.view }, activePinId: 'synthetic',
    pinAvatars: { synthetic: 'already-cached' }, unreadTotals: {}, unreadTotalsAt: {}, unreadBaseC: {},
    unreadBaseM: {}, prevUnread: {}, rankAct: {}, lastMsgAt: {}, lastMsgText: {}, lastMsgPreview: {},
    liveAct: {}, tgPeerOf: {}, tgIdentityKeys: {} }
  const ctx = sandbox(['pollUnread', '__chatHubMaxUnread', '__chatHubTgUnread', '__chatHubYdxUnread',
    '__chatHubGrabAvatar', '__chatHubScanRows', '__chatHubBoundedAvatar', 'formatMaxPreview', 'tabBadgeTotal',
    'unreadDeltaFor', 'shouldBumpLiveAct', 'shouldMergeDomTime', 'runUnreadJob', 'unreadViewState',
    'unreadGuestCall', 'restorePreviewAuthor', 'pollUnreadService', 'refreshUnreadPresentation',
    'refreshSelectedUnread', 'parseChatTime', 'mergeLastMessageTime', 'applyTgIdentityObservation', 'tgPidSafe',
    'fmtChatWhen', 'probeActivePinView', 'mergeActivePinViewMetadata'], {
    Date: Clock, setTimeout, clearTimeout, state, favoritesOf: () => [pin], svcViewFor: () => serviceGuest.view,
    document: { querySelector(selector) {
      if (serviceVisible !== null && String(selector).startsWith('section[data-tab="svc:')) {
        return { classList: { contains: name => name === 'visible' ? serviceVisible : false } }
      }
      return null
    } },
    window: { hub: { isWinFocused: async () => windowFocused } },
    updateBadge2() {}, updateBadge() {}, sortFavoritesByActivity() {}, scheduleActSave() {},
    __chatHubGrabAvatar: function () {}
  })
  ctx.UNREAD_EXTRACTORS = { max: ctx.__chatHubMaxUnread, tg: ctx.__chatHubTgUnread, ydx: ctx.__chatHubYdxUnread }
  return { ctx, state, pin }
}

test('MAX: active pin-view supplies the fresher time and preview the service tab lags behind', async () => {
  const h = activePinHost('max', {
    serviceDoc: maxList({ preview: 'старое сообщение', badge: 3, time: '10:24' }),
    pinDoc: maxList({ preview: 'новое сообщение', badge: null, time: '11:36' })
  })
  await h.ctx.pollUnread()
  assert.equal(h.state.lastMsgAt.synthetic, clockAt(11, 36), 'open chat time must replace the stale service row time')
  assert.equal(h.state.lastMsgPreview.synthetic, 'новое сообщение', 'open chat preview must replace the stale service preview')
})

test('MAX: a newer service row is never rolled back to an older pin-view observation', async () => {
  const h = activePinHost('max', {
    serviceDoc: maxList({ preview: 'свежее сообщение', badge: 3, time: '11:36' }),
    pinDoc: maxList({ preview: 'устаревшее сообщение', badge: null, time: '10:24' })
  })
  await h.ctx.pollUnread()
  assert.equal(h.state.lastMsgAt.synthetic, clockAt(11, 36))
  assert.equal(h.state.lastMsgPreview.synthetic, 'свежее сообщение')
})

test('TG @username: the active pin-view gives time and preview but never unread counters', async () => {
  const h = activePinHost('tg', {
    serviceDoc: tgList([]),
    pinDoc: tgList([tgRow(22, { time: '11:36', subtitle: '11:36 Новое сообщение' })]),
    pinUrl: 'https://web.telegram.org/k/#@Work_User'
  })
  await h.ctx.pollUnread()
  assert.equal(h.state.lastMsgAt.synthetic, clockAt(11, 36))
  assert.equal(h.state.lastMsgPreview.synthetic, 'Новое сообщение')
  // Steady state: the identity binding exists, so cached counters must survive
  // a pin-view observation that carries no category-verified unread data.
  h.state.unreadTotals.synthetic = { c: 2, m: 0 }
  h.state.unreadTotalsAt.synthetic = 123
  await h.ctx.pollUnread()
  assert.deepEqual(h.state.unreadTotals.synthetic, { c: 2, m: 0 }, 'pin-view must not invent an unread count')
  assert.equal(h.state.unreadTotalsAt.synthetic, 123)
})

test('MAX: focused window with a hidden service tab still takes time and preview from the active pin-view', async () => {
  const h = activePinHost('max', {
    serviceDoc: maxList({ preview: 'старое сообщение', badge: 3, time: '10:24' }),
    pinDoc: maxList({ preview: 'новое сообщение', badge: null, time: '11:36' }),
    serviceVisible: false, windowFocused: true
  })
  await h.ctx.pollUnread()
  assert.equal(h.state.lastMsgAt.synthetic, clockAt(11, 36))
  assert.equal(h.state.lastMsgPreview.synthetic, 'новое сообщение')
})

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
  const fixedNow = new Date(2026, 10, 18, 12, 0, 0, 0).getTime()
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])) }
    static now() { return fixedNow }
  }
  const clocked = sandbox(['parseChatTime'], { Date: Clock })
  const r = clocked.parseChatTime('10:24')
  const d = new Date(r.at)
  const n = new Clock()
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
  assert.equal(c.shouldAutoRenameTitle('tg', '', 'https://web.telegram.org/k/#@Astra_lin'), true)
  assert.equal(c.shouldAutoRenameTitle('tg', 'чат', 'https://web.telegram.org/k/#@Astra_lin'), true)
})

test('MAX service tab keeps its native left navigation while favourite pin views keep it hidden', () => {
  const serviceStart = SRC.indexOf('function buildSection')
  const pinStart = SRC.indexOf('function ensurePinView')
  const afterPin = SRC.indexOf('function openInServiceTab')
  assert.ok(serviceStart > 0 && pinStart > serviceStart && afterPin > pinStart, 'function boundaries found')
  const serviceBlock = SRC.slice(serviceStart, pinStart)
  const pinBlock = SRC.slice(pinStart, afterPin)
  assert.equal(serviceBlock.includes('.app > .navigation{display:none'), false,
    'MAX service tab must keep its native left navigation')
  assert.equal(pinBlock.includes('.app > .navigation{display:none'), true,
    'favourite pin views must keep hiding MAX navigation')
})

test('shouldAutoRenameTitle: не-TG сервис переименовывается только из пустого или generic имени', () => {
  const c = sandbox(['shouldAutoRenameTitle', 'isUsernameFallbackName'])
  const ydx = 'https://telemost.yandex.ru/chats/x'
  // пользовательские имена не трогаем
  assert.equal(c.shouldAutoRenameTitle('ydx', 'Astra Linux', ydx), false)
  assert.equal(c.shouldAutoRenameTitle('mm', 'Мой канал', 'https://im.astralinux.ru/astralinux/channels/x'), false)
  assert.equal(c.shouldAutoRenameTitle('max', 'Рабочий чат', 'https://web.max.ru/1'), false)
  assert.equal(c.shouldAutoRenameTitle('mm', 'Любое', 'https://im.astralinux.ru/astralinux/channels/x'), false)
  // пустое и мусорные заголовки мессенджеров — переименовываем
  for (const generic of ['', '   ', 'telegram web', 'mattermost', 'telemost', 'яндекс чат', 'веб-версия max', 'max', 'чат', 'чаты', 'новый чат', 'messenger', 'dialogs', 'Mattermost', ' ЧАТЫ ']) {
    assert.equal(c.shouldAutoRenameTitle('ydx', generic, ydx), true, 'generic: ' + JSON.stringify(generic))
  }
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
  const ctx = sandbox(['cloneConfigForSave', 'queueConfigSave', 'saveConfig', 'pinKeyOf', 'sortFavoritesByActivity', 'pinCurrentChat'], {
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

test('favourite menu names removal without implying chat deletion', () => {
  assert.match(SRC, /data-act="del">✕ Убрать из избранного<\/button>/)
  assert.doesNotMatch(SRC, /data-act="del">✕ Удалить<\/button>/)
})

test('Telemost retry diagnostic ignores ordinary chat text', () => {
  const ctx = sandbox(['isTelemostRetryVisible'])
  assert.equal(ctx.isTelemostRetryVisible('Попытка подключения повторится через 5 секунд. Подключиться'), true)
  assert.equal(ctx.isTelemostRetryVisible('Подключиться к DION'), false)
  assert.equal(ctx.isTelemostRetryVisible(''), false)
})

/* ---------- вкладка MCP (пакет M6) ---------- */

// Мини-дерево DOM: только id/класс/tag/data-атрибуты, которых хватает настройкам.
class McpDomNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentElement = null
    this.dataset = {}
    this.attributes = {}
    this.classes = new Set()
    this.style = {}
    this.hidden = false
    this.disabled = false
    this.readOnly = false
    this.value = ''
    this.type = ''
    this._text = ''
    const classes = this.classes
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle: (name, on) => {
        if (on === undefined) { if (classes.has(name)) classes.delete(name); else classes.add(name) }
        else if (on) classes.add(name)
        else classes.delete(name)
      }
    }
  }
  get className() { return [...this.classes].join(' ') }
  set className(value) {
    this.classes.clear()
    for (const name of String(value).split(/\s+/).filter(Boolean)) this.classes.add(name)
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  set textContent(value) {
    this._text = String(value)
    for (const child of this.children) child.parentElement = null
    this.children = []
  }
  get id() { return this.attributes.id || '' }
  set id(value) { this.attributes.id = String(value) }
  get firstChild() { return this.children[0] || null }
  get previousElementSibling() {
    if (!this.parentElement) return null
    const index = this.parentElement.children.indexOf(this)
    return index > 0 ? this.parentElement.children[index - 1] : null
  }
  get nextSibling() {
    if (!this.parentElement) return null
    const index = this.parentElement.children.indexOf(this)
    return this.parentElement.children[index + 1] || null
  }
  appendChild(node) {
    if (node.parentElement) node.parentElement.removeChild(node)
    node.parentElement = this
    this.children.push(node)
    return node
  }
  removeChild(node) {
    const index = this.children.indexOf(node)
    if (index >= 0) { this.children.splice(index, 1); node.parentElement = null }
    return node
  }
  before(node) {
    if (!this.parentElement) return
    if (node.parentElement) node.parentElement.removeChild(node)
    const index = this.parentElement.children.indexOf(this)
    node.parentElement = this.parentElement
    this.parentElement.children.splice(index, 0, node)
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name === 'class') this.className = value
  }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null }
  addEventListener(name, fn) {
    this.listeners = this.listeners || new Map()
    const list = this.listeners.get(name) || []
    list.push(fn)
    this.listeners.set(name, list)
  }
  removeEventListener(name, fn) {
    if (this.listeners) this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== fn))
  }
  click() {
    for (const fn of (this.listeners && this.listeners.get('click')) || []) fn({ target: this })
    if (typeof this.onclick === 'function') return this.onclick({ target: this })
  }
  matches(selector) {
    const value = selector.trim()
    if (value.startsWith('#')) return this.id === value.slice(1)
    if (value.startsWith('.')) return this.classes.has(value.slice(1))
    let match = /^\[data-([a-z-]+)="([^"]*)"\]$/.exec(value)
    if (match) {
      const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      return this.dataset[key] === match[2]
    }
    match = /^\[data-([a-z-]+)\]$/.exec(value)
    if (match) {
      const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      return Object.prototype.hasOwnProperty.call(this.dataset, key)
    }
    match = /^([a-z]+)\.([a-z-]+)$/i.exec(value)
    if (match) return this.tagName === match[1].toUpperCase() && this.classes.has(match[2])
    return this.tagName === value.toUpperCase()
  }
  querySelectorAll(selector) {
    const found = []
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
}

function mcpDocument() {
  // roots — смонтированные секции: getElementById ищет только то, что реально
  // в документе, как в браузере (отделённая старая панель не находится).
  const roots = []
  return {
    roots,
    createElement: tag => new McpDomNode(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById(id) {
      const visit = node => {
        if (node.id === id) return node
        for (const child of node.children) {
          const found = visit(child)
          if (found) return found
        }
        return null
      }
      for (const root of roots) {
        const found = visit(root)
        if (found) return found
      }
      return null
    }
  }
}

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await Promise.resolve() }

function settingsTabsFixture() {
  const doc = mcpDocument()
  const sec = doc.createElement('section')
  const settings = doc.createElement('div')
  settings.className = 'settings'
  sec.appendChild(settings)
  const labels = ['Вид', 'Тема', 'Мессенджеры', 'Сборная вкладка', 'Масштаб', 'Память', 'Избранное', 'MCP', 'Диагностика']
  for (const label of labels) {
    const heading = doc.createElement('h3')
    heading.textContent = label
    settings.appendChild(heading)
    const body = doc.createElement('div')
    body.className = 'settings-body'
    body.textContent = label + ': настройки'
    settings.appendChild(body)
  }
  const state = { settingsTab: '', activePinId: '' }
  const calls = { selectChat: 0, ensurePinView: 0, readProbes: 0 }
  const ctx = sandbox(['initSettingsTabs'], {
    document: doc,
    state,
    selectChat: () => { calls.selectChat++ },
    ensurePinView: () => { calls.ensurePinView++; return doc.createElement('div') },
    queueSelectedUnread: () => { calls.readProbes++ }
  })
  ctx.initSettingsTabs(sec)
  return { doc, sec, state, calls, tabs: sec.querySelectorAll('.settings-tab') }
}

function mcpPanel(cfg = {}, hub = {}) {
  const doc = mcpDocument()
  const sec = doc.createElement('section')
  let host = doc.createElement('div')
  host.id = 'mcp-rows'
  sec.appendChild(host)
  doc.roots.push(sec)
  const state = { cfg: { mcpExportDir: '', mcpExportDepthDays: 7, pinned: [], ...cfg }, activePinId: '' }
  const saves = []
  let offCalls = 0
  let subscribeCalls = 0
  const api = {
    mcpChooseDir: async () => ({ canceled: true, path: '' }),
    mcpConnectorStatus: async service => ({ service, installed: false, path: null, mode: null, tools: [] }),
    mcpExport: async () => ({ ok: true, files: [], chats: [], truncated: false, errors: [] }),
    mcpCancel: async () => true,
    onMcpProgress: cb => {
      subscribeCalls++
      api.onProgress = cb
      return () => { offCalls++; api.onProgress = null }
    },
    saveConfig: async cfgToSave => { saves.push(JSON.parse(JSON.stringify(cfgToSave))) },
    ...hub
  }
  const ctx = sandbox([
    'saveConfig', 'queueConfigSave', 'cloneConfigForSave',
    'mcpEl', 'normalizeMcpDepth', 'mcpDepthText', 'mcpShortText', 'mcpConnectorStatusText', 'mcpErrorExplanation',
    'mcpExportBlockedReason', 'mcpReportLines', 'mcpProgressLine', 'mcpBaseName', 'mcpServiceName',
    'mcpChatStatusText', 'mcpCoverageText', 'setMcpReport', 'renderMcpReport',
    'mcpConnectorErrorText', 'mcpConnectorActionLine',
    'mcpPanelNode', 'mcpProgressRemember', 'mcpProgressAppend', 'mcpProgressReplaceLast', 'mcpProgressPush',
    'mcpExportSubscribe', 'mcpExportUnsubscribe', 'mcpApplyRunControls', 'mcpRenderRunResult', 'mcpSyncRunControls',
    'renderMcpSettings', 'refreshMcpConnectorStatuses', 'initMcpSettings'
  ], {
    state,
    document: doc,
    window: { hub: api },
    Promise, Object, Array, String, Number, parseInt, Math, JSON
  })
  ctx.mcpProgressOff = null
  ctx.mcpExportRun = { running: false, startedAt: 0, progress: [], progressRepeat: null, report: null }
  ctx.renderMcpSettings(host)
  const facadeCalls = []
  const realSaveConfig = ctx.saveConfig
  ctx.saveConfig = (...args) => { facadeCalls.push(args); return realSaveConfig(...args) }
  ctx.initMcpSettings(sec)
  return {
    doc, sec, host, state, api, saves, facadeCalls, ctx,
    byId: id => sec.querySelector('#' + id),
    offCalls: () => offCalls,
    subscribeCalls: () => subscribeCalls,
    rebuild: () => {
      // Возврат на вкладку «Настройки»: renderer пересобирает #mcp-rows заново.
      sec.removeChild(host)
      host = doc.createElement('div')
      host.id = 'mcp-rows'
      sec.appendChild(host)
      ctx.renderMcpSettings(host)
      ctx.initMcpSettings(sec)
      return host
    }
  }
}

test('Настройки: вкладка MCP объявлена между «Избранным» и «Диагностикой» и остальные вкладки целы', () => {
  const fixture = settingsTabsFixture()
  assert.deepEqual(fixture.tabs.map(tab => tab.dataset.settingsTab),
    ['view', 'theme', 'services', 'chat-style', 'zoom', 'memory', 'favorites', 'mcp', 'diagnostics'])
  assert.deepEqual(fixture.tabs.map(tab => tab.textContent),
    ['Вид', 'Тема', 'Мессенджеры', 'Оформление чатов', 'Масштаб', 'Память', 'Избранное', 'MCP', 'Диагностика'])
  const panes = fixture.sec.querySelectorAll('[data-settings-pane]')
  assert.equal(panes.length, 9, 'каждая секция получила свою панель')
  assert.equal(panes.find(pane => pane.dataset.settingsPane === 'mcp').querySelector('h3').textContent, 'MCP')
  assert.equal(panes.find(pane => pane.dataset.settingsPane === 'view').querySelector('h3').textContent, 'Вид')
  fixture.tabs.find(tab => tab.dataset.settingsTab === 'mcp').click()
  assert.equal(fixture.state.settingsTab, 'mcp')
  assert.equal(fixture.sec.querySelector('[data-settings-pane="mcp"]').classList.contains('hidden'), false)
  assert.equal(fixture.sec.querySelector('[data-settings-pane="view"]').classList.contains('hidden'), true)
  assert.match(SRC, /<div id="mcp-rows"><\/div>/)
  assert.match(SRC, /mcpEl\('h3', \{ text: 'MCP' \}\)/)
  assert.match(SRC, /typeof renderMcpSettings === 'function'/)
  assert.match(SRC, /typeof initMcpSettings === 'function'/)
})

test('Настройки: открытие вкладки MCP не меняет активный чат и не трогает гостевые вьюхи', () => {
  const fixture = settingsTabsFixture()
  const activeBefore = fixture.state.activePinId
  fixture.tabs.find(tab => tab.dataset.settingsTab === 'mcp').click()
  assert.equal(fixture.state.activePinId, activeBefore)
  assert.deepEqual(fixture.calls, { selectChat: 0, ensurePinView: 0, readProbes: 0 })
})

test('MCP: ползунок глубины сохраняет целое через фасад saveConfig', async () => {
  const panel = mcpPanel()
  const slider = panel.byId('mcp-depth')
  assert.equal(slider.value, '7')
  slider.value = '14'
  slider.oninput()
  assert.equal(panel.state.cfg.mcpExportDepthDays, 14)
  assert.equal(slider.value, '14')
  await settle()
  assert.equal(panel.facadeCalls.length, 1, 'запись идёт через локальный фасад')
  assert.equal(panel.saves.length, 1)
  assert.equal(panel.saves[0].mcpExportDepthDays, 14)
  assert.equal(typeof panel.saves[0].mcpExportDepthDays, 'number')
})

test('MCP: границы глубины 1 и 30 сохраняются, мусор зажимается', () => {
  const panel = mcpPanel()
  const slider = panel.byId('mcp-depth')
  slider.value = '1'
  slider.oninput()
  assert.equal(panel.state.cfg.mcpExportDepthDays, 1)
  slider.value = '30'
  slider.oninput()
  assert.equal(panel.state.cfg.mcpExportDepthDays, 30)
  const ctx = sandbox(['normalizeMcpDepth'])
  assert.equal(ctx.normalizeMcpDepth(0), 1)
  assert.equal(ctx.normalizeMcpDepth(31), 30)
  assert.equal(ctx.normalizeMcpDepth('abc'), 7)
  assert.equal(ctx.normalizeMcpDepth('30'), 30)
  assert.equal(ctx.normalizeMcpDepth(7.9), 7)
})

test('MCP: подпись глубины показывает «N дн.» и обновляется вместе с ползунком', () => {
  const panel = mcpPanel({ mcpExportDepthDays: 7 })
  assert.equal(panel.byId('mcp-depth-label').textContent, '7 дн.')
  assert.equal(panel.byId('mcp-depth').getAttribute('aria-valuetext'), '7 дн.')
  panel.byId('mcp-depth').value = '30'
  panel.byId('mcp-depth').oninput()
  assert.equal(panel.byId('mcp-depth-label').textContent, '30 дн.')
  assert.equal(panel.byId('mcp-depth').getAttribute('aria-valuetext'), '30 дн.')
})

test('MCP: выбор папки пишет mcpExportDir в конфиг и обновляет поле', async () => {
  const panel = mcpPanel({ pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpChooseDir: async () => ({ canceled: false, path: 'C:\\Выгрузка' })
  })
  await panel.byId('mcp-choose-dir').onclick()
  assert.equal(panel.state.cfg.mcpExportDir, 'C:\\Выгрузка')
  assert.equal(panel.byId('mcp-export-dir').value, 'C:\\Выгрузка')
  assert.equal(panel.saves.length, 1)
  assert.equal(panel.saves[0].mcpExportDir, 'C:\\Выгрузка')
  assert.equal(panel.byId('mcp-export-run').disabled, false)
})

test('MCP: отмена диалога выбора папки ничего не меняет', async () => {
  const panel = mcpPanel({ mcpExportDir: 'C:\\Старая', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpChooseDir: async () => ({ canceled: true, path: '' })
  })
  await panel.byId('mcp-choose-dir').onclick()
  assert.equal(panel.state.cfg.mcpExportDir, 'C:\\Старая')
  assert.equal(panel.byId('mcp-export-dir').value, 'C:\\Старая')
  assert.equal(panel.saves.length, 0)
  assert.equal(panel.facadeCalls.length, 0)
})

test('MCP: выгрузка вызывает mcpExport без аргументов и рисует отчёт', async () => {
  let releaseExport = null
  const pendingPanel = mcpPanel({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpExport: () => new Promise(resolve => { releaseExport = resolve })
  })
  const pending = pendingPanel.byId('mcp-export-run').onclick()
  assert.equal(pendingPanel.byId('mcp-export-run').disabled, true, 'кнопка заблокирована на время выгрузки')
  assert.equal(pendingPanel.byId('mcp-cancel').hidden, false, 'кнопка отмены видна во время выгрузки')
  releaseExport({ ok: true, files: [], chats: [], truncated: false, errors: [] })
  await pending
  assert.equal(pendingPanel.byId('mcp-export-run').disabled, false)
  assert.equal(pendingPanel.byId('mcp-cancel').hidden, true)

  const calls = []
  const report = {
    ok: true,
    files: [{ project: '14544', path: 'C:\\out\\14544_23112026.md', count: 12 }],
    chats: [
      { pinId: 'p1', service: 'mm', status: 'ok', code: null, coverage: 'truncated', count: 12, undated: 2 },
      { pinId: 'p2', service: 'max', status: 'skipped', code: 'no_messages', coverage: null, count: 0 }
    ],
    truncated: true,
    errors: []
  }
  const panel = mcpPanel({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpExport: async (...args) => { calls.push(args); return report }
  })
  await panel.byId('mcp-export-run').onclick()
  assert.deepEqual(calls, [[]], 'renderer не передаёт ни путей, ни чатов')
  const text = panel.byId('mcp-report').textContent
  assert.match(text, /14544_23112026\.md/)
  assert.match(text, /сообщений: 12/)
  assert.match(text, /без даты: 2/)
  assert.match(text, /Сообщений без даты: 2/)
  assert.match(text, /Покрытие неполное/)
  assert.match(text, /пропущен/)
  assert.match(text, /no_messages/)
  assert.equal(panel.byId('mcp-export-run').disabled, false)
  assert.equal(panel.byId('mcp-cancel').hidden, true)
})

test('MCP: ошибка EXPORT_DIR_MISSING объясняется по-русски и не блокирует кнопку навсегда', async () => {
  const panel = mcpPanel({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpExport: async () => ({ ok: false, code: 'EXPORT_DIR_MISSING' })
  })
  await panel.byId('mcp-export-run').onclick()
  const text = panel.byId('mcp-report').textContent
  assert.match(text, /EXPORT_DIR_MISSING/)
  assert.match(text, /папк/i)
  assert.equal(panel.byId('mcp-export-run').disabled, false)
  assert.equal(panel.byId('mcp-cancel').hidden, true)
})

test('MCP: кнопка выгрузки заблокирована без папки и без чатов с проектом, причина в title', () => {
  const noDir = mcpPanel({ pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] })
  assert.equal(noDir.byId('mcp-export-run').disabled, true)
  assert.match(noDir.byId('mcp-export-run').title, /укажите папку/)
  const noProjects = mcpPanel({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p1', serviceId: 'mm', title: 'без проекта' }] })
  assert.equal(noProjects.byId('mcp-export-run').disabled, true)
  assert.match(noProjects.byId('mcp-export-run').title, /нет чатов с проектом/)
  const ready = mcpPanel({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] })
  assert.equal(ready.byId('mcp-export-run').disabled, false)
})

test('MCP: три карточки коннекторов, включая Яндекс, статус не «ждёт коннектор»', () => {
  const panel = mcpPanel()
  const cards = panel.sec.querySelectorAll('[data-mcp-card]')
  assert.deepEqual(cards.map(card => card.dataset.mcpCard), ['mm', 'max', 'ydx'])
  assert.deepEqual(cards.map(card => card.querySelector('h4').textContent), ['Mattermost', 'MAX', 'Яндекс Телемост'])
  for (const service of ['mm', 'max', 'ydx']) {
    for (const action of ['install', 'connect', 'probe']) {
      assert.equal(panel.byId('mcp-' + action + '-' + service).disabled, true, action + '/' + service + ' выключена без каналов hub')
    }
  }
  assert.equal(panel.byId('mcp-install-mm').title, 'появится в следующем пакете')
  assert.equal(panel.byId('mcp-probe-max').title, 'появится в следующем пакете')
  assert.equal(panel.byId('mcp-install-ydx').title, 'появится в следующем пакете')
  assert.equal(panel.byId('mcp-status-ydx').textContent, 'проверяем…')
  assert.notEqual(panel.byId('mcp-status-ydx').textContent, 'ждёт коннектор')
  assert.equal(panel.byId('mcp-export-dir').placeholder, 'не выбрана')
  assert.equal(panel.byId('mcp-export-dir').getAttribute('readonly'), 'readonly')
  assert.equal(panel.byId('mcp-cancel').hidden, true)
  assert.equal(panel.sec.textContent.includes('Telegram'), false)
  assert.equal(panel.sec.querySelectorAll('[data-mcp-card="tg"]').length, 0)
})

test('MCP: статусы коннекторов берутся из ответа, сбой вызова даёт «ошибка»', async () => {
  const panel = mcpPanel({}, {
    mcpConnectorStatus: async service => service === 'mm'
      ? ({ service, installed: true, path: 'C:\\mm', mode: 'existing', tools: ['mmchat_read_channel'] })
      : ({ service, installed: false, path: null, mode: null, tools: [] })
  })
  await settle()
  assert.equal(panel.byId('mcp-status-mm').textContent, 'готов')
  assert.equal(panel.byId('mcp-status-max').textContent, 'не установлен')
  assert.equal(panel.byId('mcp-status-ydx').textContent, 'не установлен', 'Яндекс проверяется как остальные')
  const broken = mcpPanel({}, { mcpConnectorStatus: async () => { throw Error('реестр недоступен') } })
  await settle()
  assert.match(broken.byId('mcp-status-mm').textContent, /^ошибка/)
  assert.match(broken.byId('mcp-status-mm').textContent, /реестр недоступен/)
  assert.match(broken.byId('mcp-status-ydx').textContent, /^ошибка/)
  const ctx = sandbox(['mcpConnectorStatusText'])
  assert.equal(ctx.mcpConnectorStatusText('mm', { installed: true, tools: [] }), 'не настроен')
  assert.match(ctx.mcpConnectorStatusText('mm', { installed: true, tools: [], code: 'REGISTRY_INVALID' }), /^ошибка/)
  assert.equal(ctx.mcpConnectorStatusText('ydx', { installed: false }), 'не установлен')
})

test('MCP: прогресс выводится строками textContent, подписка одна на весь запуск', async () => {
  let releaseExport = null
  const panel = mcpPanel({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpExport: () => new Promise(resolve => { releaseExport = resolve })
  })
  const pending = panel.byId('mcp-export-run').onclick()
  assert.equal(typeof panel.api.onProgress, 'function', 'запуск подписался на прогресс')
  assert.equal(panel.subscribeCalls(), 1, 'ровно одна подписка на запуск')
  panel.api.onProgress({ event: 'chat_started', service: 'mm', pinId: 'p1', text: 'секретное сообщение' })
  panel.api.onProgress({ event: 'chat_done', service: 'mm', count: 3, text: 'секретное сообщение' })
  panel.api.onProgress({ event: 'file_written', project: '14544', count: 10 })
  panel.api.onProgress({ event: 'connector_stderr', service: 'max', line: 'Traceback: token' })
  const host = panel.byId('mcp-progress')
  assert.equal(host.children.length, 4, 'каждое событие даёт одну строку')
  assert.ok(host.children.every(item => !item.textContent.includes('секретное')), 'текст сообщений в журнал не попадает')
  assert.ok(host.children.every(item => !item.textContent.includes('Traceback')), 'сырой stderr не выводится')
  assert.match(host.children[1].textContent, /сообщений 3/)
  panel.rebuild()
  assert.equal(panel.offCalls(), 0, 'пересборка панели не снимает подписку запуска')
  assert.equal(panel.subscribeCalls(), 1, 'пересборка панели не создаёт вторую подписку')
  assert.equal(panel.byId('mcp-progress').children.length, 4, 'строки прогресса восстановлены')
  releaseExport({ ok: true, files: [], chats: [], truncated: false, errors: [] })
  await pending
  assert.equal(panel.offCalls(), 1, 'по завершении подписка снята')
})

// --- пакет MCP-EXPORT-PERSIST: прогресс и отчёт переживают пересборку панели ---

test('MCP: старт выгрузки, пересоздание панели — прогресс, статус и кнопки восстановлены', async () => {
  let releaseExport = null
  const panel = mcpPanel({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpExport: () => new Promise(resolve => { releaseExport = resolve })
  })
  const pending = panel.byId('mcp-export-run').onclick()
  panel.api.onProgress({ event: 'chat_started', service: 'mm', pinId: 'p1' })
  panel.api.onProgress({ event: 'chat_done', service: 'mm', count: 4 })
  const host = panel.rebuild()
  assert.deepEqual(panel.byId('mcp-progress').children.map(item => item.textContent), [
    'Mattermost: читаю чат…',
    'Mattermost: готово, сообщений 4'
  ], 'прогресс восстановлен после пересоздания панели')
  assert.equal(host.querySelector('#mcp-progress').children.length, 2)
  assert.match(panel.byId('mcp-report').textContent, /Выгрузка идёт…/, 'статус запуска восстановлен')
  assert.equal(panel.byId('mcp-export-run').disabled, true, 'кнопка выгрузки заблокирована')
  assert.equal(panel.byId('mcp-export-run').title, 'Выгрузка идёт…')
  assert.equal(panel.byId('mcp-cancel').hidden, false, 'кнопка отмены видима')
  assert.equal(panel.byId('mcp-cancel').disabled, false, 'кнопка отмены активна')
  releaseExport({ ok: true, files: [], chats: [], truncated: false, errors: [] })
  await pending
  assert.equal(panel.byId('mcp-export-run').disabled, false, 'после завершения кнопка снова доступна')
  assert.equal(panel.byId('mcp-cancel').hidden, true)
})

test('MCP: завершение выгрузки при отсутствии панели — отчёт показывается при возврате', async () => {
  let releaseExport = null
  const panel = mcpPanel({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpExport: () => new Promise(resolve => { releaseExport = resolve })
  })
  const pending = panel.byId('mcp-export-run').onclick()
  panel.api.onProgress({ event: 'file_written', project: '14544', count: 7 })
  // панель уничтожена до завершения: события и результат должны остаться в памяти
  panel.sec.removeChild(panel.host)
  releaseExport({
    ok: true,
    files: [{ project: '14544', path: 'C:\\out\\14544_24112026.md', count: 7 }],
    chats: [],
    truncated: false,
    errors: []
  })
  await pending
  assert.equal(panel.offCalls(), 1, 'подписка снята по завершении')
  panel.rebuild()
  assert.match(panel.byId('mcp-report').textContent, /14544_24112026\.md/, 'отчёт восстановлен при возврате на вкладку')
  assert.match(panel.byId('mcp-report').textContent, /сообщений: 7/)
  assert.equal(panel.byId('mcp-progress').children.length, 1, 'прогресс не потерян')
  assert.equal(panel.byId('mcp-export-run').disabled, false)
  assert.equal(panel.byId('mcp-cancel').hidden, true)
})

test('MCP: в памяти хранится не больше 300 строк прогресса, старые вытесняются', async () => {
  let releaseExport = null
  const panel = mcpPanel({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpExport: () => new Promise(resolve => { releaseExport = resolve })
  })
  const pending = panel.byId('mcp-export-run').onclick()
  for (let i = 1; i <= 305; i++) panel.api.onProgress({ event: 'file_written', project: 'P' + i, count: i })
  const saved = panel.ctx.mcpExportRun.progress
  assert.equal(saved.length, 300, 'лимит 300 строк')
  assert.match(saved[0], /Проект P6:/, 'старые строки вытеснены')
  assert.match(saved[saved.length - 1], /Проект P305:/, 'последняя строка сохранена')
  const shown = panel.byId('mcp-progress').children
  assert.equal(shown.length, 300, 'в панели тоже не больше 300 строк')
  assert.match(shown[0].textContent, /Проект P6:/)
  releaseExport({ ok: true, files: [], chats: [], truncated: false, errors: [] })
  await pending
})

test('MCP: две пересборки панели во время выгрузки не создают вторую подписку', async () => {
  let releaseExport = null
  const panel = mcpPanel({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpExport: () => new Promise(resolve => { releaseExport = resolve })
  })
  const pending = panel.byId('mcp-export-run').onclick()
  assert.equal(panel.subscribeCalls(), 1)
  panel.rebuild()
  panel.rebuild()
  assert.equal(panel.subscribeCalls(), 1, 'повторный вход на вкладку не плодит подписки')
  panel.api.onProgress({ event: 'chat_done', service: 'mm', count: 9 })
  const lines = panel.byId('mcp-progress').children.map(item => item.textContent)
  assert.equal(lines.length, 1, 'событие обработано ровно один раз')
  assert.match(lines[0], /сообщений 9/)
  releaseExport({ ok: true, files: [], chats: [], truncated: false, errors: [] })
  await pending
  assert.equal(panel.offCalls(), 1)
})

test('MCP: после завершения подписка снята, повторный запуск создаёт новую и работает', async () => {
  let releaseSecond = null
  let call = 0
  const panel = mcpPanel({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpExport: () => {
      call++
      if (call === 1) {
        return Promise.resolve({ ok: true, files: [{ project: 'A', path: 'C:\\out\\a.md', count: 1 }], chats: [], truncated: false, errors: [] })
      }
      return new Promise(resolve => { releaseSecond = resolve })
    }
  })
  await panel.byId('mcp-export-run').onclick()
  assert.equal(panel.offCalls(), 1, 'подписка снята после успеха')
  assert.equal(panel.api.onProgress, null)
  assert.equal(panel.subscribeCalls(), 1)
  assert.match(panel.byId('mcp-report').textContent, /a\.md/)

  const pending = panel.byId('mcp-export-run').onclick()
  assert.equal(panel.subscribeCalls(), 2, 'новый запуск создаёт новую подписку')
  assert.equal(panel.ctx.mcpExportRun.progress.length, 0, 'журнал нового запуска пуст')
  assert.equal(panel.ctx.mcpExportRun.report, null, 'прошлый отчёт не переносится в новый запуск')
  panel.api.onProgress({ event: 'chat_done', service: 'max', count: 2 })
  assert.match(panel.byId('mcp-progress').textContent, /MAX: готово, сообщений 2/)
  releaseSecond({ ok: true, files: [], chats: [], truncated: false, errors: [] })
  await pending
  assert.equal(panel.offCalls(), 2, 'подписка снята и после второго запуска')
})

// --- пакет M7: кнопки карточек коннекторов ---

function connectorHub(calls, extra = {}) {
  return {
    mcpConnectorInstall: async service => { calls.push(['install', service]); return { ok: true, entry: { tools: ['mmchat_whoami', 'mmchat_list_channels'] } } },
    mcpConnectorConnect: async service => { calls.push(['connect', service]); return { ok: false, code: 'CANCELLED' } },
    mcpProbe: async service => { calls.push(['probe', service]); return { ok: true, tools: ['mmchat_whoami'] } },
    ...extra
  }
}

test('MCP: кнопки карточек ставят, подключают и проверяют сервис через hub', async () => {
  const calls = []
  const statuses = []
  const panel = mcpPanel({}, connectorHub(calls, {
    mcpConnectorStatus: async service => {
      statuses.push(service)
      return { service, installed: true, path: 'C:\\mm.exe', mode: 'existing', tools: ['mmchat_whoami'] }
    }
  }))
  for (const service of ['mm', 'max']) {
    for (const action of ['install', 'connect', 'probe']) {
      const button = panel.byId('mcp-' + action + '-' + service)
      assert.equal(button.disabled, false, action + '/' + service + ' должна быть доступна')
      assert.notEqual(button.title, 'появится в следующем пакете')
    }
  }
  await panel.byId('mcp-install-mm').onclick()
  await panel.byId('mcp-connect-mm').onclick()
  await panel.byId('mcp-probe-max').onclick()
  assert.deepEqual(calls, [['install', 'mm'], ['connect', 'mm'], ['probe', 'max']])
  const lines = panel.byId('mcp-progress').children.map(item => item.textContent)
  assert.equal(lines.length, 3, 'каждое действие даёт строку прогресса')
  assert.match(lines[0], /Mattermost: установка прошла, инструментов: 2/)
  assert.match(lines[1], /Mattermost: подключение не удалось\. .*отмен/i)
  assert.match(lines[2], /MAX: проверка прошла, инструментов: 1/)
  assert.ok(statuses.length >= 3, 'статус перечитывается после действия')
  await settle()
  assert.equal(panel.byId('mcp-status-mm').textContent, 'готов')
})

test('MCP: ошибка установки объясняется текстом, кнопка снова доступна', async () => {
  const panel = mcpPanel({}, {
    mcpConnectorInstall: async () => ({ ok: false, code: 'TOOLS_MISMATCH', tools: ['mmchat_read_channel'] }),
    mcpConnectorStatus: async service => ({ service, installed: false, path: null, mode: null, tools: [] })
  })
  const button = panel.byId('mcp-install-mm')
  await button.onclick()
  const text = panel.byId('mcp-progress').children[0].textContent
  assert.match(text, /Mattermost/)
  assert.match(text, /инструмент/i)
  assert.equal(button.disabled, false, 'кнопка не остаётся заблокированной')

  const broken = mcpPanel({}, { mcpProbe: async () => { throw Error('нет связи с main') } })
  const probeButton = broken.byId('mcp-probe-mm')
  await probeButton.onclick()
  assert.match(broken.byId('mcp-progress').children[0].textContent, /нет связи с main/)
  assert.equal(probeButton.disabled, false)
})

test('MCP: успешная проверка перечитывает статус, известные коды объясняются', async () => {
  let installed = false
  const panel = mcpPanel({}, {
    mcpConnectorStatus: async service => ({
      service,
      installed,
      path: installed ? 'C:\\mm.exe' : null,
      mode: installed ? 'existing' : null,
      tools: installed ? ['mmchat_whoami'] : []
    }),
    mcpProbe: async () => { installed = true; return { ok: true, tools: ['mmchat_whoami'] } }
  })
  await settle()
  assert.equal(panel.byId('mcp-status-mm').textContent, 'не установлен')
  await panel.byId('mcp-probe-mm').onclick()
  await settle()
  assert.equal(panel.byId('mcp-status-mm').textContent, 'готов')

  const ctx = sandbox(['mcpConnectorErrorText'])
  assert.match(ctx.mcpConnectorErrorText('CONNECTOR_NOT_FOUND'), /не найден/i)
  assert.match(ctx.mcpConnectorErrorText('PROBE_TIMEOUT'), /45/)
  assert.match(ctx.mcpConnectorErrorText('CANCELLED'), /отмен/i)
  assert.match(ctx.mcpConnectorErrorText('REGISTRY_UNSAFE_COMMAND'), /каталог/i)
  assert.match(ctx.mcpConnectorErrorText('НЕВЕДОМЫЙ_КОД'), /НЕВЕДОМЫЙ_КОД/)
})

test('MCP: карточка Яндекса активна, кнопки вызывают hub с service ydx', async () => {
  const calls = []
  const panel = mcpPanel({}, connectorHub(calls, {
    mcpConnectorStatus: async service => ({ service, installed: false, path: null, mode: null, tools: [] })
  }))
  for (const action of ['install', 'connect', 'probe']) {
    const button = panel.byId('mcp-' + action + '-ydx')
    assert.equal(button.disabled, false, action + '/ydx должна быть доступна')
    assert.notEqual(button.title, 'ждёт коннектор')
  }
  await panel.byId('mcp-install-ydx').onclick()
  await panel.byId('mcp-connect-ydx').onclick()
  await panel.byId('mcp-probe-ydx').onclick()
  assert.deepEqual(calls, [['install', 'ydx'], ['connect', 'ydx'], ['probe', 'ydx']])
  const lines = panel.byId('mcp-progress').children.map(item => item.textContent)
  assert.equal(lines.length, 3, 'каждое действие даёт строку прогресса')
  assert.match(lines[0], /Яндекс Телемост: установка прошла/)
  assert.match(lines[2], /Яндекс Телемост: проверка прошла/)
  await settle()
  assert.equal(panel.byId('mcp-status-ydx').textContent, 'не установлен')
  assert.notEqual(panel.byId('mcp-status-ydx').textContent, 'ждёт коннектор')

  // Код TOKEN_MISSING объясняется человеку, а не только кодом.
  const ctx = sandbox(['mcpConnectorErrorText'])
  assert.match(ctx.mcpConnectorErrorText('TOKEN_MISSING'), /токен/i)
})

test('MCP: повторная инициализация панели не удваивает вызовы коннекторов', async () => {
  const calls = []
  const panel = mcpPanel({}, connectorHub(calls))
  panel.ctx.initMcpSettings(panel.sec)
  await panel.byId('mcp-install-max').onclick()
  assert.deepEqual(calls, [['install', 'max']], 'обработчик один')
})

// ---------- MAX-SESSION-1: разлогин MAX — это не «нет сообщений» ----------
// UI-тексты читаем из renderer.js: тест проверяет реальную копию, не свою.
const MAX_SESSION_CONSTS = Object.fromEntries(
  [...SRC.matchAll(/^const (MAX_SESSION_[A-Z_]+) = '([^']*)'$/gm)].map(m => [m[1], m[2]])
)

// Мини-DOM для хостовых UI-функций: поддержаны только селекторы из кода пакета.
function stubClassList(set) {
  return {
    add(...names) { for (const name of names) set.add(name) },
    remove(...names) { for (const name of names) set.delete(name) },
    contains(name) { return set.has(name) },
    toggle(name, force) {
      const want = force === undefined ? !set.has(name) : !!force
      if (want) set.add(name); else set.delete(name)
      return want
    }
  }
}

function stubMatches(node, selector) {
  return String(selector).split(',').some(part => {
    let rest = part.trim()
    if (!rest) return false
    if (rest[0] === '#') {
      if (node.attrs.id !== rest.slice(1)) return false
      rest = ''
    }
    const tag = (rest.match(/^([a-zA-Z][\w-]*)/) || [])[1] || ''
    if (tag) rest = rest.slice(tag.length)
    if (tag && node.tag !== tag) return false
    for (const m of rest.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(m[1])) return false
    for (const m of rest.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)) {
      const key = m[1], want = m[2] ?? m[3] ?? m[4]
      const field = key.startsWith('data-') ? key.slice(5) : key
      const have = node.dataset[field] !== undefined ? node.dataset[field] : node.attrs[key]
      if (want === undefined ? have === undefined : String(have) !== want) return false
    }
    return true
  })
}

function stubNode(tag, { classes = [], attrs = {}, dataset = {}, text = '' } = {}) {
  const classSet = new Set(classes)
  const node = {
    tag,
    textContent: text,
    title: '',
    dataset: { ...dataset },
    attrs: { ...attrs },
    children: [],
    parent: null,
    classList: stubClassList(classSet),
    setAttribute(name, value) { this.attrs[name] = String(value) },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null },
    removeAttribute(name) { delete this.attrs[name] },
    appendChild(child) { this.children.push(child); child.parent = this; return child },
    insertBefore(child, ref) {
      const index = ref ? this.children.indexOf(ref) : -1
      this.children.splice(index < 0 ? 0 : index, 0, child)
      child.parent = this
      return child
    },
    remove() {
      if (!this.parent) return
      const index = this.parent.children.indexOf(this)
      if (index >= 0) this.parent.children.splice(index, 1)
      this.parent = null
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null },
    querySelectorAll(selector) {
      const out = []
      const visit = parent => {
        for (const child of parent.children) {
          if (stubMatches(child, selector)) out.push(child)
          visit(child)
        }
      }
      visit(this)
      return out
    }
  }
  Object.defineProperty(node, 'firstChild', { get() { return this.children[0] || null } })
  Object.defineProperty(node, 'className', {
    get() { return [...classSet].join(' ') },
    set(value) {
      classSet.clear()
      for (const name of String(value || '').split(/\s+/)) if (name) classSet.add(name)
    }
  })
  return node
}

function stubDoc() {
  const doc = stubNode('#document')
  doc.createElement = tag => stubNode(tag)
  return doc
}

function maxUiFixture() {
  const doc = stubDoc()
  const tabs = stubNode('div', { attrs: { id: 'tabs' } })
  const tab = stubNode('button', { classes: ['tab'], dataset: { tab: 'svc:max' } })
  const badge = stubNode('span', { classes: ['badge'] })
  const mention = stubNode('span', { classes: ['badge', 'badge-m'] })
  tab.appendChild(badge)
  tab.appendChild(mention)
  tabs.appendChild(tab)
  doc.appendChild(tabs)
  const combined = stubNode('section', { classes: ['tabpane'], dataset: { tab: 'combined' } })
  const maxPane = stubNode('section', { classes: ['tabpane'], dataset: { tab: 'svc:max' } })
  doc.appendChild(combined)
  doc.appendChild(maxPane)
  return { doc, tab, badge, mention, combined, maxPane }
}

// Гостевая страница MAX: только счётчики, которые читает __chatHubMaxSession.
function maxGuestDoc({ readyState = 'complete', profile = 0, rows = 0, cells = 0, tel = 0, qr = 0, text = '' } = {}) {
  const counts = new Map([
    ['button.main[aria-label]', profile], ['aside div.item', rows], ['button.cell', cells],
    ['input[type=tel]', tel], ['canvas,img[alt*="QR" i]', qr]
  ])
  return {
    readyState,
    body: { innerText: text },
    querySelectorAll(selector) { return Array.from({ length: counts.get(selector) || 0 }, (_, index) => ({ index })) }
  }
}

function maxSessionOf(options) {
  const ctx = sandbox(['__chatHubMaxSession'], { document: maxGuestDoc(options) })
  return ctx.__chatHubMaxSession()
}

test('MAX session: живой профиль или строки списка — вход есть', () => {
  assert.equal(maxSessionOf({ profile: 1 }).state, 'ok')
  assert.equal(maxSessionOf({ rows: 3 }).state, 'ok')
  assert.equal(maxSessionOf({ profile: 2, tel: 1 }).state, 'ok')
})

test('MAX session: пустой список с телефоном, QR или текстом входа — признак разлогина', () => {
  assert.equal(maxSessionOf({ tel: 1 }).state, 'auth')
  assert.equal(maxSessionOf({ qr: 1 }).state, 'auth')
  const words = maxSessionOf({ text: 'Войти в MAX по номеру телефона' })
  assert.equal(words.authWords, true)
  assert.equal(words.state, 'auth')
  assert.equal(maxSessionOf({ text: 'Отсканируйте QR-код в приложении MAX' }).state, 'auth')
})

test('MAX session: чужая форма и недогруженная страница не считаются разлогином', () => {
  assert.equal(maxSessionOf({ cells: 2 }).state, 'unknown')
  assert.equal(maxSessionOf({ tel: 1, readyState: 'loading' }).state, 'unknown')
  assert.equal(maxSessionOf({ text: 'Войдите', readyState: 'interactive' }).state, 'unknown')
  assert.equal(maxSessionOf({}).state, 'unknown')
})

test('MAX session: auth объявляется только после двух опросов или 20 секунд наблюдения', () => {
  let now = REF_NOW
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  const state = {}
  const ctx = sandbox(['maxSessionInfo', 'noteMaxSession', 'maxSessionAuth'], { Date: Clock, state })
  const auth = { state: 'auth' }
  const first = ctx.noteMaxSession(auth)
  assert.equal(first.state, 'unknown', 'одиночное наблюдение не индицируется')
  assert.equal(first.changed, false)
  assert.equal(ctx.maxSessionAuth(), false)
  const second = ctx.noteMaxSession(auth)
  assert.equal(second.state, 'auth', 'два опроса подряд')
  assert.equal(second.changed, true)

  assert.equal(ctx.noteMaxSession({ state: 'ok' }).state, 'ok')
  now += 1000
  assert.equal(ctx.noteMaxSession(auth).state, 'ok', 'после входа отсчёт начинается заново')
  now += 21000
  assert.equal(ctx.noteMaxSession({ state: 'unknown' }).state, 'auth',
    'признак держится ≥ 20 с без подтверждения входа')
})

test('MAX session: вкладка показывает «!» вместо счётчиков, полоса и кнопка «Открыть MAX»', () => {
  assert.equal(MAX_SESSION_CONSTS.MAX_SESSION_AUTH_LABEL, 'MAX: сеанс завершён — требуется вход')
  assert.equal(MAX_SESSION_CONSTS.MAX_SESSION_AUTH_TEXT, 'MAX: сеанс завершён. Сообщения и счётчики не обновляются.')
  assert.equal(MAX_SESSION_CONSTS.MAX_SESSION_STALE_TITLE, 'данные с последнего успешного опроса')
  const ui = maxUiFixture()
  const opened = []
  ui.badge.textContent = '0'
  const state = {
    cfg: { pinned: [] },
    maxSession: { state: 'auth', streak: 2, since: REF_NOW, lastOkAt: REF_NOW, noticeSent: true }
  }
  const ctx = sandbox(['maxSessionInfo', 'maxSessionAuth', 'maxSessionDiagnosticText',
    'applyMaxSessionUi', 'applyMaxStaleRows', 'maxSessionBar'], {
    Date, state, updateBadge2() {}, activateTab: id => opened.push(id), ...MAX_SESSION_CONSTS
  })
  ctx.applyMaxSessionUi(ui.doc)
  assert.equal(ui.badge.textContent, '!', 'вместо счётчика — маркер')
  assert.equal(ui.badge.title, MAX_SESSION_CONSTS.MAX_SESSION_AUTH_LABEL)
  assert.equal(ui.tab.getAttribute('aria-label'), MAX_SESSION_CONSTS.MAX_SESSION_AUTH_LABEL)
  assert.equal(ui.badge.classList.contains('auth-required'), true)
  for (const pane of [ui.combined, ui.maxPane]) {
    const bar = pane.querySelector('[data-max-session-bar]')
    assert.ok(bar, 'полоса-предупреждение')
    assert.equal(bar.querySelector('.svc-session-text').textContent,
      'MAX: сеанс завершён. Сообщения и счётчики не обновляются.')
    assert.equal(bar.querySelector('.svc-session-open').textContent, 'Открыть MAX')
  }
  ui.combined.querySelector('.svc-session-open').onclick()
  assert.deepEqual(opened, ['svc:max'], 'кнопка переключает на вкладку MAX')
  ctx.applyMaxSessionUi(ui.doc)
  assert.equal(ui.combined.querySelectorAll('[data-max-session-bar]').length, 1, 'полоса не дублируется')
})

test('MAX session: уведомление и тост — ровно один раз на переход, повторно только после ok', () => {
  const ui = maxUiFixture()
  const notifications = [], toasts = []
  class FakeNotification {
    static permission = 'granted'
    constructor(title, options = {}) { this.title = title; this.body = options.body; notifications.push(this) }
  }
  const state = { cfg: { pinned: [] } }
  const ctx = sandbox(['maxSessionInfo', 'noteMaxSession', 'maxSessionAuth', 'showMaxSessionNotification',
    'applyMaxSession', 'applyMaxSessionUi', 'applyMaxStaleRows', 'maxSessionBar'],
  {
    Date, state, document: ui.doc, Notification: FakeNotification,
    toast: msg => toasts.push(msg), activateTab() {}, updateBadge2() {}, ...MAX_SESSION_CONSTS
  })
  assert.equal(ctx.applyMaxSession({ state: 'auth' }).state, 'unknown')
  assert.equal(notifications.length, 0, 'одиночное наблюдение — без уведомления')
  assert.equal(ctx.applyMaxSession({ state: 'auth' }).state, 'auth')
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].title, /MAX: сеанс завершён/)
  assert.equal(toasts.filter(msg => msg === MAX_SESSION_CONSTS.MAX_SESSION_AUTH_LABEL).length, 1)
  ctx.applyMaxSession({ state: 'auth' })
  ctx.applyMaxSession({ state: 'unknown' })
  assert.equal(notifications.length, 1, 'повторные опросы не спамят')
  assert.equal(toasts.filter(msg => msg === MAX_SESSION_CONSTS.MAX_SESSION_AUTH_LABEL).length, 1)

  ctx.applyMaxSession({ state: 'ok' })
  assert.ok(toasts.includes('MAX снова на связи'))
  ctx.applyMaxSession({ state: 'auth' })
  assert.equal(notifications.length, 1, 'первый опрос после входа — ещё без индикации')
  ctx.applyMaxSession({ state: 'auth' })
  assert.equal(notifications.length, 2, 'новый разлогин после восстановления — второе уведомление')
})

test('MAX session: строки избранного помечены устаревшими, счётчик не обнуляется', () => {
  const ui = maxUiFixture()
  const maxRow = stubNode('div', { classes: ['chat-row'], dataset: { pin: 'max-1' } })
  const tgRow = stubNode('div', { classes: ['chat-row'], dataset: { pin: 'tg-1' } })
  for (const row of [maxRow, tgRow]) row.appendChild(stubNode('span', { classes: ['row-stale', 'hidden'], text: '?' }))
  ui.doc.appendChild(maxRow)
  ui.doc.appendChild(tgRow)
  const state = {
    cfg: { pinned: [{ id: 'max-1', serviceId: 'max' }, { id: 'tg-1', serviceId: 'tg' }] },
    maxSession: { state: 'auth', streak: 2, since: REF_NOW, lastOkAt: REF_NOW, noticeSent: true },
    unreadTotals: { 'max-1': { c: 5, m: 0 } }
  }
  const ctx = sandbox(['maxSessionInfo', 'maxSessionAuth', 'maxSessionDiagnosticText',
    'applyMaxSessionUi', 'applyMaxStaleRows', 'maxSessionBar'], {
    Date, state, updateBadge2() {}, activateTab() {}, ...MAX_SESSION_CONSTS
  })
  ctx.applyMaxSessionUi(ui.doc)
  const marker = maxRow.querySelector('.row-stale')
  assert.equal(maxRow.classList.contains('stale'), true)
  assert.equal(marker.classList.contains('hidden'), false)
  assert.equal(marker.title, 'данные с последнего успешного опроса')
  assert.equal(tgRow.classList.contains('stale'), false, 'чужие строки не трогаем')
  assert.equal(tgRow.querySelector('.row-stale').classList.contains('hidden'), true)
  assert.deepEqual(state.unreadTotals['max-1'], { c: 5, m: 0 }, 'последний известный счётчик цел')
  assert.equal(ui.badge.textContent, '!', 'агрегат MAX не показывается как 0')
})

test('MAX session: возврат в ok снимает маркеры и полосу, показывает тост', () => {
  const ui = maxUiFixture()
  const maxRow = stubNode('div', { classes: ['chat-row'], dataset: { pin: 'max-1' } })
  maxRow.appendChild(stubNode('span', { classes: ['row-stale', 'hidden'], text: '?' }))
  ui.doc.appendChild(maxRow)
  const toasts = [], badgeWrites = []
  const state = {
    cfg: { pinned: [{ id: 'max-1', serviceId: 'max' }] },
    maxSession: { state: 'auth', streak: 2, since: REF_NOW, lastOkAt: REF_NOW, noticeSent: true },
    svcTabTotals: { max: { t: 3, m: 1 } }
  }
  const ctx = sandbox(['maxSessionInfo', 'noteMaxSession', 'maxSessionAuth', 'maxSessionDiagnosticText',
    'applyMaxSession', 'applyMaxSessionUi', 'applyMaxStaleRows', 'maxSessionBar'], {
    Date, state, document: ui.doc, toast: msg => toasts.push(msg), activateTab() {},
    updateBadge2(id, total, mentions, partial) {
      badgeWrites.push([id, total, mentions, partial])
      if (id === 'max') { ui.badge.textContent = total > 0 ? String(total) : ''; ui.badge.classList.toggle('on', total > 0) }
    },
    ...MAX_SESSION_CONSTS
  })
  ctx.applyMaxSessionUi(ui.doc)
  assert.equal(ui.badge.textContent, '!')
  ctx.applyMaxSession({ state: 'ok' })
  assert.equal(ui.badge.textContent, '3', 'вернулись последние счётчики')
  assert.equal(ui.badge.classList.contains('auth-required'), false)
  assert.equal(ui.tab.getAttribute('aria-label'), null)
  assert.equal(ui.combined.querySelector('[data-max-session-bar]'), null)
  assert.equal(ui.maxPane.querySelector('[data-max-session-bar]'), null)
  assert.equal(maxRow.classList.contains('stale'), false)
  assert.equal(maxRow.querySelector('.row-stale').classList.contains('hidden'), true)
  assert.ok(toasts.includes('MAX снова на связи'))
  assert.deepEqual(badgeWrites.at(-1), ['max', 3, 1, false])
})

// Общий гость для MAX-строк: реальный сериализованный экстрактор + часы теста.
function maxTimeHost(document) {
  let now = REF_NOW
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  const pin = { id: 'synthetic', serviceId: 'max', title: 'Synthetic room', url: 'https://fixture.invalid/-123' }
  const results = [], badges = []
  const guest = vm.createContext({ document, window: {} })
  guest.window.__hubMaxSweepAt = REF_NOW + 60000
  const view = {
    isConnected: true,
    async executeJavaScript(source) {
      const output = await new vm.Script(source).runInContext(guest)
      results.push(JSON.parse(output))
      return output
    }
  }
  const state = {
    cfg: { services: [{ id: 'max' }], pinned: [pin] }, svcViews: { max: view }, pinViews: {},
    pinAvatars: { synthetic: 'cached' }, unreadTotals: {}, unreadTotalsAt: {}, unreadBaseC: {},
    unreadBaseM: {}, prevUnread: {}, rankAct: {}, lastMsgAt: {}, lastMsgText: {}, lastMsgPreview: {},
    liveAct: {}, unreadDots: {}
  }
  const ctx = sandbox(['pollUnread', '__chatHubMaxUnread', '__chatHubGrabAvatar', '__chatHubScanRows',
    '__chatHubBoundedAvatar', 'formatMaxPreview', 'tabBadgeTotal', 'unreadDeltaFor', 'shouldBumpLiveAct',
    'shouldMergeDomTime', 'runUnreadJob', 'unreadViewState', 'unreadGuestCall', 'restorePreviewAuthor',
    'pollUnreadService', 'refreshUnreadPresentation', 'refreshSelectedUnread', 'parseChatTime',
    'mergeLastMessageTime', 'fmtChatWhen', 'mergeMaxLastMessageTime', 'maxSessionInfo', 'noteMaxSession',
    'maxSessionAuth', '__chatHubMaxSession', 'applyMaxSession'], {
    Date: Clock, setTimeout, clearTimeout, state, favoritesOf: () => [pin], svcViewFor: () => view,
    document: { querySelector: () => null }, updateBadge2: (...args) => badges.push(args), updateBadge() {},
    sortFavoritesByActivity() {}, scheduleActSave() {},
    __chatHubGrabAvatar: function () {}, formatMaxPreview: function () {}
  })
  ctx.UNREAD_EXTRACTORS = { max: ctx.__chatHubMaxUnread }
  return {
    ctx, state, guest, pin, results, badges,
    setDocument(next) { guest.document = next },
    advance(ms) { now += ms },
    async poll() { await ctx.pollUnread(); return results.at(-1) }
  }
}

// Строка MAX в изобретённом DOM: время только из перечисленных источников.
function maxTimeRow({ meta = null, datetime = '', title = '', badge = null } = {}) {
  return {
    cloneNode() { return this },
    getBoundingClientRect() { return { width: 120, height: 42 } },
    querySelector(selector) {
      if (selector === 'span.name' || selector === 'h3.title') return { textContent: 'MAX room' }
      if (selector === '.meta') return meta
      if (selector === '[datetime]') return datetime ? { getAttribute: name => name === 'datetime' ? datetime : null } : null
      if (selector === '[title*=":"]') return title ? { getAttribute: name => name === 'title' ? title : null } : null
      return null
    },
    querySelectorAll(selector) {
      return selector === '.indicator' ? (badge === null ? [] : [{ textContent: String(badge) }]) : []
    }
  }
}
const maxMetaNode = parts => ({
  textContent: parts.join(''),
  querySelectorAll(selector) { return selector === '.text' ? parts.map(text => ({ textContent: text })) : [] }
})

async function maxExtract(row) {
  const ctx = sandbox(['__chatHubMaxUnread', 'parseChatTime'], {
    document: { querySelectorAll(selector) { return selector === 'aside div.item' ? [row] : [] } },
    __chatHubScanRows: async collect => collect(),
    __chatHubBoundedAvatar: async () => null,
    formatMaxPreview: () => ''
  })
  return JSON.parse(await ctx.__chatHubMaxUnread([{ id: 'max-room', title: 'MAX room' }], false))
}

test('MAX: время строки читается из .meta/.meta .text/[datetime]/[title] без маркеров доставки', async () => {
  const fromText = await maxExtract(maxTimeRow({ meta: maxMetaNode(['\u200b✓ ', '17:30', '\u200b']) }))
  assert.equal(fromText.favs[0].time, '17:30')
  const fromControl = await maxExtract(maxTimeRow({ meta: maxMetaNode(['\u0000', '17:30']) }))
  assert.equal(fromControl.favs[0].time, '17:30')
  const iso = '2026-11-23T17:30:00'
  const fromDatetime = await maxExtract(maxTimeRow({ meta: maxMetaNode(['Доставлено']), datetime: iso }))
  assert.equal(fromDatetime.favs[0].time, iso)
  const fromTitle = await maxExtract(maxTimeRow({ title: 'Доставлено в 17:30' }))
  assert.equal(fromTitle.favs[0].time, '17:30')
})

test('parseChatTime: ISO-время из [datetime] — локальные часы и минуты', () => {
  const ctx = sandbox(['parseChatTime'])
  const parsed = ctx.parseChatTime('2026-11-23T17:30:00')
  const at = new Date(parsed.at)
  assert.equal(parsed.dayOnly, false)
  assert.equal(at.getHours(), 17)
  assert.equal(at.getMinutes(), 30)
  assert.equal(ctx.parseChatTime('2026-13-45T99:99:00').at, 0)
})

test('MAX: непрочитанное без разобранного времени поднимает чат один раз (фолбэк)', async () => {
  const h = maxTimeHost(maxList({ badge: 2, time: '---' }))
  await h.poll()
  assert.equal(h.state.lastMsgAt.synthetic, REF_NOW)
  assert.equal(h.state.lastMsgSource.synthetic.source, 'max-unread-fallback')
  assert.equal(h.state.lastMsgSource.synthetic.at, REF_NOW)
})

test('MAX: повторный опрос с тем же непрочитанным не двигает фолбэк-время', async () => {
  const h = maxTimeHost(maxList({ badge: 2, time: '---' }))
  await h.poll()
  const first = h.state.lastMsgAt.synthetic
  h.advance(30000)
  h.setDocument(maxList({ badge: 2, time: '---' }))
  await h.poll()
  assert.equal(h.state.lastMsgAt.synthetic, first, 'время фолбэка не переписывается')
})

test('MAX: свежий переход 0→2 ставит фолбэк, снятие непрочитанного — нет', async () => {
  const h = maxTimeHost(maxList({ badge: null }))
  await h.poll()
  assert.equal(h.state.lastMsgAt.synthetic || 0, 0)
  h.advance(10000)
  h.setDocument(maxList({ badge: 2 }))
  await h.poll()
  assert.equal(h.state.lastMsgAt.synthetic, REF_NOW + 10000, 'переход 0→2 поднимает чат')
  assert.equal(h.state.lastMsgSource.synthetic.source, 'max-unread-fallback')
  h.advance(10000)
  h.setDocument(maxList({ badge: null }))
  await h.poll()
  assert.equal(h.state.lastMsgAt.synthetic, REF_NOW + 10000, 'снятие непрочитанного не двигает время')
})

test('MAX: разобранное время строки побеждает фолбэк', async () => {
  const h = maxTimeHost(maxList({ badge: 2, time: '---' }))
  await h.poll()
  assert.equal(h.state.lastMsgAt.synthetic, REF_NOW)
  h.advance(60000)
  h.setDocument(maxList({ badge: 2, time: '10:24' }))
  await h.poll()
  assert.equal(h.state.lastMsgAt.synthetic, clockAt(10, 24), 'реальное время важнее синтетического')
  assert.equal(h.state.lastMsgSource.synthetic, undefined)
})

test('MAX session: при разлогине опрос сохраняет последние счётчики и время', async () => {
  const loginDoc = {
    readyState: 'complete',
    body: { innerText: 'Войдите по номеру телефона' },
    querySelector() { return null },
    querySelectorAll(selector) { return selector === 'input[type=tel]' ? [{}] : [] }
  }
  const h = maxTimeHost(loginDoc)
  h.state.unreadTotals.synthetic = { c: 5, m: 0 }
  h.state.unreadTotalsAt.synthetic = 12345
  h.state.prevUnread.synthetic = 6
  h.state.lastMsgAt.synthetic = REF_NOW - 3600000
  await h.poll()
  assert.equal(h.ctx.maxSessionAuth(), false, 'первый опрос не индицируется')
  await h.poll()
  assert.equal(h.ctx.maxSessionAuth(), true, 'второй опрос подряд — разлогин')
  assert.deepEqual(h.state.unreadTotals.synthetic, { c: 5, m: 0 })
  assert.equal(h.state.unreadTotalsAt.synthetic, 12345)
  assert.equal(h.state.lastMsgAt.synthetic, REF_NOW - 3600000, 'время не выдумывается')
  assert.deepEqual(h.badges.at(-1), ['combined', 5, 0], 'агрегат не обнуляется')
  assert.equal(h.badges.some(args => args[0] === 'max' && args[1] === ''), false, 'счётчик MAX не сбрасывается в ноль')
})

test('MAX session: при живом входе экстрактор работает как раньше', async () => {
  const rows = maxList({ badge: 7, preview: 'привет', time: '10:24' }).querySelectorAll('aside div.item')
  const signedIn = {
    readyState: 'complete',
    body: { innerText: '' },
    querySelector(selector) { return null },
    querySelectorAll(selector) {
      if (selector === 'aside div.item') return rows
      if (selector === 'button.main[aria-label]') return [{}]
      return []
    }
  }
  const h = unreadFixture('max', signedIn)
  const result = await h.poll()
  assert.equal(result.session.state, 'ok')
  assert.equal(result.favs[0].found, true)
  assert.equal(result.favs[0].count, 7)
  assert.equal(result.favs[0].time, '10:24')
  assert.equal(result.favs[0].preview, 'привет')
  assert.equal(result.observedTotals.total, 7)
  assert.equal(result.coverage.complete, false)
})

/* ---------- журнал сеансов (общий для всех мессенджеров) ---------- */

// Минимальный DOM для блока «Состояние сеансов»: только #session-state-rows.
// innerHTML-сеттер бросает — данные обязаны идти через textContent.
function sessionDiagDoc() {
  const make = tag => {
    const node = {
      tag,
      className: '',
      textContent: '',
      children: [],
      appendChild(child) { this.children.push(child); return child },
      removeChild(child) {
        const index = this.children.indexOf(child)
        if (index >= 0) this.children.splice(index, 1)
        return child
      },
      get firstChild() { return this.children[0] || null }
    }
    Object.defineProperty(node, 'innerHTML', {
      get() { return '' },
      set() { throw new Error('данные блока сеансов не должны идти в HTML') }
    })
    return node
  }
  const doc = make('#document')
  const host = make('div')
  doc.createElement = tag => make(tag)
  doc.querySelector = selector => selector === '#session-state-rows' ? host : null
  doc.appendChild(host)
  return { doc, host }
}

function sessionClock(now) {
  return class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now.now])) }
    static now() { return now.now }
  }
}

// Константы журнала берём из самого renderer.js — тест не дублирует список сервисов.
const SESSION_JOURNAL_CONSTS = (() => {
  const start = SRC.indexOf('const SERVICE_SESSION_IDS')
  const end = SRC.indexOf('function serviceSessionLogStore')
  const ctx = vm.createContext({})
  vm.runInContext(SRC.slice(start, end), ctx)
  return vm.runInContext('({ SERVICE_SESSION_IDS, SERVICE_SESSION_LOG_LIMIT, SERVICE_TIME_FALLBACK_LIMIT, SERVICE_SESSION_LABELS, SERVICE_SESSION_STATE_LABELS })', ctx)
})()

const SESSION_JOURNAL_FUNCS = ['noteServiceSession', 'serviceSessionState', 'serviceSessionEntries',
  'serviceSessionLogStore', 'serviceSessionStateLabel', 'serviceSessionLastOkAt', 'writeThroughServiceActivity',
  'snapshotServiceSessionLog', 'snapshotServiceTimeFallbackLog', 'normalizeServiceSessionEntry',
  'restoreServiceSessionLog', 'normalizeServiceTimeFallbackEntry', 'restoreServiceTimeFallbackLog',
  'noteServiceTimeFallback', 'serviceTimeFallbackLogStore', 'formatSessionLogTime']

test('журнал сеансов: запись только при смене состояния сервиса, повторный опрос не пишет', () => {
  const now = { now: REF_NOW }
  const state = {
    cfg: { activity: {} },
    serviceSessionLog: { mm: [], max: [], tg: [], ydx: [] },
    serviceTimeFallbackLog: []
  }
  const ctx = sandbox(SESSION_JOURNAL_FUNCS, { Date: sessionClock(now), state, scheduleActSave() {}, ...SESSION_JOURNAL_CONSTS })
  assert.equal(ctx.serviceSessionState('max'), 'unknown', 'до наблюдений состояние неизвестно')
  const first = ctx.noteServiceSession('max', { state: 'auth' })
  assert.equal(first.changed, true, 'первое наблюдение пишется')
  assert.equal(ctx.serviceSessionEntries('max').length, 1)
  now.now += 1000
  const repeat = ctx.noteServiceSession('max', { state: 'auth' })
  assert.equal(repeat.changed, false)
  assert.equal(ctx.serviceSessionEntries('max').length, 1, 'повторный auth не добавляет запись')
  now.now += 1000
  const back = ctx.noteServiceSession('max', { state: 'ok' })
  assert.equal(back.changed, true, 'возврат в ok — новая запись')
  const entries = ctx.serviceSessionEntries('max')
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map(entry => entry.state), ['auth', 'ok'])
  assert.equal(entries[1].lastOkAt, REF_NOW + 2000, 'lastOkAt фиксирует успешный опрос')
  assert.equal(ctx.serviceSessionState('max'), 'ok')
  assert.equal(state.cfg.activity.serviceSessionLog.max.length, 2, 'журнал пишется сквозь cfg.activity')
})

test('журнал сеансов: лимит 20 — старые записи вытесняются', () => {
  const now = { now: REF_NOW }
  const state = { cfg: { activity: {} }, serviceSessionLog: { mm: [], max: [], tg: [], ydx: [] }, serviceTimeFallbackLog: [] }
  const ctx = sandbox(SESSION_JOURNAL_FUNCS, { Date: sessionClock(now), state, scheduleActSave() {}, ...SESSION_JOURNAL_CONSTS })
  for (let i = 0; i < 25; i++) {
    now.now += 1000
    ctx.noteServiceSession('tg', { state: i % 2 === 0 ? 'unknown' : 'ok' })
  }
  const entries = ctx.serviceSessionEntries('tg')
  assert.equal(entries.length, 20, 'в журнале остаются только последние 20 записей')
  assert.equal(entries[0].at, REF_NOW + 6000, 'самая старая из выживших — 6-я запись')
  assert.equal(entries.at(-1).at, REF_NOW + 25000)
  assert.equal(ctx.serviceSessionState('tg'), 'unknown', 'последняя запись — unknown (25-й опрос)')
})

test('журнал сеансов: MAX пишет через общий API, антидребезг и тексты сохранены', () => {
  const now = { now: REF_NOW }
  const state = { cfg: { activity: {}, pinned: [] }, serviceSessionLog: { mm: [], max: [], tg: [], ydx: [] }, serviceTimeFallbackLog: [] }
  const ctx = sandbox(['maxSessionInfo', 'noteMaxSession', 'maxSessionAuth', 'maxSessionDiagnosticText', ...SESSION_JOURNAL_FUNCS], {
    Date: sessionClock(now), state, scheduleActSave() {}, ...SESSION_JOURNAL_CONSTS
  })
  const first = ctx.noteMaxSession({ state: 'auth' })
  assert.equal(first.state, 'unknown', 'одиночный разлогин по-прежнему не индицируется')
  assert.deepEqual(ctx.serviceSessionEntries('max').map(entry => entry.state), ['unknown'],
    'первое наблюдение попадает в общий журнал')
  assert.equal(ctx.noteMaxSession({ state: 'auth' }).state, 'auth')
  assert.deepEqual(ctx.serviceSessionEntries('max').map(entry => entry.state), ['unknown', 'auth'])
  ctx.noteMaxSession({ state: 'auth' })
  assert.equal(ctx.serviceSessionEntries('max').length, 2, 'повторный auth журнал не пополняет')
  now.now += 5000
  ctx.noteMaxSession({ state: 'ok' })
  assert.equal(ctx.serviceSessionState('max'), 'ok')
  assert.match(ctx.maxSessionDiagnosticText(), /MAX: связь есть/, 'тексты диагностики MAX не изменились')
  // разлогин после успеха: lastOkAt берётся из журнала
  now.now += 5000
  ctx.noteMaxSession({ state: 'auth' })
  ctx.noteMaxSession({ state: 'auth' })
  const last = ctx.serviceSessionEntries('max').at(-1)
  assert.equal(last.state, 'auth')
  assert.equal(last.lastOkAt, REF_NOW + 5000, 'в записи разлогина остаётся время последнего успеха')
})

test('журнал сеансов: mm/tg/ydx пишут unknown и не рисуют маркер', async () => {
  const now = { now: REF_NOW }
  const state = { cfg: { activity: {}, pinned: [] }, serviceSessionLog: { mm: [], max: [], tg: [], ydx: [] }, serviceTimeFallbackLog: [] }
  const ctx = sandbox(SESSION_JOURNAL_FUNCS, { Date: sessionClock(now), state, scheduleActSave() {}, ...SESSION_JOURNAL_CONSTS })
  for (const id of ['mm', 'tg', 'ydx']) {
    assert.equal(ctx.noteServiceSession(id, { state: 'unknown' }).changed, true)
    ctx.noteServiceSession(id, { state: 'unknown' })
    assert.equal(ctx.serviceSessionEntries(id).length, 1, id + ': повторный опрос не пишет')
    assert.equal(ctx.serviceSessionState(id), 'unknown')
  }
  // Опрос TG идёт тем же путём, что и в приложении: запись в журнал есть,
  // MAX-состояние/маркеры не появляются.
  const pin = { id: 'synthetic', serviceId: 'tg', title: 'Synthetic room', url: 'https://fixture.invalid/-123' }
  const badges = []
  const view = { isConnected: true, async executeJavaScript() { return JSON.stringify({ favs: [{ id: 'synthetic', found: true, count: 0, mentions: 0 }] }) } }
  const pollState = {
    cfg: { services: [{ id: 'tg' }], pinned: [pin], activity: {} },
    svcViews: { tg: view }, pinViews: {}, activePinId: '',
    pinAvatars: { synthetic: 'cached' }, unreadTotals: {}, unreadTotalsAt: {}, unreadBaseC: {}, unreadBaseM: {},
    prevUnread: {}, rankAct: {}, lastMsgAt: {}, lastMsgText: {}, lastMsgPreview: {}, liveAct: {}, svcTabTotals: {},
    unreadDots: {}, serviceSessionLog: { mm: [], max: [], tg: [], ydx: [] }, serviceTimeFallbackLog: []
  }
  const poll = sandbox(['pollUnreadService', 'unreadViewState', 'unreadGuestCall', 'tabBadgeTotal', 'unreadDeltaFor',
    'shouldBumpLiveAct', 'shouldMergeDomTime', 'restorePreviewAuthor', 'probeActivePinView', 'mergeActivePinViewMetadata',
    'parseChatTime', 'mergeLastMessageTime', 'fmtChatWhen', ...SESSION_JOURNAL_FUNCS], {
    Date: sessionClock(now), state: pollState, favoritesOf: () => [pin], svcViewFor: () => view,
    document: { querySelector: () => null }, updateBadge2: (...args) => badges.push(args), updateBadge() {},
    sortFavoritesByActivity() {}, scheduleActSave() {}, ...SESSION_JOURNAL_CONSTS
  })
  poll.UNREAD_EXTRACTORS = { tg: function () { return '{}' } }
  const job = { check() {}, async wait(operation) { return operation() } }
  await poll.pollUnreadService({ id: 'tg' }, job)
  await poll.pollUnreadService({ id: 'tg' }, job)
  assert.equal(pollState.serviceSessionLog.tg.length, 1, 'опрос TG фиксирует unknown один раз')
  assert.equal(pollState.serviceSessionLog.tg[0].state, 'unknown')
  assert.deepEqual(pollState.serviceSessionLog.max, [], 'MAX журнал не трогает')
  assert.equal(pollState.maxSession, undefined, 'маркер MAX для TG не создаётся')
})

test('журнал сеансов и фолбэк времени переживают перезапуск (сохранение → восстановление)', () => {
  const now = { now: REF_NOW }
  const state = {
    cfg: { activity: {}, pinned: [{ id: 'pin-1', serviceId: 'max', title: 'Рабочий чат' }] },
    lastMsgAt: {}, lastMsgDayOnly: {}, lastMsgSource: {}, lastMsgText: {}, lastMsgPreview: {}, msgAuth: {},
    liveAct: {}, tgPeerOf: {}, prevUnread: {}, unreadBaseC: {}, unreadBaseM: {}, unreadTotals: {},
    unreadTotalsAt: {}, unreadDots: {}, svcTabTotals: {},
    serviceSessionLog: { mm: [], max: [], tg: [], ydx: [] }, serviceTimeFallbackLog: []
  }
  const ctx = sandbox(['activitySnapshot', ...SESSION_JOURNAL_FUNCS], { Date: sessionClock(now), state, scheduleActSave() {}, ...SESSION_JOURNAL_CONSTS })
  ctx.noteServiceSession('max', { state: 'auth', lastOkAt: REF_NOW - 3600000 })
  ctx.noteServiceTimeFallback('max', 'pin-1', 'Рабочий чат')
  const snapshot = ctx.activitySnapshot()
  assert.equal(snapshot.serviceSessionLog.max.length, 1)
  assert.equal(snapshot.serviceTimeFallbackLog.length, 1)

  // «Перезапуск»: новый state, восстановление из снимка activity.
  const fresh = { serviceSessionLog: { mm: [], max: [], tg: [], ydx: [] }, serviceTimeFallbackLog: [] }
  const restored = sandbox(['serviceSessionState', 'serviceSessionEntries', 'serviceSessionLogStore',
    'restoreServiceSessionLog', 'restoreServiceTimeFallbackLog',
    'normalizeServiceSessionEntry', 'normalizeServiceTimeFallbackEntry'], {
    Date: sessionClock(now), state: fresh, ...SESSION_JOURNAL_CONSTS
  })
  fresh.serviceSessionLog = restored.restoreServiceSessionLog(snapshot.serviceSessionLog)
  fresh.serviceTimeFallbackLog = restored.restoreServiceTimeFallbackLog(snapshot.serviceTimeFallbackLog)
  assert.equal(restored.serviceSessionState('max'), 'auth', 'состояние сеанса переживает перезапуск')
  assert.equal(fresh.serviceTimeFallbackLog.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.serviceTimeFallbackLog[0])),
    { at: REF_NOW, service: 'max', pinId: 'pin-1', title: 'Рабочий чат' }, 'фолбэк времени восстановлен')
  assert.equal(fresh.serviceSessionLog.max[0].lastOkAt, REF_NOW - 3600000)
  // Белый список: мусор из конфига не восстанавливается.
  const garbage = restored.restoreServiceSessionLog({
    mm: [{ at: 'позавчера', state: 'ok' }, { at: REF_NOW, state: 'auth', junk: 1 }],
    evil: [{ at: REF_NOW, state: 'ok' }]
  })
  assert.deepEqual(Object.keys(garbage).sort(), ['max', 'mm', 'tg', 'ydx'], 'только известные сервисы')
  assert.equal(garbage.mm.length, 1)
  assert.deepEqual(Object.keys(garbage.mm[0]).sort(), ['at', 'state'], 'лишние поля записи отброшены')
  assert.equal(restored.restoreServiceTimeFallbackLog([{ at: REF_NOW, service: 'zzz' }, { at: 0, service: 'max' }]).length, 0)
})

test('MAX: фолбэк времени логируется один раз на переход, а не каждый опрос', () => {
  const now = { now: REF_NOW }
  const state = {
    cfg: { activity: {}, pinned: [{ id: 'synthetic', serviceId: 'max', title: 'Synthetic room' }] },
    lastMsgAt: {}, lastMsgDayOnly: {}, lastMsgText: {}, lastMsgSource: {}, prevUnread: {},
    serviceSessionLog: { mm: [], max: [], tg: [], ydx: [] }, serviceTimeFallbackLog: []
  }
  const ctx = sandbox(['mergeMaxLastMessageTime', 'mergeLastMessageTime', 'fmtChatWhen', 'parseChatTime', ...SESSION_JOURNAL_FUNCS], {
    Date: sessionClock(now), state, scheduleActSave() {}, ...SESSION_JOURNAL_CONSTS
  })
  const row = { found: true, unread: 2, count: 2, time: '---' }
  assert.equal(ctx.mergeMaxLastMessageTime(row, 'synthetic', 'https://fixture.invalid/-123'), 'fallback')
  assert.equal(state.serviceTimeFallbackLog.length, 1, 'переход 0→2 пишет фолбэк в журнал')
  state.prevUnread.synthetic = 2
  now.now += 30000
  assert.equal(ctx.mergeMaxLastMessageTime(row, 'synthetic', 'https://fixture.invalid/-123'), '')
  assert.equal(state.serviceTimeFallbackLog.length, 1, 'повторный опрос с тем же непрочитанным не пишет')
  assert.deepEqual(JSON.parse(JSON.stringify(state.serviceTimeFallbackLog[0])),
    { at: REF_NOW, service: 'max', pinId: 'synthetic', title: 'Synthetic room' })
})

test('Диагностика: «Состояние сеансов» показывает последние записи только через textContent', () => {
  const now = { now: REF_NOW }
  const state = {
    cfg: { activity: {}, pinned: [] },
    serviceSessionLog: {
      mm: [{ at: REF_NOW, state: 'unknown' }],
      max: [{ at: REF_NOW - 300000, state: 'ok', lastOkAt: REF_NOW - 300000 },
        { at: REF_NOW, state: 'ok', lastOkAt: REF_NOW },
        { at: REF_NOW + 60000, state: 'auth', lastOkAt: REF_NOW }],
      tg: [], ydx: []
    },
    serviceTimeFallbackLog: [
      { at: REF_NOW - 120000, service: 'max', pinId: 'p1', title: 'Старый чат' },
      { at: REF_NOW, service: 'max', pinId: 'p2', title: 'Рабочий чат' }
    ]
  }
  const { doc, host } = sessionDiagDoc()
  const ctx = sandbox(['renderServiceSessionDiagnostics', ...SESSION_JOURNAL_FUNCS], { Date: sessionClock(now), state, ...SESSION_JOURNAL_CONSTS })
  ctx.renderServiceSessionDiagnostics(doc)
  const texts = host.children.map(row => row.textContent)
  assert.ok(texts.includes('MAX — завершён'), 'текущее состояние сервиса: ' + texts.join(' | '))
  assert.ok(texts.includes('Mattermost — неизвестно'))
  assert.ok(texts.includes('Telegram — неизвестно'))
  assert.ok(texts.includes('· 23.11.2026 12:01 — завершён'), 'последняя запись журнала с локальным временем')
  assert.ok(texts.includes('· 23.11.2026 12:00 — есть'), 'предыдущая запись журнала')
  assert.ok(texts.includes('Фолбэк времени'))
  assert.ok(texts.includes('· MAX — «Рабочий чат» — 23.11.2026 12:00'), 'фолбэк: сервис, чат, время')
  assert.ok(texts.includes('· MAX — «Старый чат» — 23.11.2026 11:58'))
  assert.equal(host.children.filter(row => row.className === 'session-state-entry').length,
    8, 'по 3 записи журнала на сервис (или «записей нет») и 3 последних фолбэка')
  assert.equal(host.children.filter(row => row.className === 'session-state-row').length,
    5, 'четыре сервиса + заголовок журнала фолбэков')
  // Перерисовка заменяет строки, а не копит их; innerHTML-сеттер не вызывается.
  ctx.renderServiceSessionDiagnostics(doc)
  assert.deepEqual(host.children.map(row => row.textContent), texts)
})

/* ---------- MCP: подсказка у кнопки выгрузки и человеческий текст ошибки MAX ---------- */

// Панель MCP с подсказкой: общий mcpPanel собирает фиксированный список функций
// и про mcpRunHintText не знает, поэтому доинициализируем её в том же
// vm-контексте и пересобираем панель. Сам mcpPanel не меняем.
function mcpHintPanel(cfg = {}, hub = {}) {
  const panel = mcpPanel(cfg, hub)
  vm.runInContext(extractFunction('mcpRunHintText'), panel.ctx)
  panel.ctx.renderMcpSettings(panel.host)
  panel.ctx.initMcpSettings(panel.sec)
  return panel
}

test('MCP: подсказка у кнопки выгрузки показывает причину в трёх состояниях', async () => {
  // 1. Папка не выбрана.
  const noDir = mcpHintPanel()
  const noDirHint = noDir.byId('mcp-run-hint')
  assert.ok(noDirHint, 'подсказка #mcp-run-hint есть в блоке MCP')
  assert.equal(noDirHint.textContent, 'Укажите папку выгрузки')
  assert.equal(noDirHint.hidden, false, 'подсказка видна всегда, без наведения')
  assert.equal(noDirHint.parentElement.className, 'mcp-run', 'подсказка стоит рядом с кнопкой выгрузки')
  assert.equal(noDir.byId('mcp-export-run').disabled, true)

  // 2. Папка есть, но проектов в избранном нет.
  const noProjects = mcpHintPanel({ mcpExportDir: 'C:\\Выгрузка' })
  assert.equal(noProjects.byId('mcp-run-hint').textContent, 'Заполните проект хотя бы у одного чата в Избранном')
  assert.equal(noProjects.byId('mcp-export-run').disabled, true)

  // 3. Папка и хотя бы один проект — выгрузка доступна.
  const ready = mcpHintPanel({ mcpExportDir: 'C:\\Выгрузка', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] })
  assert.equal(ready.byId('mcp-run-hint').textContent, 'Готово к выгрузке')
  assert.equal(ready.byId('mcp-export-run').disabled, false)

  // Подсказка обновляется тем же updateRun, что и кнопка: выбор папки меняет
  // текст без пересоздания панели.
  const live = mcpHintPanel({ pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpChooseDir: async () => ({ canceled: false, path: 'C:\\Выгрузка' })
  })
  assert.equal(live.byId('mcp-run-hint').textContent, 'Укажите папку выгрузки')
  await live.byId('mcp-choose-dir').onclick()
  assert.equal(live.byId('mcp-run-hint').textContent, 'Готово к выгрузке', 'после выбора папки подсказка обновилась')
  assert.equal(live.byId('mcp-export-run').disabled, false)

  // Кнопка остаётся заблокированной, но причина видна текстом, а не только в title.
  const ctx = sandbox(['mcpExportBlockedReason', 'mcpRunHintText'])
  assert.equal(ctx.mcpRunHintText({ mcpExportDir: '', pinned: [] }), 'Укажите папку выгрузки')
  assert.equal(ctx.mcpRunHintText({ mcpExportDir: 'C:\\out', pinned: [] }), 'Заполните проект хотя бы у одного чата в Избранном')
  assert.equal(ctx.mcpRunHintText({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p', mcpProject: '14544' }] }), 'Готово к выгрузке')
})

test('MCP: отчёт по MAX без окна даёт ровно одну человеческую строку', async () => {
  const report = {
    ok: true,
    files: [],
    chats: [
      { pinId: 'p1', service: 'max', status: 'error', code: 'NO_CDP', count: 0 },
      { pinId: 'p2', service: 'max', status: 'error', code: 'HEADER_MISMATCH', count: 0 },
      { pinId: 'p3', service: 'mm', status: 'ok', count: 4 }
    ],
    truncated: false,
    errors: []
  }
  const panel = mcpPanel({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpExport: async () => report
  })
  await panel.byId('mcp-export-run').onclick()
  const text = panel.byId('mcp-report').textContent
  assert.equal((text.match(/Start-MAX-Window\.cmd/g) || []).length, 1, 'одна строка на весь отчёт, не на каждый чат')
  assert.match(text, /Окно MAX не открыто или сеанс завершён — запустите Start-MAX-Window\.cmd и войдите/)
  // По-прежнему видны коды каждого чата: человеческая строка их не заменяет.
  assert.match(text, /NO_CDP/)
  assert.match(text, /HEADER_MISMATCH/)

  // Без NO_CDP/HEADER_MISMATCH человеческой строки нет.
  const quiet = mcpPanel({ mcpExportDir: 'C:\\out', pinned: [{ id: 'p1', serviceId: 'mm', mcpProject: '14544' }] }, {
    mcpExport: async () => ({ ok: true, files: [], chats: [{ service: 'max', status: 'ok', count: 2 }], truncated: false, errors: [] })
  })
  await quiet.byId('mcp-export-run').onclick()
  assert.equal(quiet.byId('mcp-report').textContent.includes('Start-MAX-Window.cmd'), false)
})

test('MCP: человеческий текст ошибки MAX одинаков и в чистом mcpReportLines', () => {
  const line = 'Окно MAX не открыто или сеанс завершён — запустите Start-MAX-Window.cmd и войдите'
  const ctx = sandbox(['mcpReportLines', 'mcpServiceName', 'mcpChatStatusText', 'mcpCoverageText', 'mcpBaseName', 'mcpErrorExplanation'])
  const lines = ctx.mcpReportLines({
    ok: true, files: [],
    chats: [{ service: 'max', status: 'error', code: 'NO_CDP' }, { service: 'max', status: 'error', code: 'HEADER_MISMATCH' }],
    truncated: false, errors: []
  })
  assert.equal(lines.filter(text => text === line).length, 1)
})

// --- MAX-выгрузка из webview ChatHub: синтетическая страница MAX ---
// Селекторы production-кода проверяются один в один: незнакомый селектор —
// ошибка фикстуры, а не «тихо ничего не нашли». Ни Electron, ни сети нет.
class MaxNode {
  constructor(tag, { classes = '', attrs = {}, text = '', children = [], onClick = null } = {}) {
    this.tag = tag
    this.classes = classes ? classes.split(/\s+/).filter(Boolean) : []
    this.attrs = attrs || {}
    this.text = text
    this.children = children
    this.onClick = onClick
    for (const child of children) child.parent = this
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join('') }
  // Как в браузере: className строкой и проверка наличия атрибута — этим
  // пользуется диагностика второго замера.
  get className() { return this.classes.join(' ') }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) }
  click() { if (typeof this.onClick === 'function') this.onClick() }
  // События колеса: виртуальная лента MAX реагирует на wheel, даже когда
  // контейнер не переполнен (scrollHeight == clientHeight).
  dispatchEvent(event) {
    if (event && event.type === 'wheel' && typeof this.onWheel === 'function') this.onWheel(event)
    return true
  }
  getBoundingClientRect() { return { width: 240, height: 32, top: 0, left: 0 } }
  matches(selector) {
    // Звёздочка нужна диагностике: она сканирует все элементы документа.
    if (selector.trim() === '*') return true
    const m = /^([a-zA-Z0-9]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(selector.trim())
    if (!m) throw new Error('неподдерживаемый селектор: ' + selector)
    if (m[1] && this.tag.toLowerCase() !== m[1].toLowerCase()) return false
    for (const cls of m[2].split('.').filter(Boolean)) if (!this.classes.includes(cls)) return false
    for (const attr of m[3].match(/\[[^\]]+\]/g) || []) {
      const body = attr.slice(1, -1)
      if (!Object.prototype.hasOwnProperty.call(this.attrs, body.split('=')[0])) return false
      const eq = body.indexOf('=')
      if (eq >= 0) {
        const value = body.slice(eq + 1).replace(/^["']|["']$/g, '')
        if (String(this.attrs[body.slice(0, eq)]) !== value) return false
      }
    }
    return true
  }
  querySelectorAll(selector) {
    const chains = selector.split(',').map(part => part.trim().split(/\s+/))
    const found = []
    const visit = node => {
      for (const child of node.children) {
        const hit = chains.some(chain => {
          if (!child.matches(chain[chain.length - 1])) return false
          let index = chain.length - 2
          let ancestor = node
          while (index >= 0 && ancestor) {
            if (ancestor.matches(chain[index])) index -= 1
            ancestor = ancestor.parent
          }
          return index < 0
        })
        if (hit) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
}

function maxHistoryNode(chat) {
  const children = []
  let lastDate = null
  for (const message of chat.messages) {
    // Служебная капсула («Непрочитанные» и т.п.) — отдельный span.capsule,
    // дату следующих сообщений она не меняет.
    if (message.service) children.push(new MaxNode('span', { classes: 'capsule', text: message.service }))
    const date = message.date || null
    if (date && date !== lastDate) {
      children.push(new MaxNode('span', { classes: 'capsule', text: date }))
      lastDate = date
    }
    const texts = [new MaxNode('span', { classes: 'text', attrs: { 'data-message-markup': '' }, text: message.text || '' })]
    if (message.dupText) texts.push(new MaxNode('span', { classes: 'text', attrs: { 'data-message-markup': '' }, text: 'дубль' }))
    const metaChildren = []
    // timeClass — мета времени бывает не только span.text, но и span.time.
    if (message.time) metaChildren.push(new MaxNode('span', { classes: message.timeClass || 'text', text: message.time }))
    // metaDate — дата в мете старого сообщения («31 мая», «29.05»), без капсулы.
    if (message.metaDate) metaChildren.push(new MaxNode('span', { classes: 'text', text: message.metaDate }))
    // metaText — произвольная подпись меты («ред. 20:21»).
    if (message.metaText) metaChildren.push(new MaxNode('span', { classes: 'text', text: message.metaText }))
    if (message.edited) metaChildren.push(new MaxNode('span', { classes: 'text', text: 'изменено' }))
    const bubble = [
      ...texts,
      new MaxNode(message.metaTag || 'span', { classes: message.metaClass || 'meta', children: metaChildren })
    ]
    const body = new MaxNode('div', {
      classes: 'message' + (message.out ? ' message--isOut' : ''),
      attrs: { role: 'article' },
      children: [new MaxNode('div', { classes: 'bubble', children: [new MaxNode('div', { classes: 'bubbleContent', children: bubble })] })]
    })
    const wrapper = [body]
    if (message.author) {
      wrapper.unshift(new MaxNode('div', { classes: 'author', children: [new MaxNode('span', { classes: 'name', text: message.author })] }))
    }
    children.push(new MaxNode('div', { classes: 'messageWrapper', attrs: { role: 'article' }, children: wrapper }))
  }
  return new MaxNode('div', { classes: 'history history--withBottomMargin', attrs: { 'data-scale': '1' }, children })
}

function maxFakePage(chats, options = {}) {
  const page = {
    chats,
    current: chats[0].title,
    location: { pathname: chats[0].pathname },
    clickable: options.clickable !== false,
    header: options.header !== false,
    headerTitle: options.headerTitle || null,
    rootCount: options.rootMissing === true ? 0 : (options.rootCount === undefined ? 1 : options.rootCount)
  }
  const document = {
    querySelectorAll(selector) {
      const aside = new MaxNode('aside')
      for (const chat of page.chats) {
        // Production-разметка MAX: строка списка — button.cell, заголовок —
        // h3.title .name .text (проверено в max-mcp-b22-runtime live_browser.py).
        const row = new MaxNode('button', {
          classes: 'cell',
          children: [
            new MaxNode('h3', {
              classes: 'title',
              children: [
                new MaxNode('span', {
                  classes: 'name',
                  children: [new MaxNode('span', { classes: 'text', text: chat.title })]
                })
              ]
            })
          ]
        })
        row.onClick = () => {
          if (!page.clickable) return
          page.current = chat.title
          page.location.pathname = chat.pathname
        }
        aside.children.push(row)
        row.parent = aside
      }
      const roots = [aside]
      if (page.header) {
        roots.push(new MaxNode('button', {
          classes: 'main',
          attrs: { 'aria-label': 'Открыть профиль ' + (page.headerTitle || page.current) }
        }))
      }
      const chat = page.chats.find(item => item.title === page.current) || page.chats[0]
      for (let index = 0; index < page.rootCount; index += 1) roots.push(maxHistoryNode(chat))
      return new MaxNode('document', { children: roots }).querySelectorAll(selector)
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  }
  page.document = document
  page.ctx = vm.createContext({
    document,
    location: page.location,
    JSON, String, Number, Date, Math, Object, Array, RegExp,
    setTimeout, clearTimeout,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
  })
  return page
}

function maxFakeView(page) {
  return {
    isConnected: true,
    executeJavaScript: async code => vm.runInContext(code, page.ctx),
    getURL: () => 'https://web.max.ru' + page.location.pathname
  }
}

const MAX_COLLECT_FUNCTIONS = [
  '__chatHubMaxChatId', '__chatHubMaxStamp', '__chatHubMaxLinks', '__chatHubMaxSleep',
  '__chatHubMaxChatIdentity', '__chatHubMaxClickRow', '__chatHubMaxReadWindow',
  '__chatHubMaxWaitSwitch', '__chatHubCollectMaxHistory',
  // Префлайт пакета MAX-PREFLIGHT: сессия, выбор webview, гарантия загрузки,
  // однократный перезагруз при пустой ленте.
  '__chatHubMaxSession', '__chatHubMaxJson', '__chatHubMaxViewUrl', '__chatHubMaxProbeView',
  '__chatHubMaxProbe', '__chatHubMaxChooseView', '__chatHubMaxEnsureLoaded',
  '__chatHubMaxHistoryRoots', '__chatHubMaxReloadHistory',
  // Лента MAX: метрики прокручиваемого контейнера и запись позиции
  // (MAX-SCROLL-DOWN) — запас прокрутки, число обёрток и шаг вниз.
  '__chatHubMaxFeedMetrics', '__chatHubMaxScrollFeedTo'
]

function maxCollector(view) {
  return sandbox(MAX_COLLECT_FUNCTIONS, {
    state: { svcViews: view === null ? {} : { max: view } },
    setTimeout,
    clearTimeout,
    URL
  })
}

// Префлайт требует полного state: активный пин, pinViews и служебную вкладку.
function maxCollectorState(state) {
  return sandbox(MAX_COLLECT_FUNCTIONS, { state, setTimeout, clearTimeout, URL })
}

// Локальная сегодняшняя дата теста: у сегодняшних сообщений MAX показывает
// только время, поэтому ожидание зависит от дня запуска, а не от константы.
function localTodayIso() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

test('MAX-выгрузка из webview: строка ищется среди button.cell, чат переключается кликом и проверяется по заголовку', async () => {
  const page = maxFakePage([
    { title: 'Исходный', pathname: '/111', messages: [] },
    { title: 'Целевой чат', pathname: '/-222', messages: [{ author: 'Иван', text: 'привет', time: '10:05', date: '19 ноября 2026' }] }
  ])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/-222', title: 'Целевой чат' }],
    timeoutMs: 500
  })))
  assert.equal(result.chats.length, 1)
  assert.equal(result.chats[0].status, 'ok')
  assert.equal(result.chats[0].code, null)
  assert.equal(result.chats[0].coverage, 'window')
  assert.equal(result.chats[0].messages.length, 1)
  assert.equal(result.chats[0].messages[0].service, 'max')
  assert.equal(result.chats[0].messages[0].chatId, '-222')
  assert.equal(result.chats[0].messages[0].messageId, 'max:/-222:0')
  assert.equal(result.chats[0].messages[0].author, 'Иван')
  assert.equal(result.chats[0].messages[0].text, 'привет')
  // до выгрузки и после неё открыт прежний чат — восстановление тем же кликом
  assert.equal(page.current, 'Исходный')
  assert.equal(page.location.pathname, '/111')
  assert.equal(result.restored, true)
})

test('MAX-выгрузка из webview: успех по заголовку, даже когда pathname и url не совпадают (url со слагом)', async () => {
  const page = maxFakePage([
    { title: 'Исходный', pathname: '/111', messages: [] },
    { title: 'Целевой чат', pathname: '/-98765', messages: [{ author: 'Пётр', text: 'слаг', time: '11:00', date: '19 ноября 2026' }] }
  ])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    // id в url нет вовсе: маршрут после открытия — числовой peer id, сравнивать нечего
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/team-slug', title: 'Целевой чат' }],
    timeoutMs: 500
  })))
  assert.equal(result.chats[0].status, 'ok')
  assert.equal(result.chats[0].messages[0].text, 'слаг')
  // chatId: числового id в url нет — берём фактический путь открытого чата
  assert.equal(result.chats[0].messages[0].chatId, '/-98765')
  assert.equal(page.current, 'Исходный')
  assert.equal(result.restored, true)
})

test('MAX-выгрузка из webview: дата capsule и время meta дают ISO +07:00, без даты — сегодня', async () => {
  const page = maxFakePage([
    {
      title: 'Чат',
      pathname: '/777',
      messages: [
        { author: 'Иван', text: 'без даты', time: '09:00' },
        { author: 'Пётр', text: 'первое', time: '10:05', date: '19 ноября 2026' },
        { author: 'Иван', text: 'второе', time: '23:59', date: '19 ноября 2026' },
        { text: 'третье', time: '07:15', date: '2026-11-20' }
      ]
    }
  ])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/777', title: 'Чат' }],
    timeoutMs: 500
  })))
  const messages = result.chats[0].messages
  // Сообщение с одним временем — сегодняшнее: MAX рисует время только у
  // текущего дня, поэтому дата берётся локальная, а не пустая.
  assert.deepEqual(messages.map(message => message.timestamp), [
    localTodayIso() + 'T09:00:00+07:00', '2026-11-19T10:05:00+07:00', '2026-11-19T23:59:00+07:00', '2026-11-20T07:15:00+07:00'
  ])
  assert.deepEqual(messages.map(message => message.dayOnly), [false, false, false, false])
  // четвёртое сообщение — входящее без автора: «—», имя не выдумывается
  assert.deepEqual(messages.map(message => message.author), ['Иван', 'Пётр', 'Иван', '—'])
  assert.deepEqual(messages.map(message => message.messageId), [
    'max:/777:0', 'max:/777:1', 'max:/777:2', 'max:/777:3'
  ])
})

// Синтетический корень истории MAX для проверки диагностики чтения: две
// капсулы, два сообщения с .meta — ровно те селекторы, что использует парсер.
function maxDiagRoot(messages, capsules) {
  const children = []
  for (const capsule of capsules) children.push(new MaxNode('span', { classes: 'capsule', text: capsule }))
  for (const message of messages) {
    const metaChildren = [new MaxNode('span', { classes: 'text', text: message.time })]
    // Дополнительная подпись в мете («изменено» и т.п.) — проверка metaWithDate.
    // Пробел перед подписью, как в разметке MAX между узлами меты.
    if (message.metaExtra) metaChildren.push(new MaxNode('span', { classes: 'text', text: ' ' + message.metaExtra }))
    const bubble = [
      new MaxNode('span', { classes: 'text', attrs: { 'data-message-markup': '' }, text: message.text }),
      new MaxNode('span', { classes: 'meta', children: metaChildren })
    ]
    children.push(new MaxNode('div', {
      classes: 'messageWrapper',
      attrs: { role: 'article' },
      children: [
        new MaxNode('div', { classes: 'author', children: [new MaxNode('span', { classes: 'name', text: message.author })] }),
        new MaxNode('div', {
          classes: 'message',
          attrs: { role: 'article' },
          children: [new MaxNode('div', { classes: 'bubble', children: [new MaxNode('div', { classes: 'bubbleContent', children: bubble })] })]
        })
      ]
    }))
  }
  return new MaxNode('div', {
    classes: 'history history--withBottomMargin',
    attrs: { class: 'history history--withBottomMargin', 'data-scale': '1' },
    children
  })
}

function maxReadWindowResult(root, extraNodes = []) {
  // Документ как в браузере: запросы идут по всему дереву, а не только по корню —
  // диагностике нужны .history/.capsule/узлы дат за пределами истории.
  const tree = new MaxNode('document', { children: root ? [root, ...extraNodes] : [...extraNodes] })
  const document = {
    querySelectorAll(selector) { return tree.querySelectorAll(selector) },
    querySelector(selector) { return tree.querySelector(selector) }
  }
  const ctx = sandbox(['__chatHubMaxReadWindow'], { document })
  return JSON.parse(ctx.__chatHubMaxReadWindow())
}

test('MAX диагностика: diag считает корни, капсулы, обёртки и мету', () => {
  const root = maxDiagRoot(
    [{ author: 'Иван', text: 'первое', time: '10:05' }, { author: 'Пётр', text: 'второе', time: '11:30' }],
    ['19 ноября 2026', 'Сегодня']
  )
  const result = maxReadWindowResult(root)
  assert.equal(result.ok, true)
  assert.equal(result.diag.roots, 1)
  assert.equal(result.diag.capsuleCount, 2)
  assert.deepEqual(result.diag.capsuleSamples, ['19 ноября 2026', 'Сегодня'])
  assert.equal(result.diag.wrapperCount, 2)
  assert.equal(result.diag.metaCount, 2)
  assert.deepEqual(result.diag.metaSamples, ['10:05', '11:30'])
  assert.deepEqual(result.diag.historyClasses, ['history history--withBottomMargin'])
})

test('MAX диагностика: без капсул capsuleCount=0 и пустые примеры', () => {
  const root = maxDiagRoot(
    [{ author: 'Иван', text: 'без даты', time: '09:00' }, { author: 'Пётр', text: 'тоже', time: '09:01' }],
    []
  )
  const result = maxReadWindowResult(root)
  assert.equal(result.ok, true)
  assert.equal(result.diag.roots, 1)
  assert.equal(result.diag.capsuleCount, 0)
  assert.deepEqual(result.diag.capsuleSamples, [])
  assert.equal(result.diag.wrapperCount, 2)
})

test('MAX диагностика 2: капсулы вне корня, узлы с датой и первые дети видны в diag', () => {
  const root = maxDiagRoot(
    [{ author: 'Иван', text: 'первое', time: '18:28', metaExtra: 'изменено' }],
    ['19 ноября 2026']
  )
  // Капсула и узел с датой — ВНЕ корня истории: второй замер должен их видеть.
  const outside = new MaxNode('div', {
    classes: 'datePanel',
    children: [
      new MaxNode('span', { classes: 'capsule', text: 'Сегодня' }),
      new MaxNode('div', { classes: 'stamp', attrs: { 'data-date': '2026-11-18' }, text: '18.11.2026' })
    ]
  })
  const result = maxReadWindowResult(root, [outside])
  assert.equal(result.ok, true)
  assert.equal(result.diag.docCapsules.total, 2)
  assert.deepEqual(result.diag.docCapsules.texts, ['19 ноября 2026', 'Сегодня'])
  // Узел с data-date попадает в диагностику даже вне корня, с tag/cls/text.
  const stamp = result.diag.dateLikeNodes.find(node => node.cls === 'stamp')
  assert.deepEqual(stamp, { tag: 'div', cls: 'stamp', text: '18.11.2026' })
  assert.ok(result.diag.dateLikeNodes.some(node => node.tag === 'span' && node.cls === 'capsule' && node.text === '19 ноября 2026'))
  // Прямые дети корня: капсула даты и обёртка сообщения.
  assert.equal(result.diag.firstChildren.length, 2)
  assert.deepEqual(result.diag.firstChildren[0], { tag: 'span', cls: 'capsule', text: '19 ноября 2026' })
  assert.equal(result.diag.firstChildren[1].tag, 'div')
  assert.equal(result.diag.firstChildren[1].cls, 'messageWrapper')
  // Мета с чем-то кроме HH:MM: дата в мете старого сообщения была бы видна.
  assert.deepEqual(result.diag.metaWithDate, ['18:28 изменено'])
})

test('MAX диагностика 2: без дат — пустые docCapsules, dateLikeNodes и metaWithDate', () => {
  const root = maxDiagRoot([{ author: 'Иван', text: 'без даты', time: '09:00' }], [])
  const result = maxReadWindowResult(root)
  assert.equal(result.ok, true)
  assert.equal(result.diag.docCapsules.total, 0)
  assert.deepEqual(result.diag.docCapsules.texts, [])
  assert.deepEqual(result.diag.dateLikeNodes, [])
  assert.deepEqual(result.diag.metaWithDate, [])
  // Дети корня есть всегда — пустота касается только дат.
  assert.equal(result.diag.firstChildren.length, 1)
})

test('MAX-выгрузка из webview: diag едет только с первым MAX-чатом', async () => {
  const page = maxFakePage([
    { title: 'Первый', pathname: '/1', messages: [{ author: 'Иван', text: 'раз', time: '10:00', date: '19 ноября 2026' }] },
    { title: 'Второй', pathname: '/2', messages: [{ author: 'Пётр', text: 'два', time: '11:00', date: '19 ноября 2026' }] }
  ])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [
      { pinId: 'p1', url: 'https://web.max.ru/1', title: 'Первый' },
      { pinId: 'p2', url: 'https://web.max.ru/2', title: 'Второй' }
    ],
    timeoutMs: 500
  })))
  assert.equal(result.chats.length, 2)
  assert.equal(result.chats[0].diag.capsuleCount, 1)
  assert.deepEqual(result.chats[0].diag.capsuleSamples, ['19 ноября 2026'])
  assert.equal(result.chats[0].diag.wrapperCount, 1)
  assert.equal(result.chats[1].diag, undefined, 'второй чат без диагностики — отчёт не раздувается')
})

test('MAX-выгрузка из webview: ссылки извлекаются без хвостовой пунктуации', async () => {
  const page = maxFakePage([
    {
      title: 'Ссылки',
      pathname: '/5',
      messages: [{
        author: 'Иван',
        time: '12:00',
        date: '19 ноября 2026',
        text: 'план: https://example.test/plan?id=7), ещё https://ru.wikipedia.org/wiki/Foo_(bar). и дубль https://example.test/plan?id=7).'
      }]
    }
  ])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/5', title: 'Ссылки' }],
    timeoutMs: 500
  })))
  assert.deepEqual(result.chats[0].messages[0].links, [
    'https://example.test/plan?id=7',
    'https://ru.wikipedia.org/wiki/Foo_(bar)'
  ])
})

test('MAX-выгрузка из webview: пустая история — skipped HISTORY_EMPTY без сообщений', async () => {
  const page = maxFakePage([{ title: 'Пусто', pathname: '/8', messages: [] }])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/8', title: 'Пусто' }],
    timeoutMs: 500
  })))
  assert.equal(result.chats[0].status, 'skipped')
  assert.equal(result.chats[0].code, 'HISTORY_EMPTY')
  assert.deepEqual(result.chats[0].messages, [])
})

test('MAX-выгрузка из webview: нет точного названия строки — CHAT_NOT_FOUND без частичной выдачи', async () => {
  const page = maxFakePage([
    { title: 'Общий канал', pathname: '/1', messages: [{ text: 'чужое', time: '10:00', date: '19 ноября 2026' }] }
  ])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/1', title: 'Общий' }],
    timeoutMs: 500
  })))
  assert.equal(result.chats[0].status, 'error')
  assert.equal(result.chats[0].code, 'CHAT_NOT_FOUND')
  assert.deepEqual(result.chats[0].messages, [])
  assert.equal(page.location.pathname, '/1')
})

test('MAX-выгрузка из webview: отсутствие вкладки MAX — MAX_VIEW_MISSING на каждый чат', async () => {
  const ctx = maxCollector(null)
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [
      { pinId: 'p1', url: 'https://web.max.ru/1', title: 'Первый' },
      { pinId: 'p2', url: 'https://web.max.ru/2', title: 'Второй' }
    ],
    timeoutMs: 500
  })))
  assert.deepEqual(result.chats.map(chat => chat.code), ['MAX_VIEW_MISSING', 'MAX_VIEW_MISSING'])
  assert.ok(result.chats.every(chat => chat.status === 'error' && chat.messages.length === 0))
  assert.equal(result.restored, false)
})

test('MAX-выгрузка из webview: заголовок не сменился — SWITCH_TIMEOUT с expected/actual', async () => {
  const page = maxFakePage([
    { title: 'Исходный', pathname: '/3', messages: [] },
    { title: 'Заклинило', pathname: '/999', messages: [] }
  ], { clickable: false })
  const ctx = maxCollector(maxFakeView(page))
  const started = Date.now()
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/999', title: 'Заклинило' }],
    timeoutMs: 150
  })))
  assert.equal(result.chats[0].status, 'error')
  assert.equal(result.chats[0].code, 'SWITCH_TIMEOUT')
  assert.deepEqual(result.chats[0].detail, { expected: 'Заклинило', actual: 'Исходный' })
  assert.ok(Date.now() - started < 10000, 'переключение не должно ждать больше 10 секунд')
})

test('MAX-выгрузка из webview: две строки с одинаковым названием — MULTIPLE_CHATS без клика', async () => {
  const page = maxFakePage([
    { title: 'Дубль', pathname: '/1', messages: [] },
    { title: 'Дубль', pathname: '/2', messages: [] }
  ])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/2', title: 'Дубль' }],
    timeoutMs: 500
  })))
  assert.equal(result.chats[0].status, 'error')
  assert.equal(result.chats[0].code, 'MULTIPLE_CHATS')
  assert.deepEqual(result.chats[0].messages, [])
  // неоднозначную строку не кликаем: маршрут остался прежним
  assert.equal(page.location.pathname, '/1')
})

test('MAX-выгрузка из webview: нет readyState и окна истории — ждёт заголовок и не падает', async () => {
  // document без readyState (проверенный коннектор его не читает) и без корня
  // истории: переключение должно пройти по заголовку, чтение — вернуть код.
  const page = maxFakePage([
    { title: 'Исходный', pathname: '/10', messages: [] },
    { title: 'Без окна', pathname: '/11', messages: [] }
  ], { rootMissing: true })
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/11', title: 'Без окна' }],
    timeoutMs: 500
  })))
  assert.equal(result.chats[0].status, 'error')
  // Пустая лента после успешного переключения — отдельный код, а не MALFORMED_DOM:
  // иначе разлогин/недогрузка выглядят как «битая разметка». Перезагружать нечем
  // (у фикстуры нет loadURL), поэтому повтор не состоялся.
  assert.equal(result.chats[0].code, 'HISTORY_ROOT_MISSING')
  // заголовок сменился — ожидание не зависло и не бросило; затем чат восстановлен
  assert.equal(page.location.pathname, '/10')
  assert.equal(result.restored, true)
})

test('MAX-выгрузка из webview: битый пузырь — MALFORMED_DOM, без частичной выдачи', async () => {
  const page = maxFakePage([
    { title: 'Битый', pathname: '/4', messages: [{ text: 'первое', time: '10:00', date: '19 ноября 2026', dupText: true }] }
  ])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/4', title: 'Битый' }],
    timeoutMs: 500
  })))
  assert.equal(result.chats[0].status, 'error')
  assert.equal(result.chats[0].code, 'MALFORMED_DOM')
  assert.deepEqual(result.chats[0].messages, [])
})

test('MAX-выгрузка из webview: несколько корней истории — MALFORMED_DOM', async () => {
  const page = maxFakePage([{ title: 'Два корня', pathname: '/6', messages: [] }], { rootCount: 2 })
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/6', title: 'Два корня' }],
    timeoutMs: 500
  })))
  assert.equal(result.chats[0].status, 'error')
  assert.equal(result.chats[0].code, 'MALFORMED_DOM')
})

test('MAX-выгрузка из webview: исходный чат не найден в списке — отчёт жив, restored false', async () => {
  const page = maxFakePage([
    { title: 'Другой', pathname: '/2', messages: [{ text: 'текст', time: '10:00', date: '19 ноября 2026' }] }
  ])
  // Исходно открыт чат, которого нет среди строк button.cell: восстановить его
  // кликом нечем, но цель собирается и отчёт не падает.
  page.current = 'Скрытый чат'
  page.location.pathname = '/999'
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/2', title: 'Другой' }],
    timeoutMs: 500
  })))
  assert.equal(result.chats[0].status, 'ok')
  assert.equal(result.restored, false)
})

test('MAX-сбор вывешен на window: main вызывает его через window, а не по имени', async () => {
  const page = maxFakePage([
    { title: 'Исходный', pathname: '/111', messages: [] },
    { title: 'Целевой', pathname: '/-333', messages: [{ author: 'Иван', text: 'привет', time: '10:05', date: '19 ноября 2026' }] }
  ])
  const ctx = maxCollector(maxFakeView(page))
  // main.js делает именно это: executeJavaScript('window.__chatHubCollectMaxHistory(...)').
  assert.equal(typeof ctx.window.__chatHubCollectMaxHistory, 'function',
    'window.__chatHubCollectMaxHistory должен быть функцией')
  assert.equal(ctx.window.__chatHubCollectMaxHistory, ctx.__chatHubCollectMaxHistory,
    'window-ссылка и объявленная функция — одна и та же')
  const request = JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/-333', title: 'Целевой' }],
    timeoutMs: 500
  })
  const raw = await vm.runInContext('window.__chatHubCollectMaxHistory(' + request + ')', ctx)
  const result = JSON.parse(raw)
  assert.equal(result.chats[0].status, 'ok')
  assert.deepEqual(result.chats[0].messages.map(message => message.text), ['привет'])
})

test('MCP: схлопнутая серия stderr показывает счётчик (×N)', () => {
  const ctx = sandbox(['mcpServiceName', 'mcpProgressLine'])
  assert.equal(
    ctx.mcpProgressLine({ event: 'connector_stderr', service: 'mm', line: 'шум', repeat: 40 }),
    'Mattermost: диагностическое сообщение коннектора (×40)'
  )
  // одиночное событие остаётся без счётчика
  assert.equal(
    ctx.mcpProgressLine({ event: 'connector_stderr', service: 'mm', line: 'шум' }),
    'Mattermost: диагностическое сообщение коннектора'
  )
})

test('MCP renderer: 40 одинаковых подписей connector_stderr дают одну строку журнала (×40)', () => {
  // main схлопывает только точные копии строки, а подпись в renderer у всех
  // диагностических строк общая: серию считает журнал прогресса запуска.
  const run = { running: true, startedAt: 0, progress: [], progressRepeat: null, report: null }
  const ctx = sandbox([
    'mcpServiceName', 'mcpProgressLine', 'mcpProgressRemember', 'mcpProgressAppend',
    'mcpPanelNode', 'mcpProgressReplaceLast', 'mcpProgressPush'
  ], { mcpExportRun: run })
  for (let index = 0; index < 40; index += 1) {
    ctx.mcpProgressPush({ event: 'connector_stderr', service: 'mm', line: 'строка ' + index })
  }
  assert.equal(run.progress.length, 1, 'сорок разных строк с одной подписью — одна запись')
  assert.equal(run.progress[0], 'Mattermost: диагностическое сообщение коннектора (×40)')
  // другая подпись начинает новую серию
  ctx.mcpProgressPush({ event: 'connector_stderr', service: 'max', line: 'другое' })
  assert.equal(run.progress.length, 2)
  assert.equal(run.progress[1], 'MAX: диагностическое сообщение коннектора')
  // ошибка с текстом не схлопывается в счётчик: код остаётся виден
  ctx.mcpProgressPush({ event: 'connector_stderr', service: 'mm', line: 'Ошибка: ECONNRESET', code: 'ECONNRESET' })
  assert.equal(run.progress.length, 3)
  assert.equal(run.progress[2], 'Mattermost: диагностическое сообщение коннектора (ECONNRESET)')
})

/* ---------- MCP: частичный успех выгрузки (MCP-REPORT-PARTIAL) ---------- */

// Чистые mcpReportLines + карта «пин → название» из state.cfg.pinned.
function mcpReportLineCtx(pinned = []) {
  return sandbox([
    'mcpReportLines', 'mcpServiceName', 'mcpChatStatusText', 'mcpCoverageText',
    'mcpBaseName', 'mcpErrorExplanation'
  ], { state: { cfg: { pinned } } })
}

test('MCP отчёт: файлы без ошибок — «Готово: файлов N, сообщений M»', () => {
  const ctx = mcpReportLineCtx()
  const lines = ctx.mcpReportLines({
    ok: true,
    files: [{ project: '14544', path: 'C:\\out\\14544.md', count: 12 }],
    chats: [{ pinId: 'p1', service: 'mm', status: 'ok', coverage: 'full', count: 12, undated: 0 }],
    errors: []
  })
  assert.equal(lines[0], 'Готово: файлов 1, сообщений 12')
  assert.equal(lines.some(line => /Проблемные чаты/.test(line)), false, 'проблемного блока нет')
  assert.equal(lines.some(line => /^Пропущено:/.test(line)), false, 'строки пропусков нет')
})

test('MCP отчёт MAX: строка DOM-диагностики печатается один раз и только при наличии diag', () => {
  const diag = {
    roots: 1,
    capsuleCount: 2,
    capsuleSamples: ['19 ноября 2026', 'Сегодня'],
    wrapperCount: 2,
    metaCount: 2,
    metaSamples: ['10:05', '11:30'],
    historyClasses: ['history', 'history--withBottomMargin']
  }
  const withDiag = mcpReportLineCtx()
  const lines = withDiag.mcpReportLines({
    ok: true,
    files: [{ project: '14544', path: 'C:\\out\\14544.md', count: 2 }],
    chats: [
      { pinId: 'p1', service: 'max', status: 'ok', coverage: 'window', count: 2, undated: 0, diag },
      { pinId: 'p2', service: 'max', status: 'ok', coverage: 'window', count: 2, undated: 0 }
    ],
    errors: []
  })
  const diagLines = lines.filter(line => line.startsWith('MAX диагностика:'))
  assert.equal(diagLines.length, 1, 'одна строка на весь отчёт')
  assert.equal(diagLines[0], 'MAX диагностика: корней 1, капсул 2, примеры: «19 ноября 2026», «Сегодня», мета: «10:05», «11:30»')

  // Без diag строки нет: обычный отчёт не меняется.
  const bare = mcpReportLineCtx()
  const bareLines = bare.mcpReportLines({
    ok: true,
    files: [{ project: '14544', path: 'C:\\out\\14544.md', count: 1 }],
    chats: [{ pinId: 'p1', service: 'max', status: 'ok', coverage: 'window', count: 1, undated: 0 }],
    errors: []
  })
  assert.equal(bareLines.some(line => line.startsWith('MAX диагностика:')), false)
})

test('MCP отчёт MAX: второй замер печатает три компактные строки диагностики', () => {
  const diag = {
    roots: 1,
    capsuleCount: 0,
    capsuleSamples: [],
    wrapperCount: 18,
    metaCount: 18,
    metaSamples: ['18:28', '20:39'],
    historyClasses: ['history history--withBottomMargin'],
    docCapsules: { total: 1, texts: ['Сегодня'] },
    dateLikeNodes: [{ tag: 'time', cls: 'date', text: '18.11.2026' }],
    firstChildren: [
      { tag: 'span', cls: 'capsule', text: 'Сегодня' },
      { tag: 'div', cls: 'messageWrapper', text: 'Иван18:28' }
    ],
    metaWithDate: ['18:28 изменено']
  }
  const lines = mcpReportLineCtx().mcpReportLines({
    ok: true,
    files: [{ project: '14544', path: 'C:\\out\\14544.md', count: 2 }],
    chats: [{ pinId: 'p1', service: 'max', status: 'ok', coverage: 'window', count: 2, undated: 2, diag }],
    errors: []
  })
  const diag2 = lines.filter(line => line.startsWith('MAX диагностика 2:'))
  assert.equal(diag2.length, 3, 'ровно три строки второго замера')
  assert.match(diag2[0], /\.history: «history history--withBottomMargin»/)
  assert.match(diag2[0], /капсул в документе: 1, тексты: «Сегодня»/)
  assert.match(diag2[1], /time\.date «18\.11\.2026»/)
  assert.match(diag2[1], /мета с датой: «18:28 изменено»/)
  assert.match(diag2[2], /span\.capsule «Сегодня», div\.messageWrapper «Иван18:28»/)
  // Старая строка первого замера остаётся отдельной и единственной.
  assert.equal(lines.filter(line => line.startsWith('MAX диагностика:')).length, 1)
})

test('MCP отчёт: файлы + ошибка + два пропуска — «Выгружено частично», проблема названа, пропуски отдельно', () => {
  const ctx = mcpReportLineCtx([
    { id: 'p1', serviceId: 'max', title: 'Проект А', mcpProject: '14544' },
    { id: 'p2', serviceId: 'mm', title: 'Проект Б', mcpProject: '14544' },
    { id: 'p3', serviceId: 'mm', title: 'Проект В', mcpProject: '14544' }
  ])
  const lines = ctx.mcpReportLines({
    ok: false,
    files: [{ project: '14544', path: 'C:\\out\\14544.md', count: 12 }],
    chats: [
      { pinId: 'p1', service: 'max', status: 'error', code: 'CHAT_NOT_FOUND', count: 0 },
      { pinId: 'p2', service: 'mm', status: 'skipped', code: 'no_messages' },
      { pinId: 'p3', service: 'mm', status: 'skipped', code: 'bad_project' }
    ],
    errors: [{ code: 'CHAT_NOT_FOUND', message: 'MAX: чат не найден' }]
  })
  assert.equal(lines[0], 'Выгружено частично: файлов 1, сообщений 12; проблемных чатов 1')
  const at = lines.indexOf('Проблемные чаты:')
  assert.ok(at >= 0, 'перечень проблемных идёт отдельным блоком')
  assert.match(lines[at + 1], /«Проект А»/, 'название чата берётся из пина')
  assert.match(lines[at + 1], /CHAT_NOT_FOUND/)
  assert.match(lines[at + 1], /не найден среди избранных чатов/)
  assert.equal(lines[at + 2], 'Пропущено: 2', 'пропуски не смешиваются с ошибками')
  assert.equal(lines[at + 1].startsWith('• '), true)
})

test('MCP отчёт: нет файлов — «Выгрузка не выполнена» и код причины', () => {
  const ctx = mcpReportLineCtx([{ id: 'p1', serviceId: 'max', title: 'Проект А' }])
  const lines = ctx.mcpReportLines({
    ok: false,
    files: [],
    chats: [{ pinId: 'p1', service: 'max', status: 'error', code: 'CHAT_NOT_FOUND', count: 0 }],
    errors: [{ code: 'CHAT_NOT_FOUND', message: 'MAX: чат не найден' }]
  })
  assert.match(lines[0], /^Выгрузка не выполнена/)
  assert.match(lines[0], /CHAT_NOT_FOUND/)
})

test('MCP отчёт: SWITCH_TIMEOUT печатает ожидаемый и фактический заголовок', () => {
  const ctx = mcpReportLineCtx([{ id: 'p1', serviceId: 'max', title: 'Проект А' }])
  const lines = ctx.mcpReportLines({
    ok: false,
    files: [{ project: '14544', path: 'C:\\out\\14544.md', count: 3 }],
    chats: [{
      pinId: 'p1', service: 'max', status: 'error', code: 'SWITCH_TIMEOUT', count: 0,
      detail: { expected: 'Проект А', actual: 'Проект Б' }
    }],
    errors: [{ code: 'SWITCH_TIMEOUT', message: 'сбор в окне ChatHub не удался' }]
  })
  const at = lines.indexOf('Проблемные чаты:')
  assert.ok(at >= 0)
  assert.match(lines[at + 1], /ожидался «Проект А», открыт «Проект Б»/)
})

test('MCP отчёт: pinId без пина в конфиге — «пин <id>», без падения', () => {
  const report = {
    ok: false,
    files: [{ project: '14544', path: 'C:\\out\\14544.md', count: 1 }],
    chats: [{ pinId: 'p9', service: 'max', status: 'error', code: 'CHAT_NOT_FOUND', count: 0 }],
    errors: [{ code: 'CHAT_NOT_FOUND' }]
  }
  const ctx = mcpReportLineCtx([])
  const lines = ctx.mcpReportLines(report)
  const at = lines.indexOf('Проблемные чаты:')
  assert.ok(at >= 0)
  assert.match(lines[at + 1], /«пин p9»/)

  // Контекст вообще без state: функция не должна падать на отсутствии конфига.
  const bare = sandbox([
    'mcpReportLines', 'mcpServiceName', 'mcpChatStatusText', 'mcpCoverageText',
    'mcpBaseName', 'mcpErrorExplanation'
  ])
  const bareLines = bare.mcpReportLines({
    ok: false,
    files: [{ project: '14544', path: 'C:\\out\\14544.md', count: 1 }],
    chats: [{ pinId: 'p7', service: 'max', status: 'error', code: 'CHAT_NOT_FOUND', count: 0 }],
    errors: []
  })
  assert.match(bareLines[bareLines.indexOf('Проблемные чаты:') + 1], /«пин p7»/)
})

test('MCP панель: ok:false из моста при записанных файлах — частичный успех, не провал', async () => {
  const report = {
    ok: false,
    exportedAt: '2026-11-24T09:55:00.000Z',
    files: [
      { project: '15455', path: 'C:\\out\\15455.md', count: 40 },
      { project: '14459', path: 'C:\\out\\14459.md', count: 30 },
      { project: '14457', path: 'C:\\out\\14457.md', count: 20 },
      { project: '14456', path: 'C:\\out\\14456.md', count: 10 }
    ],
    chats: [
      { pinId: 'p1', service: 'mm', status: 'ok', count: 100 },
      { pinId: 'p2', service: 'max', status: 'error', code: 'CHAT_NOT_FOUND', count: 0 }
    ],
    truncated: false,
    errors: [{ code: 'CHAT_NOT_FOUND', message: 'MAX: чат не найден' }]
  }
  const panel = mcpPanel({
    mcpExportDir: 'C:\\out',
    pinned: [
      { id: 'p1', serviceId: 'mm', title: 'Рабочий чат', mcpProject: '15455' },
      { id: 'p2', serviceId: 'max', title: 'Кубань', mcpProject: '15455' }
    ]
  }, { mcpExport: async () => report })
  await panel.byId('mcp-export-run').onclick()
  const text = panel.byId('mcp-report').textContent
  assert.match(text, /Выгружено частично: файлов 4, сообщений 100; проблемных чатов 1/)
  assert.match(text, /«Кубань»/)
  assert.match(text, /CHAT_NOT_FOUND/)
  assert.equal(text.includes('Повторите выгрузку'), false, 'частичный успех не выглядит полным провалом')
})

/* ---------- MAX: относительные капсулы, автор исходящих, дата без времени ---------- */

// Локальная дата чтения: «Сегодня»/«Вчера»/«Позавчера» считаются от неё.
function maxLocalDay(offsetDays) {
  const now = new Date()
  const probe = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays))
  return probe.toISOString().slice(0, 10)
}

function maxStamped(day, time) {
  return day + 'T' + time + ':00+07:00'
}

test('MAX capsule «Сегодня»: локальная дата запуска и время meta дают сегодняшние +07:00', async () => {
  const page = maxFakePage([{
    title: 'Сегодня',
    pathname: '/today',
    messages: [
      { author: 'Иван', text: 'раз', time: '12:34', date: 'Сегодня' },
      // «сегодня» строчными — та же дата, регистр не важен
      { author: 'Иван', text: 'два', time: '12:35', date: 'сегодня' }
    ]
  }])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/today', title: 'Сегодня' }],
    timeoutMs: 500
  })))
  const messages = result.chats[0].messages
  assert.deepEqual(messages.map(message => message.timestamp), [
    maxStamped(maxLocalDay(0), '12:34'),
    maxStamped(maxLocalDay(0), '12:35')
  ])
})

test('MAX capsule «Вчера» и «Позавчера»: минус один и минус два дня от локальной даты', async () => {
  const page = maxFakePage([{
    title: 'Относительные',
    pathname: '/rel',
    messages: [
      { author: 'Иван', text: 'вчера', time: '09:10', date: 'Вчера' },
      { author: 'Иван', text: 'позавчера', time: '08:05', date: 'Позавчера' }
    ]
  }])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/rel', title: 'Относительные' }],
    timeoutMs: 500
  })))
  assert.deepEqual(result.chats[0].messages.map(message => message.timestamp), [
    maxStamped(maxLocalDay(-1), '09:10'),
    maxStamped(maxLocalDay(-2), '08:05')
  ])
})

test('MAX capsule «19 ноября» без года совпадает с «19 ноября 2026» (год текущий)', async () => {
  const year = String(new Date().getFullYear())
  const page = maxFakePage([{
    title: 'Год',
    pathname: '/year',
    messages: [
      { author: 'Иван', text: 'без года', time: '10:00', date: '19 ноября' },
      { author: 'Пётр', text: 'с годом', time: '11:00', date: '19 ноября ' + year }
    ]
  }])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/year', title: 'Год' }],
    timeoutMs: 500
  })))
  assert.deepEqual(result.chats[0].messages.map(message => message.timestamp), [
    maxStamped(year + '-11-19', '10:00'),
    maxStamped(year + '-11-19', '11:00')
  ])
})

test('MAX capsule «Непрочитанные» не сбрасывает дату следующих сообщений', async () => {
  const page = maxFakePage([{
    title: 'Служебная',
    pathname: '/service',
    messages: [
      { author: 'Иван', text: 'до', time: '10:00', date: '19 ноября 2026' },
      { author: 'Пётр', text: 'после', time: '10:05', service: 'Непрочитанные' }
    ]
  }])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/service', title: 'Служебная' }],
    timeoutMs: 500
  })))
  assert.deepEqual(result.chats[0].messages.map(message => message.timestamp), [
    '2026-11-19T10:00:00+07:00',
    '2026-11-19T10:05:00+07:00'
  ])
})

test('MAX автор: исходящее без .author .name — «Я», входящее без автора — «—»', async () => {
  const page = maxFakePage([{
    title: 'Автор',
    pathname: '/author',
    messages: [
      { text: 'от меня', time: '10:00', date: '19 ноября 2026', out: true },
      { text: 'мне', time: '10:01' },
      { author: 'Иван', text: 'с именем', time: '10:02' }
    ]
  }])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/author', title: 'Автор' }],
    timeoutMs: 500
  })))
  assert.deepEqual(result.chats[0].messages.map(message => message.author), ['Я', '—', 'Иван'])
})

test('MAX: дата без времени после разделителя — полночь, dayOnly=true, полдень не выдумывается', async () => {
  const page = maxFakePage([{
    title: 'Без времени',
    pathname: '/notime',
    messages: [{ author: 'Иван', text: 'без времени', date: '19 ноября 2026' }]
  }])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/notime', title: 'Без времени' }],
    timeoutMs: 500
  })))
  // Дата из разделителя известна, час — нет: полночь и флаг dayOnly, полдень не выдумываем.
  assert.equal(result.chats[0].messages[0].timestamp, '2026-11-19T00:00:00+07:00')
  assert.equal(result.chats[0].messages[0].dayOnly, true)
  assert.equal(result.chats[0].messages[0].author, 'Иван')
})

// --- MAX: даты и время читаются из меты сообщения, а не из капсул ---

// Собирает окно с сообщениями без капсул: проверяется именно мета.
async function maxMetaMessages(messages) {
  const page = maxFakePage([{ title: 'Мета', pathname: '/meta', messages }])
  const ctx = maxCollector(maxFakeView(page))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/meta', title: 'Мета' }],
    timeoutMs: 500
  })))
  assert.equal(result.chats[0].status, 'ok')
  return result.chats[0].messages
}

test('MAX мета: «18:28» без капсулы — сегодняшняя дата, dayOnly=false', async () => {
  const messages = await maxMetaMessages([{ author: 'Иван', text: 'сегодня', time: '18:28' }])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].timestamp, localTodayIso() + 'T18:28:00+07:00')
  assert.equal(messages[0].dayOnly, false)
})

test('MAX мета: «31 мая» — дата без времени, dayOnly=true и полночь', async () => {
  const year = new Date().getFullYear()
  const messages = await maxMetaMessages([{ author: 'Иван', text: 'май', metaDate: '31 мая' }])
  assert.equal(messages[0].timestamp, `${year}-05-31T00:00:00+07:00`)
  assert.equal(messages[0].dayOnly, true)
})

test('MAX мета: «31 мая 2025» — год берётся из меты', async () => {
  const messages = await maxMetaMessages([{ author: 'Иван', text: 'прошлый год', metaDate: '31 мая 2025' }])
  assert.equal(messages[0].timestamp, '2025-05-31T00:00:00+07:00')
  assert.equal(messages[0].dayOnly, true)
})

test('MAX мета: «29.05» — 29 мая текущего года', async () => {
  const year = new Date().getFullYear()
  const messages = await maxMetaMessages([{ author: 'Иван', text: 'точка', metaDate: '29.05' }])
  assert.equal(messages[0].timestamp, `${year}-05-29T00:00:00+07:00`)
  assert.equal(messages[0].dayOnly, true)
})

test('MAX мета: «ред. 20:21» — время читается вместе с подписью', async () => {
  const messages = await maxMetaMessages([{ author: 'Иван', text: 'правка', metaText: 'ред. 20:21' }])
  assert.equal(messages[0].timestamp, localTodayIso() + 'T20:21:00+07:00')
  assert.equal(messages[0].dayOnly, false)
})

test('MAX мета: пустая мета — undated, dayOnly=false', async () => {
  const messages = await maxMetaMessages([{ author: 'Иван', text: 'пусто' }])
  assert.equal(messages[0].timestamp, null)
  assert.equal(messages[0].dayOnly, false)
})

test('MAX мета: дата без времени не получает выдуманного полудня', async () => {
  const messages = await maxMetaMessages([{ author: 'Иван', text: 'день', metaDate: '29.05.2025' }])
  assert.equal(messages[0].timestamp, '2025-05-29T00:00:00+07:00')
  assert.ok(!messages[0].timestamp.includes('T12:00'), 'полдень не выдумывается')
  assert.equal(messages[0].dayOnly, true)
})

test('MAX мета: div.meta с датой и span.time с временем читаются как источники', async () => {
  const messages = await maxMetaMessages([
    { author: 'Иван', text: 'дата в div', metaDate: '27 мая', metaTag: 'div' },
    { author: 'Пётр', text: 'время в span.time', time: '20:39', timeClass: 'time' }
  ])
  assert.equal(messages[0].timestamp, `${new Date().getFullYear()}-05-27T00:00:00+07:00`)
  assert.equal(messages[0].dayOnly, true)
  assert.equal(messages[1].timestamp, localTodayIso() + 'T20:39:00+07:00')
  assert.equal(messages[1].dayOnly, false)
})

test('MAX мета: невидимые символы вокруг времени не мешают разбору', async () => {
  const messages = await maxMetaMessages([{ author: 'Иван', text: 'маркер', metaText: '\u200b18:28\ufeff' }])
  assert.equal(messages[0].timestamp, localTodayIso() + 'T18:28:00+07:00')
  assert.equal(messages[0].dayOnly, false)
})

test('MAX мета: дата из меты не липнет к следующему сообщению без меты', async () => {
  const messages = await maxMetaMessages([
    { author: 'Иван', text: 'с датой', metaDate: '31 мая' },
    { author: 'Пётр', text: 'без меты' }
  ])
  assert.equal(messages[0].dayOnly, true)
  // Второе сообщение честно недатировано: дату предыдущего не наследует.
  assert.equal(messages[1].timestamp, null)
  assert.equal(messages[1].dayOnly, false)
})


// --- MAX: даты дня лежат в разделителях ленты (capsuleSeparator/systemCapsule) ---
// Живой замер: дата дня — div.capsuleSeparator «18 ноября» (дубль —
// span.systemCapsule), в мете сообщения только «18:28»/«ред. 20:21».
// Разделитель задаёт дату всем последующим сообщениям до следующего раздела.

// Синтетическая лента production-разметки: разделитель дня и .messageWrapper[role]
// с .meta. separatorClass/separatorTag позволяют повторить любую версию MAX.
function maxSeparatorHistory(items) {
  const children = []
  for (const item of items) {
    if (item.separator !== undefined) {
      children.push(new MaxNode(item.separatorTag || 'div', {
        classes: item.separatorClass || 'capsuleSeparator',
        text: item.separator
      }))
      continue
    }
    const metaChildren = [new MaxNode('span', { classes: 'text', text: item.time || '' })]
    if (item.metaText) metaChildren.push(new MaxNode('span', { classes: 'text', text: ' ' + item.metaText }))
    children.push(new MaxNode('div', {
      classes: 'messageWrapper',
      attrs: { role: 'article' },
      children: [
        new MaxNode('div', { classes: 'author', children: [new MaxNode('span', { classes: 'name', text: item.author || 'Иван' })] }),
        new MaxNode('div', {
          classes: 'message',
          attrs: { role: 'article' },
          children: [new MaxNode('div', {
            classes: 'bubble',
            children: [new MaxNode('div', {
              classes: 'bubbleContent',
              children: [
                new MaxNode('span', { classes: 'text', attrs: { 'data-message-markup': '' }, text: item.text }),
                new MaxNode('span', { classes: 'meta', children: metaChildren })
              ]
            })]
          })]
        })
      ]
    }))
  }
  return new MaxNode('div', {
    classes: 'history history--withBottomMargin',
    attrs: { class: 'history history--withBottomMargin', 'data-scale': '1' },
    children
  })
}

test('MAX разделители: capsuleSeparator «18 ноября» даёт дату следующим сообщениям, «20 ноября» переключает день', () => {
  const year = String(new Date().getFullYear())
  const result = maxReadWindowResult(maxSeparatorHistory([
    { separator: '18 ноября' },
    { author: 'Иван', text: 'первое', time: '10:15' },
    { separator: '20 ноября' },
    { author: 'Пётр', text: 'правка', metaText: 'ред. 20:21' }
  ]))
  assert.equal(result.ok, true)
  assert.deepEqual(result.messages.map(message => message.date), [year + '-11-18', year + '-11-20'])
  assert.deepEqual(result.messages.map(message => message.time), ['10:15', '20:21'])
  assert.deepEqual(result.messages.map(message => message.dayOnly), [false, false])
})

test('MAX разделители: span.systemCapsule «Вчера» — вчерашний день', () => {
  const result = maxReadWindowResult(maxSeparatorHistory([
    { separator: 'Вчера', separatorTag: 'span', separatorClass: 'systemCapsule' },
    { author: 'Иван', text: 'вчера', time: '08:20' }
  ]))
  assert.equal(result.messages[0].date, maxLocalDay(-1))
  assert.equal(result.messages[0].time, '08:20')
  assert.equal(result.messages[0].dayOnly, false)
})

test('MAX разделители: «18.11» и «19.11.2026» — числовые даты разделителя', () => {
  const year = String(new Date().getFullYear())
  const result = maxReadWindowResult(maxSeparatorHistory([
    { separator: '18.11' },
    { author: 'Иван', text: 'точка', time: '11:00' },
    { separator: '19.11.2026' },
    { author: 'Пётр', text: 'с годом', time: '12:00' }
  ]))
  assert.deepEqual(result.messages.map(message => message.date), [year + '-11-18', '2026-11-19'])
})

test('MAX разделители: служебные «Чат готов» и «Непрочитанные» дату не меняют', () => {
  const year = String(new Date().getFullYear())
  const result = maxReadWindowResult(maxSeparatorHistory([
    { separator: '18 ноября' },
    { author: 'Иван', text: 'до', time: '10:00' },
    { separator: 'Чат готов' },
    { author: 'Пётр', text: 'после', time: '11:00' },
    { separator: 'Непрочитанные' },
    { author: 'Иван', text: 'ещё', time: '12:00' }
  ]))
  assert.deepEqual(result.messages.map(message => message.date), [year + '-11-18', year + '-11-18', year + '-11-18'])
})

test('MAX разделители: сообщение без времени после разделителя — dayOnly=true', () => {
  const year = String(new Date().getFullYear())
  const result = maxReadWindowResult(maxSeparatorHistory([
    { separator: '18 ноября' },
    { author: 'Иван', text: 'только день' }
  ]))
  assert.equal(result.messages[0].date, year + '-11-18')
  assert.equal(result.messages[0].time, '')
  assert.equal(result.messages[0].dayOnly, true)
})

test('MAX разделители: без разделителя — сегодня, без даты и времени — undated', () => {
  const result = maxReadWindowResult(maxSeparatorHistory([
    { author: 'Иван', text: 'сегодня', time: '12:00' },
    { author: 'Пётр', text: 'ни даты, ни времени' }
  ]))
  assert.equal(result.messages[0].date, localTodayIso())
  assert.equal(result.messages[0].dayOnly, false)
  assert.equal(result.messages[1].date, null)
  assert.equal(result.messages[1].dayOnly, false)
})

test('MAX разделители: span.capsule старой версии остаётся разделителем', () => {
  const result = maxReadWindowResult(maxSeparatorHistory([
    { separator: '18 ноября 2026', separatorTag: 'span', separatorClass: 'capsule' },
    { author: 'Иван', text: 'старая версия', time: '10:15' }
  ]))
  assert.equal(result.messages[0].date, '2026-11-18')
  assert.equal(result.messages[0].time, '10:15')
})


// --- MAX префлайт: рабочий webview, сессия, загрузка страницы, пустая лента ---
// Живой факт: человек смотрит избранный MAX-чат в pin-view, а коллектор жёстко
// брал state.svcViews.max — пустая страница давала «корней 0» и маскировала
// разлогин кодами MALFORMED_DOM/CHAT_NOT_FOUND. Фикстуры ниже повторяют обе
// поверхности (пин и служебную вкладку) и браузерные признаки готовности.

// Страница MAX: readyState/body как в браузере, строки списка и корень истории —
// теми же MaxNode, что и остальные фикстуры. options:
//   empty — страница ещё не отрисована (about:blank), дерево пустое;
//   login — экран входа (input[type=tel]), строк и корня нет;
//   rootMissing — корень истории не отрисован.
function maxPreflightPage(options = {}) {
  const chats = options.chats || []
  const page = {
    chats,
    current: chats.length ? chats[0].title : '',
    href: options.href || 'https://web.max.ru/',
    pathname: chats.length ? chats[0].pathname : '/',
    readyState: options.readyState || (options.empty ? 'loading' : 'complete'),
    empty: options.empty === true,
    login: options.login === true,
    rootCount: options.rootMissing === true ? 0 : 1,
    loads: [],
    clicks: 0
  }
  const tree = () => {
    if (page.empty) return new MaxNode('document', { children: [] })
    if (page.login) {
      return new MaxNode('document', { children: [new MaxNode('input', { attrs: { type: 'tel' } })] })
    }
    const aside = new MaxNode('aside')
    for (const chat of page.chats) {
      const row = new MaxNode('button', {
        classes: 'cell',
        children: [new MaxNode('h3', {
          classes: 'title',
          children: [new MaxNode('span', {
            classes: 'name',
            children: [new MaxNode('span', { classes: 'text', text: chat.title })]
          })]
        })]
      })
      row.onClick = () => {
        page.clicks += 1
        page.current = chat.title
        page.pathname = chat.pathname
        page.href = 'https://web.max.ru' + chat.pathname
      }
      aside.children.push(row)
      row.parent = aside
    }
    const roots = [aside, new MaxNode('button', { classes: 'main', attrs: { 'aria-label': 'Открыть профиль ' + page.current } })]
    const chat = page.chats.find(item => item.title === page.current) || page.chats[0]
    if (chat) for (let index = 0; index < page.rootCount; index += 1) roots.push(maxHistoryNode(chat))
    return new MaxNode('document', { children: roots })
  }
  const document = {
    get readyState() { return page.readyState },
    body: { get innerText() { return page.login ? 'Войдите по номеру телефона' : '' } },
    querySelectorAll(selector) { return tree().querySelectorAll(selector) },
    querySelector(selector) { return tree().querySelector(selector) }
  }
  page.location = { get pathname() { return page.pathname }, get href() { return page.href } }
  page.ctx = vm.createContext({
    document, location: page.location, JSON, String, Number, Date, Math, Object, Array, RegExp,
    setTimeout, clearTimeout
  })
  return page
}

// Webview поверх такой страницы. options.load:
//   'ready'  — loadURL отрисовывает список и ленту;
//   'repair' — loadURL дорисовывает и корень истории (однократный перезагруз);
//   'fail'   — loadURL вызван, но страница так и не готова.
function maxPreflightView(page, options = {}) {
  const view = {
    isConnected: options.isConnected !== false,
    executeJavaScript: async code => vm.runInContext(code, page.ctx),
    getURL: () => page.href
  }
  if (options.load === 'ready' || options.load === 'repair') {
    view.loadURL = async url => {
      page.loads.push(String(url))
      page.empty = false
      page.readyState = 'complete'
      page.href = String(url)
      page.pathname = new URL(String(url)).pathname
      if (!page.current && page.chats.length) page.current = page.chats[0].title
      if (options.load === 'repair') page.rootCount = 1
    }
  } else if (options.load === 'fail') {
    view.loadURL = async url => { page.loads.push(String(url)) }
  }
  return view
}

function maxStateFor({ pins = [], activePinId = '', pinViews = {}, svcView = null } = {}) {
  return {
    cfg: { pinned: pins, services: [{ id: 'max', name: 'MAX' }] },
    activePinId,
    pinViews,
    svcViews: svcView ? { max: svcView } : {}
  }
}

const MAX_SESSION_LINE = /^MAX: (сессия (ок|завершена)|состояние неизвестно)$/
const MAX_VIEW_LINE = /^MAX: рабочий webview — (pin|service|нет), лента: \d+$/

test('MAX префлайт: сессия завершена — MAX_SESSION_LOST на все чаты, обхода нет', async () => {
  const page = maxPreflightPage({
    login: true,
    chats: [
      { title: 'Первый', pathname: '/1', messages: [] },
      { title: 'Второй', pathname: '/2', messages: [] }
    ]
  })
  const ctx = maxCollectorState(maxStateFor({ svcView: maxPreflightView(page) }))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [
      { pinId: 'p1', url: 'https://web.max.ru/1', title: 'Первый' },
      { pinId: 'p2', url: 'https://web.max.ru/2', title: 'Второй' }
    ]
  })))
  // Экран входа — не «битая разметка» и не «чат не найден»: сессия потеряна.
  assert.deepEqual(result.chats.map(chat => chat.code), ['MAX_SESSION_LOST', 'MAX_SESSION_LOST'])
  assert.ok(result.chats.every(chat => chat.status === 'error' && chat.messages.length === 0))
  assert.equal(page.clicks, 0, 'обход чатов не начинается: кликов по строкам нет')
  assert.equal(result.session.state, 'auth')
  assert.equal(result.notes.includes('MAX: сессия завершена'), true)
  assert.equal(result.notes.filter(line => MAX_SESSION_LINE.test(line)).length, 1, 'строка сессии одна')
  assert.equal(result.restored, false)
})

test('MAX префлайт: состояние неизвестно (readyState не complete) — обход идёт', async () => {
  const page = maxPreflightPage({
    readyState: 'loading',
    chats: [
      { title: 'Исходный', pathname: '/10', messages: [] },
      { title: 'Целевой', pathname: '/11', messages: [{ author: 'Иван', text: 'привет', time: '10:05', date: '19 ноября 2026' }] }
    ]
  })
  const ctx = maxCollectorState(maxStateFor({ svcView: maxPreflightView(page) }))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/11', title: 'Целевой' }]
  })))
  assert.equal(result.session.state, 'unknown')
  assert.equal(result.notes.includes('MAX: состояние неизвестно'), true)
  // «Неизвестно» не блокирует: переключение и чтение выполняются.
  assert.ok(page.clicks > 0, 'клик по строке списка был')
  assert.equal(result.chats[0].status, 'ok')
  assert.deepEqual(result.chats[0].messages.map(message => message.text), ['привет'])
})

test('MAX загрузка: webview на about:blank — грузится web.max.ru и сбор идёт', async () => {
  const page = maxPreflightPage({
    empty: true,
    href: 'about:blank',
    readyState: 'loading',
    chats: [{ title: 'Целевой', pathname: '/-222', messages: [{ author: 'Иван', text: 'после загрузки', time: '11:00', date: '19 ноября 2026' }] }]
  })
  const ctx = maxCollectorState(maxStateFor({ svcView: maxPreflightView(page, { load: 'ready' }) }))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/-222', title: 'Целевой' }],
    historyWaitMs: 400
  })))
  assert.deepEqual(page.loads, ['https://web.max.ru/'], 'сначала грузится корень MAX, а не URL пина')
  assert.equal(result.chats[0].status, 'ok')
  assert.deepEqual(result.chats[0].messages.map(message => message.text), ['после загрузки'])
  assert.match(result.view.line, /^MAX: рабочий webview — service, лента: 1$/)
})

test('MAX лента: после переключения корня нет — один loadURL пина и повторное чтение', async () => {
  const page = maxPreflightPage({
    rootMissing: true,
    chats: [
      { title: 'Исходный', pathname: '/20', messages: [] },
      { title: 'Целевой', pathname: '/21', messages: [{ author: 'Иван', text: 'после перезагрузки', time: '12:00', date: '19 ноября 2026' }] }
    ]
  })
  const ctx = maxCollectorState(maxStateFor({ svcView: maxPreflightView(page, { load: 'repair' }) }))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/21', title: 'Целевой' }],
    historyWaitMs: 500
  })))
  assert.deepEqual(page.loads, ['https://web.max.ru/21'], 'перезагружается URL пина, ровно один раз')
  assert.equal(result.chats[0].status, 'ok')
  assert.deepEqual(result.chats[0].messages.map(message => message.text), ['после перезагрузки'])
  assert.equal(page.current, 'Исходный', 'исходный чат восстановлен после перезагрузки ленты')
})

test('MAX лента: повтор не помог — HISTORY_ROOT_MISSING и ровно один loadURL', async () => {
  const page = maxPreflightPage({
    rootMissing: true,
    chats: [
      { title: 'Исходный', pathname: '/30', messages: [] },
      { title: 'Целевой', pathname: '/31', messages: [{ author: 'Иван', text: 'не прочитается', time: '12:30', date: '19 ноября 2026' }] }
    ]
  })
  const ctx = maxCollectorState(maxStateFor({ svcView: maxPreflightView(page, { load: 'fail' }) }))
  const started = Date.now()
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/31', title: 'Целевой' }],
    historyWaitMs: 300
  })))
  assert.equal(result.chats[0].status, 'error')
  assert.equal(result.chats[0].code, 'HISTORY_ROOT_MISSING')
  assert.deepEqual(result.chats[0].messages, [])
  assert.equal(page.loads.length, 1, 'одна попытка перезагрузки, не цикл')
  assert.ok(Date.now() - started < 5000, 'повтор ограничен бюджетом ожидания')
})

test('MAX webview: активный MAX-пин с лентой выигрывает у пустой служебной вкладки', async () => {
  const pinPage = maxPreflightPage({
    chats: [{ title: 'Пин-чат', pathname: '/-5', messages: [{ author: 'Иван', text: 'из пина', time: '13:00', date: '19 ноября 2026' }] }]
  })
  const svcPage = maxPreflightPage({ empty: true, href: 'about:blank', readyState: 'loading' })
  const ctx = maxCollectorState(maxStateFor({
    pins: [{ id: 'pin-max', serviceId: 'max', title: 'Пин-чат', url: 'https://web.max.ru/-5' }],
    activePinId: 'pin-max',
    pinViews: { 'pin-max': maxPreflightView(pinPage) },
    svcView: maxPreflightView(svcPage, { load: 'fail' })
  }))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'pin-max', url: 'https://web.max.ru/-5', title: 'Пин-чат' }]
  })))
  assert.equal(result.chats[0].status, 'ok')
  assert.deepEqual(result.chats[0].messages.map(message => message.text), ['из пина'])
  assert.equal(result.view.source, 'pin')
  assert.equal(result.view.pinId, 'pin-max')
  assert.match(result.view.line, /^MAX: рабочий webview — pin, лента: 1$/)
  assert.deepEqual(svcPage.loads, [], 'служебная вкладка не грузится: рабочий пин найден')
})

test('MAX webview: без пинов сбор идёт через служебную вкладку', async () => {
  const page = maxPreflightPage({
    chats: [{ title: 'Сервис', pathname: '/7', messages: [{ author: 'Иван', text: 'из сервиса', time: '14:00', date: '19 ноября 2026' }] }]
  })
  const ctx = maxCollectorState(maxStateFor({ svcView: maxPreflightView(page) }))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/7', title: 'Сервис' }]
  })))
  assert.equal(result.chats[0].status, 'ok')
  assert.equal(result.view.source, 'service')
  assert.match(result.view.line, /^MAX: рабочий webview — service, лента: 1$/)
})

test('MAX webview: живого окна нет — MAX_VIEW_MISSING на все чаты', async () => {
  // Пин отключён (isConnected false), служебная вкладка на about:blank без loadURL:
  // грузить некуда, рабочих корней нет — сбор невозможен.
  const deadPin = maxPreflightView(maxPreflightPage({ empty: true, href: 'about:blank', readyState: 'loading' }), { isConnected: false })
  const blankSvc = maxPreflightView(maxPreflightPage({ empty: true, href: 'about:blank', readyState: 'loading' }))
  const ctx = maxCollectorState(maxStateFor({
    pins: [{ id: 'pin-max', serviceId: 'max', title: 'Пин', url: 'https://web.max.ru/-5' }],
    activePinId: 'pin-max',
    pinViews: { 'pin-max': deadPin },
    svcView: blankSvc
  }))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [
      { pinId: 'p1', url: 'https://web.max.ru/1', title: 'Первый' },
      { pinId: 'p2', url: 'https://web.max.ru/2', title: 'Второй' }
    ]
  })))
  assert.deepEqual(result.chats.map(chat => chat.code), ['MAX_VIEW_MISSING', 'MAX_VIEW_MISSING'])
  assert.ok(result.chats.every(chat => chat.status === 'error' && chat.messages.length === 0))
  assert.equal(result.view.source, null)
  assert.equal(result.view.line, 'MAX: рабочий webview — нет, лента: 0')
  assert.equal(result.session.state, 'unknown', 'без окна состояние сессии проверить нечем')
  assert.equal(result.restored, false)
})

test('MAX строка состояния сессии: «сессия ок» и рабочий webview — по одной строке', async () => {
  const page = maxPreflightPage({
    chats: [{ title: 'Чат', pathname: '/9', messages: [{ author: 'Иван', text: 'текст', time: '15:00', date: '19 ноября 2026' }] }]
  })
  const ctx = maxCollectorState(maxStateFor({ svcView: maxPreflightView(page) }))
  const result = JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru/9', title: 'Чат' }]
  })))
  assert.equal(result.session.state, 'ok')
  assert.deepEqual(result.notes.filter(line => MAX_SESSION_LINE.test(line)), ['MAX: сессия ок'])
  assert.deepEqual(result.notes.filter(line => MAX_VIEW_LINE.test(line)), ['MAX: рабочий webview — service, лента: 1'])
})

/* ---------- MAX: лента читается прокруткой сверху вниз (MAX-SCROLL-DOWN) ---------- */
// Живой дефект: в узкой правой панели pin-view MAX держит в DOM только окно
// вокруг scrollTop. У чата НЭСК в выгрузке оказалось 6 сообщений из 30, хотя
// в большом окне Chrome в DOM лежали все 30 обёрток (scrollHeight 5460 при
// clientHeight 1212). Поэтому сборщик ставит ленту в начало, читает окно и
// шагает вниз на 0.9 clientHeight, склеивая окна по подписи
// (дата+время+автор+80 символов текста). Потолок — 60 шагов; после обхода
// scrollTop возвращается на исходное место.

// Сообщения окна: по 6 штук в день, чтобы в ленте были настоящие разделители.
function maxFeedMessages(count, dayBase, prefix) {
  const items = []
  for (let index = 0; index < count; index += 1) {
    const day = dayBase + Math.floor(index / 6)
    const hours = 9 + (index % 6)
    items.push({
      author: 'Иван',
      text: prefix + ' ' + (index + 1),
      time: (hours < 10 ? '0' : '') + hours + ':00',
      date: day + ' ноября 2026'
    })
  }
  return items
}

// Длинная лента для проверки потолка шагов: даты остаются в ноябре.
function maxLongFeedMessages(count, prefix) {
  const items = []
  for (let index = 0; index < count; index += 1) {
    const day = 1 + (Math.floor(index / 12) % 28)
    const hours = 8 + (index % 12)
    items.push({
      author: 'Иван',
      text: prefix + ' ' + (index + 1),
      time: (hours < 10 ? '0' : '') + hours + ':00',
      date: day + ' ноября 2026'
    })
  }
  return items
}

// Корень ленты из сообщений с разделителями дня: maxSeparatorHistory ждёт
// готовые separator-узлы, поэтому дату каждого сообщения разворачиваем в
// настоящий разделитель (как MAX рисует день в ленте).
function maxFeedHistory(items) {
  const nodes = []
  let lastDate = null
  for (const item of items) {
    if (item.date && item.date !== lastDate) {
      nodes.push({ separator: item.date })
      lastDate = item.date
    }
    nodes.push(item)
  }
  return maxSeparatorHistory(nodes)
}

// Виртуальная лента: в DOM только окно вокруг scrollTop — как в pin-view.
// Окно — фиксированное число сообщений от scrollTop, поэтому соседние окна
// перекрываются и проверяют дедуп. growing: scrollHeight растёт вместе с
// прокруткой — лента, до низа которой за 60 шагов не добраться.
class MaxVirtualFeedNode extends MaxNode {
  constructor(options = {}) {
    super('div', { classes: 'scrollable scrollListScrollable', children: [] })
    this.messages = Array.isArray(options.messages) ? options.messages : []
    this.perMessage = Number.isFinite(options.perMessage) ? options.perMessage : 100
    this.clientHeightValue = Number.isFinite(options.clientHeight) ? options.clientHeight : 600
    this.windowSize = Number.isFinite(options.windowSize) ? options.windowSize : 6
    this.growing = options.growing === true
    this.failAfterWrites = Number.isFinite(options.failAfterWrites) ? options.failAfterWrites : null
    this.writes = []
    this.windows = []
    this.top = 0
    // Исходная позиция — без записи в журнал: шаги сборщика видны отдельно.
    this.top = this.clamp(Number.isFinite(options.initialTop) ? options.initialTop : 0)
    this.renderWindow()
  }
  get scrollHeight() {
    return this.messages.length * this.perMessage + (this.growing ? this.top : 0)
  }
  get clientHeight() { return this.clientHeightValue }
  get scrollTop() { return this.top }
  set scrollTop(value) {
    const raw = Number(value) || 0
    this.writes.push(raw)
    this.top = this.clamp(raw)
    if (this.failAfterWrites !== null && this.writes.length >= this.failAfterWrites) {
      this.children = []
      return
    }
    this.renderWindow()
  }
  clamp(value) {
    const max = Math.max(0, this.scrollHeight - this.clientHeightValue)
    return Math.min(Math.max(0, value), max)
  }
  renderWindow() {
    const first = Math.min(Math.max(0, this.messages.length - 1), Math.floor(this.top / this.perMessage))
    const slice = this.messages.slice(first, first + this.windowSize)
    this.windows.push({ top: this.top, first, count: slice.length })
    this.children = slice.length ? [maxFeedHistory(slice)] : []
    for (const child of this.children) child.parent = this
  }
}

// Страница MAX с виртуальной лентой и списком чатов: те же селекторы, что в
// production, но в DOM только текущее окно.
function maxScrollFeedPage(options = {}) {
  const title = options.title || 'Лента'
  const pathname = options.pathname || '/-777'
  const feed = new MaxVirtualFeedNode({
    messages: options.messages,
    clientHeight: options.clientHeight,
    perMessage: options.perMessage,
    windowSize: options.windowSize,
    growing: options.growing,
    failAfterWrites: options.failAfterWrites,
    initialTop: Number.isFinite(options.initialTop) ? options.initialTop : 640
  })
  const page = { title, pathname, feed, listWrites: 0 }
  const row = new MaxNode('button', {
    classes: 'cell',
    children: [new MaxNode('h3', {
      classes: 'title',
      children: [new MaxNode('span', {
        classes: 'name',
        children: [new MaxNode('span', { classes: 'text', text: title })]
      })]
    })]
  })
  row.onClick = () => {}
  // Индекс 0 — список чатов: прокручивается, но сообщений не содержит.
  const chatList = new MaxNode('div', { classes: 'scrollable scrollListScrollable', children: [row] })
  Object.defineProperty(chatList, 'scrollTop', { get: () => 0, set: () => { page.listWrites += 1 } })
  const header = new MaxNode('button', { classes: 'main', attrs: { 'aria-label': 'Открыть профиль ' + title } })
  const tree = new MaxNode('document', { children: [chatList, feed, header] })
  page.tree = tree
  page.document = {
    readyState: 'complete',
    body: { innerText: '' },
    querySelectorAll(selector) { return tree.querySelectorAll(selector) },
    querySelector(selector) { return tree.querySelector(selector) }
  }
  page.location = { pathname: pathname, href: 'https://web.max.ru' + pathname }
  page.ctx = vm.createContext({
    document: page.document, location: page.location, JSON, String, Number, Date, Math, Object, Array, RegExp,
    setTimeout, clearTimeout
  })
  return page
}

// Сбор через настоящий __chatHubCollectMaxHistory с реальными паузами.
async function maxFeedCollect(page, extra = {}) {
  const ctx = maxCollector(maxFakeView(page))
  return JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru' + page.location.pathname, title: page.title || page.current }],
    ...extra
  })))
}

// Тот же сбор, но таймеры схлопнуты: журнал пауз проверяется отдельно, а
// 60 шагов не должны занимать 30 реальных секунд.
function maxCollectorWithWaits(view, waits) {
  return sandbox(MAX_COLLECT_FUNCTIONS, {
    state: { svcViews: { max: view } },
    setTimeout(fn, ms) { waits.push(Number(ms) || 0); return setTimeout(fn, 0) },
    clearTimeout,
    URL
  })
}

async function maxFeedCollectFast(page, waits = [], extra = {}) {
  const ctx = maxCollectorWithWaits(maxFakeView(page), waits)
  return JSON.parse(await ctx.__chatHubCollectMaxHistory(JSON.stringify({
    chats: [{ pinId: 'p1', url: 'https://web.max.ru' + page.location.pathname, title: page.title || page.current }],
    ...extra
  })))
}

// page.feedWrites — фактические записи scrollTop ленты; page.feedTop — текущее
// положение; page.listWrites — попытки крутить список чатов. Фикстура считает
// любую запись, чтобы тест видел и старт в 0, и возврат.
function maxFeedPage(options = {}) {
  const recent = Array.isArray(options.recent) ? options.recent : []
  const title = options.title || 'Чат'
  const clientHeight = Number.isFinite(options.clientHeight) ? options.clientHeight : 1212
  const perMessage = Number.isFinite(options.perMessage) ? options.perMessage : 100
  const fixedHeight = Number.isFinite(options.scrollHeight) ? options.scrollHeight : null
  const page = {
    title,
    pathname: options.pathname || '/-500',
    clientHeight,
    feedWrites: [],
    feedTop: Number.isFinite(options.initialTop) ? options.initialTop : 640,
    listWrites: 0
  }
  const row = new MaxNode('button', {
    classes: 'cell',
    children: [new MaxNode('h3', {
      classes: 'title',
      children: [new MaxNode('span', {
        classes: 'name',
        children: [new MaxNode('span', { classes: 'text', text: title })]
      })]
    })]
  })
  row.onClick = () => {}
  // Индекс 0 — список чатов: прокручивается, но сообщений не содержит.
  const chatList = new MaxNode('div', { classes: 'scrollable scrollListScrollable', children: [row] })
  Object.defineProperty(chatList, 'scrollTop', { get: () => 0, set: () => { page.listWrites += 1 } })
  const nodes = [chatList]
  let feed = null
  if (options.withFeed !== false) {
    feed = new MaxNode('div', { classes: 'scrollable scrollListScrollable', children: [maxFeedHistory(recent)] })
    Object.defineProperty(feed, 'scrollHeight', {
      get: () => (fixedHeight === null ? recent.length * perMessage : fixedHeight)
    })
    Object.defineProperty(feed, 'clientHeight', { get: () => clientHeight })
    Object.defineProperty(feed, 'scrollTop', {
      get: () => page.feedTop,
      set: value => {
        // Любая запись — уже событие: тест ловит и старт, и шаг, и возврат.
        const raw = Number(value) || 0
        page.feedWrites.push(raw)
        page.feedTop = Math.min(Math.max(0, raw), Math.max(0, feed.scrollHeight - clientHeight))
      }
    })
    nodes.push(feed)
  } else {
    // Корень истории есть, но лежит вне прокручиваемого контейнера: ленты нет.
    nodes.push(maxSeparatorHistory(recent))
  }
  nodes.push(new MaxNode('button', { classes: 'main', attrs: { 'aria-label': 'Открыть профиль ' + title } }))
  const tree = new MaxNode('document', { children: nodes })
  const document = {
    readyState: 'complete',
    body: { innerText: '' },
    querySelectorAll(selector) { return tree.querySelectorAll(selector) },
    querySelector(selector) { return tree.querySelector(selector) }
  }
  page.document = document
  page.tree = tree
  page.feed = feed
  page.chatList = chatList
  page.location = { pathname: page.pathname, href: 'https://web.max.ru' + page.pathname }
  page.ctx = vm.createContext({
    document, location: page.location, JSON, String, Number, Date, Math, Object, Array, RegExp,
    setTimeout, clearTimeout
  })
  return page
}

test('MAX прокрутка: старт с 0, все 30 сообщений из окон без дублей, стоп по низу', async () => {
  const page = maxScrollFeedPage({ messages: maxFeedMessages(30, 14, 'свежее') })
  const result = await maxFeedCollect(page)
  const chat = result.chats[0]
  assert.equal(chat.status, 'ok')
  assert.equal(chat.code, null)
  assert.equal(chat.messages.length, 30, 'каждое сообщение попало в результат')
  assert.deepEqual(chat.messages.map(message => message.text),
    Array.from({ length: 30 }, (_, index) => 'свежее ' + (index + 1)))
  assert.equal(new Set(chat.messages.map(message => message.text)).size, 30, 'дублей нет')
  const rendered = page.feed.windows.reduce((sum, window) => sum + window.count, 0)
  assert.ok(rendered > 30, 'окна перекрывались, дедуп реально работал: ' + rendered)
  assert.equal(page.feed.writes[0], 0, 'первая запись — начало ленты')
  assert.equal(page.listWrites, 0, 'список чатов не прокручивается')
  assert.equal(chat.coverage, 'full')
  assert.ok(page.feed.windows.length < 60, 'до низа дошли раньше потолка')
})

test('MAX прокрутка: исходный scrollTop восстанавливается после сбора', async () => {
  const page = maxScrollFeedPage({ messages: maxFeedMessages(30, 14, 'свежее'), initialTop: 1000 })
  const result = await maxFeedCollectFast(page)
  assert.equal(result.chats[0].status, 'ok')
  assert.equal(page.feed.writes.at(-1), 1000, 'последняя запись — исходная позиция')
  assert.equal(page.feed.scrollTop, 1000)
})

test('MAX прокрутка: 60 шагов без низа — coverage truncated', async () => {
  const page = maxScrollFeedPage({
    messages: maxLongFeedMessages(600, 'длинная'),
    growing: true,
    initialTop: 200
  })
  const waits = []
  const result = await maxFeedCollectFast(page, waits)
  const chat = result.chats[0]
  assert.equal(chat.status, 'ok')
  assert.equal(chat.coverage, 'truncated')
  const line = result.notes.find(text => text.startsWith('MAX: собрано '))
  assert.match(line, /, шагов 60, /)
  assert.equal(waits.filter(ms => ms === 500).length, 60, 'ровно 60 шаговых пауз')
  assert.equal(page.feed.scrollTop, 200, 'позиция восстановлена и после потолка')
})

test('MAX прокрутка: одинаковый текст в разное время не теряется', async () => {
  const messages = maxFeedMessages(30, 14, 'свежее')
  messages[2] = { author: 'Иван', text: 'ок', time: '10:00', date: '18 ноября 2026' }
  messages[25] = { author: 'Иван', text: 'ок', time: '16:00', date: '18 ноября 2026' }
  const page = maxScrollFeedPage({ messages })
  const result = await maxFeedCollectFast(page)
  const oks = result.chats[0].messages.filter(message => message.text === 'ок')
  assert.equal(oks.length, 2, 'оба «ок» из разных окон сохранены')
  assert.deepEqual(oks.map(message => message.timestamp),
    ['2026-11-18T10:00:00+07:00', '2026-11-18T16:00:00+07:00'])
})

test('MAX прокрутка: шаг 0.9 clientHeight, пауза 400 мс на старте и 500 мс между шагами', async () => {
  const page = maxScrollFeedPage({ messages: maxFeedMessages(30, 14, 'свежее') })
  const waits = []
  const result = await maxFeedCollectFast(page, waits)
  assert.equal(result.chats[0].status, 'ok')
  assert.deepEqual(page.feed.writes.slice(0, 6), [0, 540, 1080, 1620, 2160, 2400])
  assert.equal(waits.filter(ms => ms === 400).length, 1, 'пауза после установки в начало')
  assert.ok(waits.filter(ms => ms === 500).length >= 4, 'между шагами 500 мс: ' + JSON.stringify(waits))
  const firstStart = waits.indexOf(400)
  const firstStep = waits.indexOf(500)
  assert.ok(firstStart >= 0 && firstStep > firstStart, 'старт раньше первого шага')
})

test('MAX прокрутка: лентой считается контейнер с сообщениями, а не список чатов', () => {
  const page = maxFeedPage({ recent: maxFeedMessages(6, 14, 'свежее') })
  const ctx = sandbox(['__chatHubMaxFeedMetrics'], { document: page.document })
  const state = JSON.parse(ctx.__chatHubMaxFeedMetrics())
  assert.equal(state.ok, true)
  assert.equal(state.scrollers, 2, 'в документе два прокручиваемых контейнера')
  assert.equal(state.feeds, 1, 'лента ровно одна — та, где есть .messageWrapper')
  assert.equal(state.index, 1, 'индекс ленты среди .scrollListScrollable')
  assert.equal(state.wrapperCount, 6)
  assert.equal(state.scrollHeight, 600)
  assert.equal(state.clientHeight, 1212)
  // Лента короче окна: запаса нет (отрицательное значение не выдумываем).
  assert.equal(state.reserve, 0)
  assert.deepEqual(page.feedWrites, [], 'чтение метрик ничего не двигает')
})

test('MAX прокрутка: граница глубины достигнута — coverage full без низа', async () => {
  const page = maxScrollFeedPage({
    messages: maxLongFeedMessages(600, 'длинная'),
    growing: true,
    initialTop: 0
  })
  const result = await maxFeedCollectFast(page, [], { windowStartMs: Date.parse('2026-12-31T00:00:00+07:00') })
  assert.equal(result.chats[0].coverage, 'full', 'самый старый timestamp ≤ windowStartMs')
  assert.equal(result.chats[0].messages.length > 0, true)
})

test('MAX прокрутка: 29 обёрток — дошли до низа, coverage full', async () => {
  const page = maxFeedPage({ recent: maxFeedMessages(29, 14, 'свежее') })
  const result = await maxFeedCollectFast(page)
  assert.equal(result.chats[0].coverage, 'full')
  assert.equal(result.chats[0].messages.length, 29)
})

test('MAX прокрутка: запаса прокрутки нет — coverage full, шагов нет', async () => {
  const page = maxFeedPage({
    recent: maxFeedMessages(30, 14, 'свежее'),
    clientHeight: 1212,
    scrollHeight: 1212,
    // Живой случай Агасиевой: лента целиком в окне, прокрутки нет вовсе.
    initialTop: 0
  })
  const result = await maxFeedCollectFast(page)
  assert.equal(result.chats[0].status, 'ok')
  assert.equal(result.chats[0].coverage, 'full', 'весь загруженный чат уже в DOM')
  assert.equal(result.chats[0].messages.length, 30)
  assert.deepEqual(page.feedWrites, [0, 0], 'только старт в 0 и возврат в 0')
})

test('MAX прокрутка: запас 3 px — coverage full после одного шага', async () => {
  const page = maxFeedPage({
    recent: maxFeedMessages(30, 14, 'свежее'),
    clientHeight: 1212,
    scrollHeight: 1215
  })
  const result = await maxFeedCollectFast(page)
  assert.equal(result.chats[0].coverage, 'full', 'порог низа — 2 px')
  assert.equal(result.chats[0].messages.length, 30)
})

test('MAX прокрутка: лента Tantor (13 обёрток, 1603/1212) — coverage full, низ достигнут', async () => {
  const page = maxFeedPage({
    recent: maxFeedMessages(13, 14, 'свежее'),
    clientHeight: 1212,
    scrollHeight: 1603,
    initialTop: 0
  })
  const result = await maxFeedCollectFast(page)
  assert.equal(result.chats[0].coverage, 'full', '13 обёрток — не признак среза')
  assert.equal(result.chats[0].messages.length, 13)
  assert.deepEqual(page.feedWrites, [0, 391, 0])
})

test('MAX прокрутка: строка отчёта «собрано N сообщений, шагов K, диапазон …»', async () => {
  const page = maxScrollFeedPage({ messages: maxFeedMessages(30, 14, 'свежее') })
  const result = await maxFeedCollectFast(page)
  const lines = result.notes.filter(text => text.startsWith('MAX: собрано '))
  assert.equal(lines.length, 1, 'ровно одна строка на чат: ' + JSON.stringify(result.notes))
  assert.equal(lines[0], 'MAX: собрано 30 сообщений, шагов 6, диапазон 2026-11-14—2026-11-18, покрытие: full')
})

test('MAX прокрутка: в сборщике цикл вниз с потолком 60 и без wheel/scrollBy', () => {
  const body = extractFunction('__chatHubCollectMaxHistory')
  assert.match(body, /__chatHubMaxScrollFeedTo/)
  assert.match(body, /__chatHubMaxSleep\(400\)/)
  assert.match(body, /__chatHubMaxSleep\(500\)/)
  assert.match(body, /height \* 0\.9/)
  assert.match(body, /step < 60/)
  assert.match(body, /top \+ height >= total - 2/)
  // Стратегии колеса и прокрутки документа не нужны: двигается scrollTop ленты.
  assert.equal(/WheelEvent/.test(SRC), false, 'WheelEvent не нужен')
  assert.equal(/scrollBy/.test(SRC), false, 'scrollBy не нужен')
})

test('MAX прокрутка: только список чатов без ленты — HISTORY_ROOT_MISSING', async () => {
  const page = maxFeedPage({ recent: maxFeedMessages(3, 14, 'свежее'), withFeed: false })
  const result = await maxFeedCollect(page)
  assert.equal(result.chats[0].status, 'error')
  assert.equal(result.chats[0].code, 'HISTORY_ROOT_MISSING')
  assert.deepEqual(result.chats[0].messages, [])
  assert.equal(page.listWrites, 0)
})

test('MAX прокрутка: без прокручиваемых контейнеров — одно окно и coverage window', async () => {
  const page = maxFakePage([{
    title: 'Без виртуализации',
    pathname: '/-50',
    messages: [{ author: 'Иван', text: 'первое', time: '10:00', date: '19 ноября 2026' }]
  }])
  const result = await maxFeedCollect(page)
  assert.equal(result.chats[0].status, 'ok')
  assert.equal(result.chats[0].coverage, 'window')
  assert.equal(result.chats[0].messages.length, 1)
  assert.ok(result.notes.some(line => line.startsWith('MAX: собрано 1 сообщений, шагов 0, ')),
    JSON.stringify(result.notes))
})

test('MAX прокрутка: в узкой панели в DOM только 6 сообщений, сбор всё равно полный', async () => {
  const page = maxScrollFeedPage({ messages: maxFeedMessages(30, 14, 'свежее') })
  assert.equal(page.document.querySelectorAll('.messageWrapper[role]').length, 6,
    'узкая панель рендерит только окно')
  const result = await maxFeedCollectFast(page)
  assert.equal(result.chats[0].messages.length, 30)
  assert.ok(page.feed.windows.some(window => window.first === 0), 'читалось начало ленты')
  assert.ok(page.feed.windows.some(window => window.first + window.count >= 30), 'читался конец ленты')
})

test('MAX прокрутка: лента исчезла посреди обхода — truncated без падения', async () => {
  const page = maxScrollFeedPage({ messages: maxFeedMessages(30, 14, 'свежее'), failAfterWrites: 2 })
  const result = await maxFeedCollectFast(page)
  const chat = result.chats[0]
  assert.equal(chat.status, 'ok')
  assert.equal(chat.coverage, 'truncated')
  assert.ok(chat.messages.length > 0, 'прочитанное окно не потеряно')
  assert.ok(chat.messages.length < 30, 'невиденное не выдаётся за собранное')
})

test('MAX прокрутка: 30 обёрток при переполнении — не признак среза, coverage full', async () => {
  const page = maxScrollFeedPage({ messages: maxFeedMessages(30, 14, 'свежее') })
  const result = await maxFeedCollectFast(page)
  assert.equal(result.chats[0].coverage, 'full', 'дошли до низа — среза нет')
  assert.equal(result.chats[0].messages.length, 30)
})

/* ---------- MCP-NOTES: строки сборщика MAX доходят до отчёта ---------- */

test('MCP отчёт MAX: notes сборщика печатаются отдельным блоком после списка чатов', () => {
  const ctx = mcpReportLineCtx()
  const notes = [
    'MAX: сессия ок',
    'MAX: рабочий webview — pin, лента: 1',
    'MAX: собрано 30 сообщений, шагов 6, диапазон 2026-11-14—2026-11-18, покрытие: full',
    'MAX: лента top=0/sh=3000/ch=600 wraps=6 → top=540/wraps=6, шагов 6, собрано 30'
  ]
  const lines = ctx.mcpReportLines({
    ok: true,
    files: [{ project: '14544', path: 'C:/out/14544.md', count: 30 }],
    chats: [{ pinId: 'p1', service: 'max', status: 'ok', coverage: 'full', count: 30, undated: 0 }],
    errors: [],
    notes
  })
  const chatsIndex = lines.indexOf('Чаты (1):')
  const notesIndex = lines.indexOf('Заметки сборщика MAX:')
  assert.ok(chatsIndex >= 0, 'список чатов напечатан: ' + JSON.stringify(lines))
  assert.ok(notesIndex > chatsIndex, 'блок notes идёт после «Чаты (N)»: ' + JSON.stringify(lines))
  // Каждая строка сборщика — отдельной строкой, без склейки и потерь.
  // Массив из vm-контекста приводим к массиву теста: прототипы разные.
  assert.deepEqual([...lines.slice(notesIndex + 1, notesIndex + 1 + notes.length)], notes)
  // Без notes блок не появляется вовсе — прежний отчёт не меняется.
  const bare = mcpReportLineCtx().mcpReportLines({
    ok: true, files: [{ project: '1', path: 'a.md', count: 1 }], chats: [], errors: []
  })
  assert.equal(bare.includes('Заметки сборщика MAX:'), false)
})

test('MAX трасса: метрики скроллера до и после первого шага — одной строкой', async () => {
  const page = maxScrollFeedPage({ messages: maxFeedMessages(30, 14, 'свежее') })
  const result = await maxFeedCollectFast(page)
  const trace = result.notes.filter(text => text.startsWith('MAX: лента '))
  assert.equal(trace.length, 1, 'ровно одна строка трассы: ' + JSON.stringify(result.notes))
  // До первого шага лента стоит в начале: top=0, sh=30*100, ch=600, wraps=6.
  // После шага 0,9*clientHeight: top=540 и то же окно в 6 обёрток.
  assert.equal(trace[0], 'MAX: лента top=0/sh=3000/ch=600 wraps=6 → top=540/wraps=6, шагов 6, собрано 30')
  assert.match(trace[0],
    /^MAX: лента top=\d+\/sh=\d+\/ch=\d+ wraps=\d+ → top=\d+\/wraps=\d+, шагов \d+, собрано \d+$/)
  // Трасса — диагностика шага: она идёт после строки «собрано …» того же чата.
  const collectedIndex = result.notes.findIndex(text => text.startsWith('MAX: собрано '))
  assert.ok(collectedIndex >= 0 && result.notes.indexOf(trace[0]) > collectedIndex)
})

/* ---------- Избранное: выгрузка локального списка в Markdown ---------- */

test('Избранное: кнопка выгрузки в MD стоит под списком и показывает результат', async () => {
  const f = await settingsPinEditor()
  vm.runInContext(extractFunction('favoritesExportErrorText'), f.h.ctx)
  const controls = f.host.children[f.host.children.length - 1]
  const button = controls.children[0]
  assert.equal(button.id, 'fav-export-md')
  assert.equal(button.textContent, 'Выгрузить список в MD')
  assert.equal(button.type, 'button')

  const notices = []
  f.h.ctx.toast = message => notices.push(message)
  let calls = 0
  f.h.ctx.window.hub.favoritesExport = async () => {
    calls++
    return { ok: true, path: 'C:/Выгрузка/favorites_24112026.md', count: 2 }
  }
  await button.onclick()
  assert.equal(calls, 1)
  assert.deepEqual(notices, ['Список избранного: 2 чатов → C:/Выгрузка/favorites_24112026.md'])
  assert.equal(button.disabled, false, 'кнопка снова доступна после ответа')

  // Отмена выбора пути и ошибка — понятной строкой, а не «готово».
  f.h.ctx.window.hub.favoritesExport = async () => ({ ok: false, code: 'CANCELLED' })
  await button.onclick()
  assert.match(notices[notices.length - 1], /отменен/)
  f.h.ctx.window.hub.favoritesExport = async () => ({ ok: false, code: 'EXPORT_DIR_MISSING' })
  await button.onclick()
  assert.match(notices[notices.length - 1], /EXPORT_DIR_MISSING|Не удалось/)
})

test('Избранное: кнопка выгрузки остаётся доступной и при пустом списке', async () => {
  const h = startupSandbox(true)
  await h.ctx.init()
  vm.runInContext(extractFunction('renderPinRows'), h.ctx)
  h.state.cfg.pinned = []
  const host = h.ctx.document.createElement('div')
  h.ctx.renderPinRows(host)
  assert.match(host.innerHTML, /Пока ничего в избранном/)
  const controls = host.children[host.children.length - 1]
  assert.equal(controls.children[0].id, 'fav-export-md')
})
