// tests/service-memory-saver-renderer.test.js
// Renderer-side memory controls: executes real renderer.js functions in an
// offline synthetic DOM/VM harness. No Electron, webview process, network,
// profile or messenger session is involved.
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8')

function extractFunction(name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{')
  const match = re.exec(SOURCE)
  if (!match) throw new Error('renderer.js function not found: ' + name)
  let depth = 0
  let end = match.index + match[0].length - 1
  for (; end < SOURCE.length; end++) {
    if (SOURCE[end] === '{') depth++
    else if (SOURCE[end] === '}') { depth--; if (depth === 0) break }
  }
  return SOURCE.slice(match.index, end + 1)
}

function extractConst(name) {
  const match = new RegExp('^const ' + name + ' = (.+)$', 'm').exec(SOURCE)
  if (!match) throw new Error('renderer.js const not found: ' + name)
  return 'const ' + name + ' = ' + match[1].trim()
}

/* ---------- minimal synthetic DOM ---------- */

const VOID_TAGS = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr'])

class ClassList {
  constructor(el) { this.el = el }
  add(...names) { for (const n of names) if (n) this.el._classes.add(n) }
  remove(...names) { for (const n of names) this.el._classes.delete(n) }
  contains(name) { return this.el._classes.has(name) }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : !!force
    if (on) this.add(name); else this.remove(name)
    return on
  }
}

class Element {
  constructor(tag, doc) {
    this.tag = String(tag).toLowerCase()
    this.doc = doc
    this.children = []
    this.parent = null
    this.dataset = {}
    this.attributes = {}
    this._classes = new Set()
    this.classList = new ClassList(this)
    this.style = {}
    this._text = ''
    this.listeners = new Map()
    this.checked = false
    this.value = ''
    this.disabled = false
    this.title = ''
    this.__isDocumentRoot = false
  }
  get tagName() { return this.tag === '#text' ? '#text' : this.tag.toUpperCase() }
  get parentElement() { return this.parent }
  set parentElement(value) { this.parent = value }
  get nextSibling() {
    if (!this.parent) return null
    const index = this.parent.children.indexOf(this)
    return index < 0 ? null : this.parent.children[index + 1] || null
  }
  get isConnected() {
    let node = this
    while (node) { if (node.__isDocumentRoot) return true; node = node.parent }
    return false
  }
  get className() { return Array.from(this._classes).join(' ') }
  set className(value) {
    this._classes.clear()
    for (const part of String(value || '').split(/\s+/)) if (part) this._classes.add(part)
  }
  get textContent() {
    if (this.tag === '#text') return this._text
    return this._text + this.children.map(child => child.textContent).join('')
  }
  set textContent(value) {
    this.children = []
    this._text = value == null ? '' : String(value)
  }
  get id() { return this.attributes.id || '' }
  set id(value) { this.attributes.id = String(value); this.doc._index(this) }
  get innerHTML() { return this.children.map(child => child.outerHTML || child.textContent).join('') }
  set innerHTML(html) {
    this.children = []
    this._text = ''
    parseInto(this, String(html == null ? '' : html), this.doc)
  }
  get outerHTML() {
    if (this.tag === '#text') return this._text
    const attrs = Object.entries(this.attributes).map(([k, v]) => v === '' ? ' ' + k : ' ' + k + '="' + v + '"').join('')
    return '<' + this.tag + attrs + '>' + this.innerHTML + '</' + this.tag + '>'
  }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null }
  removeAttribute(name) { delete this.attributes[name] }
  appendChild(child) {
    if (!child) return child
    if (child.parent) child.parent.removeChild(child)
    child.parent = this
    this.children.push(child)
    return child
  }
  removeChild(child) {
    const i = this.children.indexOf(child)
    if (i >= 0) this.children.splice(i, 1)
    child.parent = null
    return child
  }
  remove() { if (this.parent) this.parent.removeChild(this) }
  before(...nodes) {
    if (!this.parent) return
    let index = this.parent.children.indexOf(this)
    if (index < 0) return
    for (const node of nodes) {
      if (node.parent) node.parent.removeChild(node)
      node.parent = this.parent
      this.parent.children.splice(index++, 0, node)
    }
  }
  addEventListener(type, cb, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Map())
    this.listeners.get(type).set(cb, options || {})
  }
  removeEventListener(type, cb) { this.listeners.get(type)?.delete(cb) }
  emit(type, event) {
    const handlers = [...(this.listeners.get(type) || [])]
    for (const [cb, opts] of handlers) {
      if (opts.once) this.removeEventListener(type, cb)
      cb(event || {})
    }
  }
  closest(selector) {
    let node = this
    while (node && node.tag !== '#text') {
      if (node.matches(selector)) return node
      node = node.parent
    }
    return null
  }
  matches(selector) {
    return String(selector).split(',').some(part => {
      const compound = parseCompound(part.trim())
      if (!compound) return false
      if (compound.tag && compound.tag !== this.tag) return false
      if (compound.id && this.attributes.id !== compound.id) return false
      for (const cls of compound.classes) if (!this._classes.has(cls)) return false
      for (const [name, value] of compound.attrs) {
        if (name.indexOf('data-') === 0) {
          const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
          if (value === null ? this.dataset[key] === undefined : String(this.dataset[key]) !== value) return false
        } else if (value === null) {
          if (!Object.prototype.hasOwnProperty.call(this.attributes, name)) return false
        } else if (this.attributes[name] !== value) return false
      }
      return true
    })
  }
  querySelectorAll(selector) {
    const found = []
    const visit = node => {
      for (const child of node.children) {
        if (child.tag !== '#text' && childMatchesSelector(child, selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
}

function matchesChain(el, chain) {
  if (!el || el.tag === '#text') return false
  if (!el.matches(tagSelector(chain[chain.length - 1]))) return false
  let ancestor = el.parent
  for (let i = chain.length - 2; i >= 0; i--) {
    while (ancestor && (ancestor.tag === '#text' || !ancestor.matches(tagSelector(chain[i])))) ancestor = ancestor.parent
    if (!ancestor || ancestor.tag === '#text') return false
    ancestor = ancestor.parent
  }
  return true
}

function parseCompound(text) {
  if (!text) return null
  const m = /^([a-zA-Z0-9-]*)((?:[.#][\w-]+|\[[^\]]+\])*)$/.exec(text)
  if (!m) return null
  const compound = { tag: m[1] ? m[1].toLowerCase() : '', id: '', classes: [], attrs: [] }
  let rest = m[2]
  while (rest.length) {
    if (rest[0] === '.') {
      const r = /^\.([\w-]+)/.exec(rest); compound.classes.push(r[1]); rest = rest.slice(r[0].length)
    } else if (rest[0] === '#') {
      const r = /^#([\w-]+)/.exec(rest); compound.id = r[1]; rest = rest.slice(r[0].length)
    } else {
      const r = /^\[([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest)
      compound.attrs.push([r[1], r[2] !== undefined ? r[2] : r[3] !== undefined ? r[3] : r[4] !== undefined ? r[4] : null])
      rest = rest.slice(r[0].length)
    }
  }
  return compound
}

function childMatchesSelector(el, selector) {
  return String(selector).split(',').some(part => {
    const chain = part.trim().split(/\s+/).map(parseCompound).filter(Boolean)
    if (!chain.length) return false
    return matchesChain(el, chain)
  })
}

function tagSelector(compound) {
  let s = compound.tag || ''
  if (compound.id) s += '#' + compound.id
  for (const cls of compound.classes) s += '.' + cls
  for (const [name, value] of compound.attrs) s += value === null ? '[' + name + ']' : '[' + name + '="' + value + '"]'
  return s
}

function parseInto(root, html, doc) {
  const stack = [root]
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g
  let match
  while ((match = re.exec(html))) {
    if (match[0].startsWith('<!--')) continue
    if (match[1]) {
      const tag = match[1].toLowerCase()
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break }
      continue
    }
    if (match[2]) {
      const el = doc.createElement(match[2])
      const attrs = match[3] || ''
      const attrRe = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
      let attr
      while ((attr = attrRe.exec(attrs))) {
        const name = attr[1]
        const value = attr[2] !== undefined ? attr[2] : attr[3] !== undefined ? attr[3] : attr[4] !== undefined ? attr[4] : ''
        el.setAttribute(name, value)
        if (name === 'id') el.id = value
        if (name === 'class') el.className = value
        if (name.indexOf('data-') === 0) {
          el.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
        }
      }
      stack[stack.length - 1].appendChild(el)
      if (!VOID_TAGS.has(el.tag) && match[4] !== '/') stack.push(el)
      continue
    }
    if (match[5]) {
      const text = doc.createElement('#text')
      text._text = match[5]
      stack[stack.length - 1].appendChild(text)
    }
  }
}

function createDocument() {
  const doc = {}
  doc.createElement = tag => new Element(tag, doc)
  doc._index = () => {}
  const root = doc.createElement('html')
  root.__isDocumentRoot = true
  root.classList.add('document-root')
  doc.documentElement = root
  doc.body = doc.createElement('body')
  root.appendChild(doc.body)
  doc.querySelector = selector => root.querySelector(selector)
  doc.querySelectorAll = selector => root.querySelectorAll(selector)
  doc.getElementById = id => {
    const all = []
    const visit = node => { for (const c of node.children) { all.push(c); visit(c) } }
    visit(root)
    return all.find(el => el.tag !== '#text' && el.attributes.id === id) || null
  }
  doc.addEventListener = () => {}
  doc.styleSheets = []
  return doc
}

/* ---------- renderer sandbox ---------- */

const SERVICES = [
  { id: 'mm', name: 'Mattermost', url: 'https://mm.fixture.invalid/team/channels/town-square', partition: 'persist:mm' },
  { id: 'tg', name: 'Telegram', url: 'https://web.telegram.org/k/#@fixture_chat', partition: 'persist:tg' },
  { id: 'max', name: 'MAX', url: 'https://web.max.ru/', partition: 'persist:max' },
  { id: 'ydx', name: 'Телемост', url: 'https://telemost.yandex.ru/', partition: 'persist:ydx' }
]

const CORE_FUNCTIONS = [
  'initialSvcUrl', 'buildSection', 'activateTab', 'init', 'markServiceTabOpened',
  'enqueueLoad', 'pumpPreload', 'maxLiveViews', 'destroyPinView', 'trimPinViews',
  'cloneConfigForSave', 'queueConfigSave', 'saveConfig',
  'serviceMemoryPolicy', 'retireServiceView',
  'recreateServiceView', 'serviceIdleTick', 'serviceIdleWatch',
  'serviceMemoryGuardTick', 'serviceMemoryGuardWatch'
]

const CORE_CONSTS = [
  'SERVICE_IDLE_DEADLINE_MS',
  'SERVICE_IDLE_CHECK_MS',
  'SERVICE_MEMORY_GUARD_POLL_MS',
  'SERVICE_MEMORY_GUARD_SINGLE_MIB',
  'SERVICE_MEMORY_GUARD_TOTAL_MIB',
  'SERVICE_MEMORY_GUARD_COOLDOWN_MS'
]

function createEnv(options = {}) {
  const doc = createDocument()
  const content = doc.createElement('section')
  content.id = 'content'
  doc.body.appendChild(content)
  const timers = new Map()
  const intervals = new Map()
  const srcCalls = []
  const saves = []
  const pendingSaves = []
  const badges = []
  const metricsCalls = []
  let timerSeq = 0

  const state = {
    cfg: {
      services: options.services || SERVICES,
      pinned: options.pinned || [],
      serviceMemorySaver: options.saver === true,
      maxLiveViews: options.maxLiveViews || 8,
      selectedPinId: '',
      ...(options.cfgExtra || {})
    },
    svcViews: {},
    pinViews: {},
    lastUsed: options.lastUsed || {},
    unreadTotals: options.unreadTotals || {},
    unreadTotalsAt: options.unreadTotalsAt || {},
    unreadDots: {},
    activePinId: '',
    configSaveQueue: undefined
  }

  const ctx = vm.createContext({
    console, Date, Math, JSON, String, Number, Boolean, Object, Array, Set, Map,
    Promise, RegExp, Error, parseInt, parseFloat, isFinite, decodeURIComponent, encodeURIComponent,
    setTimeout(fn, delay) { const id = ++timerSeq; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    setInterval(fn, delay) { const id = ++timerSeq; intervals.set(id, { fn, delay }); return id },
    clearInterval(id) { intervals.delete(id) },
    document: doc,
    window: {
      hub: {
        getConfig: async () => state.cfg,
        saveConfig: cfg => {
          const copy = JSON.parse(JSON.stringify(cfg))
          saves.push(copy)
          if (!options.deferSaves) return Promise.resolve()
          return new Promise((resolve, reject) => pendingSaves.push({ cfg: copy, resolve, reject }))
        },
        configPath: async () => 'C:/synthetic/config.json',
        getVersion: async () => '0.0.0-test',
        isWinFocused: async () => true,
        getServiceMemoryMetrics: async () => {
          metricsCalls.push(1)
          return options.metrics ? options.metrics() : null
        }
      },
      location: { reloaded: false, reload() { this.reloaded = true } }
    },
    navigator: { clipboard: { writeText: async () => {} } },
    state,
    setTimeoutRef: null,
    UNREAD_EXTRACTORS: options.extractors || {},
    badgeColor: () => '#000',
    captureSvcIcon: async () => {},
    updateSvcBar: async () => {},
    updateBadge: (...args) => badges.push(['tab', ...args]),
    updateBadge2: (...args) => badges.push(['tab2', ...args]),
    closeAllFavMenus() {},
    fillFavMenu() {},
    returnServiceToOrigin: async () => true,
    removePin: async () => {},
    pinCurrentChat: async () => {},
    favoritesOf: svcId => state.cfg.pinned.filter(p => p.serviceId === svcId),
    svcViewFor: svcId => state.svcViews[svcId] || null,
    ensureKeys() {}, buildTabs() {},
    applyTheme() {}, applyLayout() {}, applyBadgeVisibility() {}, applyFavouriteDensity() {},
    applyTabIcons() {}, refreshTabIcons() {}, refreshUnreadPresentation() {}, initListSplitter() {},
    toast() {}, renderChatList() {}, renderSvcRows() {}, renderCssRows() {}, renderZoomRows() {},
    renderPinRows() {}, initSettingsTabs() {}, localSelfcheck: () => [], buildSettings: () => {},
    sortFavoritesByActivity() {}, scheduleActSave() {}, setRowPreview() {},
    confirm: () => false,
    runUnreadJob: options.runUnreadJob,
    __srcCalls: srcCalls,
    __saves: saves,
    __badges: badges,
    __metricsCalls: metricsCalls,
    __timersSize: () => timers.size
  })

  for (const name of CORE_CONSTS) vm.runInContext(extractConst(name), ctx)
  if (SOURCE.includes('async function tgSearchResolve(')) {
    vm.runInContext('let tgSearchBusy = false\nlet tgBusyAt = 0', ctx)
  }
  for (const name of CORE_FUNCTIONS) vm.runInContext(extractFunction(name), ctx)
  // module-level preload queue shared by the real enqueueLoad/pumpPreload
  vm.runInContext('const preloadQueue = []\nlet preloadBusy = false', ctx)

  // Wrap webview.setAttribute after creation instead: patch createElement on doc.
  const createElement = doc.createElement
  doc.createElement = tag => {
    const el = createElement(tag)
    if (String(tag).toLowerCase() === 'webview') {
      const setAttribute = el.setAttribute.bind(el)
      el.setAttribute = (name, value) => {
        if (name === 'src') srcCalls.push(value)
        return setAttribute(name, value)
      }
      el.loadURL = url => { srcCalls.push(url); el.attributes.src = url }
      el.reload = () => { el.attributes.reloads = String((Number(el.attributes.reloads) || 0) + 1) }
      el.executeJavaScript = async () => ''
      el.getURL = () => el.attributes.src || ''
      el.insertCSS = () => {}
    }
    return el
  }

  return { ctx, state, doc, content, srcCalls, saves, pendingSaves, badges, timers, intervals, metricsCalls }
}

async function flush(count = 40) {
  for (let i = 0; i < count; i++) await Promise.resolve()
}

function loadExtra(ctx, names) {
  for (const name of names) vm.runInContext(extractFunction(name), ctx)
}

function memoryPolicy(flags = {}, extra = {}) {
  return createEnv({
    cfgExtra: {
      serviceBackgroundThrottling: false,
      serviceIdleUnload: false,
      serviceMemoryGuard: false,
      ...flags
    },
    ...extra
  })
}

// Полный последовательный старт: init создаёт 4 секции и грузит их по очереди.
async function startAll(env) {
  await env.ctx.init()
  for (let i = 0; i < SERVICES.length; i++) {
    const wv = env.state.svcViews[SERVICES[i].id]
    if (!wv) break
    wv.emit('dom-ready')
    await flush()
  }
  await flush()
}

function intervalHandlers(env, delay) {
  return [...env.intervals.values()].filter(item => item.delay === delay).map(item => item.fn)
}

/* ---------- 1. startup keeps all four collectors ---------- */

for (const legacySaver of [false, true]) {
  test('startup launches four sequential collectors (legacy serviceMemorySaver=' + legacySaver + ') and «Сборная»/«Настройки» never evict them', async () => {
    const env = createEnv({ saver: legacySaver })
    await env.ctx.init()
    assert.equal(Object.keys(env.state.svcViews).length, 4)
    assert.deepEqual(env.srcCalls.slice(), [SERVICES[0].url], 'only the first view starts loading')
    for (let i = 0; i < 4; i++) {
      const wv = env.state.svcViews[SERVICES[i].id]
      assert.ok(wv && wv.isConnected, 'view connected: ' + SERVICES[i].id)
      wv.emit('dom-ready')
      await flush()
    }
    assert.deepEqual(env.srcCalls.slice(), SERVICES.map(s => env.ctx.initialSvcUrl(s)), 'one sequential load per service, in order')

    const live = Object.assign({}, env.state.svcViews)
    for (const tab of ['combined', 'settings', 'combined', 'settings']) {
      env.ctx.activateTab(tab)
      await flush()
      assert.equal(Object.keys(env.state.svcViews).length, 4, 'no collector retired by ' + tab)
      for (const svc of SERVICES) {
        assert.equal(env.state.svcViews[svc.id], live[svc.id], 'same view instance kept for ' + svc.id)
        assert.equal(live[svc.id].isConnected, true, 'view still in DOM: ' + svc.id)
        assert.ok(env.doc.querySelector('section[data-tab="svc:' + svc.id + '"]'), 'section kept: ' + svc.id)
      }
    }
    assert.equal(vm.runInContext('preloadQueue.length', env.ctx), 0)
    assert.equal(env.srcCalls.length, 4, 'no extra navigation')
  })
}

test('legacy serviceMemorySaver is not read as a lifecycle policy anywhere in renderer source', () => {
  const hits = SOURCE.split('\n').filter(line => line.includes('serviceMemorySaver') && !/^\s*\/\//.test(line))
  assert.deepEqual(hits.map(line => line.trim()), [], 'renderer must ignore serviceMemorySaver')
})

/* ---------- 2. background throttling ---------- */

test('backgroundThrottling=no is kept by default and omitted when the runtime policy enables throttling', async () => {
  const def = createEnv({ saver: false })
  await def.ctx.init()
  assert.equal(def.state.svcViews.mm.getAttribute('webpreferences'), 'backgroundThrottling=no')

  const on = memoryPolicy({ serviceBackgroundThrottling: true })
  await on.ctx.init()
  assert.equal(on.state.svcViews.mm.getAttribute('webpreferences'), null)
})

test('throttling changes only webpreferences, including the Telegram healing replacement, never residency', async () => {
  for (const throttled of [false, true]) {
    const env = memoryPolicy({ serviceBackgroundThrottling: throttled })
    await startAll(env)
    const viewsBefore = Object.assign({}, env.state.svcViews)
    const tgBefore = viewsBefore.tg
    assert.equal(tgBefore.getAttribute('webpreferences'), throttled ? null : 'backgroundThrottling=no')

    const heal = intervalHandlers(env, 20000)
    assert.equal(heal.length, 1, 'Telegram healing interval registered')
    heal[0]()
    await flush(80)

    const tgAfter = env.state.svcViews.tg
    assert.notEqual(tgAfter, tgBefore, 'healing replaced the Telegram view')
    assert.equal(tgAfter.getAttribute('webpreferences'), throttled ? null : 'backgroundThrottling=no', 'healing honours the runtime policy')
    assert.equal(tgAfter.getAttribute('partition'), 'persist:tg')
    assert.equal(Object.keys(env.state.svcViews).length, 4, 'residency unchanged by healing')
    assert.equal(env.state.svcViews.mm, viewsBefore.mm)
    assert.equal(env.state.svcViews.max, viewsBefore.max)
    assert.equal(env.state.svcViews.ydx, viewsBefore.ydx)
    assert.equal(env.doc.querySelectorAll('webview').length, 4)
  }
})

/* ---------- 3. idle unload ---------- */

test('idle unload retires only hidden zero-favourite services after the 15 minute boundary', async () => {
  const env = memoryPolicy({ serviceIdleUnload: true })
  await startAll(env)
  const base = 1000000
  env.state.svcIdleAt = { mm: base, tg: base, max: base, ydx: base }

  assert.deepEqual(Array.from(env.ctx.serviceIdleTick(base + 899999)), [], 'before the boundary nothing is retired')
  assert.equal(Object.keys(env.state.svcViews).length, 4)

  assert.deepEqual(Array.from(env.ctx.serviceIdleTick(base + 900000)), ['mm', 'tg', 'max', 'ydx'])
  assert.deepEqual(Object.keys(env.state.svcViews), [])
  for (const svc of SERVICES) {
    assert.equal(env.doc.querySelector('section[data-tab="svc:' + svc.id + '"]'), null, 'section removed: ' + svc.id)
  }
  assert.equal(env.doc.querySelectorAll('webview').length, 0)
})

test('idle unload is inert when the runtime policy is off, even with an expired clock', async () => {
  const env = memoryPolicy({ serviceIdleUnload: false })
  await startAll(env)
  env.state.svcIdleAt = { mm: 0, tg: 0, max: 0, ydx: 0 }
  assert.deepEqual(Array.from(env.ctx.serviceIdleTick(Date.now())), [])
  assert.equal(Object.keys(env.state.svcViews).length, 4)
})

test('a visible service is never idle-retired and an explicit tab click refreshes only its own clock', async () => {
  const env = memoryPolicy({ serviceIdleUnload: true })
  await startAll(env)
  const base = 2000000
  env.state.svcIdleAt = { mm: base, tg: base, max: base, ydx: base }

  env.doc.querySelector('section[data-tab="svc:max"]').classList.add('visible')
  env.ctx.markServiceTabOpened('mm')
  const clickAt = env.state.svcIdleAt.mm
  assert.equal(clickAt >= base, true, 'explicit click sets the service clock')
  assert.equal(env.state.svcIdleAt.max, base, 'other services keep their clock')

  env.ctx.serviceIdleTick(clickAt + 899999)
  const alive = Object.keys(env.state.svcViews).sort()
  assert.deepEqual(alive, ['max', 'mm'], 'visible max and freshly clicked mm survive')
  assert.equal(env.state.svcIdleAt.max, base, 'retirement check never refreshes the clock')
})

test('idle teardown removes queued work, settles the loader and keeps stale callbacks inert', async () => {
  const env = memoryPolicy({ serviceIdleUnload: true })
  await env.ctx.init() // mm is loading; tg/max/ydx wait in the serial queue
  assert.equal(vm.runInContext('preloadBusy', env.ctx), true)
  assert.equal(vm.runInContext('preloadQueue.length', env.ctx), 3)

  const mm = env.state.svcViews.mm
  const queued = vm.runInContext('preloadQueue.map(job => job.wv)', env.ctx)
  const base = 3000000
  env.state.svcIdleAt = { mm: base, tg: base, max: base, ydx: base }

  env.ctx.serviceIdleTick(base + 900000)

  assert.deepEqual(Object.keys(env.state.svcViews), [])
  assert.equal(mm.isConnected, false)
  assert.equal(vm.runInContext('preloadQueue.length', env.ctx), 0, 'queued work removed')
  assert.equal(vm.runInContext('preloadBusy', env.ctx), false, 'active loader settled')
  for (const wv of queued) assert.equal(wv.isConnected, false)
  assert.equal(mm.__hubPreloadDone, undefined, 'loader handle cleared')

  // Late callbacks cannot resurrect or navigate a retired view.
  mm.emit('dom-ready')
  for (const wv of queued) wv.emit('dom-ready')
  await flush()
  assert.deepEqual(Object.keys(env.state.svcViews), [])
  assert.equal(env.srcCalls.length, 1, 'retired queued views never navigated')
})

test('explicit re-open after idle unload creates one replacement with the same partition and the Telegram root URL', async () => {
  const env = memoryPolicy({ serviceIdleUnload: true })
  await startAll(env)
  const base = 4000000
  env.state.svcIdleAt = { mm: base, tg: base, max: base, ydx: base }
  env.ctx.serviceIdleTick(base + 900000)
  const tgBefore = env.doc.querySelectorAll('webview').length

  env.ctx.activateTab('svc:tg')
  await flush()
  const tg = env.state.svcViews.tg
  assert.ok(tg && tg.isConnected)
  assert.equal(tg.getAttribute('partition'), 'persist:tg')
  assert.equal(tg.getAttribute('src'), 'https://web.telegram.org/k/')
  assert.equal(String(tg.getAttribute('src')).includes('#'), false, 'no chat deep link')
  assert.equal(env.doc.querySelectorAll('webview').length, tgBefore + 1, 'exactly one replacement webview')
  assert.equal(env.srcCalls[env.srcCalls.length - 1], 'https://web.telegram.org/k/')
})

/* ---------- 4. favourites protect a service ---------- */

test('a current favourite blocks idle unload and losing the last favourite does not unload synchronously', async () => {
  const env = memoryPolicy({ serviceIdleUnload: true }, {
    pinned: [{ id: 'p1', serviceId: 'mm', url: 'https://mm.fixture.invalid/team/channels/town-square', title: 'Fixture' }]
  })
  await startAll(env)
  const base = 5000000
  env.state.svcIdleAt = { mm: base, tg: base, max: base, ydx: base }

  env.ctx.serviceIdleTick(base + 30 * 900000) // very long idle
  assert.ok(env.state.svcViews.mm, 'service with a favourite survives any idle time')
  assert.deepEqual(Object.keys(env.state.svcViews).sort(), ['mm'])

  const mm = env.state.svcViews.mm
  env.state.cfg.pinned = [] // last favourite removed
  await flush()
  assert.equal(env.state.svcViews.mm, mm, 'removal alone unloads nothing')
  assert.equal(mm.isConnected, true)

  env.ctx.serviceIdleTick(base + 899999)
  assert.equal(env.state.svcViews.mm, mm, 'unexpired clock keeps it open')

  env.ctx.serviceIdleTick(base + 900000)
  assert.equal(env.state.svcViews.mm, undefined, 'a later eligible timer can retire it')
  assert.equal(mm.isConnected, false)
})

/* ---------- 5. memory guard ---------- */

function guardEnv(options = {}) {
  return memoryPolicy({ serviceMemoryGuard: true }, options)
}

test('a disabled guard makes no metrics request and registers no guard timer', async () => {
  const env = memoryPolicy({ serviceMemoryGuard: false })
  await startAll(env)
  assert.equal(env.metricsCalls.length, 0)
  assert.deepEqual(intervalHandlers(env, 30000).map(fn => fn.name), [])
  assert.equal(await env.ctx.serviceMemoryGuardTick(), null)
  assert.equal(env.metricsCalls.length, 0, 'direct tick call still performs no request while disabled')
})

test('an enabled guard registers one 30 s timer and skips a visible service even above the threshold', async () => {
  const env = guardEnv({ metrics: () => ({ services: [{ id: 'mm', memoryMiB: 2000 }], totalMiB: 2100 }) })
  await startAll(env)
  assert.deepEqual(intervalHandlers(env, 30000).map(fn => fn.name), ['serviceMemoryGuardWatch'])

  env.doc.querySelector('section[data-tab="svc:mm"]').classList.add('visible')
  const mm = env.state.svcViews.mm
  assert.equal(await env.ctx.serviceMemoryGuardTick(), null)
  assert.equal(env.state.svcViews.mm, mm, 'visible service never restarted')
  assert.equal(env.metricsCalls.length, 1)
})

test('the individual threshold restarts the largest eligible hidden service and recreates it immediately', async () => {
  const env = guardEnv({ metrics: () => ({ services: [{ id: 'tg', memoryMiB: 1536 }, { id: 'mm', memoryMiB: 900 }], totalMiB: 2500 }) })
  await startAll(env)
  const tgBefore = env.state.svcViews.tg
  const srcBefore = env.srcCalls.length

  assert.equal(await env.ctx.serviceMemoryGuardTick(), 'tg')
  const tgAfter = env.state.svcViews.tg
  assert.notEqual(tgAfter, tgBefore, 'restarted, not left absent')
  assert.ok(tgAfter && tgAfter.isConnected, 'replacement is attached')
  assert.equal(tgAfter.getAttribute('partition'), 'persist:tg')
  assert.equal(env.doc.querySelectorAll('section[data-tab="svc:tg"]').length, 1, 'exactly one tg section')
  assert.equal(env.doc.querySelectorAll('webview').length, 4)
  assert.equal(env.srcCalls[env.srcCalls.length - 1], 'https://web.telegram.org/k/', 'recreated with the Telegram root URL')
  assert.equal(env.srcCalls.length, srcBefore + 1)
  assert.equal(env.state.svcViews.mm.getAttribute('partition'), 'persist:mm', 'other services untouched')
})

test('the whole-app threshold selects at most one largest hidden victim; sub-threshold metrics do nothing', async () => {
  const env = guardEnv({
    metrics: () => ({
      services: [{ id: 'mm', memoryMiB: 700 }, { id: 'max', memoryMiB: 400 }, { id: 'tg', memoryMiB: 950 }],
      totalMiB: 3072
    })
  })
  await startAll(env)
  const mm = env.state.svcViews.mm
  const max = env.state.svcViews.max

  assert.equal(await env.ctx.serviceMemoryGuardTick(), 'tg', 'largest eligible hidden service chosen under the total threshold')
  assert.equal(env.state.svcViews.mm, mm, 'only one victim')
  assert.equal(env.state.svcViews.max, max)

  const calm = guardEnv({ metrics: () => ({ services: [{ id: 'mm', memoryMiB: 1535 }], totalMiB: 3071 }) })
  await startAll(calm)
  const calmMm = calm.state.svcViews.mm
  assert.equal(await calm.ctx.serviceMemoryGuardTick(), null)
  assert.equal(calm.state.svcViews.mm, calmMm, 'below both thresholds nothing restarts')
})

test('a stale metrics response is ignored when view identity or visibility changed meanwhile', async () => {
  const deferred = {}
  deferred.promise = new Promise(resolve => { deferred.resolve = resolve })
  const env = guardEnv({ metrics: () => deferred.promise })
  await startAll(env)

  const pending = env.ctx.serviceMemoryGuardTick()
  env.ctx.retireServiceView('mm') // identity changed while the request was in flight
  deferred.resolve({ services: [{ id: 'mm', memoryMiB: 3000 }], totalMiB: 4000 })
  assert.equal(await pending, null, 'stale victim ignored')
  assert.equal(env.state.svcViews.mm, undefined, 'no recreation for an absent view')

  const deferred2 = {}
  deferred2.promise = new Promise(resolve => { deferred2.resolve = resolve })
  const env2 = guardEnv({ metrics: () => deferred2.promise })
  await startAll(env2)
  const tg = env2.state.svcViews.tg
  const pending2 = env2.ctx.serviceMemoryGuardTick()
  env2.doc.querySelector('section[data-tab="svc:tg"]').classList.add('visible') // became visible
  deferred2.resolve({ services: [{ id: 'tg', memoryMiB: 3000 }], totalMiB: 3200 })
  assert.equal(await pending2, null, 'stale visibility ignored')
  assert.equal(env2.state.svcViews.tg, tg)
})

test('the guard is single-flight and honours a 15 minute per-service cooldown', async () => {
  let release
  const deferred = new Promise(resolve => { release = resolve })
  const env = guardEnv({ metrics: () => deferred })
  await startAll(env)
  const first = env.ctx.serviceMemoryGuardTick()
  const second = await env.ctx.serviceMemoryGuardTick()
  assert.equal(second, null, 'no second concurrent request')
  assert.equal(env.metricsCalls.length, 1, 'single-flight')
  release({ services: [{ id: 'mm', memoryMiB: 2000 }], totalMiB: 2100 })
  assert.equal(await first, 'mm')

  const restarted = env.state.svcViews.mm
  assert.equal(await env.ctx.serviceMemoryGuardTick(), null, 'cooldown blocks an immediate restart')
  assert.equal(env.state.svcViews.mm, restarted)
  assert.equal(env.metricsCalls.length, 2)
  assert.equal(env.state.svcGuardCooldown.mm > 0, true)
})

test('the guard keeps cached unread values byte-for-value across a restart', async () => {
  const env = guardEnv({
    metrics: () => ({ services: [{ id: 'mm', memoryMiB: 1600 }], totalMiB: 1700 }),
    unreadTotals: { p1: { c: 5, m: 2 } },
    unreadTotalsAt: { p1: 111222 }
  })
  await startAll(env)
  env.state.unreadDots = { p1: true }
  env.state.svcTabTotals = { mm: { t: 9, m: 1, partial: false } }
  const totals = JSON.stringify(env.state.unreadTotals)
  const at = JSON.stringify(env.state.unreadTotalsAt)
  const dots = JSON.stringify(env.state.unreadDots)
  const tabs = JSON.stringify(env.state.svcTabTotals)

  assert.equal(await env.ctx.serviceMemoryGuardTick(), 'mm')
  assert.equal(JSON.stringify(env.state.unreadTotals), totals)
  assert.equal(JSON.stringify(env.state.unreadTotalsAt), at)
  assert.equal(JSON.stringify(env.state.unreadDots), dots)
  assert.equal(JSON.stringify(env.state.svcTabTotals), tabs)
})

test('a hidden service with favourites may be restarted by the guard, and it comes back immediately', async () => {
  const env = guardEnv({
    metrics: () => ({ services: [{ id: 'mm', memoryMiB: 1800 }], totalMiB: 1900 }),
    pinned: [{ id: 'p1', serviceId: 'mm', url: 'https://mm.fixture.invalid/team/channels/town-square', title: 'Fixture' }]
  })
  await startAll(env)
  const before = env.state.svcViews.mm
  assert.equal(await env.ctx.serviceMemoryGuardTick(), 'mm')
  assert.notEqual(env.state.svcViews.mm, before)
  assert.ok(env.state.svcViews.mm.isConnected)
})

test('no forceful renderer crash or invented metrics fallback is used', () => {
  assert.equal(SOURCE.includes('forcefullyCrashRenderer'), false)
  const calls = SOURCE.match(/window\.hub\.[A-Za-z0-9_]+/g) || []
  const metricCalls = calls.filter(name => /memory|metric/i.test(name))
  assert.deepEqual([...new Set(metricCalls)], ['window.hub.getServiceMemoryMetrics'])
  assert.match(SOURCE, /window\.hub\.getServiceMemoryMetrics\(\)/)
})

/* ---------- 6. UI controls ---------- */

function settingsEnv(flags = {}) {
  const env = memoryPolicy(flags)
  loadExtra(env.ctx, ['buildSettings', 'initSettingsTabs'])
  const sec = env.doc.createElement('section')
  sec.dataset.tab = 'settings'
  env.content.appendChild(sec)
  env.ctx.buildSettings(sec)
  return { env, sec }
}

// Утверждённые формулировки панели «Память»: тест требует их дословно.
const MEMORY_PANE_COPY = {
  intro: 'Быстрый возврат к чатам расходует больше памяти. Если экономить память, возврат к чату может занять несколько секунд.',
  sliderLabel: 'Держать открытыми чатов:',
  pinBgLabel: 'Держать недавно открытые чаты готовыми к быстрому возврату',
  pinBgHelp: 'Если включить эту настройку, возврат к недавно открытым чатам будет быстрее, но памяти потребуется больше. Изменение вступит в силу после перезапуска.',
  bgLabel: 'Уменьшать нагрузку от мессенджеров в фоне',
  bgHelp: 'Мессенджеры остаются открытыми, но некоторые фоновые обновления могут приходить с задержкой. Изменение вступит в силу после «Сохранить и перезапустить».',
  idleLabel: 'Закрывать мессенджеры без избранных чатов через 15 минут',
  idleHelp: 'Если у мессенджера есть хотя бы один избранный чат, он остаётся открытым, поэтому «Сборная» продолжает получать свежие обновления. Мессенджер без избранных чатов откроется снова при выборе его вкладки. Изменение вступит в силу после «Сохранить и перезапустить».',
  guardLabel: 'Перезапускать вкладку мессенджера, если она заняла слишком много памяти',
  guardHelp: 'Пороги: 1,5 ГиБ для одной вкладки мессенджера или 3 ГиБ для всего ChatHub. Видимый мессенджер не перезапускается. Фоновый может перезагружаться несколько секунд, а неотправленный черновик может быть потерян. Сборщик автоматически переподключится, и обновление избранного продолжится. Изменение вступит в силу после «Сохранить и перезапустить».'
}

const CONTROLS = [
  ['service-background-throttling', 'serviceBackgroundThrottling', 'bgLabel', 'bgHelp'],
  ['service-idle-unload', 'serviceIdleUnload', 'idleLabel', 'idleHelp'],
  ['service-memory-guard', 'serviceMemoryGuard', 'guardLabel', 'guardHelp']
]

// Срез HTML только панели «Память»: от её заголовка до заголовка следующей панели.
function memoryPane(html) {
  const start = html.indexOf('<h3>Память</h3>')
  const end = html.indexOf('<h3>Избранное</h3>')
  assert.ok(start >= 0, 'заголовок «Память» присутствует')
  assert.ok(end > start, 'заголовок следующей панели присутствует')
  return html.slice(start, end)
}

test('Settings puts Favourites immediately after Memory with no Telegram date tab or controls', () => {
  const { sec } = settingsEnv({ tgBackgroundIndex: true })
  const tabs = sec.querySelectorAll('.settings-tab').map(tab => tab.dataset.settingsTab)
  assert.deepEqual(tabs, ['view', 'theme', 'services', 'chat-style', 'zoom', 'memory', 'favorites', 'diagnostics'])
  assert.equal(sec.querySelector('#tg-bg-index'), null)
  assert.equal(sec.textContent.includes('Даты сообщений Telegram'), false)
})

test('Memory pane has exactly the three new controls with the approved copy and no legacy saver control', () => {
  const { sec } = settingsEnv()
  const pane = memoryPane(sec.innerHTML)

  assert.equal(sec.querySelector('#service-memory-saver'), null, 'legacy control is gone')
  assert.equal(pane.indexOf('service-memory-saver'), -1, 'legacy control absent from markup')
  assert.equal(pane.indexOf('Закрывать мессенджеры, которыми я сейчас не пользуюсь'), -1)

  // Прежние ID панели остаются.
  for (const id of ['live-views', 'live-views-label', 'pin-bg-active']) {
    assert.ok(sec.querySelector('#' + id), 'контрол существует: #' + id)
  }

  assert.ok(pane.includes('<p class="hint">' + MEMORY_PANE_COPY.intro + '</p>'))
  assert.ok(pane.includes(MEMORY_PANE_COPY.sliderLabel + ' <b id="live-views-label">'))
  assert.equal(sec.querySelector('#pin-bg-active').parentElement.textContent.trim(), MEMORY_PANE_COPY.pinBgLabel)
  assert.ok(pane.includes('<p class="hint">' + MEMORY_PANE_COPY.pinBgHelp + '</p>'))

  let previous = pane.indexOf(MEMORY_PANE_COPY.pinBgHelp)
  for (const [id, , labelKey, helpKey] of CONTROLS) {
    const cb = sec.querySelector('#' + id)
    assert.ok(cb, 'контрол существует: #' + id)
    assert.equal(cb.parentElement.textContent.trim(), MEMORY_PANE_COPY[labelKey], 'точная подпись: ' + id)
    assert.equal(cb.checked, false, 'absent config means unchecked: ' + id)

    const helpAt = pane.indexOf('<p class="hint">' + MEMORY_PANE_COPY[helpKey] + '</p>')
    const cbAt = pane.indexOf('id="' + id + '"')
    assert.ok(helpAt > 0 && cbAt > 0, 'контрол и подсказка присутствуют: ' + id)
    assert.ok(cbAt > previous, 'порядок контролов: ' + id)
    assert.ok(helpAt > cbAt, 'подсказка идёт после своего контрола: ' + id)
    previous = helpAt
  }

  const paneLower = pane.toLowerCase()
  for (const banned of ['background throttling', 'webview', 'процесс мессенджера', 'lru', 'видеокарт']) {
    assert.equal(paneLower.indexOf(banned), -1, 'панель «Память» не должна содержать: ' + banned)
  }
})

test('each control persists independently and never changes the current lifecycle runtime', async () => {
  const { env, sec } = settingsEnv()
  env.ctx.activateTab('svc:mm')
  const liveView = env.state.svcViews.mm
  assert.ok(liveView && liveView.isConnected)
  const srcBefore = env.srcCalls.slice()
  const queueBefore = vm.runInContext('preloadQueue.length', env.ctx)
  const timersBefore = env.timers.size
  const intervalsBefore = env.intervals.size
  const policyBefore = JSON.stringify(env.state.serviceMemoryPolicy || null)

  let n = 0
  for (const [id, key] of CONTROLS) {
    const cb = sec.querySelector('#' + id)
    const before = Object.assign({}, env.state.cfg)
    cb.checked = true
    await cb.onchange()
    await flush()
    n++
    assert.equal(env.saves.length, n, 'exactly one save per toggle: ' + id)
    const saved = env.saves[n - 1]
    assert.equal(saved[key], true, 'flag persisted: ' + key)
    for (const [, other] of CONTROLS) {
      if (other === key) continue
      assert.equal(saved[other], before[other] === true, 'other flags untouched: ' + other)
    }
    assert.equal(env.state.cfg[key], true)

    assert.deepEqual(Object.keys(env.state.svcViews), ['mm'], 'no view created or unloaded: ' + id)
    assert.equal(env.state.svcViews.mm, liveView, 'live view untouched: ' + id)
    assert.deepEqual(env.srcCalls.slice(), srcBefore, 'no navigation: ' + id)
    assert.equal(vm.runInContext('preloadQueue.length', env.ctx), queueBefore, 'no queue change: ' + id)
    assert.equal(env.timers.size, timersBefore, 'no timer: ' + id)
    assert.equal(env.intervals.size, intervalsBefore, 'no guard or idle interval before the restart: ' + id)
    assert.equal(env.metricsCalls.length, 0, 'no metrics request before the restart: ' + id)
    assert.equal(JSON.stringify(env.state.serviceMemoryPolicy || null), policyBefore, 'runtime policy is frozen until restart')
  }
})

test('a checkbox reflects an already saved value on the next open', () => {
  const { sec } = settingsEnv({ serviceIdleUnload: true })
  assert.equal(sec.querySelector('#service-idle-unload').checked, true)
  assert.equal(sec.querySelector('#service-background-throttling').checked, false)
  assert.equal(sec.querySelector('#service-memory-guard').checked, false)
})

test('pin-bg-active toggle persists only the flag and starts no save-restart, preload or lifecycle action', async () => {
  const { env, sec } = settingsEnv()
  // Живая незавершённая сервисная вьюха: переключение должно оставить её как есть.
  env.ctx.activateTab('svc:mm')
  const view = env.state.svcViews.mm
  assert.ok(view && view.isConnected, 'precondition: mm view is live')

  vm.runInContext('window.location.reloaded = false; window.location.reload = () => { window.location.reloaded = true }', env.ctx)

  const snap = {
    svcKeys: Object.keys(env.state.svcViews).slice(),
    src: env.srcCalls.slice(),
    webviews: env.doc.querySelectorAll('webview').length,
    queue: vm.runInContext('preloadQueue.length', env.ctx),
    timers: env.timers.size
  }

  const cb = sec.querySelector('#pin-bg-active')
  assert.ok(cb, 'pin-bg-active control exists')
  assert.equal(cb.checked, false, 'absent config means unchecked')

  cb.checked = true
  await cb.onchange()
  await flush()

  assert.equal(env.saves.length, 1, 'exactly one facade save: the flag persistence itself')
  assert.equal(env.saves[0].pinBackgroundActive, true)
  assert.equal(env.state.cfg.pinBackgroundActive, true)

  assert.equal(vm.runInContext('window.location.reloaded', env.ctx), false, 'no restart / reload')
  assert.equal(env.timers.size, snap.timers, 'no new timer (no scheduled reload)')
  assert.equal(vm.runInContext('preloadQueue.length', env.ctx), snap.queue, 'no preload queue operation')
  assert.deepEqual(Object.keys(env.state.svcViews).slice(), snap.svcKeys, 'no view created or unloaded')
  assert.equal(env.state.svcViews.mm, view, 'live view untouched')
  assert.deepEqual(env.srcCalls.slice(), snap.src, 'no service navigation')
  assert.equal(env.doc.querySelectorAll('webview').length, snap.webviews, 'no webview added or removed')

  cb.checked = false
  await cb.onchange()
  await flush()
  assert.equal(env.saves.length, 2, 'second toggle: again exactly one facade save')
  assert.equal(env.saves[1].pinBackgroundActive, false)
})

/* ---------- 7. pin LRU + selfcheck ---------- */

test('pin view LRU still evicts only the least recently used pin, never service views', () => {
  const env = createEnv({ saver: true, maxLiveViews: 2 })
  const makeView = name => ({ name, removed: false, remove() { this.removed = true } })
  env.state.pinViews = { p1: makeView('p1'), p2: makeView('p2'), p3: makeView('p3') }
  env.state.lastUsed = { p1: 1, p2: 2, p3: 3 }
  env.state.activePinId = 'p3'
  env.state.svcViews = { mm: { service: true } }
  env.ctx.trimPinViews('p3')
  assert.deepEqual(Object.keys(env.state.pinViews).sort(), ['p2', 'p3'])
  assert.equal(env.state.pinViews.p1, undefined)
  assert.equal(env.state.svcViews.mm.service, true, 'service views are not LRU eviction candidates')
})

function selfcheckEnv(flags = {}) {
  const env = memoryPolicy(flags)
  loadExtra(env.ctx, ['parseChatTime', 'buildSettings', 'localSelfcheck'])
  return env
}

function serviceLine(env) {
  return env.ctx.localSelfcheck().find(line => String(line).indexOf('сервисы:') >= 0) || ''
}

test('selfcheck requires four live service views in default mode', async () => {
  const env = selfcheckEnv({ serviceIdleUnload: false })
  await env.ctx.init()
  assert.match(serviceLine(env), /^PASS сервисы: 4 вкладки живы/)

  delete env.state.svcViews.max
  assert.match(serviceLine(env), /^FAIL сервисы: 4 вкладки живы/, 'default diagnostic still fails without all four views')
})

test('selfcheck in idle mode accepts closed services but fails on a detached or orphan view, without side effects', async () => {
  const env = selfcheckEnv({ serviceIdleUnload: true })
  await env.ctx.init()
  // Base = mm is loading, tg/max/ydx are queued and attached: all four views are attached.
  const srcBefore = env.srcCalls.slice()
  const webviewsBefore = env.doc.querySelectorAll('webview').length
  const queuedBefore = vm.runInContext('preloadQueue.length', env.ctx)

  const line = serviceLine(env)
  assert.match(line, /^PASS сервисы: /, 'idle mode must not report a false failure: ' + line)
  assert.equal(line.indexOf('4 вкладки живы'), -1, 'idle mode uses its own truthful diagnostic')
  assert.deepEqual(env.srcCalls.slice(), srcBefore, 'selfcheck navigated nothing')
  assert.equal(env.doc.querySelectorAll('webview').length, webviewsBefore, 'selfcheck added no webview')
  assert.equal(vm.runInContext('preloadQueue.length', env.ctx), queuedBefore, 'selfcheck queued no preload')

  vm.runInContext('activateTab = function () {}', env.ctx)

  const base = 6000000
  env.state.svcIdleAt = { mm: base, tg: base, max: base, ydx: base }
  env.ctx.serviceIdleTick(base + 900000)
  assert.deepEqual(Object.keys(env.state.svcViews), [])
  assert.match(serviceLine(env), /^PASS сервисы: /, 'closed services are expected in idle mode')

  env.state.svcViews.tg = env.doc.createElement('webview') // detached, never attached
  assert.match(serviceLine(env), /^FAIL сервисы: /, 'detached view must not be reported as PASS')

  delete env.state.svcViews.tg
  const orphan = env.doc.createElement('section')
  orphan.dataset.tab = 'svc:max'
  env.content.appendChild(orphan)
  assert.match(serviceLine(env), /^FAIL сервисы: /, 'orphan service tab must not be reported as PASS')
})

/* ---------- pinned title/comment commits: overlapping saves ---------- */

// Один пин избранного: правка названия и комментария — две независимые записи
// в config.json. Стенд отдаёт сохранение только по явному resolve/reject,
// чтобы второй blur происходил строго во время полёта первого.
function pinEditEnv() {
  const env = createEnv({
    pinned: [{
      id: 'pin-1',
      key: 'k1',
      priority: 1,
      serviceId: 'mm',
      title: 'A',
      annotation: '',
      url: 'https://mm.fixture.invalid/team/channels/a'
    }],
    deferSaves: true
  })
  loadExtra(env.ctx, ['renderPinRows'])
  const host = env.doc.createElement('div')
  host.id = 'pin-rows'
  env.doc.body.appendChild(host)
  env.ctx.renderPinRows(host)
  return { env, host }
}

function rowNow(host) {
  const rows = host.querySelectorAll('.pin-row').filter(row => row.querySelector('.f-title'))
  assert.equal(rows.length, 1, 'exactly one pinned row is rendered')
  return rows[0]
}

function fieldInput(host, field) {
  return rowNow(host).querySelector(field === 'title' ? '.f-title' : '.f-comment')
}

// Пользователь печатает (oninput) и уводит фокус (onblur -> коммит).
function editAndBlur(host, field, value) {
  const input = fieldInput(host, field)
  input.value = value
  input.oninput({ target: input })
  return input.onblur()
}

function typeOnly(host, field, value) {
  const input = fieldInput(host, field)
  input.value = value
  input.oninput({ target: input })
  return input
}

function pinOf(env) { return env.state.cfg.pinned[0] }

function baselineOf(env) {
  const baseline = env.state.pinEditBaseline && env.state.pinEditBaseline['pin-1']
  assert.ok(baseline, 'a rollback baseline is recorded for the pin')
  return baseline
}

test('a rejected comment never rolls back a title that was already saved (overlapping commits)', async () => {
  const { env, host } = pinEditEnv()

  const titleCommit = editAndBlur(host, 'title', 'B')
  await flush()
  assert.equal(env.pendingSaves.length, 1, 'the title save is in flight')

  const commentCommit = editAndBlur(host, 'annotation', 'C')
  await flush()
  assert.equal(env.pendingSaves.length, 1, 'the comment commit waits for the title commit to finish')

  env.pendingSaves[0].resolve()
  await flush()
  assert.equal(env.pendingSaves.length, 2, 'the comment save runs only after the title save settled')
  assert.equal(env.saves[0].pinned[0].title, 'B', 'first write persisted title B')
  assert.equal(env.pendingSaves[1].cfg.pinned[0].title, 'B', 'the second write still carries the saved title B')
  assert.equal(env.pendingSaves[1].cfg.pinned[0].annotation, 'C')

  env.pendingSaves[1].reject(new Error('config write refused'))
  await Promise.all([titleCommit, commentCommit])
  await flush()

  assert.equal(pinOf(env).title, 'B', 'the saved title survives a failed comment: memory')
  assert.equal(pinOf(env).annotation, '', 'the rejected comment returns to its prior value')
  const baseline = baselineOf(env)
  assert.equal(baseline.title, 'B', 'baseline keeps the saved title')
  assert.equal(baseline.hasTitle, true)
  assert.equal(baseline.annotation, '', 'baseline keeps the prior comment')
  assert.equal(fieldInput(host, 'title').value, 'B', 'the rendered title shows the saved value')
  assert.equal(fieldInput(host, 'annotation').value, '', 'the rejected comment is reverted in the UI')

  // Последующее сохранение не должно воскресить исходное название A.
  const nextCommit = editAndBlur(host, 'annotation', 'E')
  await flush()
  assert.equal(env.pendingSaves.length, 3, 'the next blur still saves through the queue')
  env.pendingSaves[2].resolve()
  await nextCommit
  await flush()
  assert.equal(env.saves[2].pinned[0].title, 'B', 'later writes never resurrect the old title A')
  assert.equal(env.saves[2].pinned[0].annotation, 'E')
  assert.equal(baselineOf(env).title, 'B')
  assert.equal(baselineOf(env).annotation, 'E')
})

test('a rejected title never wipes a comment that was already saved (overlapping commits)', async () => {
  const { env, host } = pinEditEnv()

  const titleCommit = editAndBlur(host, 'title', 'B')
  await flush()
  const commentCommit = editAndBlur(host, 'annotation', 'C')
  await flush()
  assert.equal(env.pendingSaves.length, 1)

  env.pendingSaves[0].reject(new Error('config write refused'))
  await flush()
  assert.equal(env.pendingSaves.length, 2, 'the comment save proceeds after the title failure')
  assert.equal(env.pendingSaves[1].cfg.pinned[0].title, 'A', 'the failed title is rolled back before the next write')
  assert.equal(env.pendingSaves[1].cfg.pinned[0].annotation, 'C')

  env.pendingSaves[1].resolve()
  await Promise.all([titleCommit, commentCommit])
  await flush()

  assert.equal(pinOf(env).title, 'A', 'the rejected title returns to its prior value')
  assert.equal(pinOf(env).annotation, 'C', 'the saved comment survives')
  const baseline = baselineOf(env)
  assert.equal(baseline.title, 'A')
  assert.equal(baseline.annotation, 'C')
  assert.equal(fieldInput(host, 'title').value, 'A', 'the rendered title is reverted')
  assert.equal(fieldInput(host, 'annotation').value, 'C', 'the rendered comment keeps the saved value')
})

test('two overlapping edits of one field keep exactly the value that reached config.json', async () => {
  // B succeeded, C rejected -> B stays.
  {
    const { env, host } = pinEditEnv()
    const first = editAndBlur(host, 'title', 'B')
    await flush()
    const second = editAndBlur(host, 'title', 'C')
    await flush()
    assert.equal(env.pendingSaves.length, 1, 'C waits while B is in flight')

    env.pendingSaves[0].resolve()
    await flush()
    assert.equal(env.pendingSaves.length, 2)
    env.pendingSaves[1].reject(new Error('config write refused'))
    await Promise.all([first, second])
    await flush()

    assert.equal(pinOf(env).title, 'B', 'the last successful value stays')
    assert.equal(baselineOf(env).title, 'B')
    assert.equal(fieldInput(host, 'title').value, 'B')
  }
  // B rejected, C succeeded -> C stays.
  {
    const { env, host } = pinEditEnv()
    const first = editAndBlur(host, 'title', 'B')
    await flush()
    const second = editAndBlur(host, 'title', 'C')
    await flush()

    env.pendingSaves[0].reject(new Error('config write refused'))
    await flush()
    assert.equal(env.pendingSaves.length, 2, 'C is still saved after the failed B')
    assert.equal(env.pendingSaves[1].cfg.pinned[0].title, 'C')
    env.pendingSaves[1].resolve()
    await Promise.all([first, second])
    await flush()

    assert.equal(pinOf(env).title, 'C', 'the newer successful value wins')
    assert.equal(baselineOf(env).title, 'C')
    assert.equal(fieldInput(host, 'title').value, 'C')
  }
})

test('a later unsaved keystroke is never marked as saved by an earlier success', async () => {
  const { env, host } = pinEditEnv()

  const titleCommit = editAndBlur(host, 'title', 'B')
  await flush()
  assert.equal(env.pendingSaves.length, 1)

  typeOnly(host, 'title', 'D') // пользователь продолжает печатать, blur ещё не было
  await flush()

  env.pendingSaves[0].resolve()
  await titleCommit
  await flush()

  assert.equal(pinOf(env).title, 'D', 'unsaved typing survives the earlier success')
  assert.equal(baselineOf(env).title, 'B', 'baseline records what actually reached config.json')
  assert.equal(fieldInput(host, 'title').value, 'D', 'the UI keeps the newer input')

  const nextCommit = editAndBlur(host, 'title', 'D')
  await flush()
  assert.equal(env.pendingSaves.length, 2, 'the next blur saves the pending value')
  env.pendingSaves[1].resolve()
  await nextCommit
  await flush()

  assert.equal(env.saves[1].pinned[0].title, 'D')
  assert.equal(baselineOf(env).title, 'D', 'only now is D recorded as saved')
})

test('when both overlapping writes fail each field rolls back to its own prior and the queue keeps working', async () => {
  const { env, host } = pinEditEnv()

  const titleCommit = editAndBlur(host, 'title', 'B')
  await flush()
  const commentCommit = editAndBlur(host, 'annotation', 'C')
  await flush()

  env.pendingSaves[0].reject(new Error('config write refused'))
  await flush()
  assert.equal(env.pendingSaves.length, 2, 'the comment commit still runs after the title failure')
  env.pendingSaves[1].reject(new Error('config write refused'))
  await Promise.all([titleCommit, commentCommit])
  await flush()

  assert.equal(pinOf(env).title, 'A', 'the title rolls back to A')
  assert.equal(pinOf(env).annotation, '', 'the comment rolls back to empty')
  const baseline = baselineOf(env)
  assert.equal(baseline.title, 'A')
  assert.equal(baseline.hasTitle, true)
  assert.equal(baseline.annotation, '')
  assert.equal(fieldInput(host, 'title').value, 'A')
  assert.equal(fieldInput(host, 'annotation').value, '')

  const recovery = editAndBlur(host, 'annotation', 'E')
  await flush()
  assert.equal(env.pendingSaves.length, 3, 'the queue is not wedged after two failures')
  env.pendingSaves[2].resolve()
  await recovery
  await flush()

  assert.equal(env.saves[2].pinned[0].annotation, 'E')
  assert.equal(env.saves[2].pinned[0].title, 'A')
  assert.equal(pinOf(env).annotation, 'E')
  assert.equal(baselineOf(env).annotation, 'E')
})
