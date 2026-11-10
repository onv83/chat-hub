/* ChatHub — renderer
   Вкладки мессенджеров (живые веб-версии) + «сборная вкладка» —
   классический мессенджер: слева список избранного, справа содержание чата.
   Непрочитанные: красный бейдж-счётчик; упоминания (@) — отдельным стилем. */

const state = {
  cfg: null,
  svcViews: {},        // serviceId -> <webview> вкладки мессенджера
  pinViews: {},        // pinId -> <webview> этого чата: гружен заранее, открытие мгновенное
  combinedBuilt: false,
  liveAct: {},         // pinId -> Date.now() всплеска активности (пришли сообщения)
  rankAct: {},         // pinId -> позиция строки в списке мессенджера (меньше = свежее; 9999 = не в списке)
  prevUnread: {},      // pinId -> прошлое число непрочитанных (детект новых сообщений)
  lastUsed: {},        // pinId -> Date.now() последнего открытия (для вытеснения неактивных вьюх)
  svcIcons: {},        // serviceId -> data URL фирменной иконки мессенджера (favicon)
  lastMsgAt: {},       // pinId -> время последнего сообщения в чате (мс) — сортировка «главное — активность»
  lastMsgText: {},     // pinId -> компактный текст времени для строки («17:30», «пн», «12.03»)
  mmUserIds: {},       // username Mattermost -> user id (для мэтчинга DM-каналов по API)
  mmChannelsAt: 0,     // когда последний раз читали last_post_at через API MM
  tgPeerOf: {},        // TG pinId -> числовой peer-id (однозначное сопоставление строк)
  tgSearchedAt: {}     // TG pinId -> когда последний раз искали через поиск webk
}

// сколько чатов избранного держать загруженными одновременно: каждый webview —
// отдельный процесс мессенджера (~150-250 МБ); 68 чатов = ~16 ГБ оперативки.
// Верхние чаты списка (приоритет/свежие) предзагружены, остальные грузятся
// по клику; давно не открывавшиеся — вытесняются (LRU)
function maxLiveViews() { return parseInt(state.cfg.maxLiveViews, 10) > 0 ? parseInt(state.cfg.maxLiveViews, 10) : 8 }

// Селекторы заголовка открытого чата (имя при добавлении в избранное)
const NAME_SELECTORS = {
  mm: ['#channelHeaderTitle', '[data-testid="channelHeaderTitle"]', '.channel-header__title'],
  tg: ['.topbar .peer-title', '.chat-info .peer-title', '.peer-title'],
  max: ['.app main h1', '.app main .title', '.app main h2'],
  ydx: []
}

// Экстракторы непрочитанных и сборщики папок запускаются ВНУТРИ страниц
// мессенджеров — сериализуются в executeJavaScript (как __chatHubApplyCss).
const UNREAD_EXTRACTORS = {
  mm: __chatHubMmUnread,
  tg: __chatHubTgUnread,
  max: __chatHubMaxUnread,
  ydx: __chatHubYdxUnread
}

init()

async function init() {
  state.cfg = await window.hub.getConfig()
  ensureKeys(state.cfg)
  buildTabs()
  activateTab('combined')
  initListSplitter()
  // вкладки мессенджеров грузим сразу при старте (панели скрыты через visibility,
  // но разложены — webview правильного размера): переключение вкладки мгновенное.
  // deferSrc + очередь — чтобы 4 мессенджера не стартовали одновременно
  for (const svc of state.cfg.services) {
    const id = 'svc:' + svc.id
    if (!document.querySelector('section[data-tab="' + id + '"]')) {
      document.getElementById('content').appendChild(buildSection(id, true))
    }
  }
  document.addEventListener('click', (e) => { if (!e.target.closest('.fav-menu-wrap')) closeAllFavMenus() })
  // активность пользователя: поисковые проходы TG (требуют фокуса) — только в простое
  ;['keydown', 'mousedown', 'wheel'].forEach(ev =>
    document.addEventListener(ev, () => { state.lastUserInput = Date.now() }, { passive: true, capture: true }))
  setInterval(() => pollUnread().catch(() => {}), 5000)
  // TG-вкладка после старта иногда остаётся пустым скелетом: webk грузится,
  // но не гидрируется, и reload() это не лечит. Свежесозданный webview с тем
  // же адресом рендерится корректно, поэтому при пустом списке диалогов
  // пересоздаём элемент вкладки целиком. Проверяем раз в 20 с (пока вкладка
  // не ожила — быстрее, чем пользователь успеет на неё нажать); пересозданий
  // не больше трёх за сессию; если пользователь смотрит на вкладку — не
  // дёргаем её первые ~3,5 мин (вдруг это переходное состояние), потом всё же
  // лечим — пустой скелет хуже перезагрузки.
  let tgHealTries = 0
  let tgHealVisibleEmpty = 0
  setInterval(() => {
    // зависший проход (замороженная вьюха раньше резолвила промисы вечно):
    // через 7 минут принудительно сбрасываем флаг — проходы и лечение продолжатся
    if (tgSearchBusy && tgBusyAt && Date.now() - tgBusyAt > 420000) {
      tgSearchBusy = false
      try { (state.tgSearchLog = state.tgSearchLog || []).push(new Date().toLocaleTimeString('ru-RU') + ' проход завис — сброс флага') } catch {}
    }
    if (tgSearchBusy) return // не пересоздаём вьюху посреди поискового прохода
    const wv = state.svcViews.tg
    const firstTg = state.cfg.pinned.find(p => p.serviceId === 'tg')
    if (!wv || !firstTg) return
    try {
      // проба с таймаутом: замороженная вьюха не отвечает никогда — лечим как пустую
      Promise.race([
        wv.executeJavaScript('document.querySelectorAll(".row-clickable").length'),
        new Promise(resolve => setTimeout(() => resolve('FROZEN'), 8000))
      ]).then(n => {
        if (n === 'FROZEN') n = 0
        if (n) { tgHealTries = 0; tgHealVisibleEmpty = 0; return }
        const pane = document.querySelector('section[data-tab="svc:tg"]')
        if (pane && pane.classList.contains('visible')) {
          tgHealVisibleEmpty++
          if (tgHealVisibleEmpty < 10) return
        } else tgHealVisibleEmpty = 0
        if (String(wv.getURL()).indexOf('#') < 0) {
          const pr = wv.loadURL(firstTg.url); if (pr && pr.catch) pr.catch(() => {})
          return
        }
        if (tgHealTries >= 3) return
        tgHealTries++
        const svc = state.cfg.services.find(s => s.id === 'tg')
        const sec = wv.parentElement
        if (!svc || !sec) return
        const nv = document.createElement('webview')
        nv.setAttribute('partition', svc.partition)
        nv.setAttribute('allowpopups', '')
        nv.setAttribute('webpreferences', 'backgroundThrottling=no')
        nv.className = wv.className
        state.svcViews.tg = nv
        wv.remove()
        sec.appendChild(nv)
        nv.setAttribute('src', firstTg.url)
        nv.addEventListener('dom-ready', () => { captureSvcIcon('tg', nv); updateSvcBar('tg') })
        nv.addEventListener('did-navigate-in-page', () => updateSvcBar('tg'))
        nv.addEventListener('page-title-updated', () => setTimeout(() => updateSvcBar('tg'), 400))
        nv.addEventListener('dom-ready', () => {
          nv.executeJavaScript('document.querySelectorAll(".row-clickable").length').then(r => { if (r) tgHealTries = 0 }).catch(() => {})
        })
      }).catch(() => {})
    } catch (e) {}
  }, 20000)
}

// Ширина списка чатов: тянется мышью за разделитель, сохраняется в конфиге.
// По умолчанию 360 px — чтобы длинные названия было видно целиком.
// Pointer Capture + отключение pointer-events у webview на время драга:
// иначе мышь над webview уводит события в гостевую страницу, и «отпустить» драг нельзя.
function initListSplitter() {
  const wrap = document.getElementById('chat-list-wrap')
  const split = document.getElementById('list-split')
  if (!wrap || !split) return
  wrap.style.width = (parseInt(state.cfg.listWidth, 10) || 360) + 'px'
  initFavSearch()
  split.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    try { split.setPointerCapture(e.pointerId) } catch (err) {}
    split.classList.add('dragging')
    document.body.classList.add('split-dragging')
  })
  split.addEventListener('pointermove', (e) => {
    if (!split.classList.contains('dragging')) return
    const max = Math.max(280, Math.floor(window.innerWidth * 0.7))
    const w = Math.min(Math.max(e.clientX, 220), max)
    wrap.style.width = w + 'px'
  })
  const end = (e) => {
    if (!split.classList.contains('dragging')) return
    split.classList.remove('dragging')
    document.body.classList.remove('split-dragging')
    try { split.releasePointerCapture(e.pointerId) } catch (err) {}
    state.cfg.listWidth = Math.round(wrap.getBoundingClientRect().width)
    window.hub.saveConfig(state.cfg)
  }
  split.addEventListener('pointerup', end)
  split.addEventListener('pointercancel', end)
  // двойной клик — вернуть стандартную ширину
  split.addEventListener('dblclick', () => {
    wrap.style.width = '360px'
    state.cfg.listWidth = 360
    window.hub.saveConfig(state.cfg)
  })
}

function ensureKeys(cfg) {
  if (!cfg.services) cfg.services = []
  if (!cfg.columnCss) cfg.columnCss = {}
  if (!cfg.zoom) cfg.zoom = {}
  if (!cfg.pinned) cfg.pinned = []
  // П.13: восстановление накопленной активности прошлой сессии — времена
  // последних сообщений, pid-кэш TG и исчерпанность свипа переживают
  // перезапуск; список сразу отсортирован правильно, без 10 мин проходов
  if (cfg.activity) {
    const A = cfg.activity
    const merge = (dst, src) => { if (src && typeof src === 'object') for (const k of Object.keys(src)) { try { dst[k] = src[k] } catch (e) {} } }
    merge(state.lastMsgAt, A.lastMsgAt)
    merge(state.lastMsgText, A.lastMsgText)
    merge(state.liveAct, A.liveAct)
    merge(state.tgPeerOf, A.tgPeerOf)
    merge(state.prevUnread, A.prevUnread)
    if (A.tgScrollDone) tgScrollDone = true
    console.log('[hub] активность восстановлена из конфига:', Object.keys(A.lastMsgAt || {}).length, 'времён')
  }
}

// П.13: сохранение накопленной активности в config.json — дебаунс 20 с,
// пишем только когда что-то реально накопили (времена/pid/liveAct)
let actSaveTimer = 0
function scheduleActSave() {
  if (actSaveTimer) return
  actSaveTimer = setTimeout(() => {
    actSaveTimer = 0
    try {
      state.cfg.activity = {
        lastMsgAt: { ...state.lastMsgAt },
        lastMsgText: { ...state.lastMsgText },
        liveAct: { ...state.liveAct },
        tgPeerOf: { ...state.tgPeerOf },
        prevUnread: { ...state.prevUnread },
        tgScrollDone: !!tgScrollDone
      }
      window.hub.saveConfig(state.cfg)
    } catch (e) {}
  }, 20000)
}

/* ---------- вкладки ---------- */

function buildTabs() {
  const tabs = document.getElementById('tabs')
  tabs.innerHTML = ''
  const mk = (id, label) => {
    const b = document.createElement('button')
    b.className = 'tab'
    b.dataset.tab = id
    const s = document.createElement('span')
    s.className = 'tab-label'
    s.textContent = label
    b.appendChild(s)
    b.onclick = () => activateTab(id)
    tabs.appendChild(b)
    return b
  }
  const cb = mk('combined', '★ Сборная')
  const cbadge = document.createElement('span')
  cbadge.className = 'badge'
  cb.appendChild(cbadge)
  for (const svc of state.cfg.services) {
    const b = mk('svc:' + svc.id, svc.name)
    const badge = document.createElement('span')
    badge.className = 'badge'
    b.appendChild(badge)
    // второй чип — «@упоминания лично тебя» (пока только MM, из API)
    const mbadge = document.createElement('span')
    mbadge.className = 'badge badge-m'
    b.appendChild(mbadge)
  }
  mk('settings', '⚙ Настройки')
}

function activateTab(id) {
  const content = document.getElementById('content')
  let sec = content.querySelector('section[data-tab="' + id + '"]')
  if (!sec) {
    sec = buildSection(id)
    content.appendChild(sec)
  }
  // пользователь сам открыл вкладку — если её webview ещё ждёт в очереди
  // предзагрузки, грузим сразу, не дожидаясь очереди. ВАЖНО: для TG —
  // начальный адрес (глубокая ссылка на чат), НЕ корень k/: корень уводит
  // webk в пустой скелет, и вкладка перезагружалась прямо при клике
  const svc = state.cfg.services.find(s => 'svc:' + s.id === id)
  const wv = svc && state.svcViews[svc.id]
  if (svc && wv && !wv.dataset.loadedSrc) enqueueLoad(wv, initialSvcUrl(svc), true)
  if (id === 'settings') buildSettings(sec)
  for (const s of content.children) s.classList.toggle('visible', s.dataset.tab === id)
  document.querySelectorAll('#tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id))
  if (id === 'combined' && !state.combinedBuilt) {
    state.combinedBuilt = true
    renderChatList()
  }
}

// начальный адрес вкладки сервиса: Telegram грузим сразу глубокой ссылкой
// на первый TG-чат избранного — корень web.telegram.org/k/ после загрузки
// часто остаётся пустым скелетом (вьюхи пинов с адресом чата грузятся
// корректно всегда; прерывать загрузку корня ссылкой тоже ненадёжно)
function initialSvcUrl(svc) {
  if (svc.id === 'tg') {
    const firstTg = state.cfg.pinned.find(p => p.serviceId === 'tg')
    if (firstTg) return firstTg.url
  }
  return svc.url
}

function buildSection(id, deferSrc) {
  const sec = document.createElement('section')
  sec.dataset.tab = id
  sec.className = 'tabpane'

  if (id === 'combined') {
    sec.innerHTML = `
      <div class="combined hidden" id="combined-layout">
        <aside class="chat-list-wrap" id="chat-list-wrap">
          <div class="chat-list-head">
            <span>Избранное</span>
            <span class="chat-list-count" id="fav-count"></span>
          </div>
          <div class="chat-list-search" id="chat-list-search">
            <span class="search-icon" aria-hidden="true">🔍</span>
            <input id="fav-search" type="text" placeholder="Поиск" autocomplete="off" spellcheck="false" title="Фильтр избранного по названию чата">
            <button class="icon-btn search-clear hidden" id="fav-search-clear" title="Очистить">✕</button>
          </div>
          <div class="chat-list" id="chat-list"></div>
          <div class="chat-list-nores hidden" id="chat-list-nores">Ничего не найдено</div>
        </aside>
        <div class="list-split" id="list-split" title="Потяните, чтобы изменить ширину списка"></div>
        <div class="chat-view">
          <div class="view-head" id="view-head"></div>
          <div class="chat-view-stack" id="chat-view-stack"></div>
        </div>
      </div>
      <div class="empty" id="combined-empty">
        <div class="empty-emoji">⭐</div>
        <h2>Сборная вкладка пока пуста</h2>
        <p>1. Откройте вкладку мессенджера сверху и войдите (один раз — сессия сохранится).<br>
           2. Кликните нужный чат и нажмите «⭐ В избранное».</p>
        <p class="hint">Слева — общий список чатов, справа — содержание. Красный бейдж — новые сообщения, «@N» — тегнули сабакой.</p>
      </div>`
    return sec
  }

  if (id === 'settings') return sec // содержимое строит buildSettings при каждом открытии

  const svc = state.cfg.services.find(s => 'svc:' + s.id === id)
  if (!svc) {
    sec.innerHTML = '<div class="empty">Мессенджер не найден (удалён в настройках)</div>'
    return sec
  }

  const bar = document.createElement('div')
  bar.className = 'svcbar'
  bar.innerHTML = `
    <span class="svc-dot"></span>
    <span class="svc-name"></span>
    <div class="fav-menu-wrap">
      <button class="btn open-fav-menu">★ Избранное <span class="fav-count"></span></button>
      <div class="fav-menu hidden"></div>
    </div>
    <button class="btn pin-current">⭐ В избранное</button>`
  const dot = bar.querySelector('.svc-dot')
  dot.style.background = badgeColor(svc.name)
  bar.querySelector('.svc-name').textContent = svc.name

  sec.appendChild(bar)

  const wv = document.createElement('webview')
  if (!deferSrc) wv.setAttribute('src', initialSvcUrl(svc))
  wv.setAttribute('partition', svc.partition)
  wv.setAttribute('allowpopups', '')
  wv.setAttribute('webpreferences', 'backgroundThrottling=no')
  wv.className = 'svc-webview'
  sec.appendChild(wv)
  state.svcViews[svc.id] = wv
  // при предзагрузке на старте src назначает очередь — грузим вкладки по очереди
  if (deferSrc) enqueueLoad(wv, initialSvcUrl(svc))

  // счётчик непрочитанных в заголовке вкладки — только для сервисов без
  // собственного экстрактора (у остальных считаем сами, по избранному)
  wv.addEventListener('page-title-updated', (e) => {
    if (UNREAD_EXTRACTORS[svc.id]) return
    const t = String(e.title || '')
    const m = t.match(/\((\d+)\)/) || t.match(/(\d+)\s*непрочитан/i)
    updateBadge(svc.id, m ? m[1] : '', false)
  })
  // фирменная иконка мессенджера — из favicon его же страницы
  wv.addEventListener('dom-ready', () => captureSvcIcon(svc.id, wv))

  const menuBtn = bar.querySelector('.open-fav-menu')
  menuBtn.onclick = (e) => {
    e.stopPropagation()
    const m = bar.querySelector('.fav-menu')
    const wasHidden = m.classList.contains('hidden')
    closeAllFavMenus()
    if (wasHidden) { fillFavMenu(svc.id, bar); m.classList.remove('hidden') }
  }

  const pinBtn = bar.querySelector('.pin-current')
  pinBtn.onclick = async () => {
    if (pinBtn.dataset.pin) { await removePin(pinBtn.dataset.pin); return }
    await pinCurrentChat(svc)
  }

  wv.addEventListener('dom-ready', () => updateSvcBar(svc.id))
  wv.addEventListener('did-navigate-in-page', () => updateSvcBar(svc.id))
  wv.addEventListener('page-title-updated', () => setTimeout(() => updateSvcBar(svc.id), 400))
  return sec
}

function updateBadge(svcId, text, mention) {
  const b = document.querySelector('.tab[data-tab="svc:' + svcId + '"] .badge')
  if (!b) return
  b.textContent = text
  b.classList.toggle('on', !!text)
  b.classList.toggle('mention', !!mention)
  // второй чип (@упоминания) — только MM пишет; прочие сервисы чистят
  const m = b.parentElement && b.parentElement.querySelector('.badge.badge-m')
  if (m) { m.textContent = ''; m.classList.remove('on') }
}

// п.20: два счётчика на вкладке MM — всего непрочитанных сообщений (красный)
// и упоминаний пользователя лично (яркий @-чип: личные чаты + @-упоминания).
// Числа канонические, из API MM /users/me/teams/unread — сайдбар каналов
// показывает только упоминания, «всего» из него не получить.
function updateBadgeMM(total, mentions) {
  const b = document.querySelector('.tab[data-tab="svc:mm"] .badge')
  const m = b && b.parentElement && b.parentElement.querySelector('.badge.badge-m')
  if (!b || !m) return
  b.textContent = total > 0 ? String(total) : ''
  b.classList.toggle('on', total > 0)
  b.classList.remove('mention')
  m.textContent = mentions > 0 ? '@' + mentions : ''
  m.classList.toggle('on', mentions > 0)
  m.classList.add('mention')
}

/* ---------- избранное ---------- */

function favoritesOf(svcId) {
  return state.cfg.pinned.filter(p => p.serviceId === svcId)
}

function pinKeyOf(svcId, url, title) {
  const svc = (state.cfg.services || []).find(s => s.id === svcId)
  // MAX/Телемост дают deep-link на чат (web.max.ru/-7672…) — различаем по нему,
  // а на базовом URL (открыт список чатов) — по названию
  if (svcId === 'max' || svcId === 'ydx') {
    if (svc && url && String(url).split('?')[0] !== String(svc.url).split('?')[0]) {
      return svcId + '|' + String(url).split('?')[0]
    }
    return svcId + '|' + String(title).trim()
  }
  return svcId + '|' + url
}

async function pinCurrentChat(svc) {
  const wv = state.svcViews[svc.id]
  if (!wv) return
  let url = wv.getURL()
  if (!url || url === 'about:blank') { toast('Чат ещё не открыт'); return }
  // webk иногда живёт на URL без хеша (открыт список чатов) — закреплять нечего
  if (svc.id === 'tg' && !/#.+/.test(url)) { toast('Сначала откройте чат в Telegram'); return }
  const title = (await getChatNameFor(svc.id, wv, url)) || 'Чат'
  const key = pinKeyOf(svc.id, url, title)
  if (state.cfg.pinned.some(p => (p.key || (p.serviceId + '|' + p.url)) === key)) { toast('Этот чат уже в избранном'); return }
  const pin = {
    id: 'p' + Date.now() + Math.random().toString(36).slice(2, 6),
    serviceId: svc.id,
    title,
    url,
    key
  }
  state.cfg.pinned.push(pin)
  state.cfg.selectedPinId = pin.id
  await window.hub.saveConfig(state.cfg)
  renderChatList()
  updateSvcBar(svc.id)
  toast('В избранном: ' + title)
}

async function getChatName(svcId, wv) {
  const sels = NAME_SELECTORS[svcId] || []
  for (const sel of sels) {
    try {
      const t = await wv.executeJavaScript(
        '(() => { const el = document.querySelector(' + JSON.stringify(sel) + '); return el ? el.textContent.trim() : "" })()'
      )
      if (t) return t.slice(0, 80)
    } catch {}
  }
  try {
    const t = await wv.executeJavaScript('document.title')
    if (t && !/непрочитан|unread/i.test(t)) return t.replace(/^\(\d+\)\s*/, '').split(' - ')[0].trim().slice(0, 80)
  } catch {}
  return null
}

// Имя чата надёжным способом — из СТРОКИ СПИСОКА (статичные данные), а не из шапки:
// шапка отстаёт при переключении (TG) и при старте показывает последний открытый
// канал из localStorage (MM — при одновременной загрузке нескольких вьюх все шапки
// показывали один канал, и имена чатов портились).
async function getChatNameFor(svcId, wv, pinUrl) {
  let expr = null
  if (svcId === 'tg' && pinUrl) {
    const pid = (String(pinUrl).match(/#([-\w@]+)/) || [])[1]
    if (pid) {
      expr = '(() => { const av = document.querySelector(' +
        JSON.stringify('[data-peer-id="' + pid + '"]') +
        '); const row = av ? (av.closest(".row-clickable") || av) : null; const t = row ? row.querySelector(".peer-title") : null; return t ? t.textContent.trim() : "" })()'
    }
  }
  if (svcId === 'mm' && pinUrl) {
    const m = String(pinUrl).match(/\/(channels|messages)\/([^/?#]+)/)
    if (m) {
      expr = '(() => { const a = document.querySelector(' +
        JSON.stringify('a[href$="/' + m[1] + '/' + m[2] + '"]') +
        '); const s = a ? (a.querySelector(".SidebarChannelLinkLabel") || a.querySelector(".SidebarChannelLinkLabel_wrapper")) : null; return s ? s.textContent.trim() : "" })()'
    }
  }
  if (svcId === 'ydx' && pinUrl) {
    // Телемост: имя открытого чата — в шапке области чата (.yamb-chat-bar).
    // Надёжный DOM-селектор (не document.title — тот всегда «Яндекс Телемост»)
    expr = '(() => { const bar = document.querySelector(".yamb-chat-bar .ui-entity-block-horizontal-layout__content"); const cell = bar ? bar.querySelector(".ui-cell_flex") : null; return cell ? cell.textContent.trim() : "" })()'
  }
  if (expr) {
    // имя — ТОЛЬКО из строки списка/шапки ЭТОГО чата: сперва своя вьюха, затем
    // вкладка мессенджера (вьюха может висеть на экране «Присоединиться к команде»,
    // где сайдбара нет). Фолбэка на document.title НЕТ — именно он портил
    // имена чатов («Astra Team Chat» — общее название команды Mattermost).
    // Для Телемоста вкладку сервиса не пробуем: в её шапке ДРУГОЙ чат.
    const views = svcId === 'ydx' ? [wv] : [wv, state.svcViews[svcId]].filter((v, i, a) => v && a.indexOf(v) === i)
    for (const v of views) {
      try {
        const t = await v.executeJavaScript(expr)
        if (t) return t.slice(0, 80)
      } catch (e) {}
    }
    return null
  }
  return getChatName(svcId, wv)
}

/* ---------- сборная вкладка ---------- */

function renderChatList() {
  const list = document.getElementById('chat-list')
  if (!list) return
  list.innerHTML = ''
  const favs = state.cfg.pinned
  const has = favs.length > 0
  const empty = document.getElementById('combined-empty')
  const layout = document.getElementById('combined-layout')
  if (empty) empty.classList.toggle('hidden', has)
  if (layout) layout.classList.toggle('hidden', !has)
  const cnt = document.getElementById('fav-count')
  if (cnt) cnt.textContent = has ? String(favs.length) : ''

  for (const p of favs) list.appendChild(makeChatRow(p))
  applyFavFilter() // фильтр поиска живёт и после перерисовки списка

  // webview НА КАЖДЫЙ чат из избранного: предзагружаем только ВЕРХНИЕ чаты
  // списка (приоритет/свежие) — остальные создаются и грузятся по клику
  // (selectChat): иначе 60+ процессов мессенджеров съедают всю оперативку
  for (const p of favs.slice(0, maxLiveViews())) ensurePinView(p)
  // вьюхи чатов, которых больше нет в избранном, — убираем
  const alive = new Set(favs.map(p => p.id))
  for (const [pid, v] of Object.entries(state.pinViews)) {
    if (!alive.has(pid)) { destroyPinView(pid, v) }
  }
  trimPinViews(state.cfg.selectedPinId)

  if (has) {
    const sel = favs.find(x => x.id === state.cfg.selectedPinId) || favs[0]
    selectChat(sel.id)
  } else {
    for (const v of Object.values(state.pinViews)) v.classList.remove('active')
  }
}

/* ---------- поиск по избранному (пункт 11 бэклога) ---------- */
// Фильтр строк списка избранного по названию чата по мере ввода.
// Пустой запрос — все чаты. По тексту сообщений НЕ ищет — только названия.
function initFavSearch() {
  const input = document.getElementById('fav-search')
  const clear = document.getElementById('fav-search-clear')
  if (!input || clear === null) return
  input.addEventListener('input', () => { state.favQuery = input.value; applyFavFilter() })
  clear.addEventListener('click', () => {
    input.value = ''
    state.favQuery = ''
    applyFavFilter()
    input.focus()
  })
}

function applyFavFilter() {
  const list = document.getElementById('chat-list')
  const nores = document.getElementById('chat-list-nores')
  const clear = document.getElementById('fav-search-clear')
  if (!list) return
  const q = String(state.favQuery || '').trim().toLowerCase()
  if (clear) clear.classList.toggle('hidden', !q)
  let shown = 0
  for (const row of list.children) {
    if (!row.classList || !row.classList.contains('chat-row')) continue
    const title = (row.querySelector('.chat-row-title') || {}).textContent || ''
    const svc = (row.querySelector('.chat-row-svc') || {}).textContent || ''
    const hit = !q || title.toLowerCase().includes(q) || svc.toLowerCase().includes(q)
    row.classList.toggle('filtered-out', !hit)
    if (hit) shown++
  }
  if (nores) nores.classList.toggle('hidden', shown > 0 || !q)
}

function makeChatRow(p) {
  const svc = state.cfg.services.find(s => s.id === p.serviceId)
  const svcName = svc ? svc.name : '?'
  const row = document.createElement('div')
  row.className = 'chat-row'
  row.dataset.pin = p.id
  row.innerHTML = `
    ${svc && state.svcIcons[svc.id] ? '<img class="svc-badge svc-icon" alt="">' : '<span class="svc-badge"></span>'}
    <div class="chat-row-text">
      <div class="chat-row-title"></div>
      <div class="chat-row-svc"></div>
    </div>
    <span class="row-badge hidden"></span>
    <button class="icon-btn row-pin-btn" title="Закрепить наверху (как в Telegram) / открепить">📌</button>
    <button class="icon-btn row-del" title="Убрать из избранного">✕</button>`
  const badge = row.querySelector('.svc-badge')
  badge.dataset.svc = svc ? svc.id : ''
  if (svc && state.svcIcons[svc.id]) badge.src = state.svcIcons[svc.id]
  else {
    badge.textContent = Array.from(svcName.trim())[0] || '?'
    badge.style.background = badgeColor(svcName)
  }
  row.classList.toggle('priority', !!p.priority)
  badge.title = svcName
  const ttl = row.querySelector('.chat-row-title')
  ttl.textContent = p.title
  ttl.title = p.url
  row.querySelector('.chat-row-svc').textContent = svcName + (state.lastMsgText[p.id] ? ' · ' + state.lastMsgText[p.id] : '')
  row.onclick = (e) => { if (!e.target.closest('.icon-btn')) selectChat(p.id) }
  row.querySelector('.row-del').onclick = () => removePin(p.id)
  row.querySelector('.row-pin-btn').onclick = () => togglePin(p.id)
  return row
}

function selectChat(pinId) {
  const p = state.cfg.pinned.find(x => x.id === pinId)
  if (!p) return
  const svc = state.cfg.services.find(s => s.id === p.serviceId)
  if (!svc) return
  state.cfg.selectedPinId = pinId
  window.hub.saveConfig(state.cfg)
  document.querySelectorAll('.chat-row').forEach(r => r.classList.toggle('selected', r.dataset.pin === pinId))
  // открытие чата: если вьюха ещё не создана (за пределами топа списка) —
  // создаём и грузим вне очереди; давно не открывавшиеся вьюхи вытесняем (LRU),
  // иначе 60+ чатов держат 60+ процессов мессенджеров в оперативке.
  // ВАЖНО: открытие чата активностью для сортировки НЕ считается —
  // наверх чат поднимают только сообщения («время последней активности»)
  state.lastUsed[pinId] = Date.now()
  const wv = ensurePinView(p)
  if (wv && !wv.dataset.loadedSrc) enqueueLoad(wv, p.url, true)
  trimPinViews(pinId)
  for (const [pid, v] of Object.entries(state.pinViews)) v.classList.toggle('active', pid === pinId)
  try { if (wv) wv.executeJavaScript('window.dispatchEvent(new Event("resize"))') } catch (e) {}
  renderViewHead(p, svc)
}

function currentPinFor(svcId) {
  return state.cfg.pinned.find(p => p.id === state.cfg.selectedPinId && p.serviceId === svcId) || favoritesOf(svcId)[0]
}

// Последовательная загрузка webview: при одновременном старте многих вьюх
// Mattermost уводит часть чатов на экран «Присоединиться к команде» (гонка
// команд/членства в команде), а Telegram теряет строки сайдбара. Поэтому
// источники грузим по очереди: dom-ready (или 8 c) → следующий в очереди.
const preloadQueue = []
let preloadBusy = false
function enqueueLoad(wv, url, front) {
  if (!wv || !url) return
  if (wv.dataset.loadedSrc === url) return
  if (wv.dataset.loadedSrc) { try { wv.loadURL(url) } catch (e) {}; wv.dataset.loadedSrc = url; return }
  // уже ждёт в очереди? при front — поднимаем наверх, дублей не создаём
  const i = preloadQueue.findIndex(j => j.wv === wv)
  if (i >= 0) {
    if (front) { preloadQueue.splice(i, 1); preloadQueue.unshift({ wv, url }) }
    return
  }
  const job = { wv, url }
  if (front) preloadQueue.unshift(job); else preloadQueue.push(job)
  pumpPreload()
}
function pumpPreload() {
  if (preloadBusy || !preloadQueue.length) return
  const { wv, url } = preloadQueue.shift()
  if (!wv.isConnected) { pumpPreload(); return }
  preloadBusy = true
  let settled = false
  const done = () => { if (settled) return; settled = true; clearTimeout(tid); preloadBusy = false; pumpPreload() }
  const tid = setTimeout(done, 8000)
  wv.addEventListener('dom-ready', done, { once: true })
  wv.dataset.loadedSrc = url
  try { wv.setAttribute('src', url) } catch (e) { done() }
}

// webview на конкретный чат из избранного: создаётся заранее (renderChatList)
// и сам грузит страницу чата. Открытие чата = показ этой вьюхи — мгновенно,
// без повторной загрузки мессенджера.
function ensurePinView(p) {
  let wv = state.pinViews[p.id]
  if (wv) return wv
  const svc = state.cfg.services.find(s => s.id === p.serviceId)
  if (!svc) return null
  wv = document.createElement('webview')
  wv.setAttribute('partition', svc.partition)
  wv.setAttribute('allowpopups', '')
  wv.setAttribute('webpreferences', 'backgroundThrottling=no')
  wv.className = 'chat-webview'
  // src назначает очередь предзагрузки (см. enqueueLoad) — не все MM-вьюхи сразу
  const stack = document.getElementById('chat-view-stack')
  if (stack) stack.appendChild(wv)
  state.pinViews[p.id] = wv
  enqueueLoad(wv, p.url, p.id === state.cfg.selectedPinId)
  wv.addEventListener('dom-ready', () => { applyColumnTweaks(wv, p); captureSvcIcon(svc.id, wv) })
  wv.addEventListener('did-navigate-in-page', () => setTimeout(() => applyColumnTweaks(wv, p), 400))
  // страховка: если CSS потерялся (медленный старт SPA, самообновление страницы) — вернуть
  wv.__hubTimer = setInterval(async () => {
    try {
      const ok = await wv.executeJavaScript('!!window.__chatHubCssTimer')
      if (ok) return
      if (String((state.cfg.columnCss || {})[svc.id] || '').trim()) applyColumnTweaks(wv, p, 4)
    } catch (e) {}
  }, 5000)
  return wv
}

// убрать webview чата из памяти (вытеснение LRU / чат удалён из избранного):
// убивает процесс мессенджера, освобождая оперативку; при следующем открытии
// чат загрузится заново (пара секунд)
function destroyPinView(pid, v) {
  try { clearInterval(v.__hubTimer) } catch (e) {}
  // выкидываем из очереди предзагрузки, если ещё ждёт
  for (let i = preloadQueue.length - 1; i >= 0; i--) {
    if (preloadQueue[i].wv === v) preloadQueue.splice(i, 1)
  }
  try { v.remove() } catch (e) {}
  delete state.pinViews[pid]
  delete state.lastUsed[pid]
}

// LRU: живых вьюх — не больше maxLiveViews (8 по умолчанию). Вытесняем самые
// давно не открывавшиеся; текущий чат и чаты с ручным приоритетом (↑) не трогаем.
function trimPinViews(keepId) {
  const entries = Object.entries(state.pinViews)
  const max = maxLiveViews()
  const prio = new Set(state.cfg.pinned.filter(p => p.priority).map(p => p.id))
  const evictable = entries.filter(([pid]) => pid !== keepId && !prio.has(pid))
  const excess = entries.length - max
  if (excess <= 0 || !evictable.length) return
  evictable.sort((a, b) => (state.lastUsed[a[0]] || 0) - (state.lastUsed[b[0]] || 0))
  for (const [pid, v] of evictable.slice(0, excess)) destroyPinView(pid, v)
}

// любое живое окно сервиса (для чтения непрочитанных): вьюха первого чата сервиса
function svcViewFor(svcId) {
  const first = favoritesOf(svcId)[0]
  return (first && state.pinViews[first.id]) || state.svcViews[svcId] || null
}

// Фирменная иконка мессенджера для строк избранного: favicon читается ВНУТРИ
// webview этого сервиса (его сессия/прокси), конвертируется в data URL и живёт
// в памяти шелла — Telegram-иконка тоже загрузится (у него свой прокси в госте).
async function captureSvcIcon(svcId, wv) {
  if (!wv || state.svcIcons[svcId]) return
  try {
    const dataUrl = await wv.executeJavaScript('(async () => { try {' +
      ' const link = document.querySelector(\'link[rel~="icon"][href], link[rel="shortcut icon"][href], link[rel="apple-touch-icon"][href]\');' +
      ' const href = link ? link.href : (location.origin + \'/favicon.ico\');' +
      ' const blob = await fetch(href).then(r => r.blob());' +
      ' if (!blob || !blob.size || blob.size > 300000) return \'\';' +
      ' return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(\'\'); fr.readAsDataURL(blob) })' +
      ' } catch (e) { return \'\' } })()')
    if (dataUrl && !state.svcIcons[svcId]) {
      state.svcIcons[svcId] = dataUrl
      // перерисовать строки: буквы → фирменные иконки
      renderChatList()
    }
  } catch (e) {}
}

function renderViewHead(p, svc) {
  const head = document.getElementById('view-head')
  if (!head) return
  head.innerHTML = `
    ${svc && state.svcIcons[svc.id] ? '<img class="svc-badge svc-icon" alt="">' : '<span class="svc-badge"></span>'}
    <span class="view-title"></span>
    <span class="view-svc"></span>
    <button class="icon-btn" id="vh-open" title="Открыть во вкладке мессенджера">↗</button>
    <button class="icon-btn" id="vh-close" title="Убрать из избранного">✕</button>`
  const b = head.querySelector('.svc-badge')
  if (svc && state.svcIcons[svc.id]) b.src = state.svcIcons[svc.id]
  else {
    b.textContent = Array.from(svc.name.trim())[0] || '?'
    b.style.background = badgeColor(svc.name)
  }
  const ttl = head.querySelector('.view-title')
  ttl.textContent = (p.priority ? '📌 ' : '') + p.title
  ttl.title = p.url
  ttl.onclick = () => openInServiceTab(p)
  head.querySelector('.view-svc').textContent = svc.name
  head.querySelector('#vh-open').onclick = () => openInServiceTab(p)
  head.querySelector('#vh-close').onclick = () => removePin(p.id)
}

async function removePin(pinId) {
  const removed = state.cfg.pinned.find(x => x.id === pinId)
  state.cfg.pinned = state.cfg.pinned.filter(x => x.id !== pinId)
  if (state.cfg.selectedPinId === pinId) {
    state.cfg.selectedPinId = (state.cfg.pinned[0] || {}).id || ''
  }
  // гигиена: не оставляем записи удалённых чатов в картах состояния
  for (const k of ['liveAct', 'rankAct', 'prevUnread', 'lastUsed', 'lastMsgAt', 'lastMsgText', 'tgPeerOf', 'tgSearchedAt']) {
    try { delete state[k][pinId] } catch (e) {}
  }
  // ...и в сохранённой активности конфига (п.13)
  if (state.cfg.activity) {
    for (const k of Object.keys(state.cfg.activity)) {
      try { delete state.cfg.activity[k][pinId] } catch (e) {}
    }
  }
  await window.hub.saveConfig(state.cfg)
  renderChatList()
  if (removed) updateSvcBar(removed.serviceId)
  toast('Убрано из избранного')
}

// 📌 как в Telegram: клик по пину закрепляет чат группой сверху автосортировки
// (значок 📌 подсвечен), повторный клик — открепляет, чат возвращается
// к сортировке по времени последнего сообщения.
async function togglePin(pinId) {
  const p = state.cfg.pinned.find(x => x.id === pinId)
  if (!p) return
  p.priority = !p.priority
  await window.hub.saveConfig(state.cfg)
  renderChatList()
  toast(p.priority ? '«' + p.title + '» закреплён наверху' : '«' + p.title + '» откреплён')
}

function openInServiceTab(p) {
  activateTab('svc:' + p.serviceId)
  const wv = state.svcViews[p.serviceId]
  if (!wv) return
  const go = () => { try { wv.loadURL(p.url) } catch {} }
  if (wv.getURL() && wv.getURL() !== 'about:blank') { go(); return }
  wv.addEventListener('dom-ready', go, { once: true })
}

/* ---------- избранное на вкладке мессенджера ---------- */

// Совпадает ли запись избранного с чатом: mm — по slug канала, tg — по hash, max/ydx — по названию
function pinMatches(p, svc, url, title) {
  if (!p || p.serviceId !== svc.id) return false
  if (svc.id === 'mm') {
    const slugOf = u => { const m = String(u).match(/\/(channels|messages)\/([^/?#]+)/); return m ? m[2] : null }
    return !!slugOf(p.url) && slugOf(p.url) === slugOf(url)
  }
  if (svc.id === 'tg') {
    const hOf = u => { const m = String(u).match(/#([-\w@]+)/); return m ? m[1] : null }
    return !!hOf(p.url) && hOf(p.url) === hOf(url)
  }
  if ((svc.id === 'max' || svc.id === 'ydx') && p.url && String(p.url).split('?')[0] !== String(svc.url).split('?')[0]) {
    // deep-link пины MAX/Телемоста сравниваем по URL
    return String(p.url).split('?')[0] === String(url || '').split('?')[0]
  }
  return !!title && String(p.title).trim() === String(title).trim()
}

// Кнопка ⭐/★ и счётчик избранного на вкладке мессенджера
async function updateSvcBar(svcId) {
  const svc = state.cfg.services.find(s => s.id === svcId)
  const sec = document.querySelector('section[data-tab="svc:' + svcId + '"]')
  const wv = state.svcViews[svcId]
  if (!svc || !sec || !wv) return
  const btn = sec.querySelector('.pin-current')
  const cnt = sec.querySelector('.fav-count')
  if (!btn) return
  if (cnt) {
    const n = favoritesOf(svcId).length
    cnt.textContent = n ? String(n) : ''
  }
  const url = wv.getURL()
  if (!url || url === 'about:blank') {
    btn.textContent = '⭐ В избранное'
    btn.classList.remove('pinned')
    delete btn.dataset.pin
    return
  }
  let title = null
  try { title = await getChatName(svcId, wv) } catch {}
  const hit = state.cfg.pinned.find(p => pinMatches(p, svc, url, title))
  if (hit) {
    btn.textContent = '★ Убрать из избранного'
    btn.classList.add('pinned')
    btn.dataset.pin = hit.id
  } else {
    btn.textContent = '⭐ В избранное'
    btn.classList.remove('pinned')
    delete btn.dataset.pin
  }
}

function closeAllFavMenus() {
  document.querySelectorAll('.fav-menu').forEach(m => m.classList.add('hidden'))
}

// Меню избранного на вкладке мессенджера: клик по строке — открыть чат в этой вкладке, ✕ — убрать из избранного
function fillFavMenu(svcId, bar) {
  const m = bar.querySelector('.fav-menu')
  if (!m) return
  m.innerHTML = ''
  const favs = favoritesOf(svcId)
  if (!favs.length) {
    m.innerHTML = '<div class="fav-menu-empty">Пока ничего в избранном</div>'
    return
  }
  for (const p of favs) {
    const it = document.createElement('div')
    it.className = 'fav-menu-item'
    it.innerHTML = '<span class="fav-menu-title"></span>' +
      '<button class="icon-btn" title="Убрать из избранного">✕</button>'
    it.querySelector('.fav-menu-title').textContent = p.title
    it.querySelector('.fav-menu-title').title = p.url
    it.onclick = (e) => {
      if (e.target.closest('.icon-btn')) return
      closeAllFavMenus()
      // на вкладке самого мессенджера открываем чат напрямую по ссылке
      const wv = state.svcViews[svcId]
      if (wv) { try { const pr = wv.loadURL(p.url); if (pr && pr.catch) pr.catch(() => {}) } catch (e) {} }
    }
    it.querySelector('.icon-btn').onclick = async (e) => {
      e.stopPropagation()
      await removePin(p.id)
      fillFavMenu(svcId, bar)
      updateSvcBar(svcId)
    }
    m.appendChild(it)
  }
}

/* ---------- непрочитанные и упоминания ---------- */

// TG: сопоставление пинов через ПОИСК webk. Синтетические JS-события webk
// игнорирует, поэтому ввод доверенный — через main (webContents.insertText и
// sendInputEvent). Строки результатов поиска содержат ПОЛНОЕ название чата,
// числовой peer-id (href), время последнего сообщения и бейдж непрочитанных.
// Работает только на скрытой вкладке Telegram, не чаще 20 с; после каждого
// запроса поле очищается select+Backspace (Escape запрещён — ломает поиск).
let tgSearchAt = 0
let tgSearchBusy = false
let tgScrollAt = 0 // троттлинг доскролла списка (не чаще раза в 90 с)
let tgScrollDone = false // список диалогов прокручен до дна без новых строк — не скроллить
let tgBusyAt = 0 // когда начался текущий поисковый проход (детект зависания)

// Доскролл списка диалогов webk. Виртуализированный список рендерит только
// видимое окно: старые диалоги не загружены, глобальный поиск их находит,
// но БЕЗ времени последнего сообщения. Прокрутка доверенным колесом грузит
// следующие партии диалогов; строки собираем на лету — у них есть и время,
// и непрочитанные. После прохода возвращаем список наверх.
// guest-eval с таймаутом: замороженная вьюха НИКОГДА не резолвит промис —
// без таймаута проход висит вечно, tgSearchBusy не сбрасывается и всё
// останавливается (наблюдалось 2026-11-10: webk завис при глубокой прокрутке)
function evT(wv, code, ms = 15000) {
  return Promise.race([
    wv.executeJavaScript(code),
    new Promise((_, rej) => setTimeout(() => rej(new Error('guest eval timeout ' + ms + 'ms — вьюха заморожена?')), ms))
  ])
}

// Доскролл списка диалогов webk: прокручиваем ДО КОНЦА списка (высота
// растёт при ленивой загрузке — фиксированного числа шагов не хватает),
// строки с временем собираем на каждом шаге. Возврат наверх — прямым
// scrollTop=0. Возвращает собранные строки; end=true если достигли дна.
async function tgScrollLoad(wv, wcId, maxSteps) {
  const rows = []
  let reachedEnd = false
  try {
    // Координаты колеса — от ВИДИМОГО контейнера .chatlist-parts (его rect
    // стабилен: y≈72, h≈759 и не зависит от глубины прокрутки). Брать rect
    // самого ul.chatlist НЕЛЬЗЯ: при глубокой прокрутке он уезжает в минус
    // (y=-53033) и события колеса мажут мимо вьюпорта — скролл молча умирает.
    const info = await evT(wv, '(() => { const sup = document.querySelector(".search-super"); if (sup && sup.getBoundingClientRect().height > 0) return "SEARCH-OPEN"; const cs = Array.from(document.querySelectorAll(".chatlist-parts")).filter(c => { const r = c.getBoundingClientRect(); return r.width > 50 && r.height > 50 }); const c = cs[0]; if (!c) return null; const r = c.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + 200 }) })()')
    if (!info || info === 'SEARCH-OPEN') return { rows: rows, end: false }
    // Скролл ПРЯМЫМИ ШАГАМИ scrollTop по ~600 px (≈ высота вьюпорта):
    // trusted-колесо webk игнорирует (событие доходит, но скролла нет —
    // перехват), а большие прыжки scrollTop рендерят пустое окно —
    // виртуализатор webk рисует только малые приращения. Каждый шаг:
    // +600 px → scroll-событие → пауза 350 мс на перерисовку → сбор строк.
    const pos = '(() => { const cs = Array.from(document.querySelectorAll(".chatlist-parts")).filter(c => { const r = c.getBoundingClientRect(); return r.width > 50 && r.height > 50 }); const c = cs[0]; return c ? JSON.stringify({ top: c.scrollTop, h: c.scrollHeight, vh: c.clientHeight }) : null })()'
    const st0 = await evT(wv, pos, 8000)
    if (!st0) return { rows: rows, end: false }
    const stepGrab = `(() => { const cs = Array.from(document.querySelectorAll(".chatlist-parts")).filter(c => { const r = c.getBoundingClientRect(); return r.width > 50 && r.height > 50 }); const c = cs[0]; if (!c) return Promise.resolve("[]"); c.scrollTop = Math.min(c.scrollTop + 600, c.scrollHeight); c.dispatchEvent(new Event("scroll", { bubbles: true })); return new Promise(res => setTimeout(() => res(JSON.stringify(Array.from(document.querySelectorAll('a.row-clickable')).map(r => {
      const t = r.querySelector('.peer-title')
      const tp = r.querySelector('.message-time')
      const bd = r.querySelector('.dialog-subtitle-badge-unread')
      return {
        pid: r.getAttribute('data-peer-id') || String(r.getAttribute('href') || '').replace('#', ''),
        title: t ? t.textContent.trim() : '',
        time: tp ? tp.textContent.trim() : '',
        unreadTxt: bd ? bd.textContent.trim() : ''
      }
    }).filter(x => x.pid && x.title))), 350)) })()`
    for (let i = 0; i < maxSteps; i++) {
      const st = await evT(wv, pos, 8000)
      if (st) {
        const s = JSON.parse(st)
        if (s.top + s.vh >= s.h - 20) { reachedEnd = true; break } // дно списка
      }
      // шаг: +600 px, пауза на перерисовку, сбор строк этого окна
      try { rows.push(...JSON.parse(await evT(wv, stepGrab, 12000))) } catch (e) {}
    }
    // наверх: прямой scrollTop=0 на контейнере — надёжнее колеса (колесо
    // может не добить до конца, а «застрявший глубоко» список ломает
    // следующие проходы: ul.chatlist уезжает в минус и координаты умирают)
    await evT(wv, '(() => { const cs = Array.from(document.querySelectorAll(".chatlist-parts")).filter(c => { const r = c.getBoundingClientRect(); return r.width > 50 && r.height > 50 }); if (cs[0]) { cs[0].scrollTop = 0; cs[0].dispatchEvent(new Event("scroll", { bubbles: true })) } return true })()')
    await new Promise(r => setTimeout(r, 800))
  } catch (e) {}
  return { rows: rows, end: reachedEnd }
}

// очистка поля поиска: Ctrl+A + Backspace. ВАЖНО: БЕЗ Escape — Escape
// закрывает режим поиска webk, и последующий insertText не запускает поиск
// заново. Обычный select() тоже не годится: между select и Backspace webk
// перерисовывает результаты и снимает выделение — поле «не очищается».
async function tgEnsureClean(wv, wcId) {
  for (let i = 0; i < 3; i++) {
    try {
      const val = await evT(wv, '(() => { const i = document.querySelector("input.input-search-input"); return i ? i.value : "" })()', 8000)
      if (!val) return true // уже пусто
      await evT(wv, '(() => { const i = document.querySelector("input.input-search-input"); if (i) i.focus(); return true })()')
      await window.hub.trustedKey(wcId, 'a', 65, ['control'])
      await window.hub.trustedKey(wcId, 'Backspace', 8)
      await new Promise(r => setTimeout(r, 350))
    } catch {}
  }
  return false
}
// переключить папку диалогов webk trusted-кликом (синтетический click() webk
// игнорирует). Поиск webk действует ТОЛЬКО в пределах активной папки, поэтому
// перед запросами включаем «All» и возвращаем прежнюю папку после
async function tgSelectFolder(wv, wcId, folderId) {
  try {
    const info = await evT(wv, `(() => {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const tabs = Array.from(document.querySelectorAll('.menu-horizontal-div-item[data-filter-id]')).filter(vis)
      const active = tabs.find(t => t.classList.contains('active'))
      const target = tabs.find(t => t.getAttribute('data-filter-id') === '` + folderId + `')
      if (!target) return JSON.stringify({ ok: false })
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const r = target.getBoundingClientRect()
      return JSON.stringify({ ok: true, prev: active ? active.getAttribute('data-filter-id') : null, x: r.x + r.width / 2, y: r.y + r.height / 2 })
    })()`, 10000)
    const p = JSON.parse(info)
    if (!p.ok) return null
    if (p.prev === folderId) return p.prev // уже в нужной папке
    const okc = await window.hub.trustedClick(wcId, Math.round(p.x), Math.round(p.y))
    if (!okc) return null
    await new Promise(r => setTimeout(r, 900))
    return p.prev
  } catch { return null }
}
async function tgSearchResolve(favs) {
  // Проходы печатают в поле поиска TG и скроллят список диалогов — пока окно
  // приложения АКТИВНО, мессенджер не трогаем вообще. document.hasFocus() ВРЁТ:
  // когда пользователь кликнул в чат внутри webview, хост-документ считает
  // фокус потерянным и проход начинал печатать прямо на глазах. Спрашиваем
  // настоящий фокус окна у main-процессса; при любой ошибке считаем, что
  // пользователь здесь, и ничего не делаем. Тумблер в ⚙ Настройках. ПО УМОЛЧАНИЮ
  // ВЫКЛЮЧЕНА: проходы печатают в поиск Telegram, и когда окно видно, но не в
  // фокусе (пользователь печатает в другом окне рядом) — это выглядит как
  // «программа печатает сама». Включается только осознанно в настройках.
  if (state.cfg.tgBackgroundIndex !== true) return null
  try { if (await window.hub.isWinFocused()) return null } catch { return null }
  if (document.hasFocus()) return null
  if (tgSearchBusy || Date.now() - tgSearchAt < 20000) return null
  const pane = document.querySelector('section[data-tab="svc:tg"]')
  if (pane && pane.classList.contains('visible')) return null // не мешаем пользователю
  // поиск требует фокуса на webview — а это отбирает клавиатуру у текущей
  // вьюхи. Поэтому проходы только когда окно ChatHub в фоне или пользователь
  // бездействует 45+ с (state.tgSearchForce — отладочное исключение для тестов)
  const idleMs = Date.now() - (state.lastUserInput || 0)
  if (!state.tgSearchForce && document.hasFocus() && idleMs < 45000) return null
  const wv = state.svcViews.tg
  if (!wv || !wv.executeJavaScript) return null
  const need = favs.filter(f => !state.tgPeerOf[f.id] || !state.lastMsgAt[f.id])
  const fresh = need.length === 0
  const pool = favs.slice().sort((a, b) => {
    const an = need.some(f => f.id === a.id) ? 0 : 1
    const bn = need.some(f => f.id === b.id) ? 0 : 1
    if (an !== bn) return an - bn
    return (state.tgSearchedAt[a.id] || 0) - (state.tgSearchedAt[b.id] || 0)
  })
  const batch = pool.slice(0, fresh ? 1 : 5)
  if (!batch.length) return null
  tgSearchAt = Date.now()
  tgSearchBusy = true
  tgBusyAt = Date.now()
  const harvested = []
  const lg = s => {
    try {
      (state.tgSearchLog = state.tgSearchLog || []).push(new Date().toLocaleTimeString('ru-RU') + ' ' + s)
      if (state.tgSearchLog.length > 12) state.tgSearchLog.shift()
    } catch {}
  }
  lg('проход: запросов ' + batch.length + (fresh ? ' (ротация)' : ' (новые)'))
  const prevFocus = document.activeElement // возвращаем фокус пользователю в конце
  // запрос — самое «distinctive» слово названия: webk ищет по словам, и полный
  // прекс с «|» («EXT | ВСК ППК | Te») чаще всего ничего не находит, а одно
  // слово («ВСК», «Агасиев», «Termidesk») — находит. Сопоставление всё равно
  // по peer-id и полному названию, запрос лишь должен «всплыть» нужный чат.
  const STOP_WORDS = new Set(['ext', 'int', 'астра', 'astra', 'astrа', 'чат', 'чат-', 'группа', 'team', 'test', 'rb', 'vm'])
  const qOf = title => {
    const words = String(title || '')
      .split(/[\s|+,/()]+/)
      .map(w => w.trim())
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase().replace(/ё/g, 'е')))
    if (!words.length) return String(title || '').trim().slice(0, 18)
    words.sort((a, b) => b.length - a.length)
    return words[0]
  }
  try {
    const wcId = wv.getWebContentsId()
    // webk прячет .sidebar (display:none) при узком viewport ИЛИ открытом
    // чате в мобильной раскладке — поиск в этом состоянии не работает:
    // поле нулевого размера, ввод теряется. Пропускаем проход.
    const sbOk = await evT(wv, '(() => { const s = document.querySelector(".sidebar"); return !!s && s.getBoundingClientRect().width > 50 })()', 8000)
    if (!sbOk) { lg('проход пропущен: сайдбар webk скрыт (узкое окно?)'); return null }
    // поиск webk видит только активную папку → включаем «All» (папки и поиск
    // реагируют лишь на доверенные события; после прохода вернём папку)
    const prevFolder = await tgSelectFolder(wv, wcId, '0')
    for (const f of batch) {
      // мгновенный стоп: пользователь вернулся в приложение — прекращаем
      // проход немедленно (проход мог стартовать, пока окно было в фоне)
      try { if (await window.hub.isWinFocused()) { lg('стоп: пользователь в приложении'); break } } catch {}
      let q = qOf(f.title)
      // Дубликаты названий (два аккаунта одного человека) title-матчинг не
      // разрешает: совпадают обе строки. Для пинов без pid ищем по @username
      // из URL — он уникален; первый результат поиска = сам пользователь,
      // его pid сразу пишем в карту (дальше свип даст время по pid)
      let unameQuery = null
      if (!state.tgPeerOf[f.id]) {
        const um = String(f.url || '').match(/#@([A-Za-z0-9_]{3,})/)
        if (um) { unameQuery = um[1]; q = unameQuery }
      }
      state.tgSearchedAt[f.id] = Date.now()
      if (q.length < 3) continue
      try {
        wv.focus() // без фокуса webContents insertText теряется (hasFocus=false)
        if (!(await tgEnsureClean(wv, wcId))) { lg('«' + q + '» поле не очищается — пропуск'); continue }
        await evT(wv, '(() => { const i = document.querySelector("input.input-search-input"); if (i) i.focus(); return !!i })()')
        await window.hub.trustedText(wcId, q)
        await new Promise(r => setTimeout(r, 3000))
        // ВАЖНО: берём ВСЕ a.row-clickable без фильтра href — у глобальных
        // результатов поиска href ПУСТОЙ, pid только в data-peer-id; фильтр
        // [href^="#"] выкидывал именно нужные строки (диалоги вне папки)
        const raw = await evT(wv, `(() => JSON.stringify(Array.from(document.querySelectorAll('a.row-clickable')).map(r => {
          const t = r.querySelector('.peer-title')
          const tp = r.querySelector('.message-time')
          const bd = r.querySelector('.dialog-subtitle-badge-unread')
          let mentions = 0
          if (bd) {
            const rgb = (getComputedStyle(bd).backgroundColor.match(/\\d+/g) || []).map(Number)
            if (/danger/.test(String(bd.className)) || (rgb.length > 2 && rgb[0] > 170 && rgb[1] < 110)) mentions = 1
          }
          return {
            pid: r.getAttribute('data-peer-id') || String(r.getAttribute('href') || '').replace('#', ''),
            title: t ? t.textContent.trim() : '',
            time: tp ? tp.textContent.trim() : '',
            unreadTxt: bd ? bd.textContent.trim() : '',
            mentions: mentions,
            unreadTitle: t ? /unreadPeerTitle/.test(String(t.className)) : false,
            // строка из результатов поиска (карусель search-group-* или
            // .search-super), а не обычного списка позади него —
            // для username-поиска годятся только результаты САМОГО поиска
            inSearch: !!(r.closest && r.closest('.search-super, [class*="search-group"]'))
          }
        }).filter(x => x.pid && x.title)))()`, 15000)
        const rows = JSON.parse(raw)
        harvested.push(...rows)
        lg('«' + q + '» → строк ' + rows.length)
        if (unameQuery && rows.length) {
          // Строка-кандидат должна быть ПОЛЬЗОВАТЕЛЕМ (положительный pid —
          // но БОТЫ тоже положительные: первый попавшийся оказался StarLineBot,
          // и его pid раздался 25 пинам → у всех одинаковое время и «2 новых»).
          // Проверяем вхождение слов заголовка пина в заголовок строки
          // (заголовок пина бывает обрезан: «Абдурахимов» → «Абду»);
          // префиксы филиалов («Астра Кам», «РуБэкап») в заголовке контакта
          // могут отсутствовать — достаточно одного совпадения
          const normU = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '')
          const stopU = new Set(['ext', 'int', 'астра', 'astrа', 'astra', 'chat', 'чат', 'группа', 'team', 'test', 'rb', 'vm'])
          const wordsU = String(f.title || '').split(/[\s|,/()]+/).map(w => normU(w)).filter(w => w.length >= 4 && !stopU.has(w))
          let best = null, bestScore = 0
          for (const r of rows) {
            // только результаты поиска (оверлей), не список позади него:
            // строка «Александр …» из обычного списка выдавала pid первого
            // аккаунта ОБОИМ пинам-дубликатам
            if (!r.inSearch) continue
            if (!r.pid || String(r.pid).charAt(0) === '-') continue
            const n = normU(r.title)
            if (!n) continue
            const score = wordsU.filter(w => n.indexOf(w) >= 0).length
            if (score > bestScore) { bestScore = score; best = r }
          }
          if (best) {
            state.tgPeerOf[f.id] = best.pid
            lg('«' + unameQuery + '» pid=' + best.pid + ' (по username+названию, счёт ' + bestScore + ')')
          } else {
            lg('«' + unameQuery + '» подходящей строки нет — pid не присвоен')
          }
        }
      } catch (e) { lg('«' + q + '» ошибка: ' + (e && e.message)) }
      // очистка после запроса (до пустого поля, иначе следующий запрос склеится)
      await tgEnsureClean(wv, wcId)
      await new Promise(r => setTimeout(r, 350))
    }
    // Доскролл: у части пинов нет времени (старые диалоги вне загруженного
    // окна списка webk — глобальный поиск их даёт без времени). Прокрутка
    // грузит список ДО КОНЦА, строки с временем собираем в тот же harvest.
    // Не чаще раза в 90 с, только пока есть пины без времени. Если дошли
    // до дна и новых pid не появилось — список исчерпан, дальше не скроллим
    // (диалогов этих пинов в основном списке нет — например, архив).
    if (favs.some(f => !state.lastMsgAt[f.id]) && !tgScrollDone &&
        Date.now() - tgScrollAt > 90000) {
      tgScrollAt = Date.now()
      await tgEnsureClean(wv, wcId) // список должен быть в обычном режиме
      // Escape закрывает режим поиска webk и возвращает список диалогов —
      // без него ul.chatlist остаётся 0x0 и скроллить нечего. Иногда одного
      // Escape мало — проверяем и дожимаем (иначе свип сканирует оверлей
      // поиска: тех же ~30 строк за каждый шаг, «новых 0»).
      const supH = '(() => { const sup = document.querySelector(".search-super"); return sup ? Math.round(sup.getBoundingClientRect().height) : -1 })()'
      for (let k = 0; k < 4; k++) {
        const h = await evT(wv, supH, 8000)
        if (h <= 0) break // поиска нет — норма
        await window.hub.trustedKey(wcId, 'Escape', 27)
        await new Promise(r => setTimeout(r, 700))
      }
      await new Promise(r => setTimeout(r, 400))
      const knownPids = new Set()
      for (const r of harvested) knownPids.add(r.pid)
      const res = await tgScrollLoad(wv, wcId, 320)
      const fresh = res.rows.filter(r => !knownPids.has(r.pid))
      if (res.rows.length) harvested.push(...res.rows)
      if (res.end && !fresh.length) tgScrollDone = true // дно и ничего нового
      lg('доскролл: строк ' + res.rows.length + ', новых ' + fresh.length +
         (res.end ? ', достигнуто дно' : '') + (tgScrollDone ? ' — исчерпан' : ''))
    }
  } catch (e) { lg('проход ошибка: ' + (e && e.message)) } finally {
    tgSearchBusy = false
    try { if (prevFolder && prevFolder !== '0') await tgSelectFolder(wv, wv.getWebContentsId(), prevFolder) } catch {}
    try { if (prevFocus && prevFocus.focus) prevFocus.focus() } catch {}
  }
  if (!harvested.length) { lg('проход: строк нет'); return null }
  // дедупликация: чат встречается в результатах несколько раз (контакт +
  // сообщения) — предпочитаем строку с бейджем непрочитанных, затем с временем
  const byPid = new Map()
  for (const r of harvested) {
    const prev = byPid.get(r.pid)
    if (!prev || (!prev.unreadTxt && r.unreadTxt) || (!prev.time && r.time)) byPid.set(r.pid, r)
  }
  const uniqueRows = Array.from(byPid.values())
  const norm = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '')
  const parseN = s => {
    const m = String(s || '').trim().match(/^([\d.,]+)\s*([KКМM]?)/i)
    if (!m) return 0
    let n = parseFloat(m[1].replace(',', '.'))
    if (/^[KК]$/i.test(m[2])) n *= 1000
    if (/^[МM]$/i.test(m[2])) n *= 1000000
    return Math.round(n)
  }
  const out = []
  for (const f of favs) {
    const pid = state.tgPeerOf[f.id] || (String(f.url).match(/#(-?\d+)/) || [])[1] || ''
    let row = pid ? (uniqueRows.find(x => x.pid === pid) || null) : null
    if (!row && f.title) {
      const ft = String(f.title).trim()
      let cands = uniqueRows.filter(x => x.title.trim() === ft)
      if (!cands.length) {
        const nt = norm(ft)
        // строка ⊂ пин — только для строк из >= 2 слов (одиночное имя
        // «Евгений» матчило любой пин с этим именем; «Чат» — со словом «чат»)
        if (nt) cands = uniqueRows.filter(x => { const n = norm(x.title); return n && (n.indexOf(nt) >= 0 || (n.length >= 4 && x.title.trim().indexOf(' ') >= 0 && nt.indexOf(n) >= 0)) })
      }
      if (!cands.length) {
        // пословный fallback: заголовок пина может нести префикс/суффикс
        // («Астра …», «EXT | …», «… все ппк»), которого нет в строке TG —
        // точное вхождение подстроки не срабатывает; ищем строки, содержащие
        // ВСЕ значимые слова заголовка пина (без стоп-слов префиксов)
        const stop = new Set(['ext', 'int', 'астра', 'astrа', 'astra', 'chat', 'чат', 'группа', 'team', 'test', 'rb', 'vm', 'все'])
        const words = ft.split(/[\s|,/()]+/).map(w => norm(w)).filter(w => w.length >= 3 && !stop.has(w))
        if (words.length) cands = uniqueRows.filter(x => { const n = norm(x.title); return n && words.every(w => n.indexOf(w) >= 0) })
      }
      if (cands.length === 1) row = cands[0]
      else if (cands.length > 1) {
        cands.sort((a, b) => b.title.length - a.title.length)
        const bn = norm(cands[0].title)
        if (cands.filter(c => norm(c.title) === bn).length === 1) row = cands[0]
      }
    }
    if (!row) continue
    const count = parseN(row.unreadTxt)
    out.push({
      id: f.id,
      unread: count > 0 || !!row.unreadTitle,
      count: count,
      mentions: row.mentions ? (count || 1) : 0,
      rank: 9999, // позиция в поиске ≠ позиция в списке мессенджера
      time: row.time || null,
      found: true,
      pid: row.pid,
      rowTitle: row.title
    })
  }
  lg('сопоставлено ' + out.length + ' из ' + favs.length)
  return { favs: out }
}

// Пин можно связать с pid строки TG, только если pid стоит в URL пина
// (точное соответствие) или заголовок строки содержит значимое слово
// заголовка пина — иначе в кэш попадают чужие pid (один бот «обслуживал»
// 25 пинов: у всех его время и бейдж непрочитанных). Заголовок пина бывает
// обрезан («Абду» ← «Абдурахимов») — ищем вхождение фрагмента.
function tgPidSafe(pin, pid, rowTitle) {
  if (!pin || !pid) return false
  const upid = (String(pin.url || '').match(/#(-?\d+)/) || [])[1]
  if (upid && String(upid) === String(pid)) return true
  const norm = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '')
  const stop = new Set(['ext', 'int', 'астра', 'astrа', 'astra', 'chat', 'чат', 'группа', 'team', 'test', 'rb', 'vm'])
  const words = String(pin.title || '').split(/[\s|,/()]+/).map(w => norm(w)).filter(w => w.length >= 4 && !stop.has(w))
  if (!words.length) return false
  const n = norm(rowTitle)
  return !!n && words.some(w => n.indexOf(w) >= 0)
}

async function pollUnread() {
  let favTotal = 0        // сумма новых сообщений по всем избранным чатам (для вкладки «Сборная»)
  let favMention = false  // есть ли @-упоминания среди них
  for (const svc of state.cfg.services) {
    const favs = favoritesOf(svc.id)
    const ext = UNREAD_EXTRACTORS[svc.id]
    const wv = svcViewFor(svc.id)
    // Mattermost: в сайдбаре времён нет — время последнего сообщения берём из API MM
    if (svc.id === 'mm') mmTabCounts().catch(() => {})
    if (svc.id === 'mm' && favs.length) mmLastPosts().catch(() => {})
    if (!ext || !favs.length || !wv) continue
    let res = null
    // кандидатные вьюхи: вкладка мессенджера + живые вьюхи пинов этого сервиса.
    // У TG сервисная вкладка иногда остаётся на пустом/авторизационном экране,
    // а вьюха любого чата того же сервиса видит весь список диалогов — берём
    // первый вариант, который вернул полезные данные.
    const candidates = []
    if (wv) candidates.push(wv)
    for (const [pvId, pvView] of Object.entries(state.pinViews)) {
      const pvPin = state.cfg.pinned.find(x => x.id === pvId)
      if (pvPin && pvPin.serviceId === svc.id && candidates.indexOf(pvView) < 0) candidates.push(pvView)
    }
    for (const cand of candidates) {
      if (!cand) continue
      try {
        // второй аргумент экстрактора: можно ли скроллить список (вкладка
        // сервиса сейчас не на экране — прокрутка сайдбара не видна; TG иначе
        // не добирается до виртуализированных строк ниже первого экрана)
        const pane = document.querySelector('section[data-tab="svc:' + svc.id + '"]')
        const allowScroll = !(pane && pane.classList.contains('visible'))
        const out = await cand.executeJavaScript(
          '(' + ext.toString() + ')(' + JSON.stringify(favs.map(f => ({ id: f.id, url: f.url, title: f.title, pid: (svc.id === 'tg' && state.tgPeerOf[f.id]) || null }))) + ',' + JSON.stringify(allowScroll) + ')'
        )
        const r = JSON.parse(out)
        // TG: запоминаем сопоставление пин → числовой peer-id (после первого
        // нахождения по названию дальше матчуем по pid быстро и однозначно)
        if (svc.id === 'tg' && r && r.favs) {
          for (const f of r.favs) {
            // отравленный/устаревший pid — чистим кэш и матчим заново по названию
            if (f.pidStale) { try { delete state.tgPeerOf[f.id] } catch (e) {} ; continue }
            if (f.pid && (!state.tgPeerOf[f.id] || String(state.tgPeerOf[f.id]) === String(f.pid))) {
              const pin = state.cfg.pinned.find(p => p.id === f.id)
              if (pin && tgPidSafe(pin, f.pid, f.rowTitle)) state.tgPeerOf[f.id] = f.pid
            }
          }
        }
        if (!res) res = r
        const useful = r && r.favs && r.favs.some(f => f.time || f.found || (typeof f.rank === 'number' && f.rank < 9999))
        if (useful) { res = r; break }
      } catch {}
    }
    // TG: пины вне видимых строк (другие папки, виртуализация) добываем через
    // ПОИСК webk доверенным вводом — результат сливаем с обычным сбором.
    if (svc.id === 'tg') {
      try {
        const extra = await tgSearchResolve(favs)
        if (extra && extra.favs && extra.favs.length) {
          const byId = new Map(((res && res.favs) || []).map(f => [f.id, f]))
          for (const f of extra.favs) {
            byId.set(f.id, f)
            if (f.pidStale) { try { delete state.tgPeerOf[f.id] } catch (e) {} }
            else if (f.pid && (!state.tgPeerOf[f.id] || String(state.tgPeerOf[f.id]) === String(f.pid))) {
              const pin = state.cfg.pinned.find(p => p.id === f.id)
              if (pin && tgPidSafe(pin, f.pid, f.rowTitle)) state.tgPeerOf[f.id] = f.pid
            }
          }
          res = { favs: Array.from(byId.values()) }
        }
      } catch {}
    }
    if (!res) continue
    let mentions = res.dmMentions || 0     // mm: упоминания во ВСЕХ личных сообщениях
    let unreadChats = res.dmUnread ? 1 : 0
    let countSum = 0
    for (const r of (res.favs || [])) {
      const row = document.querySelector('.chat-row[data-pin="' + r.id + '"]')
      if (row) setRowBadge(row, r)
      if (r.mentions) mentions += r.mentions
      if (r.count) countSum += r.count
      if (r.unread) unreadChats++
      // общая сумма новых сообщений в ИЗБРАННЫХ чатах — на вкладку «★ Сборная»
      favTotal += (r.mentions || 0) + (r.count || 0) + (r.unread ? 1 : 0)
      if (r.mentions) favMention = true
      // активность для сортировки: позиция строки в списке мессенджера
      // (списки TG и MAX сами отсортированы по свежести последних сообщений)
      state.rankAct[r.id] = (typeof r.rank === 'number') ? r.rank : 9999
      // время последнего сообщения — показываем в строке рядом с мессенджером
      // («дата + время») и сортируем по нему («главное — время последней активности»)
      if (r.time) {
        const pt = parseChatTime(r.time)
        if (pt.at) {
          state.lastMsgAt[r.id] = pt.at
          state.lastMsgText[r.id] = fmtChatWhen(pt.at, pt.dayOnly)
        }
      }
      // активность для сортировки: бамп на ПРИРОСТ непрочитанных (в т.ч. в чате,
      // который открыт прямо сейчас — «если туда написали, он поднимается наверх»),
      // но не на первом замере (запас непрочитанных на старте — не «новое сообщение»).
      // Само открытие чата активностью больше НЕ считается — только сообщения
      const total = (r.mentions || 0) + (r.count || 0) + (r.unread ? 1 : 0)
      const prev = state.prevUnread[r.id]
      if (prev !== undefined && total > prev) {
        state.liveAct[r.id] = Date.now()
      }
      state.prevUnread[r.id] = total
    }
    if (svc.id === 'mm') {
      // бейдж вкладки MM — из API (mmTabCounts): два чипа «всего/@упоминаний»;
      // сайдбарные суммы здесь не трогаем (rows уже обновлены выше)
    } else if (mentions > 0) updateBadge(svc.id, '@' + mentions, true)
    else if (countSum > 0) updateBadge(svc.id, String(countSum), false)
    else if (unreadChats > 0) updateBadge(svc.id, String(unreadChats), false)
    else updateBadge(svc.id, '', false)
  }
  // общий счётчик новых сообщений избранного — на вкладке «★ Сборная»,
  // видно не открывая вкладку; красный, если есть @-упоминания
  const cb = document.querySelector('.tab[data-tab="combined"] .badge')
  if (cb) {
    const txt = favTotal > 0 ? String(favTotal) : ''
    cb.textContent = txt
    cb.classList.toggle('on', !!txt)
    cb.classList.toggle('mention', !!txt && favMention)
  }
  // время последнего сообщения в строках: «Мессенджер · 17:30»
  // (в т.ч. MM — из API; полный текст времени — в подсказке)
  for (const p of state.cfg.pinned) {
    const el = document.querySelector('.chat-row[data-pin="' + p.id + '"] .chat-row-svc')
    if (!el) continue
    const svc = state.cfg.services.find(s => s.id === p.serviceId)
    const want = (svc ? svc.name : '?') + (state.lastMsgText[p.id] ? ' · ' + state.lastMsgText[p.id] : '')
    if (el.textContent !== want) el.textContent = want
    el.title = state.lastMsgAt[p.id] ? new Date(state.lastMsgAt[p.id]).toLocaleString('ru-RU') : ''
  }
  sortFavoritesByActivity()
  // П.13: накопленные времена/pid/liveAct — в config.json (дебаунс 20 с),
  // чтобы перезапуск не сбрасывал индексацию активности избранного
  scheduleActSave()
}

// Парсер компактного времени мессенджеров («17:30», «вчера», «пн»/«Tue»,
// «Nov 8»/«11 апр», «12.03») в { at: мс, dayOnly: точность до дня } —
// для сортировки «по давности последней активности» и показа «дата + время».
// Не распозналось — { at: 0 } (не участвует в сортировке).
function parseChatTime(text) {
  const t = String(text || '').trim()
  if (!t) return { at: 0, dayOnly: false }
  const now = new Date()
  let m
  if ((m = t.match(/^(\d{1,2}):(\d{2})$/))) {
    const d = new Date(now); d.setHours(+m[1], +m[2], 0, 0)
    return { at: d.getTime(), dayOnly: false }
  }
  if (/^(вчера|yesterday)$/i.test(t)) {
    const d = new Date(now); d.setDate(d.getDate() - 1); d.setHours(12, 0, 0, 0)
    return { at: d.getTime(), dayOnly: true }
  }
  const ruDays = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
  const enDays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const tl = t.toLowerCase()
  let di = ruDays.findIndex(d => tl === d)
  if (di < 0) { const ei = enDays.findIndex(d => tl.indexOf(d) === 0); if (ei >= 0) di = ei }
  if (di >= 0 && t.length <= 4) {
    // день недели = не сегодня (сегодня показывается как ЧЧ:ММ) — ближайший прошлый
    const d = new Date(now)
    const diff = ((d.getDay() - di) + 7) % 7 || 7
    d.setDate(d.getDate() - diff); d.setHours(12, 0, 0, 0)
    return { at: d.getTime(), dayOnly: true }
  }
  const monRu = ['янв', 'фев', 'мар', 'апр', 'мая', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  const monEn = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const monIdx = w => {
    const wl = w.toLowerCase()
    const ru = monRu.findIndex(x => wl.indexOf(x) === 0)
    if (ru >= 0) return ru
    return monEn.findIndex(x => wl.indexOf(x) === 0)
  }
  if ((m = t.match(/^(\d{1,2})\s+([a-zа-яё]+)\.?$/i)) && monIdx(m[2]) >= 0) {
    const d = new Date(now.getFullYear(), monIdx(m[2]), +m[1], 12, 0, 0)
    if (d > now) d.setFullYear(d.getFullYear() - 1)
    return { at: d.getTime(), dayOnly: true }
  }
  if ((m = t.match(/^([a-zа-яё]+)\.?\s+(\d{1,2})$/i)) && monIdx(m[1]) >= 0) {
    const d = new Date(now.getFullYear(), monIdx(m[1]), +m[2], 12, 0, 0)
    if (d > now) d.setFullYear(d.getFullYear() - 1)
    return { at: d.getTime(), dayOnly: true }
  }
  if ((m = t.match(/^(\d{1,2})\.(\d{2})(?:\.(\d{2,4}))?$/))) {
    const yy = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : now.getFullYear()
    return { at: new Date(yy, +m[2] - 1, +m[1], 12, 0, 0).getTime(), dayOnly: true }
  }
  // webk в en-локали показывает старые даты как «04/18/2025» (ММ/ДД/ГГГГ)
  if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    return { at: new Date(+m[3], +m[1] - 1, +m[2], 12, 0, 0).getTime(), dayOnly: true }
  }
  return { at: 0, dayOnly: false }
}

// Дата + время последнего сообщения для строки: «06.11 14:40»,
// другой год — «28.12.25 14:40»; если мессенджер в списке показал только день
// (без точного времени) — только дату «06.11», без выдуманного времени.
function fmtChatWhen(ms, dayOnly) {
  const d = new Date(ms)
  const n = new Date()
  const pad = x => ('0' + x).slice(-2)
  let s = pad(d.getDate()) + '.' + pad(d.getMonth() + 1)
  if (d.getFullYear() !== n.getFullYear()) s += '.' + String(d.getFullYear()).slice(-2)
  if (!dayOnly) s += ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  return s
}

// Mattermost: в сайдбаре времён нет — время последнего сообщения каждого
// избранного чата читаем из API MM (GET, только чтение; сессия уже в webview).
// Каналы: name = slug; личные: name = «userA__userB» — матчуем по user id
// собеседника (username -> id через /api/v4/users/username/, кэшируется).
// Обновляемся не чаще раза в 30 с.
// п.20: два счётчика вкладки MM из API — всего непрочитанных (msg_count,
// все команды) и упоминаний пользователя (mention_count: личные + @-упоминания).
// Троттлинг 30 с; сбой молчит (бейдж остаётся прежним).
async function mmTabCounts() {
  const now = Date.now()
  if (state.mmTabCountsAt && now - state.mmTabCountsAt < 30000) return
  const wv = svcViewFor('mm')
  if (!wv || !wv.executeJavaScript) return
  try {
    const out = await wv.executeJavaScript('(async () => { try {' +
      ' const r = await fetch("/api/v4/users/me/teams/unread", { headers: { "X-Requested-With": "XMLHttpRequest" } }).then(x => x.json());' +
      ' if (!Array.isArray(r) || !r.length) return "";' +
      ' let t = 0, m = 0;' +
      ' for (const u of r) { t += Number(u.msg_count) || 0; m += Number(u.mention_count) || 0 }' +
      ' return JSON.stringify({ t, m });' +
      ' } catch (e) { return "" } })()')
    if (!out) return
    state.mmTabCountsAt = now
    const c = JSON.parse(out)
    if (typeof c.t === 'number') updateBadgeMM(c.t, c.m)
  } catch {}
}

async function mmLastPosts() {
  const now = Date.now()
  if (state.mmChannelsAt && now - state.mmChannelsAt < 30000) return
  const wv = svcViewFor('mm')
  if (!wv) return
  const mmFavs = favoritesOf('mm')
  if (!mmFavs.length) return
  try {
    const out = await wv.executeJavaScript('(async () => {' +
      ' const H = { "X-Requested-With": "XMLHttpRequest" };' +
      ' try {' +
      ' const teams = await fetch("/api/v4/users/me/teams", { headers: H }).then(r => r.json());' +
      ' if (!Array.isArray(teams) || !teams.length) return "";' +
      // каналы собираем СО ВСЕХ команд MM (у пользователя их несколько:
      // workspad/ispsystem/uveon/rubackup/astralinux — channels/teams[0]
      // не покрывал пины из других команд)
      ' let chs = [];' +
      ' for (const tm of teams) { try { const tc = await fetch("/api/v4/users/me/teams/" + tm.id + "/channels", { headers: H }).then(r => r.json()); if (Array.isArray(tc)) chs = chs.concat(tc) } catch (e) {} }' +
      ' if (!chs.length) return "";' +
      ' const uidCache = ' + JSON.stringify(state.mmUserIds || {}) + ';' +
      ' const jobs = ' + JSON.stringify(mmFavs.map(f => ({ id: f.id, url: f.url }))) + ';' +
      ' for (const j of jobs) {' +
      '   const mm2 = String(j.url).match(/\\/(channels|messages)\\/([^/?#]+)/);' +
      '   if (!mm2 || mm2[1] !== "messages" || mm2[2].charAt(0) !== "@") continue;' +
      '   const u = mm2[2].slice(1);' +
      '   if (uidCache[u]) continue;' +
      '   try { const usr = await fetch("/api/v4/users/username/" + encodeURIComponent(u), { headers: H }).then(r => r.json()); if (usr && usr.id) uidCache[u] = usr.id } catch (e) {}' +
      ' }' +
      ' const res = [];' +
      ' for (const j of jobs) {' +
      '   const mm2 = String(j.url).match(/\\/(channels|messages)\\/([^/?#]+)/);' +
      '   if (!mm2) continue;' +
      '   let ch = null;' +
      '   if (mm2[1] === "messages" && mm2[2].charAt(0) === "@") {' +
      '     const uid = uidCache[mm2[2].slice(1)];' +
      '     if (uid) ch = chs.find(c => c.type === "D" && String(c.name).split("__").indexOf(uid) >= 0);' +
      '   } else { ch = chs.find(c => (c.type === "O" || c.type === "P") && c.name === mm2[2]) }' +
      '   if (ch && ch.last_post_at) res.push({ id: j.id, at: ch.last_post_at });' +
      ' }' +
      ' return JSON.stringify({ uidCache: uidCache, res: res });' +
      ' } catch (e) { return "" }' +
      '})()')
    if (!out) return
    const d = JSON.parse(out)
    state.mmUserIds = d.uidCache || {}
    state.mmChannelsAt = now
    for (const r of (d.res || [])) {
      if (r.at > (state.lastMsgAt[r.id] || 0)) {
        state.lastMsgAt[r.id] = r.at
        state.lastMsgText[r.id] = fmtChatWhen(r.at, false)
      }
    }
  } catch (e) {}
}

// Сортировка избранного сборной вкладки. Главное — время последнего сообщения
// в чате (достаём из списков мессенджеров и API MM); открытие чата активностью
// НЕ считается. Уровни:
//   3 — закреплён 📌 вручную (как в Telegram) — всегда верх;
//   2 — есть время последнего сообщения (или пришли сообщения) — свежее выше;
//   1 — позиция строки в списке мессенджера (TG/MAX сортируют по свежести);
//   0 — порядок добавления.
// Порядок в cfg.pinned меняется только в памяти (на диск не пишем).
function sortFavoritesByActivity() {
  const arr = state.cfg.pinned
  if (!arr || arr.length < 2) return
  const key = (p, i) => {
    // активность = время последнего сообщения; «открыл, но не писал» не бампает
    const act = Math.max(state.lastMsgAt[p.id] || 0, state.liveAct[p.id] || 0)
    if (p.priority) return [3, act, -i]
    if (act) return [2, act, -i]
    const rank = state.rankAct[p.id]
    if (typeof rank === 'number' && rank < 9999) return [1, -rank, -i]
    return [0, 0, -i]
  }
  const before = arr.map(p => p.id).join('|')
  const sorted = arr.map((p, i) => ({ p: p, k: key(p, i) }))
    .sort((a, b) => {
      for (let j = 0; j < 3; j++) { if (a.k[j] !== b.k[j]) return b.k[j] - a.k[j] }
      return 0
    })
    .map(x => x.p)
  if (sorted.map(p => p.id).join('|') !== before) {
    state.cfg.pinned = sorted
    renderChatList()
  }
}

function setRowBadge(row, r) {
  const b = row.querySelector('.row-badge')
  if (!b) return
  const show = (r.mentions || 0) > 0
    ? '@' + r.mentions
    : ((r.count || 0) > 0 ? String(r.count) : (r.unread ? '•' : ''))
  b.classList.toggle('hidden', !show)
  b.textContent = show
  b.classList.toggle('mention', (r.mentions || 0) > 0)
}

/* ---------- код, исполняемый ВНУТРИ страниц мессенджеров ---------- */

// Применение CSS-правил как inline-стилей: обходит CSP и специфичность SPA.
function __chatHubApplyCss(css) {
  const apply = () => {
    for (const rule of String(css).split('}')) {
      const idx = rule.indexOf('{')
      if (idx < 0) continue
      const sels = rule.slice(0, idx).trim()
      const decls = rule.slice(idx + 1).trim()
      if (!sels) continue
      for (const sel of sels.split(',')) {
        let els = []
        try { els = Array.from(document.querySelectorAll(sel)) } catch (e) {}
        for (const el of els) {
          for (const d of decls.split(';')) {
            const m = d.match(/^\s*([-a-zA-Z]+)\s*:\s*(.+?)\s*(!important)?\s*$/)
            if (m) el.style.setProperty(m[1], m[2], m[3] ? 'important' : '')
          }
        }
      }
    }
  }
  apply()
  if (window.__chatHubCssTimer) clearInterval(window.__chatHubCssTimer)
  window.__chatHubCssTimer = setInterval(apply, 3000)
  // SPA (MAX) перерисовывает панель в произвольный момент: между тиками
  // интервала панель успевает «мигнуть». MutationObserver пере-применяет
  // правила сразу после изменения DOM (дебаунс на rAF; в скрытой вьюхе rAF
  // заморожен — там по-прежнему работает интервал выше)
  if (window.__chatHubCssMo) { try { window.__chatHubCssMo.disconnect() } catch (e) {} }
  try {
    let pending = false
    window.__chatHubCssMo = new MutationObserver(() => {
      if (pending) return
      pending = true
      const go = () => { pending = false; apply() }
      requestAnimationFrame(go)
      setTimeout(go, 100)
    })
    window.__chatHubCssMo.observe(document.documentElement, { childList: true, subtree: true })
  } catch (e) {}
  return true
}

// Mattermost: непрочитанные избранных каналов + ВСЕ личные сообщения.
// li.unread = есть непрочитанное; в ЛИЧНЫХ чатах span.badge = число непрочитанных
// сообщений (идёт в count), в каналах = число упоминаний (идёт в mentions).
function __chatHubMmUnread(favs) {
  const out = []
  let dmMentions = 0
  let dmUnread = false
  const root = document.querySelector('#SidebarContainer') || document
  for (const a of root.querySelectorAll('a[href*="/messages/"]')) {
    const li = a.closest('li')
    if (!li) continue
    const b = li.querySelector('.badge')
    const n = b ? parseInt(b.textContent, 10) || 0 : 0
    if (n > 0) dmMentions += n
    if (n > 0 || li.classList.contains('unread')) dmUnread = true
  }
  for (const f of favs) {
    const m = String(f.url).match(/\/(channels|messages)\/([^/?#]+)/) || []
    const kind = m[1]
    const slug = m[2]
    let unread = false
    let count = null
    let mentions = 0
    let found = false
    if (slug) {
      const link = root.querySelector('a[href$="/' + kind + '/' + slug + '"]')
      const li = link ? link.closest('li') : null
      if (li) {
        found = true
        if (li.classList.contains('unread')) unread = true
        const b = li.querySelector('.badge')
        const n = (b && !/dot/.test(String(b.className))) ? (parseInt(b.textContent, 10) || 0) : 0
        if (kind === 'messages') {
          count = n > 0 ? n : null      // личный чат: бейдж = число новых сообщений
          if (n > 0) unread = true
        } else {
          mentions = n                  // канал: бейдж = число упоминаний
          if (mentions > 0) unread = true
        }
      }
    }
    out.push({ id: f.id, unread: unread, count: count, mentions: mentions, found: found })
  }
  return JSON.stringify({ favs: out, dmMentions: dmMentions, dmUnread: dmUnread })
}

// Telegram (webk): список диалогов виртуализирован и разбит по папкам — в DOM видимых
// строк мало, а закреплённые чаты часто ниже первого экрана. Поэтому: (1) собираем
// все отрендеренные строки; (2) если вкладка сейчас не у пользователя на глазах —
// прокручиваем список до конца и обратно, собирая строки по мере подгрузки
// (полный скан не чаще раза в 20 с — прокрутка заметна); (3) сопоставляем пины
// по числовому peer-id из URL (#-5505486531) и по названию: точное → без
// пунктуации/регистра → вхождение с любой стороны (пины бывают с полным именем
// из шапки, строки — с коротким), при неоднозначности не матчуем.
async function __chatHubTgUnread(favs, allowScroll) {
  const parseN = s => {
    const m = String(s || '').trim().match(/^([\d.,]+)\s*([KКММ]?)/i)
    if (!m) return 0
    let n = parseFloat(m[1].replace(',', '.'))
    if (/^[KК]$/i.test(m[2])) n *= 1000
    if (/^[МM]$/i.test(m[2])) n *= 1000000
    return Math.round(n)
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const collect = () => {
    const list = []
    // только реальные строки диалогов (a[href^="#"]); служебные строки —
    // archive-dialog, предложения подарков — пропускаем. Время — .message-time
    // (обёртка .dialog-time-pill есть лишь у закреплённых, у остальных нет).
    document.querySelectorAll('a.row-clickable[href^="#"]').forEach((r, idx) => {
      const t = r.querySelector('.peer-title')
      if (!t) return
      const pid = r.getAttribute('data-peer-id') || t.getAttribute('data-peer-id') || ''
      const title = t.textContent.trim()
      if (!pid || !title) return
      const tp = r.querySelector('.message-time')
      const bd = r.querySelector('.dialog-subtitle-badge-unread')
      let mentions = 0
      if (bd) {
        const rgb = (getComputedStyle(bd).backgroundColor.match(/\d+/g) || []).map(Number)
        if (String(bd.className).indexOf('danger') >= 0 || (rgb.length > 2 && rgb[0] > 170 && rgb[1] < 110)) {
          mentions = parseN(bd.textContent) || 1
        }
      }
      list.push({
        pid: pid,
        title: title,
        time: tp ? tp.textContent.trim() : '',
        unreadTxt: bd ? bd.textContent.trim() : '',
        mentions: mentions,
        unreadTitle: /unreadPeerTitle/.test(String(t.className)),
        idx: idx
      })
    })
    return list
  }
  const seen = new Map()
  collect().forEach(x => { if (!seen.has(x.pid)) seen.set(x.pid, x) })
  const rows = Array.from(seen.values())
  const norm = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '')
  const out = []
  for (const f of favs) {
    // pid: сначала из кэша сопоставлений (state.tgPeerOf — проброшен сюда),
    // затем числовой из URL (#-5505486531); #@имя — по названию строки
    const pid = f.pid || (String(f.url).match(/#(-?\d+)/) || [])[1] || ''
    let row = pid ? (rows.find(x => x.pid === pid) || null) : null
    // Самоочистка отравленного pid-кэша: строка по pid найдена, но заголовок
    // не пересекается с заголовком пина (ни одного слова >= 4 символов) и pid
    // не из URL пина — кэш устарел/ошибочен, строку не засчитываем
    let pidStale = false
    if (row) {
      const upid = (String(f.url || '').match(/#(-?\d+)/) || [])[1]
      const urlExact = upid && String(upid) === String(row.pid)
      if (f.pid && !urlExact) {
        const ns = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '')
        const stopW = new Set(['ext', 'int', 'астра', 'astrа', 'astra', 'chat', 'чат', 'группа', 'team', 'test', 'rb', 'vm'])
        const ws = String(f.title || '').split(/[\s|,/()]+/).map(w => ns(w)).filter(w => w.length >= 4 && !stopW.has(w))
        const rn = ns(row.title)
        const ok = !!rn && ws.some(w => rn.indexOf(w) >= 0)
        if (!ok) { pidStale = true; row = null }
      }
    }
    if (!row && f.title) {
      const ft = String(f.title).trim()
      let cands = rows.filter(x => x.title.trim() === ft)
      if (!cands.length) {
        const nt = norm(ft)
        // прямое вхождение (пин ⊂ строка) — обрезанные заголовки пинов;
        // обратное (строка ⊂ пин) — только для строк из >= 2 слов: одиночное
        // имя («Евгений», «Дмитрий») матчило ЛЮБОЙ пин с этим именем внутри
        if (nt) cands = rows.filter(x => { const n = norm(x.title); return n && (n.indexOf(nt) >= 0 || (n.length >= 4 && x.title.trim().indexOf(' ') >= 0 && nt.indexOf(n) >= 0)) })
      }
      if (!cands.length) {
        // пословный fallback: заголовок пина может нести префикс/суффикс
        // («Астра …», «EXT | …»), которого нет в строке TG
        const stop = new Set(['ext', 'int', 'астра', 'astrа', 'astra', 'chat', 'чат', 'группа', 'team', 'test', 'rb', 'vm', 'все'])
        const words = ft.split(/[\s|,/()]+/).map(w => norm(w)).filter(w => w.length >= 3 && !stop.has(w))
        if (words.length) cands = rows.filter(x => { const n = norm(x.title); return n && words.every(w => n.indexOf(w) >= 0) })
      }
      if (cands.length === 1) row = cands[0]
      else if (cands.length > 1) {
        cands.sort((a, b) => b.title.length - a.title.length)
        const bn = norm(cands[0].title)
        if (cands.filter(c => norm(c.title) === bn).length === 1) row = cands[0]
      }
    }
    let unread = false
    let count = 0
    let mentions = 0
    let rank = 9999
    let time = null
    let found = false
    if (row) {
      found = true
      rank = row.idx
      if (row.time) time = row.time
      count = parseN(row.unreadTxt)
      mentions = row.mentions
      if (count > 0 || row.unreadTitle) unread = true
    }
    out.push({ id: f.id, unread: unread, count: count, mentions: mentions, rank: rank, time: time, found: found, pid: row ? row.pid : null, rowTitle: row ? row.title : '', pidStale: pidStale })
  }
  return JSON.stringify({ favs: out })
}

// MAX: строка чата по названию (span.name — НЕ span.text, это текст последнего
// сообщения), число в строке = непрочитанные (упоминаний не видно).
// Позиция строки = активность: список MAX отсортирован по свежести.
function __chatHubMaxUnread(favs) {
  const out = []
  const items = Array.from(document.querySelectorAll('aside div.item'))
  const nameOf = item => {
    const el = item.querySelector('span.name') || item.querySelector('h3.title')
    return el ? el.textContent.trim() : ''
  }
  for (const f of favs) {
    let unread = false
    let count = 0
    let rank = 9999
    let time = null
    const idx = items.findIndex(item => nameOf(item) === String(f.title).trim())
    if (idx >= 0) {
      rank = idx
      // время последнего сообщения («17:30», «пн», «Nov 8»)
      const meta = items[idx].querySelector('.meta')
      if (meta) time = meta.textContent.trim()
      for (const sp of items[idx].querySelectorAll('span')) {
        const txt = (sp.textContent || '').trim()
        if (/^\d+$/.test(txt)) { count = parseInt(txt, 10); unread = true }
      }
    }
    out.push({ id: f.id, unread: unread, count: count, mentions: 0, rank: rank, time: time })
  }
  return JSON.stringify({ favs: out })
}

// Яндекс Чат (Телемост): строки списка .yamb-chat-list-item, имя —
// .yamb-chat-list-item__name, время последнего сообщения — .ui-entity-block-date.
// Непрочитанные: контейнер .yamb-chat-list-item__badges — при непрочитанных
// туда рендерится бейдж с числом (aria-labelledby строки ссылается на
// элемент «<id>_unread», в DOM он появляется только с бейджем).
function __chatHubYdxUnread(favs) {
  const out = []
  const items = Array.from(document.querySelectorAll('.yamb-chat-list-item'))
  const norm = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '')
  for (const f of favs) {
    let rank = 9999
    let time = null
    let unread = false
    let count = 0
    const ft = norm(f.title)
    const idx = items.findIndex(it => {
      const el = it.querySelector('.yamb-chat-list-item__name')
      const n = norm(el ? el.textContent : '')
      return n && ft && (n.indexOf(ft) >= 0 || ft.indexOf(n) >= 0)
    })
    if (idx >= 0) {
      rank = idx
      const tEl = items[idx].querySelector('.ui-entity-block-date')
      if (tEl) time = tEl.textContent.trim()
      const badges = items[idx].querySelector('.yamb-chat-list-item__badges')
      if (badges) {
        const txt = (badges.textContent || '').trim()
        if (txt) {
          const n = parseInt(txt.replace(/\D+/g, ''), 10)
          if (n > 0) { count = n; unread = true }
          else unread = true // нечисловой бейдж (точка/иконка «есть новое»)
        }
      }
    }
    out.push({ id: f.id, unread: unread, count: count, mentions: 0, rank: rank, time: time })
  }
  return JSON.stringify({ favs: out })
}

/* ---------- настройка вида чата справа (CSS + зум) ---------- */

async function applyColumnTweaks(wv, p, attempt) {
  attempt = attempt || 0
  const svc = state.cfg.services.find(s => s.id === p.serviceId)
  if (!svc) return
  const css = String((state.cfg.columnCss || {})[svc.id] || '').trim()
  if (css) {
    // webview.insertCSS в Electron не доходит до гостевой страницы, а <style>-тег
    // проигрывает собственным стилям SPA — применяем правила как inline-стили
    // (работает вопреки CSP) и обновляем их периодически внутри самой страницы
    try {
      await wv.executeJavaScript('(' + __chatHubApplyCss.toString() + ')(' + JSON.stringify(css) + ')')
    } catch {}
    // несколько повторных попыток: обработчик может сработать раньше отрисовки SPA
    if (attempt < 4) setTimeout(() => applyColumnTweaks(wv, p, attempt + 1), 2500)
  }
  const z = Number((state.cfg.zoom || {})[svc.id] || 1)
  if (z && z !== 1) { try { wv.setZoomFactor(z) } catch {} }
  // обновляем имя чата, если мессенджер знает название лучше нас;
  // переименовываем только когда webview действительно показывает этот чат (защита от гонки),
  // в TG имя берём из строки списка, а не из отстающей шапки
  try {
    // MAX не переименовываем: надёжного селектора имени нет, document.title
    // при загрузке — «Веб-версия MAX». Телемост переименовываем: имя открытого
    // чата читается из шапки области чата (.yamb-chat-bar) — это надёжно.
    if (svc.id !== 'max') {
      const name = await getChatNameFor(svc.id, wv, p.url)
      // мусорные названия (заголовок вкладки мессенджера, экран «Присоединиться
      // к команде» — общий заголовок команды Mattermost) не записываем
      const nm = String(name || '').trim()
      const generic = /^(telegram web|веб-версия max|mattermost|max|чаты|чат|новый чат|messenger|dialogs)$/i.test(nm)
        || /^astra team chat/i.test(nm) || /присоедин[ися]*\s*к\s*команд/i.test(nm)
      if (name && !generic && name !== p.title && pinMatches(p, svc, wv.getURL(), name)) {
        p.title = name
        const t = document.querySelector('.chat-row[data-pin="' + p.id + '"] .chat-row-title')
        if (t) { t.textContent = name; t.title = p.url }
        const h = document.querySelector('#view-head .view-title')
        if (h && state.cfg.selectedPinId === p.id) { h.textContent = name; h.title = p.url }
        window.hub.saveConfig(state.cfg)
      }
    }
  } catch {}
}

/* ---------- настройки ---------- */

function buildSettings(sec) {
  sec.innerHTML = `
    <div class="settings">
      <h2>⚙ Настройки</h2>
      <p class="hint">Файл конфигурации: <code id="cfg-path"></code></p>

      <h3>Мессенджеры (вкладки)</h3>
      <div id="svc-rows"></div>
      <button class="btn" id="add-svc">+ Добавить мессенджер</button>

      <h3>Сборная вкладка: скрыть лишнее (CSS)</h3>
      <p class="hint">Применяется только к чату справа в сборной вкладке — прячем боковые панели,
      остаётся лента чата с полем ввода. На вкладки мессенджеров не влияет.</p>
      <div id="css-rows"></div>

      <h3>Масштаб</h3>
      <div id="zoom-rows"></div>

      <h3>Память</h3>
      <p class="hint">Сколько чатов избранного держать загруженными (мгновенное открытие).
      Каждый загруженный чат — процесс мессенджера (~150-250 МБ). Остальные чаты
      открываются с загрузкой за пару секунд, давно не открывавшиеся выгружаются.</p>
      <div class="form-row">
        <label>Чатов в памяти: <b id="live-views-label"></b></label>
        <input type="range" id="live-views" min="2" max="20" step="1" style="flex:1">
      </div>

      <h3>Индексация Telegram</h3>
      <p class="hint">Обновление «времени последнего сообщения» у пинов Telegram: приложение
      ищет чаты и читает список диалогов ТОЛЬКО когда окно свёрнуто и неактивно.
      <b>По умолчанию выключено</b> — включайте, если хотите свежие времена у пинов
      в фоне. Активное окно не трогается никогда.</p>
      <div class="form-row">
        <label style="flex:1"><input type="checkbox" id="tg-bg-index"> Фоновая индексация Telegram</label>
      </div>

      <h3>Избранное</h3>
      <div id="pin-rows"></div>

      <div class="settings-actions">
        <button class="btn primary" id="save-settings">💾 Сохранить и перезапустить</button>
        <button class="btn danger" id="reset-pins">Очистить избранное</button>
      </div>
    </div>`

  window.hub.configPath().then(p => {
    const el = document.getElementById('cfg-path')
    if (el) el.textContent = p
  })

  renderSvcRows()
  renderCssRows()
  renderZoomRows()
  renderPinRows()

  // ползунок «чатов в памяти» (LRU): применяется сразу, без перезапуска
  const lvSlider = document.getElementById('live-views')
  const lvLabel = document.getElementById('live-views-label')
  if (lvSlider && lvLabel) {
    const show = n => { lvLabel.textContent = n }
    lvSlider.min = '2'; lvSlider.max = '20'
    lvSlider.value = String(maxLiveViews())
    show(maxLiveViews())
    lvSlider.oninput = async () => {
      const n = Math.max(2, Math.min(20, parseInt(lvSlider.value, 10) || 8))
      show(n)
      state.cfg.maxLiveViews = n
      await window.hub.saveConfig(state.cfg)
      trimPinViews(state.cfg.selectedPinId)
      renderChatList()
    }
  }

  // тумблер «фоновая индексация Telegram» — применяется сразу, без перезапуска
  const tgBg = document.getElementById('tg-bg-index')
  if (tgBg) {
    tgBg.checked = state.cfg.tgBackgroundIndex === true
    tgBg.onchange = async () => {
      state.cfg.tgBackgroundIndex = tgBg.checked
      await window.hub.saveConfig(state.cfg)
      toast(tgBg.checked ? 'Фоновая индексация включена' : 'Фоновая индексация Telegram выключена')
    }
  }

  document.getElementById('add-svc').onclick = () => {
    const id = 's' + Date.now()
    state.cfg.services.push({ id, name: 'Новый мессенджер', url: 'https://', partition: 'persist:' + id, proxy: '' })
    state.cfg.columnCss[id] = ''
    state.cfg.zoom[id] = 1
    renderSvcRows(); renderCssRows(); renderZoomRows()
  }
  document.getElementById('save-settings').onclick = async () => {
    await window.hub.saveConfig(state.cfg)
    toast('Сохранено, перезапускаю…')
    setTimeout(() => window.location.reload(), 700)
  }
  document.getElementById('reset-pins').onclick = async () => {
    if (!confirm('Убрать все чаты из избранного?')) return
    state.cfg.pinned = []
    state.cfg.selectedPinId = ''
    await window.hub.saveConfig(state.cfg)
    renderPinRows()
  }
}

function renderSvcRows() {
  const host = document.getElementById('svc-rows')
  if (!host) return
  host.innerHTML = ''
  state.cfg.services.forEach((s, i) => {
    const row = document.createElement('div')
    row.className = 'form-row'
    row.innerHTML = `
      <input class="f-name" placeholder="Название">
      <input class="f-url" placeholder="https://…">
      <input class="f-proxy" placeholder="прокси (пусто = напрямую). Напр. http://127.0.0.1:18888">
      <button class="icon-btn del" title="Удалить мессенджер">🗑</button>`
    row.querySelector('.f-name').value = s.name
    row.querySelector('.f-url').value = s.url
    row.querySelector('.f-proxy').value = s.proxy || ''
    row.querySelector('.f-name').oninput = e => { s.name = e.target.value }
    row.querySelector('.f-url').oninput = e => { s.url = e.target.value }
    row.querySelector('.f-proxy').oninput = e => { s.proxy = e.target.value.trim() }
    row.querySelector('.del').onclick = () => {
      if (!confirm('Удалить «' + s.name + '» вместе с его избранными чатами?')) return
      state.cfg.services.splice(i, 1)
      state.cfg.pinned = state.cfg.pinned.filter(p => p.serviceId !== s.id)
      renderSvcRows(); renderCssRows(); renderZoomRows(); renderPinRows()
    }
    host.appendChild(row)
  })
}

function renderCssRows() {
  const host = document.getElementById('css-rows')
  if (!host) return
  host.innerHTML = ''
  for (const s of state.cfg.services) {
    const row = document.createElement('div')
    row.className = 'css-row'
    const label = document.createElement('label')
    label.textContent = s.name
    const ta = document.createElement('textarea')
    ta.rows = 2
    ta.spellcheck = false
    ta.placeholder = 'например: .sidebar{display:none!important}'
    ta.value = state.cfg.columnCss[s.id] || ''
    ta.oninput = () => { state.cfg.columnCss[s.id] = ta.value }
    row.appendChild(label)
    row.appendChild(ta)
    host.appendChild(row)
  }
}

function renderZoomRows() {
  const host = document.getElementById('zoom-rows')
  if (!host) return
  host.innerHTML = ''
  for (const s of state.cfg.services) {
    const row = document.createElement('div')
    row.className = 'form-row'
    const label = document.createElement('span')
    label.className = 'zoom-label'
    label.textContent = s.name
    const inp = document.createElement('input')
    inp.type = 'number'
    inp.min = '0.5'
    inp.max = '1.6'
    inp.step = '0.05'
    inp.value = state.cfg.zoom[s.id] || 1
    inp.oninput = () => { state.cfg.zoom[s.id] = Number(inp.value) || 1 }
    row.appendChild(label)
    row.appendChild(inp)
    host.appendChild(row)
  }
}

function renderPinRows() {
  const host = document.getElementById('pin-rows')
  if (!host) return
  host.innerHTML = ''
  if (!state.cfg.pinned.length) {
    host.innerHTML = '<p class="hint">Пока ничего в избранном.</p>'
    return
  }
  state.cfg.pinned.forEach((p, i) => {
    const row = document.createElement('div')
    row.className = 'form-row'
    row.innerHTML = `
      <span class="pin-idx"></span>
      <input class="f-title" placeholder="Название чата">
      <input class="f-url" readonly>
      <button class="icon-btn del" title="Убрать">✕</button>`
    row.querySelector('.pin-idx').textContent = (i + 1) + '.'
    row.querySelector('.f-title').value = p.title
    row.querySelector('.f-url').value = p.url
    row.querySelector('.f-title').oninput = e => { p.title = e.target.value }
    row.querySelector('.del').onclick = () => {
      state.cfg.pinned.splice(i, 1)
      renderPinRows()
    }
    host.appendChild(row)
  })
}

/* ---------- утилиты ---------- */

function badgeColor(name) {
  let h = 0
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360
  return 'hsl(' + h + ' 55% 42%)'
}

const escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

let toastTimer = null
function toast(msg) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600)
}
