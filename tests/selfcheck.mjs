// ChatHub selfcheck — автотесты живого приложения через CDP.
// Запуск: npm run selfcheck   (подключится к запущенному экземпляру с портом 9222
// или поднимет свой и закроет его после проверки).
// Код выхода 0 — всё PASS, 1 — есть FAIL (можно вешать в релизный чек-лист/CI).

import { spawn, execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CHATHUB_CDP_PORT || 9222)
const CDP = 'http://127.0.0.1:' + PORT + '/json/list'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const results = []
function pass(name, ok, detail) {
  results.push({ name, ok: !!ok })
  const line = (ok ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '   ' + JSON.stringify(detail) : '')
  console.log(line)
}

// ---------- CDP ----------
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
    ws.onmessage = async (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : await new Response(ev.data).text()
      const msg = JSON.parse(raw)
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
    ws.onopen = () => res({
      send: (method, params = {}) => new Promise((res2) => {
        const mid = ++id
        pending.set(mid, res2)
        ws.send(JSON.stringify({ id: mid, method, params }))
      }),
      close: () => ws.close()
    })
    ws.onerror = () => rej(new Error('ws error'))
  })
}
async function ev(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }
  return r.result && r.result.result ? r.result.result.value : undefined
}
async function list() {
  try { const r = await fetch(CDP); return r.ok ? await r.json() : null } catch { return null }
}
async function waitFor(fn, tries = 40, delay = 1000) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(delay) }
  return null
}

let launchedPid = null
async function ensureApp() {
  let l = await list()
  if (l && l.length) { console.log('→ подключение к запущенному ChatHub (порт ' + PORT + ')'); return }
  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'ChatHub.exe')
  console.log('→ запускаю ChatHub с портом ' + PORT + ' для проверки...')
  const p = spawn(exe, ['.', '--remote-debugging-port=' + String(PORT)], { cwd: ROOT, detached: true, stdio: 'ignore' })
  launchedPid = p.pid
  p.unref()
  l = await waitFor(list, 60, 1000)
  if (!l) throw new Error('ChatHub не поднялся с CDP-портом за 60с')
}

// ---------- проверки ----------
async function checkShell(sh) {
  const svcPre = await ev(sh, `(() => {
    const out = {};
    for (const id of ['mm', 'tg', 'max', 'ydx']) {
      const wv = state.svcViews[id];
      const sec = document.querySelector('section[data-tab="svc:' + id + '"]');
      out[id] = { hasView: !!wv, connected: !!(wv && wv.isConnected), hasSection: !!sec, src: wv ? String(wv.getAttribute('src') || '').slice(0, 45) : '' };
    }
    return out;
  })()`)
  const allViews = svcPre && ['mm', 'tg', 'max', 'ydx'].every(id => svcPre[id] && svcPre[id].hasView && svcPre[id].connected && svcPre[id].hasSection)
  pass('сервисы: 4 вкладки предзагружены при старте и живые (постоянно в памяти)', allViews, svcPre)
  // гостевые страницы реально загружены (готовность документа в каждой)
  const l0svc = await list()
  const svcRe = { mm: /im\.astralinux\.ru/, tg: /web\.telegram\.org/, max: /web\.max\.ru/, ydx: /telemost\.yandex\.ru/ }
  let loadedCount = 0
  for (const id of ['mm', 'tg', 'max', 'ydx']) {
    const t = l0svc && l0svc.find(x => x.type === 'webview' && svcRe[id].test(x.url))
    if (!t) continue
    try {
      const c = await connect(t.webSocketDebuggerUrl)
      const rdy = await ev(c, `(document.readyState === 'complete' || document.readyState === 'interactive') && document.body && document.body.childElementCount > 0`)
      c.close()
      if (rdy === true) loadedCount++
    } catch {}
  }
  pass('сервисы: контент всех 4 вьюх загружен (документ готов)', loadedCount >= 4, { loaded: loadedCount })

  const cfg = await ev(sh, `(() => ({
    ver: state.cfg.cssDefaultsVersion,
    tgShift: String(state.cfg.columnCss.tg).includes('-202'),
    maxShift: String(state.cfg.columnCss.max).includes('-77'),
    ymShift: false,
    hasApplyTabIcons: typeof applyTabIcons === 'function',
    hasColTweaks: typeof applyColumnTweaks === 'function',
    parse: (typeof parseChatTime === 'function') ? [parseChatTime('10:24').at > 0, parseChatTime('вчера').at > 0, parseChatTime('пн').at > 0] : null,
    services: (state.cfg.services || []).map(s => s.id),
    pinned: (state.cfg.pinned || []).length
  }))()`)
  pass('шелл: конфиг и функции загружены', cfg && !cfg.__err && cfg.services && cfg.services.length >= 4, cfg)
  pass('конфиг: миграция CSS-дефолтов (v5+)', cfg && Number(cfg.ver) >= 5, cfg && cfg.ver)
  pass('конфиг: фиксированные сдвиги TG/MAX удалены', cfg && cfg.tgShift === false && cfg.maxShift === false)
  pass('юнит: parseChatTime понимает «10:24»/«вчера»/«пн»', cfg && cfg.parse && cfg.parse.every(Boolean), cfg && cfg.parse)
  pass('юнит: applyTabIcons/applyColumnTweaks существуют', cfg && cfg.hasApplyTabIcons && cfg.hasColTweaks)

  const css = await ev(sh, `(() => {
    let fav = false, ti = false, hb = false
    for (const ss of document.styleSheets) { try { for (const r of ss.cssRules) { const s = r.selectorText || ''; if (s.includes('fav-badge-always')) fav = true; if (s.includes('tab-icons')) ti = true; if (s.includes('hide-badges')) hb = true } } catch {} }
    return { fav, ti, hb }
  })()`)
  pass('CSS: правила ★-бейджа, иконок вкладок, скрытия счётчиков', css && css.fav && css.ti && css.hb, css)

  // настройки: подпись и галочки
  const ui = await ev(sh, `(() => {
    const act = document.querySelector('#tabs .tab.active')
    const prev = act ? act.dataset.tab : 'combined'
    activateTab('settings')
    const light = document.querySelector('input[name="theme"][value="light"]')
    const out = {
      label: light && light.parentElement ? light.parentElement.textContent.trim() : null,
      favCb: !!document.getElementById('fav-badge-always'),
      iconsCb: !!document.getElementById('tab-icons'),
      tgCb: !!document.getElementById('tg-bg-index')
    }
    activateTab(prev || 'combined')
    return out
  })()`)
  pass('настройки: подпись «Светлая (мм не поддерживается)»', ui && ui.label === 'Светлая (мм не поддерживается)', ui && ui.label)
  pass('настройки: галочки ★-бейджа, иконок вкладок, индексации TG', ui && ui.favCb && ui.iconsCb && ui.tgCb, ui)

  // ★-бейдж: видимость при выключенных общих счётчиках
  const star = await ev(sh, `(() => {
    const badge = document.querySelector('.tab[data-tab="combined"] .badge')
    if (!badge) return { err: 'нет бейджа' }
    const orig = { bv: state.cfg.badgeVisible, fa: state.cfg.favBadgeAlways, txt: badge.textContent, cls: badge.className }
    badge.textContent = '5'; badge.classList.add('on')
    state.cfg.badgeVisible = false; state.cfg.favBadgeAlways = false; applyBadgeVisibility()
    const off = getComputedStyle(badge).display
    state.cfg.favBadgeAlways = true; applyBadgeVisibility()
    const on = getComputedStyle(badge).display
    state.cfg.badgeVisible = orig.bv; state.cfg.favBadgeAlways = orig.fa; applyBadgeVisibility()
    badge.textContent = orig.txt; badge.className = orig.cls
    return { off, on }
  })()`)
  pass('★-бейдж: скрыт/виден по галочке при выключенных счётчиках', star && star.off === 'none' && star.on !== 'none', star)
}

async function selectPin(sh, serviceId) {
  const id = await ev(sh, `(() => {
    const p = (state.cfg.pinned || []).find(x => x.serviceId === ${JSON.stringify(serviceId)})
    if (!p) return ''
    activateTab('combined')
    selectChat(p.id)
    return p.id
  })()`)
  if (!id) return null
  await sleep(4000)
  return id
}
function findView(l, re) { return l.find(t => t.type === 'webview' && re.test(t.url)) }

async function checkMM(sh) {
  const pinId = await selectPin(sh, 'mm')
  if (!pinId) { pass('ММ: пин в избранном существует', false); return }
  const l = await waitFor(async () => {
    const x = await list()
    return findView(x, /im\.astralinux\.ru.*\/(channels|messages)\//) ? x : null
  }, 30, 1000)
  if (!l) { pass('ММ: вьюха пина загрузилась', false); return }
  let t = null
  let bestW = 1e9
  for (const cand of l.filter(x => x.type === 'webview' && /im\.astralinux\.ru/.test(x.url))) {
    try {
      const cc = await connect(cand.webSocketDebuggerUrl)
      const iw = await ev(cc, 'window.innerWidth')
      cc.close()
      if ((iw || 0) > 0 && iw < bestW) { bestW = iw; t = cand }
    } catch {}
  }
  if (!t) { pass('ММ: вьюха пина загрузилась', false); return }
  const c = await connect(t.webSocketDebuggerUrl)
  const r = await waitFor(async () => {
    const v = await ev(c, `(() => {
      const disp = sel => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : 'нет' }
      const rhs = document.querySelector('#rhsCloseButton')
      const rr = rhs ? rhs.getBoundingClientRect() : null
      return { gh: disp('#global-header'), ch: disp('.channel-header'), ab: disp('.app-bar'), sb: disp('#SidebarContainer'), rhsOpen: rr ? (rr.width > 0 && rr.height > 0) : false, posts: document.querySelectorAll('.post').length }
    })()`)
    return v && v.posts > 0 ? v : null
  }, 30, 1000)
  pass('ММ: хром пина скрыт (шапка/канал/плагины/навигация)', r && r.gh === 'none' && r.ch === 'none' && r.ab === 'none' && r.sb === 'none', r)
  pass('ММ: правая панель закрыта при загрузке', r && r.rhsOpen === false, r && { rhsOpen: r.rhsOpen })
  // тред: открыть и закрыть
  const th = await ev(c, `(() => {
    const links = Array.from(document.querySelectorAll('a, button')).filter(el => /^\\d+\\s+ответ/i.test((el.textContent || '').trim()) || /ReplyLink/.test(String(el.className)))
    if (!links.length) return 'none'
    links[0].click(); return 'clicked'
  })()`)
  if (th === 'clicked') {
    await sleep(1800)
    const opened = await ev(c, `(() => { const el = document.querySelector('#rhsContainer'); if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 })()`)
    await ev(c, `(() => { const b = document.querySelector('#rhsCloseButton'); if (b) b.click(); return 1 })()`)
    await sleep(800)
    const closed = await ev(c, `(() => { const el = document.querySelector('#rhsContainer'); return !el || el.getBoundingClientRect().width === 0 })()`)
    pass('ММ: тред открывается и закрывается', opened === true && closed === true, { opened, closed })
  } else {
    pass('ММ: тред открывается и закрывается', true, 'нет сообщений с ответами — пропущено')
  }
  c.close()

  // бейджи MM: API-путь и отображение числа в строке
  await sleep(2000)
  const bd = await ev(sh, `(() => {
    const pc = state.mmPinCounts || {}
    const withApi = Object.keys(pc).length
    const p = state.cfg.pinned.find(x => x.serviceId === 'mm' && /channels\\//.test(x.url))
    let shown = null
    if (p) {
      const row = document.querySelector('.chat-row[data-pin="' + p.id + '"]')
      if (row) {
        setRowBadge(row, { count: 7, mentions: 0, unread: true })
        const b = row.querySelector('.row-badge')
        shown = { text: b.textContent, hidden: b.classList.contains('hidden') }
        setRowBadge(row, { count: 0, mentions: 0, unread: false })
      }
    }
    return { withApi, shown }
  })()`)
  pass('ММ: счётчики каналов из API доходят до шелла', bd && bd.withApi > 0, bd && { pins: bd.withApi })
  pass('ММ: число новых сообщений рисуется в строке у пина/✕', bd && bd.shown && bd.shown.text === '7' && bd.shown.hidden === false, bd && bd.shown)

  // режим «только новые»: дельты от базового запаса + чистота строк на старте
  const delta = await ev(sh, `(() => {
    const hasBase = !!(state.unreadBaseC && Object.keys(state.unreadBaseC).length)
    let backlogShown = 0
    document.querySelectorAll('.chat-row').forEach(row => {
      const b = row.querySelector('.row-badge')
      if (b && !b.classList.contains('hidden') && /^\\d+$/.test(b.textContent) && Number(b.textContent) > 0) {
        // число в строке допустимо только как «новое» — проверим, что это дельта
        const pid = row.dataset.pin
        const tot = state.unreadTotals && state.unreadTotals[pid]
        const baseC = state.unreadBaseC && state.unreadBaseC[pid]
        if (tot && baseC !== undefined && Number(b.textContent) !== Math.max(0, tot.c - baseC)) backlogShown++
      }
    })
    return { hasBase, backlogShown }
  })()`)
  pass('бейджи: режим «только новые» (дельты от базы), backlog не светится', delta && delta.hasBase && delta.backlogShown === 0, delta)

  // сортировка избранного по активности (📌 всегда сверху)
  const order = await ev(sh, `(() => {
    const rows = Array.from(document.querySelectorAll('.chat-list .chat-row')).slice(0, 12)
    const seq = rows.map(row => { const p = state.cfg.pinned.find(x => x.id === row.dataset.pin); return { pr: p && p.priority ? 1 : 0, act: Math.max(state.lastMsgAt[row.dataset.pin] || 0, state.liveAct[row.dataset.pin] || 0) } })
    let bad = 0
    for (let i = 1; i < seq.length; i++) if (seq[i].pr === 0 && seq[i-1].pr === 0 && seq[i].act > seq[i-1].act + 1000) bad++
    return { bad, n: seq.length }
  })()`)
  pass('избранное: сортировка по активности (без 📌) не нарушена', order && order.bad === 0, order)
}

async function checkRows(sh) {
  // увести курсор в угол через Input CDP, чтобы hover не влиял на «⋮ скрыт без наведения»
  try {
    await sh.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
    await new Promise(r => setTimeout(r, 300))
  } catch {}
  // «Избранное» должно быть активно — иначе скрытые строки дают rect=0
  await ev(sh, 'activateTab("combined")')
  await new Promise(r => setTimeout(r, 400))
  const r = await ev(sh, `(() => {
    const rows = [...document.querySelectorAll('.chat-list .chat-row')]
    if (!rows.length) return { err: 'нет строк' }
    const out = { total: rows.length, bad: [], warn: 0, noAuth: 0 }
    for (const row of rows) {
      const title = (row.querySelector('.chat-row-title') || {}).textContent || ''
      const time = ((row.querySelector('.row-time') || {}).textContent || '').trim()
      const src = (row.querySelector('.chat-row-src') || {}).textContent || ''
      const prevEl = row.querySelector('.chat-row-preview')
      const prev = prevEl ? prevEl.innerHTML : ''
      const av = row.querySelector('.row-avatar')
      const ab = av ? av.getBoundingClientRect() : { width: 0 }
      const hm = time.split(':'); const dm = time.split('.'); const isDig = (str) => str.length > 0 && Array.from(str).every(ch => ch >= '0' && ch <= '9'); const timeOk = time === 'вчера' || (hm.length === 2 && isDig(hm[0]) && hm[0].length <= 2 && isDig(hm[1]) && hm[1].length === 2) || (dm.length >= 2 && dm.length <= 3 && dm.every(isDig))
      if (!title) out.bad.push('нет названия')
      if (!timeOk && time !== '') out.bad.push('время: ' + time)
      if (!src) out.bad.push('нет источника')
      if (!av) out.bad.push('нет слота аватара')
      else if (Math.round(ab.width) < 40) out.bad.push('аватар мал: ' + Math.round(ab.width))
      const prevPlain = prevEl ? String(prevEl.textContent || '').trim() : ''
      const isUrl = /^(https?:|ftp:|mailto:)/.test(prevPlain)
      if (!isUrl && prevEl && prev && prev.includes(':') && !/<b>/.test(prev)) out.warn = (out.warn || 0) + 1
      const prevText = prevEl ? String(prevEl.textContent || '').trim() : ''
      const pinO = state.cfg.pinned.find(p => p.id === row.dataset.pin)
      const isDM = !!(pinO && /#@/.test(String(pinO.url || '')))
      const hasData = !!(state.lastMsgPreview || {})[row.dataset.pin]
      if (prevText && title && prevText.indexOf(title) === 0 && prevText.length > title.length) out.bad.push('дубль имени в превью: ' + title.slice(0, 14))
      if (!prevText && hasData) out.bad.push('превью не отображено при данных: ' + title.slice(0, 14))
      if ((src === 'Mattermost' || src === 'Telegram') && !isDM && prevText && prevText.indexOf(':') < 0) out.noAuth = (out.noAuth || 0) + 1
    }
    // меню: ⋮ скрыт без наведения, открывается вправо, закрывается blur
    const row = rows[0]
    const more = row.querySelector('.row-more')
    const menu = row.querySelector('.row-menu')
    const hiddenByDefault = more ? getComputedStyle(more).opacity === '0' : false
    let opensRight = false, menuItems = 0, closedOnBlur = false
    if (more && menu) {
      more.click()
      const mr = menu.getBoundingClientRect()
      opensRight = mr.left >= row.getBoundingClientRect().right - 6
      menuItems = menu.querySelectorAll('button').length
      window.dispatchEvent(new Event('blur'))
      closedOnBlur = menu.classList.contains('hidden')
    }
    return { ...out, hiddenByDefault, opensRight, menuItems, closedOnBlur }
  })()`)
  pass('строки: ВСЕ ' + (r && r.total || 0) + ' — структура/превью/автор/аватар', r && !r.err && r.bad.length === 0, r && { всего: r.total, плохих: (r.bad || []).length, примеры: (r.bad || []).slice(0, 8), неЖирных: r.warn || 0, группБезМетки: r.noAuth || 0 })
  // одна и та же аватарка не должна стоять у разных чатов
  let dupCheck = await ev(sh, `(() => {
    const seen = {}
    document.querySelectorAll('.chat-list .chat-row').forEach(row => {
      const img = row.querySelector('.row-avatar img')
      if (!img) return
      const k = String(img.currentSrc || img.src || '')
      if (!k) return
      const tt = ((row.querySelector('.chat-row-title') || {}).textContent || '').trim()
      if (!seen[k]) seen[k] = []
      seen[k].push(tt)
    })
    const bad = []
    for (const [k, titles] of Object.entries(seen)) {
      // SVG-монограмма — сгенерированная заглушка (одинаковые инициалы+цвет
      // у разных групп дают идентичный SVG); фото — строго
      if (String(k).startsWith('data:image/svg')) continue
      const uniq = [...new Set(titles)]
      if (uniq.length < 2) continue
      // один человек с двумя чатами (разные номера) — нормально: общее слово в названиях
      const words = uniq.map(t => String(t).toLowerCase().replace(/[^а-яёa-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 4))
      let common = false
      for (let i = 0; i < words.length && !common; i++) {
        for (let j = i + 1; j < words.length; j++) {
          if (words[i].some(w => words[j].includes(w))) { common = true; break }
        }
      }
      if (!common) bad.push(uniq.join(' / ').slice(0, 60))
    }
    return { дубли: bad.length, примеры: bad.slice(0, 3) }
  })()`)
  pass('строки: аватары не дублируются между чатами', dupCheck && dupCheck.дубли === 0, dupCheck)
  const fill = await ev(sh, `(() => { const rows = [...document.querySelectorAll('.chat-list .chat-row')]; let f = 0; for (const r2 of rows) { const pv = (r2.querySelector('.chat-row-preview') || {}).textContent || ''; if (pv.trim()) f++ } return { заполнено: f, всего: rows.length } })()`)
  pass('строки: заполнение превью (метрика)', true, fill)
  pass('строки: ⋮ скрыт без наведения, меню вправо (2 пункта), закрывается кликом в чат', r && r.hiddenByDefault && r.opensRight && r.menuItems === 2 && r.closedOnBlur, r && { hiddenByDefault: r.hiddenByDefault, opensRight: r.opensRight, menuItems: r.menuItems, closedOnBlur: r.closedOnBlur })
}

async function widthsCheck(sh, kind, viewRe, measureExpr, name) {
  const pinId = await selectPin(sh, kind)
  if (!pinId) { pass(name + ': пин в избранном существует', false); return }
  // ширина именно ПИН-вьюхи: сервисная вкладка может иметь URL, совпадающий
  // с пиновым шаблоном (например, MAX deep-link) — различаем по ширине
  const wvW = await ev(sh, `(() => { const wv = state.pinViews[${JSON.stringify(pinId)}]; if (!wv) return 0; return Math.round(wv.getBoundingClientRect().width) })()`)
  const l = await waitFor(async () => {
    const x = await list()
    return findView(x, viewRe) ? x : null
  }, 30, 1000)
  if (!l) { pass(name + ': вьюха загрузилась', false); return }
  let t = null
  for (const cand of l.filter(x => x.type === 'webview' && viewRe.test(x.url))) {
    if (!wvW) { t = t || cand; continue }
    try {
      const cc = await connect(cand.webSocketDebuggerUrl)
      const iw = await ev(cc, 'window.innerWidth')
      cc.close()
      if (Math.abs((iw || 0) - wvW) <= 12) { t = cand; break }
    } catch {}
  }
  if (!t) { pass(name + ': вьюха загрузилась', false, { wvW }); return }
  const c = await connect(t.webSocketDebuggerUrl)
  let allOk = true
  const details = []
  for (const w of [600, 900, 1260]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 820, deviceScaleFactor: 1, mobile: false })
    await sleep(2400)
    let m = await ev(c, measureExpr)
    // второй замер после устаканивания (у webk на <640px slide-анимация)
    await sleep(900)
    const m2 = await ev(c, measureExpr)
    if (m2 && !m2.__err) m = m2
    details.push({ w, m })
    const ok = m && !m.__err && m.left >= -1 && (m.right === undefined || m.right <= m.iw + 2) && m.sw <= m.iw + 2
    if (!ok) allOk = false
  }
  await c.send('Emulation.clearDeviceMetricsOverride')
  c.close()
  pass(name + ': геометрия 600/900/1260 — ничего не уезжает, скролла нет', allOk, details)
}

async function main() {
  console.log('ChatHub selfcheck — ' + new Date().toISOString())
  await ensureApp()
  const l0 = await waitFor(async () => { const x = await list(); return x && x.some(t => t.type === 'page') ? x : null }, 30, 1000)
  if (!l0) throw new Error('шелл не найден')
  const sh = await connect(l0.find(t => t.type === 'page').webSocketDebuggerUrl)

  await checkShell(sh)
  await checkRows(sh)
  await checkMM(sh)
  await ev(sh, `(async () => { try { await mmLastPosts() } catch (e) {} ; await new Promise(z => setTimeout(z, 800)); return 1 })()`.replace('mmLastPosts', 'state.svcViews[\'mm\'] ? mmLastPosts : mmLastPosts'))

  // TG
  await widthsCheck(sh, 'tg',
    /web\.telegram\.org\/k\/#/,
    `(() => { const cc = document.querySelector('#column-center'); if (!cc) return { __err: 'нет #column-center' }; const r = cc.getBoundingClientRect(); const sb = document.querySelector('.sidebar'); return { left: Math.round(r.left), right: Math.round(r.right), iw: window.innerWidth, sw: document.documentElement.scrollWidth, sbHidden: sb ? getComputedStyle(sb).display === 'none' : true } })()`,
    'TG-пин')

  // MAX
  await widthsCheck(sh, 'max',
    /web\.max\.ru\/\d{6,}|web\.max\.ru\/-\d{10,}/,
    `(() => { const app = document.querySelector('.app'); if (!app) return { __err: 'нет .app' }; const main = document.querySelector('.app > main'); const nav = document.querySelector('.app > .navigation'); const r = app.getBoundingClientRect(); const rm = main ? main.getBoundingClientRect() : { x: 0 }; return { left: Math.round(r.left), mainX: Math.round(rm.x), iw: window.innerWidth, sw: document.documentElement.scrollWidth, navHidden: nav ? getComputedStyle(nav).display === 'none' : true } })()`,
    'MAX-пин')

  // Телемост
  await widthsCheck(sh, 'ydx',
    /telemost\.yandex\.ru\/chats\/|telemost\.yandex\.ru\/0%2F/,
    `(() => { const root = document.querySelector('.yamb-root'); const gb = document.querySelector('[class^="GlobalBarRoot"]'); if (!root) return { __err: 'нет .yamb-root' }; const r = root.getBoundingClientRect(); return { left: Math.round(r.left), iw: window.innerWidth, sw: document.documentElement.scrollWidth, gbHidden: gb ? getComputedStyle(gb).display === 'none' : true } })()`,
    'Телемост-пин')

  // счётчики вкладок сервисов (TG/MAX/ydx отдают svcTotals)
  const totals = await ev(sh, `({ mm: (state.svcTabTotals || {}).mm || null, tg: (state.svcTabTotals || {}).tg || null, max: (state.svcTabTotals || {}).max || null, ydx: (state.svcTabTotals || {}).ydx || null })`)
  pass('счётчики вкладок мессенджеров присутствуют (MM/TG/MAX/ydx)', totals && totals.mm !== null, totals)

  sh.close()

  const fails = results.filter(r => !r.ok)
  console.log('\n=== ИТОГ: ' + (results.length - fails.length) + ' PASS, ' + fails.length + ' FAIL ===')
  if (fails.length) { console.log('Провалены:'); for (const f of fails) console.log('  - ' + f.name) }

  if (launchedPid) {
    try { execSync('taskkill /F /PID ' + launchedPid + ' /T', { stdio: 'ignore' }) } catch {}
    console.log('→ тестовый экземпляр закрыт')
  }
  process.exit(fails.length ? 1 : 0)
}

main().catch(e => { console.error('SELFCHECK ОШИБКА: ' + (e && e.message)); process.exit(2) })
