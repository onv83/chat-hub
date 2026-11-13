/* ChatHub — renderer
   Вкладки мессенджеров (живые веб-версии) + «сборная вкладка» —
   классический мессенджер: слева список избранного, справа содержание чата.
   Непрочитанные: красный бейдж-счётчик; упоминания (@) — отдельным стилем. */

const state = {
  cfg: null,
  activePinId: '',     // session-only: restored config must never open a chat
  svcViews: {},        // serviceId -> <webview> вкладки мессенджера
  pinViews: {},        // pinId -> <webview> этого чата: гружен заранее, открытие мгновенное
  combinedBuilt: false,
  liveAct: {},         // pinId -> Date.now() всплеска активности (пришли сообщения)
  lastMsgPreview: {},  // pinId -> текст последнего сообщения (превью в строке)
  msgAuth: {},         // pinId -> {text,out,name}: авторство, выученное из открытого чата
  rankAct: {},         // pinId -> позиция строки в списке мессенджера (меньше = свежее; 9999 = не в списке)
  prevUnread: {},      // pinId -> прошлое число непрочитанных (детект новых сообщений)
  unreadBaseC: {},     // pinId -> база count «новых» (сохраняется в cfg.activity)
  unreadBaseM: {},     // pinId -> база mentions «новых» (сохраняется в cfg.activity)
  unreadTotals: {},    // pinId -> последние достоверные {c,m} непрочитанных
  lastUsed: {},        // pinId -> Date.now() последнего открытия (для вытеснения неактивных вьюх)
  svcIcons: {},        // serviceId -> data URL фирменной иконки мессенджера (favicon)
  lastMsgAt: {},       // pinId -> время последнего сообщения в чате (мс) — сортировка «главное — активность»
  lastMsgText: {},     // pinId -> компактный текст времени для строки («17:30», «пн», «12.03»)
  mmUserIds: {},       // username Mattermost -> user id (для мэтчинга DM-каналов по API)
  mmChannelsAt: 0,     // когда последний раз читали last_post_at через API MM
  tgPeerOf: {},        // TG pinId -> числовой peer-id (однозначное сопоставление строк)
  unreadTotalsAt: {},  // pinId -> Date.now() последнего достоверного замера непрочитанных
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
  tg: ['.top .user-title .peer-title', '.top .peer-title', '.topbar .peer-title', '.chat-info .peer-title'],
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

// Аватарка чата из строки списка мессенджера: <img> строки или
// background-image у аватар-элемента; конвертируется в data-URL ВНУТРИ
// webview (сессия/относительные URL недоступны шеллу). Определяется в
// шелле и пробрасывается в экстракторы обёрткой в pollUnread.
function __chatHubGrabAvatar(el) {
  return (async () => {
    try {
      if (!el) return null
      // 1) Телемост: у чатов без фото аватар — монограмма (буквы на цветном
      //    кругу). Собираем её в SVG data-URL — выглядит как в самом Телемосте.
      const mono = el.querySelector('.Orb-UserPic-Monogram, [class*="onogram"]')
      if (mono) {
        const color = getComputedStyle(mono).backgroundColor
        const text = (mono.textContent || '').trim()
        if (color && color !== 'rgba(0, 0, 0, 0)' && text) {
          const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
          const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" rx="36" fill="' + esc(color) + '"/><text x="36" y="47" font-family="sans-serif" font-size="26" font-weight="600" fill="#fff" text-anchor="middle">' + esc(text.slice(0, 2)) + '</text></svg>'
          return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
        }
      }
      // 1b) Telegram: аватар чата без фото — div.dialog-avatar с
      //     linear-gradient и буквами ПРЯМО в тексте узла («О», «Пм»).
      //     Собираем SVG: круг цветом первого стопа градиента + буквы.
      const tgAv = el.querySelector('.dialog-avatar')
      if (tgAv && !tgAv.querySelector('img')) {
        const bg = getComputedStyle(tgAv).backgroundImage || ''
        const bgc = getComputedStyle(tgAv).backgroundColor || ''
        const cm = bg.match(/rgba?\([^)]+\)/)
        const ct = (tgAv.textContent || '').trim()
        // цвет: стоп градиента → background-color → палитра по хэшу текста.
        // Раньше при непарсинге в SVG попадал "undefined" и кружок был прозрачный.
        const palette = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774']
        let col = cm ? cm[1] : ''
        if (!col && bgc && bgc !== 'rgba(0, 0, 0, 0)' && bgc !== 'transparent') col = bgc
        if (!col) { let hsh = 0; for (const ch of ct) hsh = (hsh * 31 + ch.charCodeAt(0)) | 0; col = palette[Math.abs(hsh) % palette.length] }
        if (!/^(#|rgba?\()/.test(col)) col = palette[0]
        if (ct) {
          const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
          const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" rx="36" fill="' + esc(col) + '"/><text x="36" y="47" font-family="sans-serif" font-size="26" font-weight="600" fill="#fff" text-anchor="middle">' + esc(ct.slice(0, 2)) + '</text></svg>'
          return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
        }
      }
      // 2) картинка строки: ищем аватарный <img> (не первую попавшуюся
      //    иконку-эмодзи) — классы аватаров мессенджеров или первый img
      //    достаточно крупный
      const imgs = Array.from(el.querySelectorAll('img'))
      let img = imgs.find(i => /avatar|photo|userpic/i.test(String(i.className))) || imgs.find(i => i.naturalWidth >= 24)
      const readImageData = async src => {
        try {
          const blob = await fetch(src).then(r => r.blob())
          if (blob && blob.size && blob.size < 300000) {
            const d = await new Promise(res => {
              const fr = new FileReader()
              fr.onload = () => res(fr.result)
              fr.onerror = () => res(null)
              fr.readAsDataURL(blob)
            })
            if (d) return d
          }
        } catch (e) {}
        return null
      }
      // Mattermost keeps sidebar photos loading="lazy" while its service
      // view is hidden. Waiting for the viewport load event never completes;
      // same-origin fetch is safe and does not open/read a chat.
      let lazySameOrigin = false
      try { lazySameOrigin = !!(img && !img.complete && img.loading === 'lazy' && img.src && new URL(img.src, location.href).origin === location.origin) } catch (e) {}
      if (lazySameOrigin) {
        const eager = await readImageData(img.src)
        if (eager) return eager
      }
      // webk лениво грузит аватарки: сразу после прокрутки img ещё пуст —
      // ждём загрузку, иначе нижние чаты оставались без фото
      if (img && !img.complete) {
        await new Promise(res => {
          let done = false
          const fin = () => {
            if (done) return
            done = true
            img.removeEventListener('load', fin)
            img.removeEventListener('error', fin)
            clearTimeout(to)
            res()
          }
          const to = setTimeout(fin, 900)
          img.addEventListener('load', fin)
          img.addEventListener('error', fin)
        })
      }
      if (!img || !img.src) {
        const bgEl = el.querySelector('.dialog-avatar, .UserPic, .Orb-UserPic, .avatar, [class*="avatar"]')
        if (bgEl) {
          const m = String(getComputedStyle(bgEl).backgroundImage || '').match(/url\(["']?(.+?)["']?\)/)
          if (m && m[1] && m[1] !== 'none' && m[1].startsWith('data:')) return m[1]
        }
        return null
      }
      if (img.src.startsWith('data:')) return img.src
      // 3) fetch → data-URL (blob: у TG, same-origin, CORS-дружелюбные CDN)
      const fetched = await readImageData(img.src)
      if (fetched) return fetched
      // 4) canvas: рисуем УЖЕ загруженный <img> (blob: у TG — чистый источник)
      try {
        const c = document.createElement('canvas')
        c.width = img.naturalWidth || 64; c.height = img.naturalHeight || 64
        c.getContext('2d').drawImage(img, 0, 0)
        return c.toDataURL('image/jpeg', 0.85)
      } catch (e) {}
      // 5) кросс-доменный CDN (MAX: i.oneme.ru): перезагружаем копию с
      //    crossOrigin=anonymous — если сервер отдаёт ACAO, canvas чист
      try {
        const d = await new Promise(res => {
          const im = new Image()
          im.crossOrigin = 'anonymous'
          let done = false
          const finish = value => {
            if (done) return
            done = true
            clearTimeout(to)
            im.onload = im.onerror = null
            res(value)
          }
          const to = setTimeout(() => finish(null), 4000)
          im.onload = () => {
            if (done) return
            try {
              const c = document.createElement('canvas')
              c.width = im.naturalWidth || 64; c.height = im.naturalHeight || 64
              c.getContext('2d').drawImage(im, 0, 0)
              finish(c.toDataURL('image/jpeg', 0.85))
            } catch (e) { finish(null) }
          }
          im.onerror = () => finish(null)
          im.src = img.src
        })
        if (d) return d
      } catch (e) {}
      return null
    } catch (e) { return null }
  })()
}

init()

async function init() {
  state.cfg = await window.hub.getConfig()
  state.activePinId = ''
  ensureKeys(state.cfg)
  // Активность уже восстановлена из cfg.activity; сортируем ДО первой
  // отрисовки «Сборной», иначе Telegram догоняет порядок только после
  // первого фонового pollUnread (через несколько секунд после старта).
  sortFavoritesByActivity()
  buildTabs()
  applyTheme()
  applyLayout()
  applyBadgeVisibility()
  refreshTabIcons()
  activateTab('combined')
  initListSplitter()
  // вкладки мессенджеров грузим сразу при старте (панели скрыты через visibility,
  // но разложены — webview правильного размера): переключение вкладки мгновенное.
  // deferSrc + очередь — чтобы 4 мессенджера не стартовали одновременно
  for (const svc of state.cfg.services) {
    const id = 'svc:' + svc.id
    if (!document.querySelector('section[data-tab="' + id + '"]')) {
      document.getElementById('content').appendChild(buildSection(id, true))
      // Очередь отбрасывает отсоединённые webview: сначала добавляем секцию в DOM.
      enqueueLoad(state.svcViews[svc.id], initialSvcUrl(svc))
    }
  }
  document.addEventListener('click', (e) => { if (!e.target.closest('.fav-menu-wrap')) closeAllFavMenus() })
  // активность пользователя: поисковые проходы TG (требуют фокуса) — только в простое
  ;['keydown', 'mousedown', 'wheel'].forEach(ev =>
    document.addEventListener(ev, () => { state.lastUserInput = Date.now() }, { passive: true, capture: true }))
  setInterval(() => pollUnread().catch(() => {}), 5000)
  // MAX-вкладка в фоне иногда перестаёт обновлять список сама: периодически
  // перезагружаем её, только когда пользователь её не смотрит. Это НЕ открытие
  // чатов — непрочитанные не снимаются, зато превью и счётчики не застаиваются.
  setInterval(() => {
    try {
      const wv = state.svcViews.max
      const pane = document.querySelector('section[data-tab="svc:max"]')
      if (!wv || (pane && pane.classList.contains('visible'))) return
      wv.reload()
    } catch (e) {}
  }, 60000)
  // Универсальное выучивание авторства: каждая личка без известного автора
  // один раз открывается в скрытой пин-вьюхе, читается последний пузырь
  // (is-out → «Вы:»), результат запоминается навсегда (msgAuth в конфиге).
  // Автооткрытие чатов для выучивания авторства ОТКЛЮЧЕНО: скрытая вьюха
  // тоже может отметить чат прочитанным. Учимся только на уже открытых вьюхах.
  // setInterval(() => learnAuthorSweep().catch(() => {}), 8000)
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
    const svc = state.cfg.services.find(s => s.id === 'tg')
    if (!wv || !svc) return
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
        if (tgHealTries >= 3) return
        tgHealTries++
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
        nv.setAttribute('src', initialSvcUrl(svc))
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

// Never infer incoming authors from a chat title or replace preview text.
// When either side carries identity, both must agree; legacy text-only caches
// can enrich an exact unprefixed body, never a substring or an authored preview.
function restorePreviewAuthor(preview, author, messageId) {
  const text = String(preview || '')
  if (!author || !author.text || text !== String(author.text)) return text
  if ((messageId != null || author.messageId != null) &&
      (messageId == null || author.messageId == null || String(messageId) !== String(author.messageId))) return text
  const name = author.out === true ? 'Вы' : (author.out === false ? String(author.name || '').trim() : '')
  return name ? name + ': ' + text : text
}

function ensureKeys(cfg) {
  if (!cfg.services) cfg.services = []
  if (!cfg.columnCss) cfg.columnCss = {}
  if (!cfg.zoom) cfg.zoom = {}
  if (!cfg.pinned) cfg.pinned = []
  // П.13: восстановление накопленной активности прошлой сессии — времена
  // последних сообщений, pid-кэш TG и исчерпанность свипа переживают
  // перезапуск; список сразу отсортирован правильно, без 10 мин проходов
  if (!state.activityRestored) {
    state.activityRestored = true
    const A = cfg.activity || {}
    const merge = (dst, src) => { if (src && typeof src === 'object') for (const k of Object.keys(src)) { try { dst[k] = src[k] } catch (e) {} } }
    merge(state.lastMsgAt, A.lastMsgAt)
    state.lastMsgDayOnly = state.lastMsgDayOnly || {}
    merge(state.lastMsgDayOnly, A.lastMsgDayOnly)
    state.lastMsgSource = state.lastMsgSource || {}
    merge(state.lastMsgSource, A.lastMsgSource)
    merge(state.lastMsgText, A.lastMsgText)
    merge(state.lastMsgPreview, A.lastMsgPreview)
    merge(state.msgAuth, A.msgAuth)
    // The preview is authoritative; cached authors may enrich only the same message.
    for (const k of Object.keys(state.lastMsgPreview)) {
      state.lastMsgPreview[k] = restorePreviewAuthor(state.lastMsgPreview[k], (state.msgAuth || {})[k])
    }
    merge(state.liveAct, A.liveAct)
    // liveAct — время сообщения, а не момент обнаружения: старые значения
    // Date.now() нормализуем к lastMsgAt, иначе старые чаты всплывают наверх
    for (const k of Object.keys(state.liveAct)) {
      const msgAt = state.lastMsgAt[k] || 0
      if (msgAt && state.liveAct[k] > msgAt) state.liveAct[k] = msgAt
    }
    merge(state.tgPeerOf, A.tgPeerOf)
    merge(state.prevUnread, A.prevUnread)
    // база «новых» непрочитанных переживает перезапуск: без неё после
    // рестарта первый замер принимал весь запас за базу и счётчик пропадал
    merge(state.unreadBaseC, A.unreadBaseC)
    merge(state.unreadBaseM, A.unreadBaseM)
    for (const key of ['unreadTotals', 'unreadTotalsAt', 'unreadDots', 'svcTabTotals']) {
      state[key] = state[key] || {}
      merge(state[key], A[key])
    }
    if (A.tgScrollDone) tgScrollDone = true
    console.log('[hub] активность восстановлена из конфига:', Object.keys(A.lastMsgAt || {}).length, 'времён')
  }
  // РАЗОВЫЙ сброс испорченной активности: баг «дельт» записал backlog как новые
  // сообщения (liveAct = сейчас для старых чатов) и сломал сортировку по активности
  if (!state.cfg.actReset1) {
    state.cfg.actReset1 = true
    state.liveAct = {}
    state.prevUnread = {}
    if (state.cfg.activity) state.cfg.activity.liveAct = {}
    try { window.hub.saveConfig(state.cfg).catch(() => {}) } catch (e) {}
  }
  // сброс №5: в кэше pid были отравленные записи (два разных чата получали
  // один peer-id из нечёткого матча и одинаковые аватарки) — чистим кэши
  if (!state.cfg.actReset5) {
    state.cfg.actReset5 = true
    state.tgPeerOf = {}
    state.pinAvatars = {}
    try { window.hub.saveConfig(state.cfg).catch(() => {}) } catch (e) {}
  }
  // сброс №4: авторство последних сообщений теперь берётся из открытого чата
  if (!state.cfg.actReset4) {
    state.cfg.actReset4 = true
    state.lastMsgPreview = {}
    if (state.cfg.activity) state.cfg.activity.lastMsgPreview = {}
    try { window.hub.saveConfig(state.cfg).catch(() => {}) } catch (e) {}
  }
  // сброс №3: старые сохранённые превью содержат удвоенные названия/неверных авторов —
  // чистим, пусть пересоберутся с мессенджеров по новым правилам
  if (!state.cfg.actReset3) {
    state.cfg.actReset3 = true
    state.lastMsgPreview = {}
    if (state.cfg.activity) state.cfg.activity.lastMsgPreview = {}
    try { window.hub.saveConfig(state.cfg).catch(() => {}) } catch (e) {}
  }
  // сброс №2: первый запуск после фикса успел заново испортить liveAct
  // (бамп сработал на «прыжке» чисел, когда API MM ответил позже сайдбара)
  if (!state.cfg.actReset2) {
    state.cfg.actReset2 = true
    state.liveAct = {}
    state.prevUnread = {}
    if (state.cfg.activity) state.cfg.activity.liveAct = {}
    try { window.hub.saveConfig(state.cfg).catch(() => {}) } catch (e) {}
  }
}

// П.13: сохранение накопленной активности в config.json — дебаунс 20 с,
// пишем только когда что-то реально накопили (времена/pid/liveAct)
let actSaveTimer = 0
function activitySnapshot() {
  return {
    lastMsgAt: { ...state.lastMsgAt },
    lastMsgDayOnly: { ...state.lastMsgDayOnly },
    lastMsgSource: { ...state.lastMsgSource },
    lastMsgText: { ...state.lastMsgText },
    lastMsgPreview: { ...state.lastMsgPreview },
    msgAuth: { ...state.msgAuth },
    liveAct: { ...state.liveAct },
    tgPeerOf: { ...state.tgPeerOf },
    prevUnread: { ...state.prevUnread },
    unreadBaseC: { ...state.unreadBaseC },
    unreadBaseM: { ...state.unreadBaseM },
    unreadTotals: { ...state.unreadTotals },
    unreadTotalsAt: { ...state.unreadTotalsAt },
    unreadDots: { ...state.unreadDots },
    svcTabTotals: { ...state.svcTabTotals },
    tgScrollDone: !!tgScrollDone
  }
}
function scheduleActSave() {
  if (actSaveTimer) return
  actSaveTimer = setTimeout(() => {
    actSaveTimer = 0
    try {
      state.cfg.activity = activitySnapshot()
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
    const ic = document.createElement('span')
    ic.className = 'tab-icon'
    b.appendChild(ic)
    const s = document.createElement('span')
    s.className = 'tab-label'
    s.textContent = label
    b.appendChild(s)
    b.onclick = () => activateTab(id)
    tabs.appendChild(b)
    return b
  }
  const cb = mk('combined', 'Сборная')
  const cbadge = document.createElement('span')
  cbadge.className = 'badge'
  cb.appendChild(cbadge)
  // второй чип «@упоминаний лично» — как у вкладок мессенджеров (п.20)
  const cmbadge = document.createElement('span')
  cmbadge.className = 'badge badge-m'
  cb.appendChild(cmbadge)
  for (const svc of state.cfg.services) {
    const b = mk('svc:' + svc.id, svc.name)
    const badge = document.createElement('span')
    badge.className = 'badge'
    b.appendChild(badge)
    // второй чип — «@упоминания лично тебя» (пока только MM, из API)
    const mbadge = document.createElement('span')
    mbadge.className = 'badge badge-m'
    b.appendChild(mbadge)
    const cached = (state.svcTabTotals || {})[svc.id]
    if (cached) updateBadge2(svc.id, cached.t || 0, cached.m || 0)
  }
  let total = 0, mentions = 0
  for (const p of state.cfg.pinned) {
    const cached = (state.unreadTotals || {})[p.id]
    if (cached) { total += cached.c || 0; mentions += cached.m || 0 }
    if ((state.unreadDots || {})[p.id]) total++
  }
  updateBadge2('combined', total, mentions)
  mk('settings', 'Настройки')
}

/* ---------- вид «панель слева» (как в Ferdium) + тема ---------- */

// иконки вкладок: Сборная ★, настройки ⚙, мессенджеры — favicon (data-URL)
// или первая буква названия, пока favicon не захвачен
function refreshTabIcons() {
  const firstLetter = svcId => {
    const svc = (state.cfg.services || []).find(s => s.id === svcId)
    return svc && svc.name ? svc.name.trim().charAt(0).toUpperCase() : '?'
  }
  document.querySelectorAll('#tabs .tab').forEach(b => {
    const ic = b.querySelector('.tab-icon')
    if (!ic) return
    const id = b.dataset.tab || ''
    if (id === 'combined') ic.textContent = '★'
    else if (id === 'settings') ic.textContent = '⚙'
    else if (id.startsWith('svc:')) {
      const url = state.svcIcons[id.slice(4)]
      if (url) { ic.innerHTML = '<img alt="" src="' + url + '">' }
      else ic.textContent = firstLetter(id.slice(4))
    }
  })
}

function applyBadgeVisibility() {
  document.body.classList.toggle('hide-badges', state.cfg.badgeVisible === false)
  document.body.classList.toggle('hide-svc-badge', state.cfg.svcBadgeVisible === false)
  document.body.classList.toggle('hide-chat-source', state.cfg.svcNameVisible === false)
  document.body.classList.toggle('fav-badge-always', state.cfg.favBadgeAlways === true)
}

// применить сохранённый вид (вкладки сверху / панель слева)
function applyTabIcons() {
  document.body.classList.toggle('tab-icons', state.cfg.tabIcons === true)
}

function applyLayout() {
  const sidebar = state.cfg.layout === 'sidebar'
  document.body.classList.toggle('layout-sidebar', sidebar)
  applyTabIcons()
  const bar = document.getElementById('tabbar')
  if (!sidebar) {
    document.body.classList.remove('sb-rail')
    bar.style.width = ''
    return
  }
  ensureSbChrome(bar)
  setSbWidth(Number(state.cfg.sidebarWidth) || 230)
}

function setSbWidth(px) {
  const bar = document.getElementById('tabbar')
  const rail = px < 100
  document.body.classList.toggle('sb-rail', rail)
  bar.style.width = (rail ? 76 : Math.round(px)) + 'px'
}

// ресайзер + футер с версией живут внутри панели; в виде «вкладки сверху» скрыты CSS-ом
function ensureSbChrome(bar) {
  if (document.getElementById('sb-resizer')) return
  const resizer = document.createElement('div')
  resizer.id = 'sb-resizer'
  resizer.title = 'Потяните, чтобы изменить ширину панели'
  bar.appendChild(resizer)
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault()
    document.body.classList.add('sb-resizing')
    // drag: единый clamp 76..420, rAF-троттлинг (каждый mousemove дёргает
    // layout живых webview — иначе рвётся кадрами)
    let raf = 0
    const apply = px => setSbWidth(Math.max(76, Math.min(420, px)))
    const move = ev => {
      const px = ev.clientX
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; apply(px) })
    }
    const finish = ev => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', finish)
      window.removeEventListener('blur', finish)
      if (raf) cancelAnimationFrame(raf)
      document.body.classList.remove('sb-resizing')
      // mouseup вне окна не приходит — blur финализирует тем же кодом
      const rail = document.body.classList.contains('sb-rail')
      state.cfg.sidebarWidth = rail ? 76 : Math.max(100, Math.min(420, Math.round(ev.clientX)))
      window.hub.saveConfig(state.cfg).catch(() => {})
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', finish)
    // окно потеряло фокус посреди drag — снимаем захваченное состояние,
    // иначе body.sb-resizing (cursor/user-select) залипает
    window.addEventListener('blur', finish)
  })
  const footer = document.createElement('div')
  footer.id = 'sb-footer'
  footer.title = 'О программе и настройки'
  footer.textContent = 'ChatHub'
  footer.onclick = () => activateTab('settings')
  bar.appendChild(footer)
  if (window.hub.getVersion) {
    window.hub.getVersion().then(v => { footer.textContent = 'ChatHub v' + v }).catch(() => {})
  }
}

// применить тему (тёмная по умолчанию / светлая)
/* MM управляет своей темой сам (настройки аккаунта Mattermost, у пользователя тёмная).
   ChatHub тему MM не подменяет: эксперимент с белой темой MM отменён. */

function applyTheme() {
  document.body.classList.toggle('theme-light', state.cfg.theme === 'light')
  // тема и для ВСТРОЕННЫХ чатов: мессенджеры в webview слушают
  // prefers-color-scheme («системная тема») — переключаем nativeTheme
  // через main, тогда веб-версии следуют за темой ChatHub
  try { window.hub.setThemeSource(state.cfg.theme === 'light' ? 'light' : 'dark') } catch {}
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
  for (const serviceId of ['tg', 'max', 'ydx']) {
    const view = state.svcViews[serviceId]
    if (!view) continue
    try { Promise.resolve(view.executeJavaScript('window.__hubVirtualSweepBlocked = ' + (id === 'svc:' + serviceId))).catch(() => {}) } catch {}
  }
  if (svc && wv && !wv.dataset.loadedSrc) enqueueLoad(wv, initialSvcUrl(svc), true)
  if (id === 'settings') buildSettings(sec)
  for (const s of content.children) s.classList.toggle('visible', s.dataset.tab === id)
  document.querySelectorAll('#tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id))
  if (id === 'combined' && !state.combinedBuilt) {
    state.combinedBuilt = true
    renderChatList()
  }
}

// Автоматический старт/восстановление не должны открывать TG-чат:
// даже скрытая вьюха по глубокой ссылке может отметить сообщения прочитанными.
function initialSvcUrl(svc) {
  if (svc.id === 'tg') return String(svc.url).split('#')[0]
  return svc.url
}

function buildSection(id, deferSrc) {
  const sec = document.createElement('section')
  sec.dataset.tab = id
  sec.className = 'tabpane'

  if (id === 'combined') {
    sec.innerHTML = `
      <div class="combined" id="combined-layout">
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
          <div class="chat-list-empty hidden" id="combined-empty">Откройте вкладку мессенджера, выберите чат и нажмите «⭐ В избранное».</div>
        </aside>
        <div class="list-split" id="list-split" title="Потяните, чтобы изменить ширину списка"></div>
        <div class="chat-view">
          <div class="view-head hidden" id="view-head"></div>
          <div class="chat-view-stack" id="chat-view-stack">
            <div class="chat-placeholder" id="chat-placeholder">
              <img class="chat-placeholder-logo" src="build/icon_256.png" width="256" height="256" alt="" draggable="false">
              <h1 class="chat-placeholder-title">ChatHub</h1>
              <p class="chat-placeholder-tagline">Все чаты. Одно окно.</p>
            </div>
          </div>
        </div>
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
  if (svc.id === 'ydx' && window.ChatHubServiceHealth) window.ChatHubServiceHealth.attach(wv, bar)

  // счётчик непрочитанных в заголовке вкладки — только для сервисов без
  // собственного экстрактора (у остальных считаем сами, по избранному)
  wv.addEventListener('page-title-updated', (e) => {
    if (UNREAD_EXTRACTORS[svc.id]) return
    const t = String(e.title || '')
    const m = t.match(/\((\d+)\)/) || t.match(/(\d+)\s*непрочитан/i)
    updateBadge(svc.id, m ? m[1] : '', false)
  })
  // фирменная иконка мессенджера — из favicon его же страницы
  wv.addEventListener('dom-ready', () => {
    captureSvcIcon(svc.id, wv)
    // Телемост: панель сервисов Яндекса (Алиса Про/Почта/Диск/Документы/
    // Календарь/Заметки) — скрываем и в сервисной вкладке, и в пин-вьюхах
    // (в пин-вьюхах ещё и через columnCss — там лишняя полоса слева вдвойне мешает)
    if (svc.id === 'ydx') { try { wv.insertCSS('[class^="GlobalBarRoot"]{display:none !important}') } catch (e) {} }
    // MAX (основная вкладка): прячем navigation; на >=950px CSS-сетка MAX держит
    // пустую колонку 77px — закрываем её сдвигом ТОЛЬКО на этой ширине (медиа),
    // ниже 950px колонки нет и сдвиг не нужен (фиксированный -77px на узком окне
    // уводил содержимое за левый край). insertCSS (стили-лист) MAX-JS не перебивает.
    if (svc.id === 'max') { try { wv.insertCSS('.app > .navigation{display:none !important} .app{margin:0 !important; width:100% !important; max-width:none !important; min-width:0 !important; box-sizing:border-box !important} @media (min-width:950px){.app{margin-left:-77px !important; width:calc(100% + 77px) !important}}') } catch (e) {} }
  })

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

// п.20: два счётчика на вкладке мессенджера — всего непрочитанных сообщений
// (красный) и упоминаний пользователя лично (яркий @-чип). MM берёт числа
// из API /users/me/teams/unread (mmTabCounts); TG/MAX/ydx — суммы по всем
// строкам списка от их экстракторов (svcTotals).
function updateBadge2(svcId, total, mentions) {
  const b = document.querySelector(svcId === 'combined' ? '.tab[data-tab="combined"] .badge' : '.tab[data-tab="svc:' + svcId + '"] .badge')
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
  // SPA-мессенджеры (Телемост) меняют URL ПОСЛЕ открытия чата, а getURL
  // может отдать прежний адрес (корень списка): берём свежий location.href
  // прямо со страницы — он всегда актуален.
  try { url = (await wv.executeJavaScript('location.href')) || url } catch (e) {}
  if (!url || url === 'about:blank') { toast('Чат ещё не открыт'); return }
  // webk иногда живёт на URL без хеша (открыт список чатов) — закреплять нечего
  if (svc.id === 'tg' && !/#.+/.test(url)) { toast('Сначала откройте чат в Telegram'); return }
  // защита от закрепления «списка чатов» (корня мессенджера): пин без
  // конкретного чата — мусор с ничего не значащим именем («Чат» у MAX).
  // Корень распознаём по отсутствию маркера чата в URL сервиса.
  const CHAT_URL_RE = {
    mm: /\/(channels|messages|pl)\//,
    tg: /#/,
    max: /\/-?\d+/,
    ydx: /\/(chats|user)\//
  }
  const chatRe = CHAT_URL_RE[svc.id]
  if (chatRe && !chatRe.test(url)) {
    // URL мог ещё не догнать SPA-переход (чат открывается, адрес появится
    // через мгновение) — даём полторы секунды и перечитываем
    await new Promise(r => setTimeout(r, 1500))
    try { url = (await wv.executeJavaScript('location.href')) || url } catch (e) {}
    if (chatRe && !chatRe.test(url)) { toast('Сначала откройте конкретный чат, а не список'); return }
  }
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
  // Mattermost has an authoritative last_post_at API. Fetch it immediately for
  // a newly pinned chat so its real activity position is known before the
  // first background poll; never use Date.now() as a fake message timestamp.
  if (svc.id === 'mm') {
    try { await mmLastPosts(pin.id) } catch (e) {}
  }
  sortFavoritesByActivity()
  state.cfg.selectedPinId = pin.id
  await window.hub.saveConfig(state.cfg)
  renderChatList()
  refreshUnreadPresentation()
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
      // имя из СТРОКИ СПИСКА: у каналов/юзеров строка ищется по href (#@username),
      // у числовых id — по data-peer-id; виртуализация может прятать строку,
      // тогда шапка открытого чата (сверив хеш вьюхи с URL пина) и, наконец,
      // само имя из username («@Combat_Library» → «Combat Library»)
      expr = `(() => {
        const pid = ${JSON.stringify(pid)}
        let row = document.querySelector('a.row-clickable[href="#' + pid + '"]')
        if (!row) {
          const av = document.querySelector('[data-peer-id="' + pid + '"]')
          row = av ? (av.closest('.row-clickable') || av) : null
        }
        const t = row ? row.querySelector('.peer-title') : null
        if (t && t.textContent.trim()) return t.textContent.trim()
        if (String(location.hash || '') === '#' + pid) {
          // шапка ОТКРЫТОГО чата — только точные селекторы топбара webk
          // (.top .user-title .peer-title). Голый '.peer-title' НЕЛЬЗЯ:
          // он матчит ПЕРВУЮ строку списка чатов (закреплённый канал),
          // из-за него пин «Анна Медведева» переименовался в «Data Science»
          const h = document.querySelector('.top .user-title .peer-title, .top .peer-title, .topbar .peer-title, .chat-info .peer-title')
          if (h && h.textContent.trim()) return h.textContent.trim()
        }
        if (pid.startsWith('@')) return decodeURIComponent(pid.slice(1)).replace(/[_\\.]+/g, ' ')
        return ''
      })()`
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
  if (layout) layout.classList.remove('hidden')
  const cnt = document.getElementById('fav-count')
  if (cnt) cnt.textContent = has ? String(favs.length) : ''

  for (const p of favs) list.appendChild(makeChatRow(p))
  applyFavFilter() // фильтр поиска живёт и после перерисовки списка

  // Старт — ТОЛЬКО список избранного: никаких автоматически открытых чатов.
  // Вьюха конкретного чата создаётся исключительно по клику пользователя
  // (selectChat), иначе при запуске открывались произвольные чаты.
  // вьюхи чатов, которых больше нет в избранном, — убираем
  const alive = new Set(favs.map(p => p.id))
  for (const [pid, v] of Object.entries(state.pinViews)) {
    if (!alive.has(pid)) { destroyPinView(pid, v) }
  }
  syncChatSelection()
  trimPinViews(state.activePinId)
  // Автовыбора чата при старте/перерисовке больше нет: Astra Linux или любой
  // другой чат не открывается сам. Пользователь сам выбирает чат кликом.
}

// Refresh selection chrome without navigating, loading or marking a chat read.
function syncChatSelection() {
  const p = state.cfg.pinned.find(x => x.id === state.activePinId)
  const active = !!(p && state.cfg.services.some(s => s.id === p.serviceId) && state.pinViews[p.id])
  if (!active) state.activePinId = ''
  for (const [pid, view] of Object.entries(state.pinViews)) view.classList.toggle('active', active && pid === state.activePinId)
  document.querySelectorAll('.chat-row').forEach(row => row.classList.toggle('selected', active && row.dataset.pin === state.activePinId))
  const placeholder = document.getElementById('chat-placeholder')
  if (placeholder) placeholder.classList.toggle('hidden', active)
  const head = document.getElementById('view-head')
  if (head) {
    head.classList.toggle('hidden', !active)
    if (!active) head.innerHTML = ''
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
  // Rebuilding a row must preserve the explicit session selection, not a saved preference.
  row.classList.toggle('selected', p.id === state.activePinId)
  row.dataset.pin = p.id
  row.innerHTML = `
    ${svc && state.svcIcons[svc.id] ? '<img class="svc-badge svc-icon" alt="">' : '<span class="svc-badge"></span>'}
    <span class="row-avatar" aria-hidden="true"></span>
    <div class="chat-row-text">
      <div class="row-line1">
        <div class="chat-row-title"></div>
        <span class="row-badge hidden"></span>
        <span class="row-time"></span>
      </div>
      <div class="row-line2">
        <div class="chat-row-src"></div>
      </div>
      <div class="chat-row-preview"></div>
    </div>
    <button class="icon-btn row-more" title="Действия">⋮</button>
    <div class="row-menu hidden">
      <button data-act="pin">📌 <span>Закрепить</span></button>
      <button data-act="del">✕ Удалить</button>
    </div>`
  const cachedUnread = (state.unreadTotals || {})[p.id]
  setRowBadge(row, { count: cachedUnread?.c || 0, mentions: cachedUnread?.m || 0,
    unread: !!(state.unreadDots || {})[p.id] })
  const badge = row.querySelector('.svc-badge')
  badge.dataset.svc = svc ? svc.id : ''
  if (svc && state.svcIcons[svc.id]) badge.src = state.svcIcons[svc.id]
  else {
    badge.textContent = Array.from(svcName.trim())[0] || '?'
    badge.style.background = badgeColor(svcName)
  }
  // аватарка чата (после иконки мессенджера): картинка из кэша экстрактора
  // или монограмма-заглушка цветом по названию — пока не поймали
  setRowAvatar(row)
  row.classList.toggle('priority', !!p.priority)
  badge.title = svcName
  const ttl = row.querySelector('.chat-row-title')
  // п.19: одинаковые названия в одном сервисе различаем автоматически —
  // суффикс из ссылки (@username или id), чтобы два «Агасиева» были видны
  // как разные чаты без ручного переименования
  let dispTitle = p.title
  try {
    const lc = s => String(s || '').trim().toLowerCase()
    const same = state.cfg.pinned.filter(q => q.serviceId === p.serviceId && lc(q.title) === lc(p.title))
    if (same.length > 1) {
      const um = String(p.url || '').match(/#@([A-Za-z0-9_]{3,})/)
      const ip = um ? null : String(p.url || '').match(/#(-?\d+)/)
      if (um) dispTitle = p.title + ' (@' + um[1] + ')'
      else if (ip) dispTitle = p.title + ' (id ' + ip[1] + ')'
    }
  } catch {}
  ttl.textContent = dispTitle
  ttl.title = p.url
  row.querySelector('.chat-row-src').textContent = svcName
  setRowPreview(row.querySelector('.chat-row-preview'), state.lastMsgPreview[p.id] || '')
  const timeEl = row.querySelector('.row-time')
  timeEl.textContent = state.lastMsgAt[p.id] ? fmtRowTime(state.lastMsgAt[p.id]) : ''
  timeEl.title = state.lastMsgAt[p.id] ? new Date(state.lastMsgAt[p.id]).toLocaleString('ru-RU') : ''
  row.onclick = (e) => { if (!e.target.closest('.icon-btn') && !e.target.closest('.row-menu')) selectChat(p.id) }
  // меню действий ⋮ (как контекстное меню в MAX): закрепить/открепить, удалить
  const more = row.querySelector('.row-more')
  const menu = row.querySelector('.row-menu')
  more.onclick = (e) => {
    e.stopPropagation()
    const wasOpen = menu.classList.contains('open')
    closeAllRowMenus()
    if (!wasOpen) {
      menu.querySelector('[data-act="pin"] span').textContent = p.priority ? 'Открепить' : 'Закрепить'
      menu.classList.remove('hidden')
      menu.classList.add('open')
      // меню раскрывается ВПРАВО, в сторону чата (поверх области чата)
      const br = more.getBoundingClientRect()
      menu.style.left = Math.round(br.right + 6) + 'px'
      menu.style.top = Math.round(br.top - 6) + 'px'
      const mr = menu.getBoundingClientRect()
      if (mr.bottom > window.innerHeight - 8) menu.style.top = Math.round(window.innerHeight - mr.height - 8) + 'px'
      if (mr.right > window.innerWidth - 8) menu.style.left = Math.round(Math.max(8, window.innerWidth - mr.width - 8)) + 'px'
    }
  }
  menu.addEventListener('click', (e) => e.stopPropagation())
  menu.querySelector('[data-act="pin"]').onclick = () => { closeAllRowMenus(); togglePin(p.id) }
  menu.querySelector('[data-act="del"]').onclick = () => { closeAllRowMenus(); removePin(p.id) }
  return row
}

// закрыть все открытые меню строк (клик мимо / открытие другого)
// Превью строки: «Автор: текст» — автор жирным (до первого двоеточия)
function setRowPreview(el, text) {
  if (!el) return
  let t = String(text || '')
  // Render the supplied evidence; a chat title is not a sender identity.
  const pinId = el.closest?.('.chat-row')?.dataset?.pin
  const proof = typeof state !== 'undefined' && state.msgAuth?.[pinId]
  const structured = proof?.source === 'webk-top-message-cache' && proof.preview === t
  const authorKey = structured ? 'explicit:' + proof.author : 'legacy'
  if (el.dataset.txt === t && el.dataset.authorKey === authorKey) return
  el.dataset.txt = t
  el.dataset.authorKey = authorKey
  if (structured) {
    // Explicit sender boundaries, not punctuation/length heuristics in a body.
    if (proof.author) el.innerHTML = '<b>' + escapeHtml(proof.author + ':') + '</b> ' + escapeHtml(proof.text)
    else el.textContent = t
    return
  }
  // автор до первого двоеточия — жирным; пробел после двоеточия НЕ обязателен (ydx даёт «Имя:Текст»)
  let i = t.indexOf(': ')
  let rest = ''
  if (i > 0 && i < 40) rest = t.slice(i + 2)
  else {
    const j = t.indexOf(':')
    if (j > 0 && /^(https?|ftp|mailto)$/i.test(t.slice(0, j))) return void (el.textContent = t)
    if (j > 0 && j < 40) { i = j; rest = t.slice(j + 1).trimStart() }
  }
  if (i > 0 && i < 40) {
    el.innerHTML = '<b>' + escapeHtml(t.slice(0, i + 1)) + '</b> ' + escapeHtml(rest)
  } else {
    el.textContent = t
  }
}

// Локальная самопроверка (кнопка в настройках): отчёт можно скопировать и отправить
function localSelfcheck() {
  const out = []
  const pass = (name, ok, detail) => out.push((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''))
  const cfg = state.cfg || {}
  pass('конфиг: миграция CSS v5+', Number(cfg.cssDefaultsVersion) >= 5, cfg.cssDefaultsVersion)
  pass('конфиг: сдвиги TG/MAX удалены', !String((cfg.columnCss || {}).tg || '').includes('-202') && !String((cfg.columnCss || {}).max || '').includes('-77'))
  pass('юнит: parseChatTime', parseChatTime('10:24').at > 0 && parseChatTime('вчера').at > 0)
  let cssFav = false, cssTi = false, cssHb = false
  for (const ss of document.styleSheets) { try { for (const r of ss.cssRules) { const sx = r.selectorText || ''; if (sx.includes('fav-badge-always')) cssFav = true; if (sx.includes('tab-icons')) cssTi = true; if (sx.includes('hide-badges')) cssHb = true } } catch (e) {} }
  pass('CSS: ★-бейдж/иконки вкладок/скрытие счётчиков', cssFav && cssTi && cssHb)
  activateTab('settings')
  const light = document.querySelector('input[name="theme"][value="light"]')
  pass('настройки: «Светлая (мм не поддерживается)»', !!light && !!light.parentElement && light.parentElement.textContent.includes('мм не поддерживается'))
  pass('настройки: галочки ★/иконки/индексация', !!document.getElementById('fav-badge-always') && !!document.getElementById('tab-icons') && !!document.getElementById('tg-bg-index'))
  const rows = [...document.querySelectorAll('.chat-list .chat-row')]
  pass('строки: есть', rows.length > 0, rows.length)
  let bad = 0
  const exact = []
  for (const row of rows) {
    const src = (row.querySelector('.chat-row-src') || {}).textContent || ''
    const pv = row.querySelector('.chat-row-preview')
    const pt = pv ? String(pv.textContent || '').trim() : ''
    const t = ((row.querySelector('.row-time') || {}).textContent || '').trim()
    const tmOk = t === 'вчера' || t.split(':').length === 2 || t.split('.').length >= 2
    const av = row.querySelector('.row-avatar')
    const avOk = !!av && Math.round((av.getBoundingClientRect() || { width: 0 }).width || 0) >= 40
    const title = (row.querySelector('.chat-row-title') || {}).textContent || ''
    const authOk = !(src === 'Mattermost' || src === 'Telegram') || pt.indexOf(':') > 0
    if (!(title && src && tmOk && avOk && pt && authOk)) { bad++; if (exact.length < 3) exact.push(String(title).slice(0, 14)) }
  }
  pass('строки: название/время/источник/аватар/превью+автор', bad === 0, exact.length ? exact : undefined)
  pass('MM: счётчики API', Object.keys(state.mmPinCounts || {}).length > 0, Object.keys(state.mmPinCounts || {}).length)
  pass('сервисы: 4 вкладки живы', ['mm', 'tg', 'max', 'ydx'].every(id => state.svcViews[id] && state.svcViews[id].isConnected))
  pass('бейджи: дельты активны', !!state.unreadBaseC && Object.keys(state.unreadBaseC).length > 0)
  activateTab('combined')
  return out
}

// Превью уже с автором? Автор = короткий префикс до двоеточия В НАЧАЛЕ; URL — не автор
function tgPreviewAuthored(pv) {
  const t = String(pv || '')
  const low = t.slice(0, 8).toLowerCase()
  if (low.indexOf('http') === 0 || low.indexOf('ftp') === 0 || low.indexOf('mailto') === 0) return false
  const i = t.indexOf(':')
  if (i < 2 || i > 30) return false
  return t.slice(i + 1).trim().length > 0
}

function closeAllRowMenus() {
  document.querySelectorAll('.row-menu.open').forEach(m => { m.classList.remove('open'); m.classList.add('hidden') })
}
// закрытие: клик мимо (шелл), клик ВНУТРИ вебвью (у шелла срабатывает blur),
// Escape. Иначе меню «зависало» после клика в чате.
document.addEventListener('click', () => closeAllRowMenus())
window.addEventListener('blur', () => closeAllRowMenus())
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllRowMenus() })

function selectChat(pinId, opts) {
  opts = opts || {}
  const p = state.cfg.pinned.find(x => x.id === pinId)
  if (!p) return
  const svc = state.cfg.services.find(s => s.id === p.serviceId)
  if (!svc) return
  state.cfg.selectedPinId = pinId
  state.activePinId = pinId
  // открыл чат ЯВНО (клик) → его «новые» обнуляются. Автовыбор при старте/
  // перерисовке списка базу не трогает — иначе счётчик исчезает при рестарте.
  if (opts.markRead !== false && state.unreadTotals && state.unreadTotals[pinId]) {
    state.unreadBaseC = state.unreadBaseC || {}
    state.unreadBaseM = state.unreadBaseM || {}
    state.unreadBaseC[pinId] = state.unreadTotals[pinId].c || 0
    state.unreadBaseM[pinId] = state.unreadTotals[pinId].m || 0
    state.cfg.activity = state.cfg.activity || {}
    state.cfg.activity.unreadBaseC = { ...state.unreadBaseC }
    state.cfg.activity.unreadBaseM = { ...state.unreadBaseM }
  }
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
  syncChatSelection()
  if (opts.markRead !== false) queueSelectedUnread(pinId).catch(() => {})
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
  const done = () => {
    if (settled) return
    settled = true
    clearTimeout(tid)
    wv.removeEventListener('dom-ready', done)
    delete wv.__hubPreloadDone
    preloadBusy = false
    pumpPreload()
  }
  const tid = setTimeout(done, 8000)
  wv.__hubPreloadDone = done
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
  wv.addEventListener('dom-ready', () => {
    applyColumnTweaks(wv, p)
    captureSvcIcon(svc.id, wv)
    // MAX: web-версия обновилась и снова показывает навигационный рейл (77px),
    // columnCss его не крыл. Прячем стили-листом и на >=950px закрываем пустую
    // grid-колонку сдвигом ленты (медиа); ниже 950 рейла нет — сдвига нет.
    if (svc.id === 'max') { try { wv.insertCSS('.app > .navigation{display:none !important} .app>main{width:100% !important; max-width:none !important} @media (min-width:950px){.app>main{margin-left:-77px !important; width:calc(100% + 77px) !important}}') } catch (e) {} }
    // MM: правая панель (RHS) могла остаться открытой с прошлой сессии — закрываем
    // один раз после загрузки. Треды по «N ответов» продолжают открываться (п.12).
    if (svc.id === 'mm') setTimeout(() => {
      try {
        wv.executeJavaScript('(function(){var b=document.querySelector("#rhsCloseButton");if(b){var r=b.getBoundingClientRect();if(r.width>0&&r.height>0){b.click();return "closed"}}return "no-rhs"})()').catch(() => {})
      } catch (e) {}
    }, 2500)
  })
  wv.addEventListener('did-navigate-in-page', () => setTimeout(() => applyColumnTweaks(wv, p), 400))
  // страховка: если CSS потерялся (медленный старт SPA, самообновление страницы) — вернуть
  // Keep the physical slot until settlement: a timeout cannot cancel guest JS.
  let cssProbePending = false
  wv.__hubTimer = setInterval(async () => {
    if (cssProbePending || state.pinViews[p.id] !== wv || wv.isConnected === false) return
    cssProbePending = true
    try {
      const ok = await wv.executeJavaScript('!!window.__chatHubCssTimer')
      if (ok || state.pinViews[p.id] !== wv || wv.isConnected === false) return
      if (String((state.cfg.columnCss || {})[svc.id] || '').trim()) applyColumnTweaks(wv, p, 4)
    } catch (e) {}
    finally { cssProbePending = false }
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
  // Release the serial loader now; its settled guard rejects late callbacks.
  if (v.__hubPreloadDone) v.__hubPreloadDone()
}

// LRU: priority affects list order only, never memory residency. Service collectors
// are stored separately in svcViews and are not candidates for pin eviction.
function trimPinViews(keepId = state.activePinId) {
  const entries = Object.entries(state.pinViews)
  const max = maxLiveViews()
  const evictable = entries.filter(([pid]) => pid !== (state.activePinId || keepId))
  const excess = entries.length - max
  if (excess <= 0 || !evictable.length) return
  evictable.sort((a, b) => (state.lastUsed[a[0]] || 0) - (state.lastUsed[b[0]] || 0))
  const victims = evictable.slice(0, excess)
  // Cancel the whole batch before destroying the current loader: its completion
  // pumps the queue synchronously, which must not navigate another victim.
  const views = new Set(victims.map(([, v]) => v))
  for (let i = preloadQueue.length - 1; i >= 0; i--) {
    if (views.has(preloadQueue[i].wv)) preloadQueue.splice(i, 1)
  }
  for (const [pid, v] of victims) destroyPinView(pid, v)
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
      refreshTabIcons()
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
    state.cfg.selectedPinId = ''
  }
  // гигиена: не оставляем записи удалённых чатов в картах состояния
  for (const k of ['liveAct', 'rankAct', 'prevUnread', 'lastUsed', 'lastMsgAt', 'lastMsgDayOnly', 'lastMsgSource', 'lastMsgText', 'tgPeerOf', 'tgIdentityKeys', 'tgSearchedAt', 'pinAvatars', 'lastMsgPreview', 'msgAuth', 'unreadBaseC', 'unreadBaseM', 'unreadTotals', 'unreadTotalsAt', 'unreadDots', 'mmPinCounts', '__prevLastMsgAt']) {
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
    try {
      const a = new URL(p.url), b = new URL(url)
      if (a.origin !== b.origin) return false
      const x = a.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      const y = b.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (x.length !== 3 || y.length !== 3 || !['channels', 'messages'].includes(x[1])) return false
      return x[1] === y[1] && x[2] === y[2] && (x[1] === 'messages' || x[0] === y[0])
    } catch { return false }
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
  // ОТКЛЮЧЕНО: проходы печати в поиск webk деградируют основной список
  // (экран архива вместо All), текст запросов конкатенируется, а закрыть
  // поиск программно webk не даёт. Аватарки и счётчики собирает обычный
  // экстрактор + аватарный свип (виртуализация), поиск не нужен.
  if (true) return null
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
            text: String(r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
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
          // п.19: сначала точное вхождение @username в тексте строки поиска —
          // два аккаунта с одинаковым названием различимы только юзернеймом,
          // title-скоринг здесь выбирал бы первого попавшегося
          const uHit = rows.find(r => r.inSearch && r.pid && String(r.pid).charAt(0) !== '-' &&
            r.text && r.text.indexOf('@' + unameQuery) >= 0)
          if (uHit) { best = uHit; bestScore = 999 }
          else for (const r of rows) {
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
    // ВАЖНО: вернуть чат-лист в рабочее состояние. webk с открытым поиском
    // (даже с пустым полем) показывает архив/недавние вместо основного
    // списка — экстрактор следующего цикла не находит строки (found=0).
    // Закрываем поиск Escape'ами до исчезновения .search-super и включаем
    // папку «All».
    try {
      const supH = '(() => { const sup = document.querySelector(".search-super"); return sup ? Math.round(sup.getBoundingClientRect().height) : -1 })()'
      const wid = wv.getWebContentsId()
      for (let k = 0; k < 4; k++) {
        const h = await evT(wv, supH, 8000)
        if (h <= 0) break
        await window.hub.trustedKey(wid, 'Escape', 27)
        await new Promise(r => setTimeout(r, 500))
      }
      await tgSelectFolder(wv, wid, '0')
    } catch {}
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
function applyTgIdentityObservation(pin, result) {
  if (/^https:\/\/web\.telegram\.org\/k\/#-?[1-9]\d*$/.test(pin.url || '')) {
    const numeric = result.dialogIdentity
    if (numeric?.kind === 'user' && numeric.source === 'webk-account-peer' &&
        pin.url === 'https://web.telegram.org/k/#' + numeric.peerId) {
      const bindings = state.tgIdentityKeys || (state.tgIdentityKeys = {})
      const key = `${numeric.accountId}::${numeric.peerId}`
      if (bindings[pin.id] && bindings[pin.id] !== key) {
        for (const field of ['pinAvatars', 'tgPeerOf', 'unreadTotals', 'unreadTotalsAt', 'unreadDots',
          'unreadBaseC', 'unreadBaseM', 'prevUnread', 'lastMsgAt', 'lastMsgDayOnly', 'lastMsgSource',
          'lastMsgText', 'lastMsgPreview', 'msgAuth', 'liveAct', 'rankAct', '__prevLastMsgAt']) {
          if (state[field]) delete state[field][pin.id]
        }
        const row = document.querySelector('.chat-row[data-pin="' + pin.id + '"]')
        if (row) setRowAvatar(row, null)
      }
      bindings[pin.id] = key
    }
    const proof = result.messageIdentity, saved = state.lastMsgSource?.[pin.id]
    if (proof && pin.url === 'https://web.telegram.org/k/#' + proof.peerId && saved &&
        (saved.accountId !== proof.accountId || saved.peerId !== proof.peerId || saved.canonicalUrl !== pin.url)) {
      for (const field of ['lastMsgAt', 'lastMsgDayOnly', 'lastMsgSource', 'lastMsgText', 'liveAct', '__prevLastMsgAt']) {
        if (state[field]) delete state[field][pin.id]
      }
    }
    return
  }
  if (!result.identityScoped || !/^https:\/\/web\.telegram\.org\/k\/#@[A-Za-z0-9_]+$/.test(pin.url || '')) return
  const proof = result.identity
  const key = proof ? `${proof.accountId}:${proof.username}:${proof.peerId}` : ''
  const bindings = state.tgIdentityKeys || (state.tgIdentityKeys = {})
  if (bindings[pin.id] === key) return
  // A cold-start session binding is absent, but persisted source evidence can
  // preserve this exact timestamp once the same account/peer is reverified.
  const saved = state.lastMsgSource?.[pin.id]
  const preserveTime = proof && saved?.source === 'webk-top-message-cache' &&
    saved.canonicalUrl === pin.url && saved.accountId === proof.accountId &&
    saved.peerId === proof.peerId && saved.at === state.lastMsgAt?.[pin.id]
  bindings[pin.id] = key
  // No account-less images, counters, activity or authors survive rebinding.
  for (const field of ['pinAvatars', 'tgPeerOf', 'unreadTotals', 'unreadTotalsAt', 'unreadDots',
    'unreadBaseC', 'unreadBaseM', 'prevUnread', 'lastMsgAt', 'lastMsgDayOnly', 'lastMsgSource', 'lastMsgText', 'lastMsgPreview',
    'msgAuth', 'liveAct', 'rankAct', '__prevLastMsgAt']) {
    if (preserveTime && ['lastMsgAt', 'lastMsgDayOnly', 'lastMsgSource', 'lastMsgText'].includes(field)) continue
    if (state[field]) delete state[field][pin.id]
  }
  const row = document.querySelector('.chat-row[data-pin="' + pin.id + '"]')
  if (row) setRowAvatar(row, null)
}

function tgPidSafe(pin, pid, rowTitle) {
  if (!pin || !pid) return false
  const upid = (String(pin.url || '').match(/#(-?\d+)/) || [])[1]
  if (upid) return String(upid) === String(pid)
  // п.19: пин с @username в ссылке получает pid ТОЛЬКО от собственного
  // username-поиска — общий title-матчинг не различает дубликаты названий
  if (/@([A-Za-z0-9_]{3,})/.test(String(pin.url || ''))) return false
  const norm = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '')
  const stop = new Set(['ext', 'int', 'астра', 'astrа', 'astra', 'chat', 'чат', 'группа', 'team', 'test', 'rb', 'vm'])
  const words = String(pin.title || '').split(/[\s|,/()]+/).map(w => norm(w)).filter(w => w.length >= 4 && !stop.has(w))
  if (!words.length) return false
  const n = norm(rowTitle)
  return !!n && words.some(w => n.indexOf(w) >= 0)
}

// One logical job per service/task. A deadline releases the scheduler, not the
// underlying Electron promise: unreadGuestCall keeps that physical call single-flight.
function runUnreadJob(key, svcId, work, budget = 4500) {
  const jobs = state.unreadJobs || (state.unreadJobs = new Map())
  const previous = jobs.get(key)
  if (previous && previous.current()) return previous.promise
  const svc = state.cfg.services.find(s => s.id === svcId)
  const view = state.svcViews[svcId]
  const viewState = view && unreadViewState(view)
  const epoch = viewState && viewState.epoch
  const signature = () => JSON.stringify([state.cfg.services.find(s => s.id === svcId),
    state.cfg.pinned.filter(p => p.serviceId === svcId).map(p => [p.id, p.url, p.title]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    key.startsWith('read:') || key === 'mm:read' ? state.activePinId : ''])
  const initial = signature()
  const revisions = state.unreadRevisions || (state.unreadRevisions = {})
  let revision = revisions[svcId] || 0
  let active = true, timer
  const job = {
    current: () => active && jobs.get(key) === job && revision === (revisions[svcId] || 0) && !!svc && state.svcViews[svcId] === view &&
      (!view || (view.isConnected !== false && viewState.epoch === epoch)) && signature() === initial,
    check() { if (!job.current()) throw new Error('Stale unread job') },
    supersede() { job.check(); revision = revisions[svcId] = (revisions[svcId] || 0) + 1 },
    async wait(operation) {
      job.check()
      const value = await Promise.race([Promise.resolve().then(operation), expired])
      job.check()
      return value
    }
  }
  const expired = new Promise((resolve, reject) => {
    timer = setTimeout(() => { active = false; reject(new Error('Unread deadline')) }, budget)
  })
  jobs.set(key, job)
  job.promise = Promise.race([Promise.resolve().then(() => work(job)), expired])
    .catch(() => {})
    .finally(() => {
      active = false
      clearTimeout(timer)
      if (jobs.get(key) === job) jobs.delete(key)
    })
  return job.promise
}

function unreadViewState(view) {
  const views = state.unreadViews || (state.unreadViews = new WeakMap())
  let entry = views.get(view)
  if (!entry) {
    entry = { epoch: 0, pending: new Map() }
    views.set(view, entry)
    if (view.addEventListener) {
      for (const event of ['did-start-loading', 'render-process-gone', 'destroyed']) {
        view.addEventListener(event, () => { entry.epoch++; entry.pending.clear() })
      }
    }
  }
  return entry
}

function unreadGuestCall(view, key, operation) {
  const entry = unreadViewState(view)
  if (entry.pending.has(key)) return Promise.reject(new Error('Unread guest still busy'))
  const token = { startedAt: Date.now() }
  const epoch = entry.epoch
  entry.pending.set(key, token)
  return Promise.resolve().then(operation).then(value => {
    if (entry.epoch !== epoch || view.isConnected === false) throw new Error('Stale unread guest')
    return value
  }).finally(() => {
    if (entry.pending.get(key) === token) entry.pending.delete(key)
  })
}

function recoverStaleMmGuest(view, key) {
  if (!view || typeof view.reload !== 'function') return false
  const entry = state.unreadViews && state.unreadViews.get(view)
  const pending = entry && entry.pending.get(key)
  const startedAt = Number(pending && pending.startedAt)
  if (!Number.isFinite(startedAt) || Date.now() - startedAt < 60000) return false
  // Reload only the hidden service view: a visible Mattermost tab may contain
  // an unsent user draft. The selected pin-view is never touched.
  const pane = document.querySelector('section[data-tab="svc:mm"]')
  if (pane && pane.classList.contains('visible')) return false
  if (state.mmGuestRecoveryAt && Date.now() - state.mmGuestRecoveryAt < 60000) return false
  state.mmGuestRecoveryAt = Date.now()
  try { view.reload(); return true } catch (e) { return false }
}

async function pollUnread() {
  await Promise.all(state.cfg.services.map(async svc => {
    const selected = state.cfg.pinned.find(p => p.id === state.activePinId && p.serviceId === svc.id)
    if (selected) await refreshSelectedUnread(selected.id)
    return runUnreadJob('poll:' + svc.id, svc.id, async job => {
      try { await pollUnreadService(svc, job) }
      finally { refreshUnreadPresentation() }
    })
  }))
}

// Fast, read-only lane for the selected chat: no scrolling, avatars or previews.
// A single bounded probe may bypass a slow background sweep; it never assumes
// that opening a chat means its newest messages have actually been read.
async function refreshSelectedUnread(pinId) {
  const pin = state.cfg.pinned.find(p => p.id === pinId)
  if (!pin || state.activePinId !== pinId) return
  // MAX has no verified immutable row ID yet. The single-pin lane must not
  // bypass the full collector's duplicate-favorite-title ambiguity guard.
  if (pin.serviceId === 'max' && String(pin.title || '').trim() && state.cfg.pinned.some(other => other.id !== pin.id &&
      other.serviceId === 'max' && String(other.title).trim() === String(pin.title).trim())) return
  return runUnreadJob('read:' + pin.serviceId, pin.serviceId, async job => {
    let observed = null
    if (pin.serviceId === 'mm') {
      const before = state.mmPinCounts && state.mmPinCounts[pinId]
      await job.wait(() => mmLastPosts(pinId))
      const after = state.mmPinCounts && state.mmPinCounts[pinId]
      if (after && after !== before) observed = { count: after.count, mentions: after.mentions, found: true }
    } else {
      const ext = UNREAD_EXTRACTORS[pin.serviceId]
      if (!ext) return
      const candidates = [...new Set((pin.serviceId === 'tg' && /^https:\/\/web\.telegram\.org\/k\/#(?:@[A-Za-z0-9_]+|[1-9]\d*)$/.test(pin.url || '')
        ? [state.svcViews.tg]
        : [state.pinViews[pinId], state.svcViews[pin.serviceId]]).filter(Boolean))]
      for (const view of candidates) {
        try {
          const source = `(async () => {
            const __grabAvatar = async () => null;
            const __chatHubScanRows = ${__chatHubScanRows.toString()};
            const __chatHubBoundedAvatar = ${__chatHubBoundedAvatar.toString()};
            const formatMaxPreview = ${formatMaxPreview.toString()};
            return (${ext.toString()})(${JSON.stringify([{ id: pin.id, url: pin.url, title: pin.title,
              pid: (state.tgPeerOf || {})[pin.id] || null, identityKey: state.tgIdentityKeys?.[pin.id] || '',
              needDialogMetadata: pin.serviceId === 'tg' && view === state.svcViews.tg,
              needAvatar: false, needUnread: false }])}, false);
          })()`
          const raw = await job.wait(() => unreadGuestCall(view, 'read', () => view.executeJavaScript(source)))
          const res = JSON.parse(raw)
          const result = (res.favs || []).find(r => r.id === pinId)
          if (pin.serviceId === 'tg' && (result?.identityScoped || result?.dialogIdentity)) applyTgIdentityObservation(pin, result)
          observed = result?.found === true ? result : null
          if (observed || result?.dialogScoped) break
        } catch {}
        job.check()
      }
    }
    job.check()
    if (state.activePinId !== pinId || !observed || !Number.isFinite(observed.count) || !Number.isFinite(observed.mentions)) return
    job.supersede() // older sweeps/API snapshots must not resurrect an acknowledged badge
    state.unreadTotals[pinId] = { c: observed.count, m: observed.mentions }
    state.unreadTotalsAt[pinId] = Date.now()
    state.selectedUnreadObservation = { pinId, at: Date.now() }
    state.unreadDots = state.unreadDots || {}
    state.unreadDots[pinId] = !!observed.unread && !observed.count && !observed.mentions
    const row = document.querySelector('.chat-row[data-pin="' + pinId + '"]')
    if (row) setRowBadge(row, { count: observed.count, mentions: observed.mentions,
      unread: observed.count > 0 || observed.mentions > 0 || !!observed.unread })
    refreshUnreadPresentation()
  })
}

function queueSelectedUnread(pinId) {
  clearTimeout(state.selectedUnreadTimer)
  const token = {}
  state.selectedUnreadRequest = token
  let attempts = 0
  const run = async () => {
    if (state.selectedUnreadRequest !== token || state.activePinId !== pinId) return
    await refreshSelectedUnread(pinId)
    if (++attempts < 3 && state.selectedUnreadRequest === token && state.activePinId === pinId) {
      state.selectedUnreadTimer = setTimeout(run, 1000)
    }
  }
  return run()
}

async function pollUnreadService(svc, job) {
    const favs = favoritesOf(svc.id)
    const ext = UNREAD_EXTRACTORS[svc.id]
    const wv = svcViewFor(svc.id)
    // Mattermost: в сайдбаре времён нет — время последнего сообщения берём из API MM
    if (svc.id === 'mm') mmTabCounts().catch(() => {})
    if (svc.id === 'mm' && favs.length) mmLastPosts().catch(() => {})
    // п.20: экстрактор нужен и БЕЗ избранного —svcTotals (два счётчика
    // вкладки) считаются по всему списку мессенджера; избранные строки
    // при пустом favs просто не обновятся
    if (!ext || !wv) return
    let res = null
    // кандидатные вьюхи: вкладка мессенджера ПЕРВОЙ — у неё полный живой
    // список и бейджи обновляются в реальном времени. Пин-вьюха (открытый
    // чат Сборной) показывает укороченный список и в скрытом состоянии
    // обновляется с задержкой — если опрашивать её первой, непрочитанные
    // всплывают с опозданием (баг «чат поднялся наверх, а бейджа нет»).
    // Фолбэк на пин-вьюхи остаётся: у TG сервисная вкладка иногда висит
    // на пустом/авторизационном экране (скелет) — берём первый вариант,
    // который вернул полезные данные.
    const candidates = []
    if (state.svcViews[svc.id]) candidates.push(state.svcViews[svc.id])
    if (wv && candidates.indexOf(wv) < 0) candidates.push(wv)
    for (const [pvId, pvView] of Object.entries(state.pinViews)) {
      const pvPin = state.cfg.pinned.find(x => x.id === pvId)
      if (pvPin && pvPin.serviceId === svc.id && candidates.indexOf(pvView) < 0) candidates.push(pvView)
    }
    for (const cand of candidates) {
      if (!cand) continue
      // Authoritative username/numeric-user observations never downgrade to a pin-view's
      // virtualized/stale rows when the service execution itself is unavailable.
      if (svc.id === 'tg' && cand !== state.svcViews.tg &&
          favs.some(f => /^https:\/\/web\.telegram\.org\/k\/#(?:@[A-Za-z0-9_]+|[1-9]\d*)$/.test(f.url || ''))) continue
      try {
        // второй аргумент экстрактора: можно ли скроллить список (вкладка
        // сервиса сейчас не на экране — прокрутка сайдбара не видна; TG иначе
        // не добирается до виртуализированных строк ниже первого экрана)
        const pane = document.querySelector('section[data-tab="svc:' + svc.id + '"]')
        let allowScroll = false
        if (['tg', 'max', 'ydx'].includes(svc.id) && cand === state.svcViews[svc.id] && !(pane && pane.classList.contains('visible'))) {
          try { allowScroll = (await job.wait(() => window.hub.isWinFocused())) === false } catch {}
          job.check()
        }
        // аватарки: шлём флаг needAvatar для пинов без закэшированной
        // аватарки; экстрактор при живой строке превращает <img>/background
        // строки в data-URL (ВНУТРИ webview). __grabAvatar объявляется
        // обёрткой в области видимости сериализованного экстрактора.
        state.pinAvatars = state.pinAvatars || {}
        const out = await job.wait(() => unreadGuestCall(cand, 'extract', () => cand.executeJavaScript(
          `(async () => {
            const __grabAvatar = ${__chatHubGrabAvatar.toString()};
            const __chatHubScanRows = ${__chatHubScanRows.toString()};
            const __chatHubBoundedAvatar = ${__chatHubBoundedAvatar.toString()};
            const formatMaxPreview = ${formatMaxPreview.toString()};
            return (${ext.toString()})(${JSON.stringify(favs.map(f => ({ id: f.id, url: f.url, title: f.title, pid: (svc.id === 'tg' && state.tgPeerOf[f.id]) || null, identityKey: (svc.id === 'tg' && state.tgIdentityKeys?.[f.id]) || '', needDialogMetadata: svc.id === 'tg' && cand === state.svcViews.tg, needMessageMetadata: svc.id === 'tg' && cand === state.svcViews.tg, needMessagePreview: svc.id === 'tg' && cand === state.svcViews.tg, needMetadataAvatar: svc.id === 'tg' && cand === state.svcViews.tg, needAvatar: !state.pinAvatars[f.id], needUnread: (svc.id === 'tg' || svc.id === 'max' || svc.id === 'ydx') && (!state.unreadTotals[f.id] || Date.now() - ((state.unreadTotalsAt || {})[f.id] || 0) > 30000) })))},${JSON.stringify(allowScroll)});
          })()`
        )))
        const r = JSON.parse(out)
        if (!r || !Array.isArray(r.favs)) throw new Error('Invalid unread response')
        // TG: запоминаем сопоставление пин → числовой peer-id (после первого
        // нахождения по названию дальше матчуем по pid быстро и однозначно)
        if (svc.id === 'tg' && r && r.favs) {
          for (const f of r.favs) {
            // отравленный/устаревший pid — чистим кэш и матчим заново по названию
            if (f.pidStale) { try { delete state.tgPeerOf[f.id] } catch (e) {} ; continue }
            if (f.pid && f.exact && (!state.tgPeerOf[f.id] || String(state.tgPeerOf[f.id]) === String(f.pid))) {
              const pin = state.cfg.pinned.find(p => p.id === f.id)
              if (pin && tgPidSafe(pin, f.pid, f.rowTitle)) state.tgPeerOf[f.id] = f.pid
            }
          }
        }
        if (!res) res = r
        const useful = r && r.favs && r.favs.some(f => f.time || f.found || (typeof f.rank === 'number' && f.rank < 9999))
        if (svc.id === 'tg' && cand === state.svcViews.tg && r.favs.some(f => f.dialogScoped)) { res = r; break }
        if (useful) { res = r; break }
      } catch {}
      job.check()
    }
    // TG: пины вне видимых строк (другие папки, виртуализация) добываем через
    // ПОИСК webk доверенным вводом — результат сливаем с обычным сбором.
    if (svc.id === 'tg') {
      try {
        const extra = await job.wait(() => tgSearchResolve(favs))
        if (extra && extra.favs && extra.favs.length) {
          const byId = new Map(((res && res.favs) || []).map(f => [f.id, f]))
          for (const f of extra.favs) {
            // аватарку из обычного сбора не теряем: объект поиска её не несёт
            const prev = byId.get(f.id)
            if (prev && prev.avatar && !f.avatar) f.avatar = prev.avatar
            if (prev && prev.preview && !f.preview) f.preview = prev.preview
            byId.set(f.id, f)
            if (f.pidStale) { try { delete state.tgPeerOf[f.id] } catch (e) {} }
            else if (f.pid && (!state.tgPeerOf[f.id] || String(state.tgPeerOf[f.id]) === String(f.pid))) {
              const pin = state.cfg.pinned.find(p => p.id === f.id)
              if (pin && tgPidSafe(pin, f.pid, f.rowTitle)) state.tgPeerOf[f.id] = f.pid
            }
          }
          res = { favs: Array.from(byId.values()), svcTotals: (res && res.svcTotals) || null }
          // Preserve unknown senders; search results do not prove authorship.
        }
      } catch {}
    }
    job.check()
    if (!res) return
    let mentions = res.dmMentions || 0     // mm: упоминания во ВСЕХ личных сообщениях
    let unreadChats = res.dmUnread ? 1 : 0
    let countSum = 0
    for (const r of (res.favs || [])) {
      const pin = state.cfg.pinned.find(p => p.id === r.id && p.serviceId === svc.id)
      if (!pin) continue
      if (svc.id === 'tg' && (r.identityScoped || r.messageIdentity || r.dialogIdentity)) applyTgIdentityObservation(pin, r)
      // «ТОЛЬКО НОВЫЕ»: показываем ПРИРОСТ непрочитанных, не backlog.
      // ВАЖНО: у каждого сервиса ОДИН источник чисел — иначе смена источника
      // (сайдбар -> API) выглядит как «+700 новых». MM: только API msg_count
      // (state.mmPinCounts); остальные сервисы — счётчики их экстракторов.
      let rawC = r.count || 0
      let rawM = r.mentions || 0
      let fresh = r.found !== false
      const selectedObservation = state.selectedUnreadObservation
      if (svc.id !== 'mm' && r.id === state.activePinId && selectedObservation &&
          selectedObservation.pinId === r.id && Date.now() - selectedObservation.at < 5000) fresh = false
      if (svc.id === 'mm') {
        const mp = state.mmPinCounts && state.mmPinCounts[r.id]
        fresh = !!mp && Number.isFinite(mp.observedAt) && mp.observedAt > ((state.unreadTotalsAt || {})[r.id] || 0)
        if (mp) { rawC = mp.count || 0; rawM = mp.mentions || 0 }
        r.count = rawC
        r.mentions = rawM
        if (rawC > 0 || rawM > 0) r.unread = true
      }
      let dC = 0, dM = 0, dU = false
      const row = document.querySelector('.chat-row[data-pin="' + r.id + '"]')
      state.unreadBaseC = state.unreadBaseC || {}
      state.unreadBaseM = state.unreadBaseM || {}
      state.unreadTotals = state.unreadTotals || {}
      // строки вне виртуализированного списка не должны затирать счётчик нулём:
      // держим последний достоверный запас, пока мессенджер не отдаст свежие данные
      if (!fresh) {
        const prevT = state.unreadTotals[r.id]
        if (prevT) { rawC = prevT.c || 0; rawM = prevT.m || 0 }
      }
      if (fresh || state.unreadTotals[r.id]) {
        if (fresh) {
          state.unreadTotals[r.id] = { c: rawC, m: rawM }
          state.unreadTotalsAt[r.id] = svc.id === 'mm' ? state.mmPinCounts[r.id].observedAt : Date.now()
        }
        // база ставится ОДИН раз (первый замер); вниз сдвигается только при
        // открытии чата (selectChat). После рестарта она восстанавливается
        // из cfg.activity, а для старого конфига — из prevUnread.
        if (state.unreadBaseC[r.id] === undefined) {
          const prevTotal = state.prevUnread[r.id]
          if (prevTotal !== undefined) {
            state.unreadBaseC[r.id] = Math.max(0, prevTotal - rawM)
            state.unreadBaseM[r.id] = rawM
          } else {
            state.unreadBaseC[r.id] = rawC
            state.unreadBaseM[r.id] = rawM
          }
        }
        const delta = unreadDeltaFor(r.id, rawC, rawM)
        dC = delta.dC
        dM = delta.dM
        dU = delta.dU
        // счётчик = ВСЕ непрочитанные, даже если чат пользователь не открывал
        if (row) setRowBadge(row, { count: rawC, mentions: rawM,
          unread: rawC > 0 || rawM > 0 || (fresh ? r.unread : !!(state.unreadDots || {})[r.id]) })
      } else if (row) setRowBadge(row, { count: 0, mentions: 0, unread: false })
      // аватарка чата, пойманная экстрактором → кэш и в строку (до
      // следующего рестарта; монограмма-заглушка остаётся, если не поймали)
      if (r.avatar && !state.pinAvatars[r.id]) {
        state.pinAvatars[r.id] = r.avatar
        if (row) setRowAvatar(row, r.avatar)
      }
      // TG: строка не найдена в виртуализированном списке — аватар из шапки пин-вьюхи
      if (!state.pinAvatars[r.id] && svc.id === 'tg' && !r.identityScoped) {
        try {
          const pv = state.pinViews[r.id]
          if (pv) {
            const av = await job.wait(() => unreadGuestCall(pv, 'avatar', () => grabAvatarFromPinView(pv, pin.url)))
            if (av) { state.pinAvatars[r.id] = av; if (row) setRowAvatar(row, av) }
          }
        } catch (e) {}
      }
      job.check()
      if (r.mentions) mentions += r.mentions
      if (r.count) countSum += r.count
      if (r.unread) unreadChats++
      // Сборная — только избранное: все непрочитанные + упоминания;
      // «точка без числа» (unread без count/mentions) считаем как 1
      state.unreadDots = state.unreadDots || {}
      if (fresh) state.unreadDots[r.id] = !!r.unread && rawC === 0 && rawM === 0
      // активность для сортировки: позиция строки в списке мессенджера
      // (списки TG и MAX сами отсортированы по свежести последних сообщений)
      if (r.found !== false) state.rankAct[r.id] = (typeof r.rank === 'number') ? r.rank : 9999
      // Exact cache evidence bypasses legacy text-only author learning.
      const mp = r.messagePreview
      const verifiedPreview = svc.id === 'tg' && mp?.source === 'webk-top-message-cache' &&
        mp.accountId === r.messageIdentity?.accountId && mp.peerId === r.messageIdentity?.peerId &&
        mp.messageId === r.messageTime?.messageId && typeof mp.preview === 'string' && mp.preview.length <= 370
      if (verifiedPreview) {
        state.lastMsgPreview[r.id] = mp.preview
        state.msgAuth = state.msgAuth || {}
        state.msgAuth[r.id] = { ...mp, name: mp.author }
      } else if (r.previewScoped) {
        // Missing/deleted/unavailable top cache is unknown, never an old body or draft.
        delete state.lastMsgPreview[r.id]
        if (state.msgAuth) delete state.msgAuth[r.id]
      }
      if (r.preview && !verifiedPreview && !r.previewScoped) {
      state.lastMsgPreview[r.id] = restorePreviewAuthor(r.preview, (state.msgAuth || {})[r.id], r.messageId)
      if (svc.id === 'tg' && !r.identityScoped && state.pinViews && state.pinViews[r.id]) {
        try {
          const pv = state.pinViews[r.id]
          const lb = await job.wait(() => unreadGuestCall(pv, 'preview', () => grabViewLastMsg(pv, pin.url)))
          if (lb && lb.text) {
            state.msgAuth = state.msgAuth || {}
            state.msgAuth[r.id] = { ...lb }
            // сохраняем выученное авторство — переживает перезапуск
            state.cfg.activity = state.cfg.activity || {}
            state.cfg.activity.msgAuth = state.msgAuth
            if (!state.msgAuthSaveAt || Date.now() - state.msgAuthSaveAt > 10000) {
              state.msgAuthSaveAt = Date.now()
              try { window.hub.saveConfig(state.cfg).catch(() => {}) } catch (e) {}
            }
            state.lastMsgPreview[r.id] = restorePreviewAuthor(r.preview, lb, r.messageId)
          }
        } catch (e) {}
      } }
      job.check()
      if (svc.id === 'max' && state.pinViews && state.pinViews[r.id]) {
        try {
          const pv = state.pinViews[r.id]
          const lb = await job.wait(() => unreadGuestCall(pv, 'preview', () => grabViewLastMsgMax(pv, pin.url)))
          if (lb && lb.text) {
            state.msgAuth = state.msgAuth || {}
            state.msgAuth[r.id] = { ...lb }
            state.cfg.activity = state.cfg.activity || {}
            state.cfg.activity.msgAuth = state.msgAuth
            if (!state.msgAuthSaveAt || Date.now() - state.msgAuthSaveAt > 10000) {
              state.msgAuthSaveAt = Date.now()
              try { window.hub.saveConfig(state.cfg).catch(() => {}) } catch (e) {}
            }
            state.lastMsgPreview[r.id] = restorePreviewAuthor(state.lastMsgPreview[r.id], lb, r.messageId)
          }
        } catch (e) {}
      }
      job.check()
      // время последнего сообщения — показываем в строке рядом с мессенджером
      // («дата + время») и сортируем по нему («главное — время последней активности»)
      state.__prevLastMsgAt = state.__prevLastMsgAt || {}
      state.__prevLastMsgAt[r.id] = state.lastMsgAt[r.id] || 0
      if (r.found !== false && r.time) mergeLastMessageTime(r.id, parseChatTime(r.time))
      // A top-message timestamp is independent of DOM visibility and unread.
      const mt = r.messageTime
      if (svc.id === 'ydx' && r.found === true && mt?.source === 'telemost-row-date' &&
          mt.dayOnly === false && mt.canonicalUrl === pin.url && Number.isSafeInteger(mt.at) &&
          mt.at >= 946684800000 && mt.at <= Date.now()) {
        mergeLastMessageTime(r.id, { at: mt.at, dayOnly: false })
      }
      if (svc.id === 'tg' && mt?.source === 'webk-top-message-cache' && mt.dayOnly === false &&
          /^[1-9]\d*$/.test(mt.accountId) && /^-?[1-9]\d*$/.test(mt.peerId) && /^[1-9]\d*$/.test(mt.messageId) &&
          (r.identity ? r.identity.accountId === mt.accountId && r.identity.peerId === mt.peerId :
            pin.url === 'https://web.telegram.org/k/#' + mt.peerId)) {
        mergeLastMessageTime(r.id, { ...mt, serviceId: svc.id, canonicalUrl: pin.url })
      }
      // активность для сортировки: бамп только если выросло ИМЕННО время
      // последнего сообщения. Рост непрочитанных на старом чате (прочитали
      // в другом клиенте/дошёл старый бейдж) не должен поднимать его наверх.
      if (fresh) {
        const total = (r.mentions || 0) + (r.count || 0) + (r.unread ? 1 : 0)
        const prev = state.prevUnread[r.id]
        const prevAt = state.__prevLastMsgAt && state.__prevLastMsgAt[r.id] || 0
        const nowAt = state.lastMsgAt[r.id] || 0
        if (shouldBumpLiveAct(prev, total, prevAt, nowAt)) {
          // бамп = ВРЕМЯ СООБЩЕНИЯ, а не время обнаружения бейджа:
          // старый чат с непрочитанными не должен обгонять свежие
          state.liveAct[r.id] = nowAt
        }
        state.prevUnread[r.id] = total
      }
    }
    if (svc.id === 'mm') {
      // бейдж вкладки MM — из API (mmTabCounts): два чипа «всего/@упоминаний»;
      // сайдбарные суммы здесь не трогаем (rows уже обновлены выше)
    } else if (res.svcTotals) {
      // п.20: два чипа на вкладке — суммы по ВСЕМУ списку мессенджера;
      // запоминаем для агрегата «★ Сборной»
      state.svcTabTotals = state.svcTabTotals || {}
      // нормализуем ключи к {t, m} — как у mmTabCounts (агрегат «Сборной» читает t/m)
      state.svcTabTotals[svc.id] = { t: res.svcTotals.total || 0, m: res.svcTotals.mentions || 0 }
      updateBadge2(svc.id, res.svcTotals.total || 0, res.svcTotals.mentions || 0)
    } else if (res.coverage && res.coverage.complete === false) {
      // A partial virtual window cannot replace a cached whole-service count.
    } else if (mentions > 0) updateBadge(svc.id, '@' + mentions, true)
    else if (countSum > 0) updateBadge(svc.id, String(countSum), false)
    else if (unreadChats > 0) updateBadge(svc.id, String(unreadChats), false)
    else updateBadge(svc.id, '', false)
}

function refreshUnreadPresentation() {
  let favSumT = 0, favSumM = 0
  for (const p of state.cfg.pinned) {
    const total = (state.unreadTotals || {})[p.id]
    if (total) { favSumT += total.c || 0; favSumM += total.m || 0 }
    if ((state.unreadDots || {})[p.id]) favSumT++
  }
  // п.20b: «★ Сборная» считает ТОЛЬКО избранное (требование пользователя),
  // не все чаты мессенджеров: всего непрочитанных в избранных чатах
  // + @упоминания в них; вкладки самих мессенджеров остаются по всему списку
  updateBadge2('combined', favSumT, favSumM)
  // время последнего сообщения в строках: «Мессенджер · 17:30»
  // (в т.ч. MM — из API; полный текст времени — в подсказке)
  for (const p of state.cfg.pinned) {
    const row = document.querySelector('.chat-row[data-pin="' + p.id + '"]')
    if (!row) continue
    const svc = state.cfg.services.find(s => s.id === p.serviceId)
    const tEl = row.querySelector('.row-time')
    if (tEl) {
      const want = state.lastMsgAt[p.id] ? fmtRowTime(state.lastMsgAt[p.id]) : ''
      if (tEl.textContent !== want) tEl.textContent = want
      tEl.title = state.lastMsgAt[p.id] ? new Date(state.lastMsgAt[p.id]).toLocaleString('ru-RU') : ''
    }
    const sEl = row.querySelector('.chat-row-src')
    if (sEl) { const wantS = svc ? svc.name : '?'; if (sEl.textContent !== wantS) sEl.textContent = wantS }
    const pEl = row.querySelector('.chat-row-preview')
    if (pEl) {
      setRowPreview(pEl, state.lastMsgPreview[p.id] || '')
    }
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
// A compact date is a day bucket, never a replacement for a known clock time.
// Call only after the caller has validated the pin/account identity.
function mergeLastMessageTime(id, observation) {
  const at = observation && observation.at
  if (!Number.isFinite(at) || at <= 0) return
  const dayOnly = observation.dayOnly === true
  const previous = state.lastMsgAt[id] || 0
  state.lastMsgDayOnly = state.lastMsgDayOnly || {}
  // Legacy caches recorded precision in the formatted label, not a separate map.
  const previousDayOnly = typeof state.lastMsgDayOnly[id] === 'boolean'
    ? state.lastMsgDayOnly[id] : !/\d{1,2}:\d{2}/.test(state.lastMsgText[id] || '')
  const sameDay = previous && new Date(previous).toDateString() === new Date(at).toDateString()
  if (previous && ((sameDay && dayOnly) ||
      (at < previous && !(sameDay && previousDayOnly && !dayOnly)))) return
  state.lastMsgAt[id] = at
  state.lastMsgDayOnly[id] = dayOnly
  state.lastMsgText[id] = fmtChatWhen(at, dayOnly)
  state.lastMsgSource = state.lastMsgSource || {}
  if (observation.source) state.lastMsgSource[id] = {
    source: observation.source, serviceId: observation.serviceId, canonicalUrl: observation.canonicalUrl,
    accountId: observation.accountId, peerId: observation.peerId, messageId: observation.messageId, at
  }
  else if (at !== previous) delete state.lastMsgSource[id]
}

function parseChatTime(text) {
  const t = String(text || '').trim()
  if (!t) return { at: 0, dayOnly: false }
  const now = new Date()
  let m
  if ((m = t.match(/^(\d{1,2}):(\d{2})$/))) {
    if (+m[1] > 23 || +m[2] > 59) return { at: 0, dayOnly: false }
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
  const monRu = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  const monEn = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const monIdx = w => {
    const wl = w.toLowerCase()
    if (wl.indexOf('мая') === 0) return 4 // «мая» как отдельная форма мая, без сдвига остальных
    const ru = monRu.findIndex(x => wl.indexOf(x) === 0)
    if (ru >= 0) return ru
    return monEn.findIndex(x => wl.indexOf(x) === 0)
  }
  // Resolve yearless dates by calendar day, not by the synthetic noon time.
  // Check components before returning: Date silently normalizes impossible dates.
  const calendarDate = (month, day, year) => {
    const today = new Date(now); today.setHours(12, 0, 0, 0)
    const first = year == null ? now.getFullYear() : year
    // Eight years cover the longest Gregorian leap-day gap at a century.
    const last = year == null ? first - 8 : first
    for (let y = first; y >= last; y--) {
      const d = new Date(0); d.setFullYear(y, month, day); d.setHours(12, 0, 0, 0)
      if (d.getFullYear() !== y || d.getMonth() !== month || d.getDate() !== day) continue
      if (year == null && d > today) continue
      return { at: d.getTime(), dayOnly: true }
    }
    return { at: 0, dayOnly: false }
  }
  if ((m = t.match(/^(\d{1,2})\s+([a-zа-яё]+)\.?$/i)) && monIdx(m[2]) >= 0) {
    return calendarDate(monIdx(m[2]), +m[1])
  }
  if ((m = t.match(/^([a-zа-яё]+)\.?\s+(\d{1,2})$/i)) && monIdx(m[1]) >= 0) {
    return calendarDate(monIdx(m[1]), +m[2])
  }
  if ((m = t.match(/^(\d{1,2})\.(\d{2})(?:\.(\d{2}|\d{4}))?$/))) {
    const yy = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : undefined
    return calendarDate(+m[2] - 1, +m[1], yy)
  }
  // webk в en-локали показывает старые даты как «04/18/2025» (ММ/ДД/ГГГГ)
  if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    return calendarDate(+m[1] - 1, +m[2], +m[3])
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

// Время строки избранного: сегодня — ЧЧ:ММ, вчера — «вчера», раньше — ДД.ММ(.ГГ).
// Сортировка при этом идёт по ТОЧНОМУ времени (lastMsgAt), не по этой строке.
function fmtRowTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const n = new Date()
  const pad = x => ('0' + x).slice(-2)
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return pad(d.getHours()) + ':' + pad(d.getMinutes())
  }
  const y = new Date(n); y.setDate(y.getDate() - 1)
  if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return 'вчера'
  let s = pad(d.getDate()) + '.' + pad(d.getMonth() + 1)
  if (d.getFullYear() !== n.getFullYear()) s += '.' + String(d.getFullYear()).slice(-2)
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
  const recoveryView = state.svcViews.mm || svcViewFor('mm')
  if (recoverStaleMmGuest(recoveryView, 'mm:totals')) return
  return runUnreadJob('mm:totals', 'mm', async job => {
  const now = Date.now()
  if (state.mmTabCountsAt && now - state.mmTabCountsAt < 30000) return
  // API зовём из СЕРВИСНОЙ вкладки: первые пин-вьюхи могут быть «скелетом»
  const wv = state.svcViews['mm'] || svcViewFor('mm')
  if (!wv || !wv.executeJavaScript) return
  try {
    const out = await job.wait(() => unreadGuestCall(wv, 'mm:totals', () => wv.executeJavaScript(`(async () => {
      try {
        const response = await fetch("/api/v4/users/me/teams/unread", { headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (!response.ok) return '';
        const r = await response.json();
        if (!Array.isArray(r) || !r.length) return "";
        const seen = new Set();
        let t = 0, m = 0;
        for (const u of r) {
          if (!u || typeof u.team_id !== 'string' || seen.has(u.team_id) ||
              !Number.isSafeInteger(u.msg_count) || u.msg_count < 0 ||
              !Number.isSafeInteger(u.mention_count) || u.mention_count < 0) return '';
          seen.add(u.team_id);
          t += u.msg_count; m += u.mention_count;
        }
        if (!Number.isSafeInteger(t) || !Number.isSafeInteger(m)) return '';
        return JSON.stringify({ t, m });
      } catch (e) { return "" }
    })()`)))
    if (!out) return
    const c = JSON.parse(out)
    if (typeof c.t === 'number') {
      state.mmTabCountsAt = now
      state.svcTabTotals = state.svcTabTotals || {}
      state.svcTabTotals.mm = { t: c.t, m: c.m }
      updateBadge2('mm', c.t, c.m)
    }
  } catch {}
  }, 15000)
}

async function mmLastPosts(pinId) {
  const taskKey = pinId ? 'mm:read' : 'mm:posts'
  const recoveryView = state.svcViews.mm || svcViewFor('mm')
  if (recoverStaleMmGuest(recoveryView, taskKey)) return
  return runUnreadJob(taskKey, 'mm', async job => {
  const now = Date.now()
  if (!pinId && state.mmChannelsAt && now - state.mmChannelsAt < 30000) return
  const wv = state.svcViews['mm'] || svcViewFor('mm')
  if (!wv) return
  const mmFavs = favoritesOf('mm').filter(p => !pinId || p.id === pinId)
  if (!mmFavs.length) return
  try {
    const out = await job.wait(() => unreadGuestCall(wv, taskKey, () => wv.executeJavaScript(`(async () => {
      const H = { "X-Requested-With": "XMLHttpRequest" };
      try {
        const get = async path => {
          const response = await fetch(path, { headers: H });
          if (!response.ok) throw new Error('Mattermost metadata request failed');
          return response.json();
        };
        const me = await get('/api/v4/users/me');
        if (!me || typeof me.id !== 'string' || !me.id) return '';
        const userPath = '/api/v4/users/' + encodeURIComponent(me.id);
        // Official all-team membership endpoint (server >= 6.1), including D/G.
        // No per-team concatenation: DM/group channels are global to the account.
        const channels = await get(userPath + '/channels');
        if (!Array.isArray(channels)) return '';
        const chs = [...new Map(channels.filter(c => c && c.id && !c.delete_at).map(c => [c.id, c])).values()];
        let teams = [];
        try { const value = await get(userPath + '/teams'); if (Array.isArray(value)) teams = value } catch (e) {}
        const uidCache = {}; // resolve usernames anew; never trust another account/old username cache
        const jobs = ${JSON.stringify(mmFavs.map(f => ({ id: f.id, url: f.url })))};
        const snapshots = new Map();
        const res = [];
        for (const j of jobs) {
          let route;
          try {
            const url = new URL(j.url);
            if (url.origin !== location.origin) continue;
            const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
            if (parts.length !== 3 || !['channels', 'messages'].includes(parts[1])) continue;
            route = { team: parts[0], kind: parts[1], slug: parts[2] };
          } catch (e) { continue }
          let matches = [];
          if (route.kind === 'messages' && route.slug.startsWith('@')) {
            const username = route.slug.slice(1);
            if (!Object.prototype.hasOwnProperty.call(uidCache, username)) {
              uidCache[username] = null;
              try { const user = await get('/api/v4/users/username/' + encodeURIComponent(username)); if (user && user.username === username && user.id) uidCache[username] = user.id } catch (e) {}
            }
            const uid = uidCache[username];
            if (uid) {
              const name = [me.id, uid].sort().join('__');
              matches = chs.filter(c => c.type === 'D' && c.name === name);
            }
          } else if (route.kind === 'messages') {
            // Official group sidebar route uses channel.name, not channel.id.
            matches = chs.filter(c => c.type === 'G' && c.name === route.slug);
          } else {
            const team = teams.filter(t => t && t.name === route.team && t.id);
            if (team.length === 1) matches = chs.filter(c => (c.type === 'O' || c.type === 'P') && c.team_id === team[0].id && c.name === route.slug);
          }
          const ch = matches.length === 1 ? matches[0] : null;
          if (ch) {
            if (snapshots.has(ch.id)) { res.push({ ...snapshots.get(ch.id), id: j.id }); continue }
            let prev = "", messageId = null;
            if (!${Boolean(pinId)}) {
            try {
              const purl = "/api/v4/channels/" + ch.id + "/posts?per_page=1";
              const pp = await fetch(purl, { headers: H }).then(r => r.json());
              const post = pp && pp.posts && pp.order && pp.order.length ? pp.posts[pp.order[0]] : null;
              if (post) messageId = post.id || pp.order[0];
              if (post) { if (!post.message && Array.isArray(post.file_ids) && post.file_ids.length) post.message = '[вложение]'; if (post.message) {
                let uname = "";
                try {
                  const uid = post.user_id;
                  if (uid) {
                    if (!uidCache["_u_" + uid]) {
                      const uu = await fetch("/api/v4/users/" + uid, { headers: H }).then(r => r.json());
                      if (uu && uu.username) uidCache["_u_" + uid] = uu.username;
                    }
                    uname = uidCache["_u_" + uid] || "";
                  }
                } catch (e) {}
                prev = (uname ? uname + ": " : "") + String(post.message).split(String.fromCharCode(13)).join(" ").split(String.fromCharCode(10)).join(" ").split("**").join("").slice(0, 90)
              } }
            } catch (e) {}
            }
            let unreadCount = null, mentions = null, rootCount = null, rootMentions = null;
            try {
              // ChannelUnread is authoritative; ChannelMember.msg_count is a read cursor.
              // No since-post approximation or invented collapsed-thread query parameter.
              const response = await fetch('/api/v4/users/' + encodeURIComponent(me.id) + '/channels/' + encodeURIComponent(ch.id) + '/unread', { headers: H });
              if (response.ok) {
                const unread = await response.json();
                if (unread && unread.channel_id === ch.id && unread.team_id === ch.team_id &&
                    Number.isSafeInteger(unread.msg_count) && unread.msg_count >= 0 &&
                    Number.isSafeInteger(unread.mention_count) && unread.mention_count >= 0) {
                  unreadCount = unread.msg_count;
                  mentions = unread.mention_count;
                  // Total fields include replies. Root fields are separate subsets,
                  // not extra unread messages; this API has no CRT query parameter.
                  if (Number.isSafeInteger(unread.msg_count_root) && unread.msg_count_root >= 0) rootCount = unread.msg_count_root;
                  if (Number.isSafeInteger(unread.mention_count_root) && unread.mention_count_root >= 0) rootMentions = unread.mention_count_root;
                }
              }
            } catch (e) {}
            const snapshot = { id: j.id, accountId: me.id, channelId: ch.id, at: ch.last_post_at, count: unreadCount, mentions, rootCount, rootMentions, preview: prev, messageId };
            snapshots.set(ch.id, snapshot);
            res.push(snapshot);
          }
        }
        // A logout/account switch during the fetch sequence invalidates the batch.
        const current = await get('/api/v4/users/me');
        if (!current || current.id !== me.id) return '';
        return JSON.stringify({ uidCache: uidCache, res: res });
      } catch (e) { return "" }
    })()`)))
    if (!out) return
    const d = JSON.parse(out)
    state.mmUserIds = d.uidCache || {}
    if (!pinId) state.mmChannelsAt = now
    for (const r of (d.res || [])) {
      mergeLastMessageTime(r.id, { at: r.at, dayOnly: false })
      state.mmPinCounts = state.mmPinCounts || {}
      if (typeof r.count === 'number' && Number.isFinite(r.count)) {
        state.mmPinCounts[r.id] = { count: r.count, mentions: r.mentions || 0, rootCount: r.rootCount, rootMentions: r.rootMentions,
          accountId: r.accountId, channelId: r.channelId, observedAt: Date.now() }
      }
      if (r.preview) {
      state.lastMsgPreview[r.id] = restorePreviewAuthor(r.preview, (state.msgAuth || {})[r.id], r.messageId)
      }
    }
  } catch (e) {}
  // Full MM metadata walks all pinned routes and may include slow server-side
  // user/post lookups. Give the normal batch 45 s; targeted reads stay 4.5 s.
  }, pinId ? 4500 : 45000)
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
    const act = state.lastMsgAt[p.id] || 0
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

function unreadDeltaFor(pinId, rawC, rawM) {
  const bc = state.unreadBaseC && state.unreadBaseC[pinId] !== undefined ? state.unreadBaseC[pinId] : rawC
  const bm = state.unreadBaseM && state.unreadBaseM[pinId] !== undefined ? state.unreadBaseM[pinId] : rawM
  const dC = Math.max(0, rawC - bc)
  const dM = Math.max(0, rawM - bm)
  return { dC, dM, dU: dC > 0 || dM > 0 }
}

function shouldBumpLiveAct(prevTotal, total, prevAt, nowAt) {
  return prevTotal !== undefined && total > prevTotal && prevAt > 0 && nowAt > prevAt
}

function isUsernameFallbackName(url, name) {
  const um = String(url || '').match(/#@([-\w]+)/)
  if (!um) return false
  const fallback = decodeURIComponent(um[1]).replace(/[_\.]+/g, ' ')
  return String(name || '').trim() === fallback || String(name || '').trim() === um[1]
}

function shouldAutoRenameTitle(svcId, title, url) {
  if (svcId !== 'tg') return true
  const t = String(title || '').trim()
  if (!t) return true
  if (isUsernameFallbackName(url, t)) return true
  return /^(telegram web|чат|чаты|новый чат|messenger|dialogs)$/i.test(t)
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

// Аватарка чата в строке избранного: <img> из кэша экстрактора или
// монограмма (первая буква названия, цвет — хэш названия). Появляется
// в строке сразу, картинка подменяет монограмму, когда экстрактор
// притащит data-URL из webview мессенджера.
// Аватар из шапки пин-вьюхи (для TG-пинов вне отрисованного списка)
// Serialized into TG pin guests: URL alone can lead a stale SPA header.
function __chatHubTgViewOwns(pinUrl) {
  try {
    const wanted = new URL(pinUrl), live = new URL(location.href)
    if (wanted.origin !== live.origin || wanted.pathname !== live.pathname ||
        wanted.hash.toLowerCase() !== live.hash.toLowerCase()) return false
    const peer = document.querySelector('.top .peer-title[data-peer-id], .topbar .peer-title[data-peer-id], .chat-info .peer-title[data-peer-id]')
    const owner = peer && peer.getAttribute('data-peer-id')
    if (!owner) return false
    const key = wanted.hash.slice(1)
    if (/^-?\d+$/.test(key)) return key === owner
    if (!/^@[A-Za-z0-9_]+$/.test(key)) return false
    const peers = new Set(Array.from(document.querySelectorAll('a.row-clickable')).filter(r =>
      String(r.getAttribute('href') || '').toLowerCase() === wanted.hash.toLowerCase())
      .map(r => r.getAttribute('data-peer-id')).filter(Boolean))
    return peers.size === 1 && peers.has(owner)
  } catch { return false }
}

async function grabAvatarFromPinView(wv, pinUrl) {
  // аватар берём ТОЛЬКО если вьюха показывает именно этот чат (сверка хэша),
  // иначе в строки уезжала аватарка чужого чата из шапки вьюхи
  const mm = String(pinUrl || '').match(/#([-@A-Za-z0-9_]+)/)
  const want = mm ? mm[1] : ''
  if (!want) return ''
  try {
    return await wv.executeJavaScript(`(async () => {
      const owns = () => (${__chatHubTgViewOwns.toString()})(${JSON.stringify(pinUrl)})
      if (!owns()) return ''
      const img = document.querySelector('.chat-info .avatar img, .top .avatar img, .topbar .avatar img')
      if (!img || !img.src) return ''
      if (img.src.startsWith('data:')) return img.src
      try {
        const b = await fetch(img.src).then(r => r.blob())
        if (!b || !b.size || b.size > 300000) return ''
        const data = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(''); fr.readAsDataURL(b) })
        return owns() ? data : ''
      } catch (e) { return '' }
    })()`)
  } catch (e) { return '' }
}

// Авторитетное авторство: последний пузырь в ОТКРЫТОМ чате (is-out — писал я)
async function grabViewLastMsg(wv, pinUrl) {
  const mm = String(pinUrl || '').match(/#([-@A-Za-z0-9_]+)/)
  const want = mm ? mm[1] : ''
  if (!want) return null
  try {
    return await wv.executeJavaScript(`(() => {
      if (!(${__chatHubTgViewOwns.toString()})(${JSON.stringify(pinUrl)})) return null
      const bs = [...document.querySelectorAll('.bubbles .bubble')]
      const b = bs[bs.length - 1]
      if (!b) return null
      const out = b.classList.contains('is-out')
      const nm = b.querySelector('.name, .peer-title')
      let tx = ''
      const mEl = b.querySelector('.message, .translatable-message')
      if (mEl) {
        const cl = mEl.cloneNode(true)
        cl.querySelectorAll('.time, .message-time, .reactions, .reaction, .tail').forEach(x => x.remove())
        tx = String(cl.textContent || '').trim().slice(0, 160)
      }
      if (!tx) return null
      return { out: out, name: nm ? String(nm.textContent || '').trim().slice(0, 40) : '', text: tx }
    })()`)
  } catch (e) { return null }
}

// MAX: последнее сообщение в открытом чате. У пузырей есть
// data-bubbles-variant="incoming|outgoing" — outgoing = писал пользователь.
async function grabViewLastMsgMax(wv, pinUrl) {
  const id = (String(pinUrl || '').match(/\/(-?\d+)(?:[/?#]|$)/) || [])[1] || ''
  if (!id) return null
  try {
    return await wv.executeJavaScript(`(() => {
      const wanted = new URL(${JSON.stringify(pinUrl)}), live = new URL(location.href)
      if (wanted.origin !== live.origin || wanted.pathname !== live.pathname) return null
      const msgs = [...document.querySelectorAll('.message')]
      const m = msgs[msgs.length - 1]
      if (!m) return null
      const variantEl = m.querySelector('[data-bubbles-variant]')
      const variant = variantEl ? variantEl.getAttribute('data-bubbles-variant') : ''
      const out = variant === 'outgoing'
      const nameEl = m.querySelector('.author')
      const name = nameEl ? String(nameEl.textContent || '').trim().replace(/:$/, '').slice(0, 40) : ''
      let tx = ''
      const textEl = m.querySelector('[data-message-markup], .bubbleContent .text')
      if (textEl) {
        const cl = textEl.cloneNode(true)
        cl.querySelectorAll('.meta, .time, .reactions').forEach(x => x.remove())
        tx = String(cl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160)
      }
      if (!tx) return null
      return { out: out, name: name, text: tx, dm: !out && !name }
    })()`)
  } catch (e) { return null }
}

// Фоновый обход: учим авторство последних сообщений в личках (и группах) —
// один раз на чат, дальше из msgAuth. Не трогает открытые пользователем вьюхи
// больше LRU-лимита (trimPinViews) и не печатает ничего в мессенджеры.
async function learnAuthorSweep() {
  if (state.learnBusy) return
  state.learnBusy = true
  try {
    const pins = (state.cfg.pinned || []).filter(p => /web\.telegram\.org|web\.max\.ru/.test(String(p.url || '')))
    const need = pins.filter(p => !(state.msgAuth || {})[p.id] && (state.lastMsgPreview || {})[p.id] && (state.pinViews || {})[p.id])
    const batch = need.slice(0, 4)
    for (const pin of batch) {
      try {
        const pv = state.pinViews[pin.id]
        if (!pv) continue
        const isMax = /web\.max\.ru/.test(String(pin.url || ''))
        const lb = isMax ? await grabViewLastMsgMax(pv, pin.url) : await grabViewLastMsg(pv, pin.url)
        if (!lb || !lb.text) continue
        state.msgAuth = state.msgAuth || {}
        state.msgAuth[pin.id] = { ...lb }
        state.lastMsgPreview[pin.id] = restorePreviewAuthor(state.lastMsgPreview[pin.id], lb)
        const row = document.querySelector('.chat-row[data-pin="' + pin.id + '"]')
        if (row) setRowPreview(row.querySelector('.chat-row-preview'), state.lastMsgPreview[pin.id])
        scheduleActSave()
      } catch (e) {}
    }
  } finally { state.learnBusy = false }
}

function setRowAvatar(row, dataUrl) {
  const slot = row.querySelector('.row-avatar')
  if (!slot) return
  const p = state.cfg.pinned.find(x => x.id === row.dataset.pin)
  if (!p) return
  const av = dataUrl || (state.pinAvatars || {})[p.id]
  if (av) {
    if (slot.firstChild && slot.firstChild.tagName === 'IMG') slot.firstChild.src = av
    else slot.innerHTML = '<img alt="">', slot.firstChild.src = av
    slot.style.background = ''
    slot.title = ''
  } else {
    slot.innerHTML = ''
    slot.textContent = Array.from(String(p.title).trim() || '?')[0] || '?'
    slot.style.background = badgeColor(p.title || '?')
  }
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
  if (window.__chatHubCssCancelPending) window.__chatHubCssCancelPending()
  try {
    let pending = null
    const cancelPending = () => {
      if (!pending) return
      cancelAnimationFrame(pending.frame)
      clearTimeout(pending.timer)
      pending = null
    }
    window.__chatHubCssCancelPending = cancelPending
    window.__chatHubCssMo = new MutationObserver(() => {
      if (pending) return
      const job = {}
      pending = job
      const go = () => {
        if (pending !== job) return
        cancelPending()
        apply()
      }
      job.frame = requestAnimationFrame(go)
      job.timer = setTimeout(go, 100)
    })
    window.__chatHubCssMo.observe(document.documentElement, { childList: true, subtree: true })
  } catch (e) {}
  return true
}

// Mattermost: непрочитанные избранных каналов + ВСЕ личные сообщения.
// li.unread = есть непрочитанное; в ЛИЧНЫХ чатах span.badge = число непрочитанных
// сообщений (идёт в count), в каналах = число упоминаний (идёт в mentions).
async function __chatHubMmUnread(favs) {
  const avatarBudget = { attempts: 0 }
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
    let avatar = null
    let rowLi = null
    if (slug) {
      const link = root.querySelector('a[href$="/' + kind + '/' + slug + '"]')
      const li = link ? link.closest('li') : null
      if (li) {
        rowLi = li
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
    if (f.needAvatar && rowLi) avatar = await __chatHubBoundedAvatar(rowLi, avatarBudget)
    out.push({ id: f.id, unread: unread, count: count, mentions: mentions, found: found, avatar: avatar })
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
  // Session-local, read-only webk identity mirror. Alias lookup never calls a
  // manager/RPC, persists an alias, or trusts display names/legacy tgPeerOf.
  const readAliases = () => {
    const aliases = new Map()
    const proxy = globalThis.apiManagerProxy, root = globalThis.rootScope
    const peers = proxy?.mirrors?.peers, account = proxy?.mirrors?.state
    const accountId = String(root?.myId || '')
    if (!/^[1-9]\d*$/.test(accountId) || String(account?.userId) !== accountId ||
        account?.authState?._ !== 'authStateSignedIn' || !peers || !peers[accountId]) return null
    const wanted = new Set(favs.map(f => (String(f.url || '').match(/^https:\/\/web\.telegram\.org\/k\/#@([A-Za-z0-9_]+)$/) || [])[1]?.toLowerCase()).filter(Boolean))
    // Only the username field is inspected to filter the existing identity map;
    // project id/type/photo-presence for requested pins only. No profile dumps.
    for (const key of Object.keys(peers)) {
      const peer = peers[key], username = String(peer?.username || '').toLowerCase()
      if (!wanted.has(username)) continue
      const peerId = String(peer.id || '')
      const valid = peer._ === 'user' && /^[1-9]\d*$/.test(peerId) && peerId === key
      const identity = valid ? { source: 'webk-account-peer', accountId, username, peerId, photoPresent: !!peer.photo } : null
      aliases.set(username, aliases.has(username) ? null : identity)
    }
    return { aliases, peers, account, accountId }
  }
  const aliasSnapshot = readAliases()
  const existingPhotos = window.__hubTgPhotos
  if (existingPhotos && (!aliasSnapshot || existingPhotos.peers !== aliasSnapshot.peers || existingPhotos.account !== aliasSnapshot.account)) {
    existingPhotos.entries.clear()
    existingPhotos.peers = aliasSnapshot?.peers || null
    existingPhotos.account = aliasSnapshot?.account || null
  }
  // Proven webk contract: loadAvatar(Number(peerId), userProfilePhoto, 'photo_small').
  // Downloads only the small photo, never opens a dialog or reads messages.
  // Do not await optional work: completed bytes are consumed on a later poll.
  let photoStarts = 0
  const photoProofs = new Map()
  const metadataAvatar = identity => {
    if (!identity || !aliasSnapshot) return null
    const proxy = globalThis.apiManagerProxy
    const peer = aliasSnapshot.peers[identity.peerId], photo = peer?.photo
    const numberId = Number(identity.peerId)
    if (!Number.isSafeInteger(numberId) || numberId <= 0 || photo?._ !== 'userProfilePhoto' ||
        peer.pFlags?.min || typeof proxy?.loadAvatar !== 'function') return null
    const photoKey = `${photo.photo_id}:${photo.dc_id}`
    if (!/^\d+:\d+$/.test(photoKey)) return null
    const pool = window.__hubTgPhotos || (window.__hubTgPhotos = { pending: new Set(), entries: new Map() })
    // Pending slots survive resets: timeouts/account changes cannot multiply RPCs.
    if (pool.peers !== aliasSnapshot.peers || pool.account !== aliasSnapshot.account) {
      pool.entries.clear(); pool.peers = aliasSnapshot.peers; pool.account = aliasSnapshot.account
    }
    const key = `${identity.accountId}:${identity.username}:${identity.peerId}:${photoKey}`
    const current = () => {
      const now = readAliases(), own = now?.aliases.get(identity.username)
      const live = now?.peers[identity.peerId]
      return now && now.peers === aliasSnapshot.peers && now.account === aliasSnapshot.account &&
        now.accountId === identity.accountId && own?.peerId === identity.peerId &&
        live?.photo?._ === 'userProfilePhoto' && `${live.photo.photo_id}:${live.photo.dc_id}` === photoKey
    }
    if (!current()) return null
    const cached = pool.entries.get(key)
    if (cached && (cached.pending || Date.now() - cached.at < 60000)) {
      if (cached.data) photoProofs.set(identity.username, current)
      return cached.data || null
    }
    if (photoStarts >= 2 || pool.pending.size >= 2) return null
    photoStarts++
    if (pool.entries.size >= 32) {
      const victim = [...pool.entries].find(([, value]) => !value.pending)
      if (!victim) return null
      pool.entries.delete(victim[0])
    }
    const entry = { at: Date.now(), data: null, pending: true }
    pool.entries.set(key, entry)
    const token = {}; pool.pending.add(token)
    ;(async () => {
      let timer, controller
      try {
        const url = await proxy.loadAvatar(numberId, photo, 'photo_small')
        if (!current() || typeof url !== 'string' || !url.startsWith('blob:https://web.telegram.org/')) return
        controller = new AbortController()
        timer = setTimeout(() => controller.abort(), 1500)
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) return
        const blob = await response.blob()
        if (!/^image\/(jpeg|png|webp)$/.test(blob.type) || blob.size <= 0 || blob.size > 65536) return
        const bytes = new Uint8Array(await blob.arrayBuffer())
        if (bytes.length !== blob.size || !current() || pool.entries.get(key) !== entry) return
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte)
        entry.data = `data:${blob.type};base64,${btoa(binary)}`
      } catch (_) { /* Unknown, not a no-photo claim; retry cooldown remains. */ }
      finally { clearTimeout(timer); entry.pending = false; entry.at = Date.now(); pool.pending.delete(token) }
    })()
    return null
  }
  // Loaded worker src/lib/storages/dialogs.ts: getDialogOnly is a direct
  // this.dialogs[peerId] read. Only user peers are verified here (no forum math).
  // Never retain unread snapshots across polls: an old positive cannot hide a read.
  const dialogPool = window.__hubTgDialogs || (window.__hubTgDialogs = { pending: new Set(), generation: 0 })
  const dialogGeneration = favs.some(f => f.needDialogMetadata === true || f.needMessageMetadata === true) ? ++dialogPool.generation : dialogPool.generation
  const dialogManager = globalThis.rootScope?.managers?.dialogsStorage
  const dialogResults = new Map()
  const messageTimes = new Map(), messageProofs = new Map()
  const messageRequested = new Set()
  const messageProxy = globalThis.apiManagerProxy, messageMirror = messageProxy?.mirrors?.messages
  const numericIdentity = (url, snapshot) => {
    const peerId = (String(url || '').match(/^https:\/\/web\.telegram\.org\/k\/#(-?[1-9]\d*)$/) || [])[1]
    const n = Number(peerId), peer = snapshot?.peers[peerId]
    if (!peer || !Number.isSafeInteger(n) || !n || peer.id !== Math.abs(n) ||
        !(n > 0 ? peer._ === 'user' : ['chat', 'channel'].includes(peer._))) return null
    return { source: 'webk-account-peer', accountId: snapshot.accountId, username: '', peerId, kind: peer._ }
  }
  const ownsDialog = (identity, d) => {
    const peer = d?.peer, n = Number(identity.peerId)
    return d?._ === 'dialog' && (n > 0 ? peer?._ === 'peerUser' && peer.user_id === n :
      identity.kind === 'chat' ? peer?._ === 'peerChat' && peer.chat_id === -n :
      identity.kind === 'channel' && peer?._ === 'peerChannel' && peer.channel_id === -n)
  }
  // Loaded proxy: history key + global-ID routing read ONLY its local mirror.
  // Do not use getMessageByPeer (logs fallback), history, fetch or message RPCs.
  const cachedTime = (identity, d) => {
    if (!messageMirror || messageProxy?.mirrors?.messages !== messageMirror ||
        typeof messageProxy.getHistoryMessagesStorage !== 'function' ||
        typeof messageProxy.getMessageFromStorage !== 'function') return null
    const mid = d.top_message
    if (!Number.isSafeInteger(mid) || mid <= 0) return null
    const key = messageProxy.getHistoryMessagesStorage(Number(identity.peerId))
    const m = messageProxy.getMessageFromStorage(key, mid)
    if (!m || !['message', 'messageService'].includes(m._) || m.mid !== mid ||
        String(m.peerId) !== identity.peerId || !Number.isSafeInteger(m.date) ||
        m.date <= 0 || !Number.isSafeInteger(m.date * 1000)) return null
    const at = m.date * 1000
    if (!Number.isFinite(new Date(at).getTime())) return null
    messageProofs.set(identity.peerId, () => {
      try { return messageProxy === globalThis.apiManagerProxy &&
        messageProxy.mirrors.messages === messageMirror &&
        messageProxy.getMessageFromStorage(key, mid) === m && m.mid === mid &&
        String(m.peerId) === identity.peerId && m.date * 1000 === at }
      catch (_) { return false }
    })
    return { at, dayOnly: false, source: 'webk-top-message-cache',
      accountId: identity.accountId, peerId: identity.peerId, messageId: String(mid) }
  }
  // UI-only projection of one proven current top message; never log/return the
  // cache object, entities, media payloads or unrelated profile fields.
  const cachedPreview = (identity, time) => {
    if (!time || !dialogCurrent(identity) || !messageProofs.get(identity.peerId)?.()) return null
    const key = messageProxy.getHistoryMessagesStorage(Number(identity.peerId))
    const m = messageProxy.getMessageFromStorage(key, Number(time.messageId))
    if (!m || !['message', 'messageService'].includes(m._) || String(m.mid) !== time.messageId ||
        String(m.peerId) !== identity.peerId || !m.pFlags || typeof m.pFlags !== 'object' ||
        ![undefined, true, false].includes(m.pFlags.out)) return null
    const compact = (value, limit) => typeof value === 'string' ? value.slice(0, 4096).replace(/\s+/g, ' ').trim().slice(0, limit) : ''
    const out = m.pFlags?.out === true
    const senderId = Number.isSafeInteger(m.fromId) && m.fromId !== 0 ? String(m.fromId) : ''
    const sender = senderId && aliasSnapshot.peers[senderId]
    let author = out || (identity.peerId === identity.accountId && senderId === identity.accountId) ? 'Вы' : ''
    if (!author && sender && sender.id === Math.abs(Number(senderId))) {
      if (sender._ === 'user' && Number(senderId) > 0) author = compact([compact(sender.first_name, 128), compact(sender.last_name, 128)].filter(Boolean).join(' '), 128) || compact(sender.username, 128)
      else if (Number(senderId) < 0 && ['chat', 'channel'].includes(sender._)) author = compact(sender.title, 128)
    }
    const kind = m._ === 'messageService' ? 'service' : 'message'
    const text = kind === 'service' ? '[Служебное сообщение]' : compact(m.message, 240)
    const mediaType = kind === 'message' ? m.media?._ : ''
    const media = { messageMediaPhoto: '[Фото]', messageMediaDocument: '[Документ]', messageMediaPoll: '[Опрос]', messageMediaGeo: '[Геопозиция]', messageMediaGeoLive: '[Геопозиция]', messageMediaContact: '[Контакт]', messageMediaWebPage: '[Ссылка]' }
    const body = text || media[mediaType] || (mediaType && mediaType !== 'messageMediaEmpty' ? '[Медиа]' : '[Пустое сообщение]')
    if (!dialogCurrent(identity) || !messageProofs.get(identity.peerId)?.()) return null
    return { source: 'webk-top-message-cache', accountId: identity.accountId, peerId: identity.peerId,
      messageId: time.messageId, out, senderId, author, kind: kind === 'service' ? kind : mediaType && mediaType !== 'messageMediaEmpty' ? 'media' : text ? 'text' : 'empty',
      text: body, preview: author ? author + ': ' + body : body }
  }
  const dialogCurrent = identity => {
    const now = readAliases()
    return dialogPool.generation === dialogGeneration && now && aliasSnapshot &&
      now.account === aliasSnapshot.account && now.peers === aliasSnapshot.peers &&
      now.accountId === identity.accountId && (identity.username
        ? now.aliases.get(identity.username)?.peerId === identity.peerId
        : numericIdentity('https://web.telegram.org/k/#' + identity.peerId, now)?.kind === identity.kind) &&
      globalThis.rootScope?.managers?.dialogsStorage === dialogManager
  }
  if (aliasSnapshot && typeof dialogManager?.getDialogOnly === 'function') {
    const requested = new Map()
    for (const f of favs) {
      if (f.needDialogMetadata !== true && f.needMessageMetadata !== true) continue // service view explicitly grants access
      const name = (String(f.url || '').match(/^https:\/\/web\.telegram\.org\/k\/#@([A-Za-z0-9_]+)$/) || [])[1]?.toLowerCase()
      const numeric = numericIdentity(f.url, aliasSnapshot)
      const identity = aliasSnapshot.aliases.get(name) ||
        (f.needMessageMetadata === true || numeric?.kind === 'user' ? numeric : null)
      if (identity && requested.size < 64) {
        requested.set(identity.peerId, identity)
        if (f.needMessageMetadata === true) messageRequested.add(identity.peerId)
      }
    }
    const queue = [...requested.values()], deadline = Date.now() + 800
    const worker = async () => {
      while (queue.length && Date.now() < deadline && dialogPool.pending.size < 2) {
        const identity = queue.shift(), peerId = Number(identity.peerId)
        if (!Number.isSafeInteger(peerId) || !peerId || !dialogCurrent(identity)) continue
        const token = {}; dialogPool.pending.add(token)
        try {
          const d = await dialogManager.getDialogOnly(peerId)
          if (messageRequested.has(identity.peerId) && dialogCurrent(identity) &&
              Date.now() < deadline && ownsDialog(identity, d)) {
            try {
              const time = cachedTime(identity, d)
              if (time) {
                const latest = await dialogManager.getDialogOnly(peerId)
                if (dialogCurrent(identity) && Date.now() < deadline && ownsDialog(identity, latest) &&
                    String(latest.top_message) === time.messageId && messageProofs.get(identity.peerId)?.()) {
                  messageTimes.set(identity.peerId, time)
                }
              }
            } catch (_) { /* Optional timestamp failure cannot suppress unread. */ }
          }
          if (!dialogCurrent(identity) || Date.now() >= deadline || d?._ !== 'dialog' ||
              d.peer?._ !== 'peerUser' || String(d.peer.user_id) !== identity.peerId ||
              !Number.isSafeInteger(d.unread_count) || d.unread_count < 0 ||
              !Number.isSafeInteger(d.unread_mentions_count) || d.unread_mentions_count < 0 ||
              !d.pFlags || typeof d.pFlags !== 'object' ||
              ![undefined, true, false].includes(d.pFlags.unread_mark)) continue
          // unread_mark is an optional true flag: loaded update handler deletes
          // it on read. A missing flags container/counter is NOT a verified zero.
          dialogResults.set(identity.peerId, { count: d.unread_count, mentions: d.unread_mentions_count,
            manualUnread: d.pFlags.unread_mark === true,
            unreadSource: { source: 'webk-dialogsStorage', accountId: identity.accountId,
              peerId: identity.peerId, generation: dialogGeneration, observedAt: Date.now() } })
        } catch (_) { /* Missing/error stays unknown; no reloadConversation fallback. */ }
        finally { dialogPool.pending.delete(token) }
      }
    }
    if (queue.length && dialogPool.pending.size < 2) {
      let timer
      try { await Promise.race([Promise.all([worker(), worker()]), new Promise(resolve => { timer = setTimeout(resolve, 800) })]) }
      finally { clearTimeout(timer); queue.length = 0 }
    }
  }
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
      const pinnedRow = favs.some(f => {
        const hash = String(f.url || '').split('#')[1] || ''
        const alias = aliasSnapshot?.aliases.get(hash.replace(/^@/, '').toLowerCase())
        return hash === pid || alias?.peerId === pid || '#' + hash === r.getAttribute('href')
      })
      // Cache-enabled polls never read sidebar subtitles: those may be drafts.
      const st = pinnedRow && !messageMirror && !favs.some(f => f.needDialogMetadata || f.needMessageMetadata || f.needMessagePreview) ? r.querySelector('.dialog-subtitle') : null
      let preview = st ? String(st.textContent || '').replace(/\s+/g, ' ').trim() : ''
      preview = preview.replace(/^(\d{1,2}:\d{2}|\d{2}\.\d{2}(\.\d{2})?)\s+/, '').slice(0, 90)
      if (/^you:\s*/i.test(preview)) preview = 'Вы: ' + preview.replace(/^you:\s*/i, '')
      // Missing sender metadata remains unknown; a chat title is not evidence.
      if (/^you:\s*/i.test(preview)) preview = 'Вы: ' + preview.replace(/^you:\s*/i, '')
      list.push({
        pid: pid,
        u: r.getAttribute('href') || '',
        title: title,
        time: tp ? tp.textContent.trim() : '',
        unreadTxt: bd ? bd.textContent.trim() : '',
        mentions: mentions,
        unreadTitle: /unreadPeerTitle/.test(String(t.className)),
        preview: preview,
        idx: idx,
        el: pinnedRow ? (() => {
          const shell = r.cloneNode(false), avatar = r.querySelector('.dialog-avatar')
          if (avatar) shell.appendChild(avatar.cloneNode(true))
          if (t?.cloneNode && shell.appendChild) shell.appendChild(t.cloneNode(true))
          return shell
        })() : null
      })
    })
    return list
  }
  const avatarBudget = { attempts: 0 }
  const supH = (() => { const s = document.querySelector('.search-super'); return s ? s.getBoundingClientRect().height : 0 })()
  const rows = await __chatHubScanRows(() => collect().map(r => ({ ...r, key: r.pid })), '.chatlist-parts', 'tg',
    allowScroll && !favs.some(f => f.needDialogMetadata === true && /^https:\/\/web\.telegram\.org\/k\/#(?:@[A-Za-z0-9_]+|[1-9]\d*)$/.test(f.url || '')) && supH < 50 && favs.some(f => f.needAvatar || f.needUnread))
  const norm = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '')
  const out = []
  for (const f of favs) {
    // Canonical numeric IDs and username links never fall back to titles.
    const urlPid = (String(f.url || '').match(/#(-?\d+)$/) || [])[1] || ''
    const username = (String(f.url || '').match(/#(@[A-Za-z0-9_]+)$/) || [])[1] || ''
    // A canonical address outranks stale cache and all title heuristics.
    // Username aliases require direct evidence; a legacy numeric cache alone
    // does not prove that the username still belongs to that peer.
    const aliasName = username.slice(1).toLowerCase()
    const canonicalUsername = /^https:\/\/web\.telegram\.org\/k\/#@[A-Za-z0-9_]+$/.test(f.url || '')
    let identity = canonicalUsername && aliasSnapshot?.aliases.get(aliasName) || null
    const links = username ? rows.filter(x => x.u.toLowerCase() === '#' + username.toLowerCase()) : []
    const identityScoped = !!username && (!!globalThis.apiManagerProxy || !!f.identityKey)
    const conflict = !!username && (identityScoped && !identity || identity && links.some(x => x.pid !== identity.peerId))
    if (conflict) identity = null
    const pid = urlPid || identity?.peerId || (!username ? String(f.pid || '') : '')
    const matches = conflict ? [] : username && !identity ? links : rows.filter(x => pid && x.pid === pid)
    const uniquePeers = new Set(matches.map(x => x.pid))
    let row = uniquePeers.size === 1 ? matches[0] : null
    let rowExact = !!row // pid = точная идентичность: аватар/совпадение надёжны
    let fuzzyUnique = false // единственный кандидат по словам названия — тоже безопасен для аватара
    // Самоочистка отравленного pid-кэша: строка по pid найдена, но заголовок
    // не пересекается с заголовком пина (ни одного слова >= 4 символов) и pid
    // не из URL пина — кэш устарел/ошибочен, строку не засчитываем
    let pidStale = false
    if (row) {
      const upid = (String(f.url || '').match(/#(-?\d+)/) || [])[1]
      const urlExact = upid && String(upid) === String(row.pid)
      if (f.pid && !urlExact && !username) {
        const ns = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '')
        const stopW = new Set(['ext', 'int', 'астра', 'astrа', 'astra', 'chat', 'чат', 'группа', 'team', 'test', 'rb', 'vm'])
        const ws = String(f.title || '').split(/[\s|,/()]+/).map(w => ns(w)).filter(w => w.length >= 4 && !stopW.has(w))
        const rn = ns(row.title)
        const ok = !!rn && ws.some(w => rn.indexOf(w) >= 0)
        if (!ok) { pidStale = true; row = null; rowExact = false }
      }
    }
    if (!row && !urlPid && !username && !pid && f.title) {
      const ft = String(f.title).trim()
      let cands = rows.filter(x => x.title.trim() === ft)
      const exactOnly = cands.length > 0
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
      if (cands.length === 1) { row = cands[0]; rowExact = exactOnly; fuzzyUnique = !exactOnly }
    }
    let unread = false
    let count = 0
    let mentions = 0
    let rank = 9999
    let time = null
    let found = false
    let avatar = null
    if (row) {
      found = true
      rank = row.idx
      if (row.time) time = row.time
      count = parseN(row.unreadTxt)
      mentions = row.mentions
      if (count > 0 || row.unreadTitle) unread = true
      // аватар только при точном совпадении строки: нечёткий матч давал
      // чужое фото (два чата одного человека получали одну аватарку)
      const identityChanged = typeof f.identityKey === 'string' && identity && f.identityKey !== `${identity.accountId}:${identity.username}:${identity.peerId}`
      if ((f.needAvatar || identityChanged) && (rowExact || fuzzyUnique)) avatar = await __chatHubBoundedAvatar(row.el, avatarBudget)
    }
    if (!avatar && f.needAvatar && f.needMetadataAvatar === true && identity) avatar = metadataAvatar(identity)
    // Numeric user IDs use the same verified dialog projection, not DOM presence.
    // Keep this proof separate from username/avatar identity and signed-peer time.
    const numericUser = numericIdentity(f.url, aliasSnapshot)
    const dialogScoped = f.needDialogMetadata === true && (canonicalUsername || /^https:\/\/web\.telegram\.org\/k\/#[1-9]\d*$/.test(f.url || ''))
    const dialogIdentity = identity || (dialogScoped && numericUser?.kind === 'user' ? numericUser : null)
    const dialog = dialogIdentity && dialogCurrent(dialogIdentity) && dialogResults.get(dialogIdentity.peerId)
    if (dialogScoped && !dialog) { found = false; count = 0; mentions = 0; unread = false }
    if (dialog) {
      found = true; count = dialog.count; mentions = dialog.mentions
      unread = count > 0 || mentions > 0 || dialog.manualUnread
    }
    out.push({ id: f.id, dialogScoped, dialogIdentity, identityScoped, identity, unreadSource: dialog?.unreadSource || null, manualUnread: dialog ? dialog.manualUnread : null, unread: unread, count: count, mentions: mentions, rank: rank, time: time, found: found, exact: rowExact, pid: row ? row.pid : null, rowTitle: row ? row.title : '', pidStale: pidStale, avatar: avatar, preview: row ? ((row.preview || '')) : '' })
  }
  // Recheck after every asynchronous collection/avatar phase. Mirror replacement
  // is the webk account-reset boundary; usernames can also change in-place.
  const finalAliases = readAliases()
  const sameAccount = !aliasSnapshot || finalAliases && finalAliases.peers === aliasSnapshot.peers &&
    finalAliases.account === aliasSnapshot.account && finalAliases.accountId === aliasSnapshot.accountId
  const previewDeadline = Date.now() + 800
  for (let i = 0; i < out.length; i++) {
    const r = out[i], current = r.identity && finalAliases?.aliases.get(r.identity.username)
    const photoProof = photoProofs.get(r.identity?.username)
    if (photoProof && !photoProof()) r.avatar = null
    const timeIdentity = r.identity || (!r.identityScoped && numericIdentity(favs[i].url, aliasSnapshot))
    r.messageIdentity = favs[i].needMessageMetadata === true && timeIdentity && dialogCurrent(timeIdentity) ? timeIdentity : null
    r.messageTime = favs[i].needMessageMetadata === true && timeIdentity && dialogCurrent(timeIdentity) && messageProofs.get(timeIdentity.peerId)?.()
      ? messageTimes.get(timeIdentity.peerId) || null : null
    r.previewScoped = favs[i].needMessagePreview === true
    if (r.previewScoped) r.preview = ''
    if (r.previewScoped && r.messageTime && sameAccount && dialogPool.pending.size < 2 && Date.now() < previewDeadline) {
      const token = {}; dialogPool.pending.add(token)
      let timer
      // Recheck top_message AFTER row/avatar awaits and BEFORE touching a body.
      // A timeout retains its physical slot until the local manager call settles.
      try {
        const pending = Promise.resolve().then(() => dialogManager.getDialogOnly(Number(timeIdentity.peerId)))
          .finally(() => dialogPool.pending.delete(token))
        const latest = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, previewDeadline - Date.now())) })])
        if (Date.now() < previewDeadline && dialogCurrent(timeIdentity) && ownsDialog(timeIdentity, latest) &&
            String(latest.top_message) === r.messageTime.messageId) {
          r.previewReady = true
        }
      } catch (_) { /* Unknown preview; never expose cache errors or contents. */ }
      finally { clearTimeout(timer) }
    }
    if (r.dialogIdentity && !dialogCurrent(r.dialogIdentity)) {
      r.dialogIdentity = null
      r.found = false; r.unreadSource = null; r.manualUnread = null
      r.unread = false; r.count = 0; r.mentions = 0
    }
    if (!sameAccount || r.identity && (!current || current.peerId !== r.identity.peerId)) {
      out[i] = { id: r.id, previewScoped: r.previewScoped, dialogScoped: r.dialogScoped, unreadSource: null, manualUnread: null, identityScoped: r.identityScoped, identity: null, found: false, exact: false, pid: null, avatar: null,
        unread: false, count: 0, mentions: 0, rank: 9999, time: null, preview: '' }
    }
  }
  // Later pin confirmations can await: invalidate earlier projections if the
  // account, alias, message cache or generation changed meanwhile.
  for (let i = 0; i < out.length; i++) {
    const r = out[i], identity = r.messageIdentity
    const now = readAliases()
    const accountCurrent = !aliasSnapshot || now && now.peers === aliasSnapshot.peers &&
      now.account === aliasSnapshot.account && now.accountId === aliasSnapshot.accountId
    if (!accountCurrent || r.identity && now?.aliases.get(r.identity.username)?.peerId !== r.identity.peerId) {
      out[i] = { id: r.id, previewScoped: r.previewScoped, identityScoped: r.identityScoped,
        dialogScoped: r.dialogScoped, identity: null, dialogIdentity: null, messageIdentity: null,
        messageTime: null, messagePreview: null, found: false, exact: false, pid: null, preview: '', avatar: null,
        unreadSource: null, unread: false, count: 0, mentions: 0 }
      continue
    }
    if (r.messageTime && (!identity || !dialogCurrent(identity) || !messageProofs.get(identity.peerId)?.())) {
      r.messageTime = null; r.messageIdentity = null
    }
    if (r.dialogIdentity && !dialogCurrent(r.dialogIdentity)) {
      r.dialogIdentity = null; r.found = false; r.unreadSource = null
      r.manualUnread = null; r.unread = false; r.count = 0; r.mentions = 0
    }
    if (r.previewScoped) {
      r.messagePreview = null; r.preview = ''; r.messageId = null
      if (r.previewReady && identity && dialogCurrent(identity) && messageProofs.get(identity.peerId)?.()) {
        try {
          r.messagePreview = cachedPreview(identity, r.messageTime)
          if (r.messagePreview) { r.preview = r.messagePreview.preview; r.messageId = r.messagePreview.messageId }
        } catch (_) { /* Missing contract is unknown; no diagnostic contents. */ }
      }
      delete r.previewReady
    }
  }
  // п.20: суммы по ВСЕМ строкам списка (не только избранному) — на вкладку TG:
  // всего непрочитанных (все бейджи, включая серые заглушенных) и упоминания
  // (красный бейдж webk — упоминание/личное, как в строках избранного)
  let svcTotal = 0
  let svcMentions = 0
  for (const r of rows) {
    svcTotal += parseN(String(r.unreadTxt || '').replace(/^@/, ''))
    svcMentions += r.mentions || 0
  }
  return JSON.stringify({ favs: out, svcTotals: null, observedTotals: { total: svcTotal, mentions: svcMentions }, coverage: { complete: false } })
}

// MAX: строка чата по названию (span.name — НЕ span.text, это текст последнего
// сообщения), число в .indicator = непрочитанные (упоминаний не видно).
// Позиция строки = активность: список MAX отсортирован по свежести.
function formatMaxPreview(text, author) {
  let preview = String(text || '').replace(/\s+/g, ' ').trim()
  const authorRaw = String(author || '').trim().replace(/:$/, '')
  if (authorRaw && preview) {
    const a1 = authorRaw + ':'
    if (preview.indexOf(a1) === 0) preview = preview.slice(a1.length).trim()
    else if (preview.indexOf(authorRaw) === 0) preview = preview.slice(authorRaw.length).trim()
    return authorRaw + ': ' + preview.replace(/^\s+/, '')
  }
  const am = preview.match(/^([^:]{2,40}):\s+/)
  if (am && !/^(https?|ftp|mailto)$/i.test(am[1])) return am[1] + ': ' + preview.slice(am[0].length).trim()
  return preview
}

// One short chunk per guest. Only a numeric cursor survives between calls;
// observations/DOM snapshots belong to this response, never become falsely fresh.
// collect() must synchronously copy values or detach rows before the next await.
async function __chatHubScanRows(collect, selector, key, allowScroll) {
  const rows = new Map()
  const take = () => { for (const r of collect()) rows.set(r.key, r) }
  take()
  const focused = () => typeof document.hasFocus === 'function' && document.hasFocus()
  const scans = window.__hubVirtualScans || (window.__hubVirtualScans = {})
  const scan = scans[key] || (scans[key] = { cursor: 0, at: 0, busy: false })
  if (!allowScroll || focused() || scan.busy || Date.now() - scan.at < 15000) return [...rows.values()]
  const c = Array.from(document.querySelectorAll(selector)).find(c => {
    const r = c.getBoundingClientRect(); return r.width > 50 && r.height > 50
  })
  if (!c) return [...rows.values()]
  scan.busy = true
  scan.at = Date.now()
  const original = c.scrollTop, started = Date.now()
  let expected = original
  const safe = () => !focused() && !window.__hubVirtualSweepBlocked && c.isConnected !== false && c.scrollTop === expected
  const move = value => { c.scrollTop = value; expected = c.scrollTop; c.dispatchEvent(new Event('scroll', { bubbles: true })) }
  try {
    if (safe()) {
      move(Math.min(scan.cursor, Math.max(0, c.scrollHeight - c.clientHeight)))
      for (let step = 0; step < 16; step++) {
        await new Promise(resolve => setTimeout(resolve, 150))
        if (!safe()) break
        take()
        const next = Math.min(c.scrollTop + Math.max(1, c.clientHeight * 0.8), Math.max(0, c.scrollHeight - c.clientHeight))
        scan.cursor = next <= c.scrollTop ? 0 : next
        if (next <= c.scrollTop || step === 15 || Date.now() - started >= 2400) break
        move(next)
      }
    }
  } finally {
    try { if (safe()) move(original) } finally { scan.busy = false }
  }
  return [...rows.values()]
}

// Optional images cannot consume the unread scheduler's entire 4.5s budget.
async function __chatHubBoundedAvatar(row, budget) {
  if (!row || budget.attempts++ >= 4) return null
  const physical = window.__hubAvatarWork || (window.__hubAvatarWork = { pending: 0 })
  if (physical.pending >= 4) return null
  let lazySameOrigin = false
  try {
    const img = row.querySelector && row.querySelector('img[loading="lazy"][src]')
    lazySameOrigin = !!(img && img.src && new URL(img.src, location.href).origin === location.origin)
  } catch (e) {}
  physical.pending++
  const work = Promise.resolve().then(() => __grabAvatar(row)).finally(() => { physical.pending-- })
  let timer
  try {
    return await Promise.race([work,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), lazySameOrigin ? 700 : 150) })])
  } catch { return null } finally { clearTimeout(timer) }
}

async function __chatHubMaxUnread(favs, allowScroll) {
  const avatarBudget = { attempts: 0 }
  // MAX currently exposes only a virtual data-index, not immutable chat ID.
  // Keep no-href coverage until a verified adapter exists, but do not collapse
  // duplicate titles before checking ambiguity (see docs/max-telemost-identities.md).
  const collect = () => {
    const occurrences = new Map()
    return Array.from(document.querySelectorAll('aside div.item')).map((r, i) => {
      const name = (r.querySelector('span.name') || r.querySelector('h3.title'))?.textContent.trim() || 'row:' + i
      const occurrence = occurrences.get(name) || 0
      occurrences.set(name, occurrence + 1)
      return { key: name + ':' + occurrence, el: r.cloneNode(true) }
    })
  }
  const items = (await __chatHubScanRows(collect, '.scrollable.scrollListScrollable', 'max',
    allowScroll && favs.some(f => f.needAvatar || f.needUnread))).map(r => r.el)
  const out = []
  const nameOf = item => {
    const el = item.querySelector('span.name') || item.querySelector('h3.title')
    return el ? el.textContent.trim() : ''
  }
  // Только контейнер бейджа: числовое превью/название не является счётчиком.
  // Читаем один раз, даже если внутри indicator несколько вложенных span.
  const countOf = item => {
    for (const badge of item.querySelectorAll('.indicator')) {
      const text = String(badge.textContent || '').trim()
      if (/^\d+$/.test(text)) return Number(text)
    }
    return 0
  }
  for (const f of favs) {
    let unread = false
    let count = 0
    let rank = 9999
    let time = null
    let avatar = null
    const candidates = items.map((item, index) => ({ item, index })).filter(r => nameOf(r.item) === String(f.title).trim())
    const duplicatePin = favs.some(other => other.id !== f.id && String(other.title).trim() === String(f.title).trim())
    const idx = !duplicatePin && candidates.length === 1 ? candidates[0].index : -1
    if (idx >= 0) {
      rank = idx
      // время последнего сообщения («17:30», «пн», «Nov 8»)
      const meta = items[idx].querySelector('.meta')
      if (meta) time = meta.textContent.trim()
      count = countOf(items[idx])
      unread = count > 0
      if (f.needAvatar) avatar = await __chatHubBoundedAvatar(items[idx], avatarBudget)
    }
    // текст последнего сообщения — именно span.text.svelte-q2jdqb;
    // числовые бейджи непрочитанных живут в других классах (text--20/indicator)
    const prevEl = idx >= 0 ? (items[idx].querySelector('span.text.svelte-q2jdqb') || null) : null
    let preview = prevEl ? String(prevEl.textContent || '') : ''
    // MAX: у групп есть отдельный span.author («Илья М:»), у части строк
    // автор вшит в начало текста. Формируем единое «Автор: текст».
    const authorEl = idx >= 0 ? items[idx].querySelector('span.author') : null
    preview = formatMaxPreview(preview, authorEl ? authorEl.textContent : '')
    out.push({ id: f.id, found: idx >= 0, unread: unread, count: count, mentions: 0, rank: rank, time: time, avatar: avatar, preview: preview.slice(0, 110) })
  }
  // п.20: общая сумма непрочитанных по ВСЕМУ списку MAX — на вкладку.
  // Маркеров упоминаний список MAX не показывает — только общее число.
  let svcTotal = 0
  for (const it of items) svcTotal += countOf(it)
  return JSON.stringify({ favs: out, svcTotals: null, observedTotals: { total: svcTotal, mentions: 0 }, coverage: { complete: false } })
}

// Яндекс Чат (Телемост): строки списка .yamb-chat-list-item, имя —
// .yamb-chat-list-item__name, время последнего сообщения — .ui-entity-block-date.
// Непрочитанные: контейнер .yamb-chat-list-item__badges — при непрочитанных
// туда рендерится бейдж с числом (aria-labelledby строки ссылается на
// элемент «<id>_unread», в DOM он появляется только с бейджем).
async function __chatHubYdxUnread(favs, allowScroll) {
  const avatarBudget = { attempts: 0 }
  // Verified Telemost row contract: the row's React owner passes chatId to
  // the list-item component and its select handler. DOM aria IDs are hashes,
  // not chat IDs. Read only that scalar, before cloneNode drops React state.
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  const validId = new RegExp('^(?:[0-9]+/[0-9]+/' + uuid + '|' + uuid + '_' + uuid + ')$')
  const own = (o, k) => o && Object.getOwnPropertyDescriptor(o, k)?.value
  const branchId = (fiber, row) => {
    if (!fiber || fiber.stateNode !== row) return ''
    let id = ''
    for (let n = fiber.return, depth = 0; n && depth < 12; n = n.return, depth++) {
      if (typeof n.type === 'string') break // never borrow the containing list's state
      const value = own(n.memoizedProps, 'chatId')
      if (value !== undefined) {
        if (typeof value !== 'string' || !validId.test(value) || (id && id !== value)) return ''
        id = value
      }
    }
    return id
  }
  const rowId = row => {
    const keys = Object.keys(row).filter(k => k.startsWith('__reactFiber$'))
    if (keys.length !== 1) return ''
    const fiber = own(row, keys[0]), id = branchId(fiber, row)
    // React keeps both trees. During a recycled-row identity transition neither
    // stale nor work-in-progress identity is authoritative: retain old metadata.
    if (fiber?.alternate && branchId(fiber.alternate, row) !== id) return ''
    return id
  }
  // Verified 3.2.7 sidebar rt -> module 1193 EO: non-draft date is
  // message.timestamp or conversations[chatId].last_timestamp, in microseconds.
  const rowTime = (row, chatId) => {
    if (!chatId) return null
    const fiber = own(row, Object.keys(row).find(k => k.startsWith('__reactFiber$')))
    const branch = root => {
      let date
      for (let n = root?.return, depth = 0; n && depth < 12; n = n.return, depth++) {
        if (typeof n.type === 'string') break
        const props = n.memoizedProps
        if (own(props, 'chatId') !== chatId || !Object.getOwnPropertyDescriptor(props, 'date')) continue
        const value = own(props, 'date')
        if (['date', 'isDraft', 'status'].some(k => {
          const descriptor = Object.getOwnPropertyDescriptor(props, k)
          return descriptor && !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        }) || ![undefined, false].includes(own(props, 'isDraft')) ||
            ![undefined, 'sent', 'seen'].includes(own(props, 'status')) ||
            !Number.isSafeInteger(value) || value < 946684800000000 || value > Date.now() * 1000 ||
            (date !== undefined && date !== value)) return null
        date = value
      }
      return date ?? null
    }
    const date = branch(fiber)
    if (date === null || (fiber.alternate && branch(fiber.alternate) !== date)) return null
    return { at: Math.floor(date / 1000), dayOnly: false, source: 'telemost-row-date', chatId }
  }
  const pinIdentity = url => {
    try {
      const u = new URL(url)
      if (u.origin !== 'https://telemost.yandex.ru' || u.username || u.password) return null
      const m = u.pathname.match(/^\/(chats|user)\/([^/]+)\/?$/)
      if (!m) return null
      const id = decodeURIComponent(m[2])
      if (m[1] === 'chats') return validId.test(id) ? { kind: 'chats', id } : null
      return new RegExp('^' + uuid + '$').test(id) ? { kind: 'user', id } : null
    } catch { return null }
  }
  const collect = () => {
    const occurrences = new Map()
    return Array.from(document.querySelectorAll('.yamb-chat-list-item')).map((r, i) => {
      const chatId = rowId(r), base = chatId || 'unknown:' + i
      const occurrence = occurrences.get(base) || 0
      occurrences.set(base, occurrence + 1)
      return { key: base + ':' + occurrence, chatId, messageTime: rowTime(r, chatId), el: r.cloneNode(true) }
    })
  }
  const rows = await __chatHubScanRows(collect, '.ui-scroller.ui-virtual-list__scroller', 'ydx',
    allowScroll && favs.some(f => f.needAvatar || f.needUnread))
  const items = rows.map(r => r.el)
  const out = []
  for (const f of favs) {
    let rank = 9999
    let time = null
    let unread = false
    let count = 0
    let avatar = null
    const identity = pinIdentity(f.url)
    const candidates = identity ? rows.map((r, i) => ({ ...r, index: i })).filter(r =>
      identity.kind === 'chats' ? r.chatId === identity.id :
        r.chatId.includes('_') && r.chatId.split('_').includes(identity.id)) : []
    const idx = candidates.length === 1 ? candidates[0].index : -1
    if (idx >= 0) {
      rank = idx
      // Displayed date may be a draft timestamp; never promote it to activity.
      const badges = items[idx].querySelector('.yamb-chat-list-item__badges')
      if (badges) {
        const txt = (badges.textContent || '').trim()
        if (txt) {
          const n = parseInt(txt.replace(/\D+/g, ''), 10)
          if (n > 0) { count = n; unread = true }
          else unread = true // нечисловой бейдж (точка/иконка «есть новое»)
        }
      }
      if (f.needAvatar) avatar = await __chatHubBoundedAvatar(items[idx], avatarBudget)
    }
    const prevEl2 = idx >= 0 ? (items[idx].querySelector('[id$="_text"]') || items[idx].querySelector('.yamb-chat-list-item__preview, .yamb-chat-list-item__last-message, .ui-entity-block-text')) : null
    out.push({ id: f.id, found: idx >= 0, unread: unread, count: count, mentions: 0, rank: rank, time: time, messageTime: idx >= 0 && rows[idx].messageTime ? { ...rows[idx].messageTime, canonicalUrl: f.url } : null, avatar: avatar, preview: prevEl2 ? String(prevEl2.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90) : '' })
  }
  // п.20: общая сумма непрочитанных по ВСЕМУ списку Телемоста — на вкладку.
  // Маркеров упоминаний список не показывает — только общее число.
  let svcTotal = 0
  for (const it of items) {
    const bb = it.querySelector('.yamb-chat-list-item__badges')
    if (bb) {
      const nn = parseInt((bb.textContent || '').replace(/\D+/g, ''), 10)
      if (nn > 0) svcTotal += nn
    }
  }
  return JSON.stringify({ favs: out, svcTotals: null, observedTotals: { total: svcTotal, mentions: 0 }, coverage: { complete: false } })
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
      // username-фолбэк («Astra lin») не является именем чата: пока webk
      // не отдал строку/шапку, пользовательское название не перезаписываем
      const isUsernameFallback = svc.id === 'tg' && isUsernameFallbackName(p.url, nm)
      if (name && !generic && !isUsernameFallback && shouldAutoRenameTitle(svc.id, p.title, p.url) && name !== p.title && pinMatches(p, svc, wv.getURL(), name)) {
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
      <div class="about-box">
        <div class="about-title">ChatHub <span id="about-version"></span></div>
        <p class="hint">Все рабочие мессенджеры в одном окне — Mattermost, Telegram, MAX и Яндекс Телемост —
        плюс сборная вкладка «★» с избранными чатами из всех мессенджеров сразу.</p>
        <details>
          <summary>Как пользоваться</summary>
          <ul class="about-list">
            <li>Вкладки сверху — мессенджеры. Войти достаточно один раз (Telegram и MAX — по QR-коду).</li>
            <li>«⭐ В избранное» на вкладке мессенджера добавляет открытый чат в сборную вкладку.</li>
            <li>«★ Сборная»: избранные чаты слева, переписка справа. 📌 — закрепить наверху,
            ↗ — открыть на вкладке мессенджера, ✕ — убрать из избранного.</li>
            <li>Счётчики на вкладках: всего непрочитанных и @упоминания; на «★ Сборной» — суммы по избранным чатам.</li>
            <li>🔍 «Найти чат…» — поиск по избранным; список сортируется по времени последнего сообщения.</li>
          </ul>
        </details>
      </div>
      <h2>⚙ Настройки</h2>
      <p class="hint">Файл конфигурации: <code id="cfg-path"></code></p>

      <h3>Вид</h3>
      <div class="form-row">
        <label style="flex:1"><input type="radio" name="layout" value="tabs"> Вкладки сверху</label>
        <label style="flex:1"><input type="radio" name="layout" value="sidebar"> Панель слева</label>
        <label style="flex:1"><input type="checkbox" id="tab-icons"> Показывать иконки на вкладках (сверху)</label>
      </div>
      <p class="hint">Панель слева тянется за правый край: шире — значки с надписями,
      уже — только большие значки мессенджеров. Переключение применяется сразу.</p>
      <div class="form-row">
        <label><input type="checkbox" id="badge-visible"> Показывать счётчики непрочитанных (красные и @) на вкладках</label>
      </div>
      <div class="form-row">
        <label><input type="checkbox" id="fav-badge-always"> У ★ Сборной всегда показывать счётчик новых</label>
      </div>
      <div class="form-row">
        <label><input type="checkbox" id="svcbadge-visible"> Показывать значок мессенджера у чатов в избранном</label>
      </div>
      <div class="form-row">
        <label><input type="checkbox" id="svcname-visible"> Показывать название мессенджера у чатов в избранном</label>
      </div>

      <h3>Тема</h3>
      <div class="form-row">
        <label style="flex:1"><input type="radio" name="theme" value="dark"> Тёмная</label>
        <label style="flex:1"><input type="radio" name="theme" value="light"> Светлая (мм не поддерживается)</label>
      </div>

      <h3>Мессенджеры (вкладки)</h3>
      <div id="svc-rows"></div>

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
      в фоне. Активное окно не трогается никогда. Если после включения веб-версия
      Telegram оставит экран поиска или архив — просто выключите индексацию.</p>
      <div class="form-row">
        <label><input type="checkbox" id="tg-bg-index"> Включить фоновую индексацию Telegram</label>
      </div>

      <h3>Избранное</h3>
      <div id="pin-rows"></div>

      <h3>Диагностика</h3>
      <p class="hint">Локальная самопроверка интерфейса и данных (без запуска внешних страниц).
      Отчёт можно скопировать и отправить разработчику.</p>
      <div class="form-row">
        <button class="btn" id="run-selfcheck">🧪 Самопроверка</button>
        <button class="btn" id="copy-selfcheck" disabled>📋 Скопировать отчёт</button>
      </div>
      <pre id="selfcheck-report" style="display:none;max-height:260px;overflow:auto;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:10px;font:11px/1.5 Consolas,monospace;color:var(--text);white-space:pre-wrap;"></pre>

      <div class="settings-actions">
        <button class="btn primary" id="save-settings">💾 Сохранить и перезапустить</button>
        <button class="btn danger" id="reset-pins">Очистить избранное</button>
      </div>
    </div>`

  window.hub.configPath().then(p => {
      const el = document.getElementById('cfg-path')
      if (el) el.textContent = p
    })

    // версия приложения в блоке «О программе» (из package.json через main)
    if (window.hub.getVersion) {
      window.hub.getVersion().then(v => {
        const el = document.getElementById('about-version')
        if (el) el.textContent = 'v' + v
      }).catch(() => {})
    }

    // вид: вкладки сверху / панель слева — применяется сразу, без перезапуска
    document.querySelectorAll('input[name="layout"]').forEach(r => {
      r.checked = (r.value === (state.cfg.layout || 'tabs'))
      r.onchange = () => {
        if (!r.checked) return
        state.cfg.layout = r.value
        applyLayout()
        window.hub.saveConfig(state.cfg).catch(() => {})
        toast(r.value === 'sidebar' ? 'Панель слева' : 'Вкладки сверху')
      }
    })
    // счётчики непрочитанных на вкладках: красные и @ — видимость
    const badgeCb = document.getElementById('badge-visible')
    if (badgeCb) {
      badgeCb.checked = state.cfg.badgeVisible !== false
      badgeCb.onchange = () => {
        state.cfg.badgeVisible = badgeCb.checked
        applyBadgeVisibility()
        window.hub.saveConfig(state.cfg).catch(() => {})
      }
    }
    const favBadgeCb = document.getElementById('fav-badge-always')
    if (favBadgeCb) {
      favBadgeCb.checked = state.cfg.favBadgeAlways === true
      favBadgeCb.onchange = () => {
        state.cfg.favBadgeAlways = favBadgeCb.checked
        applyBadgeVisibility()
        window.hub.saveConfig(state.cfg).catch(() => {})
      }
    }
    const tabIconsCb = document.getElementById('tab-icons')
    if (tabIconsCb) {
      tabIconsCb.checked = state.cfg.tabIcons === true
      tabIconsCb.onchange = () => {
        state.cfg.tabIcons = tabIconsCb.checked
        applyTabIcons()
        window.hub.saveConfig(state.cfg).catch(() => {})
      }
    }
    // значок мессенджера у чатов в избранном — видимость
    const svcCb = document.getElementById('svcbadge-visible')
    if (svcCb) {
      svcCb.checked = state.cfg.svcBadgeVisible !== false
      svcCb.onchange = () => {
        state.cfg.svcBadgeVisible = svcCb.checked
        applyBadgeVisibility()
        window.hub.saveConfig(state.cfg).catch(() => {})
      }
    }
    const svcNameCb = document.getElementById('svcname-visible')
    if (svcNameCb) {
      svcNameCb.checked = state.cfg.svcNameVisible !== false
      svcNameCb.onchange = () => {
        state.cfg.svcNameVisible = svcNameCb.checked
        applyBadgeVisibility()
        window.hub.saveConfig(state.cfg).catch(() => {})
      }
    }
    // тема: тёмная / светлая — тоже сразу
    document.querySelectorAll('input[name="theme"]').forEach(r => {
      r.checked = (r.value === (state.cfg.theme || 'dark'))
      r.onchange = () => {
        if (!r.checked) return
        state.cfg.theme = r.value
        applyTheme()
        window.hub.saveConfig(state.cfg).catch(() => {})
        toast(r.value === 'light' ? 'Светлая тема' : 'Тёмная тема')
      }
    })

    // кнопка «Самопроверка»: отчёт в pre, копирование в буфер
    const scBtn = document.getElementById('run-selfcheck')
    if (scBtn) {
      scBtn.onclick = () => {
        const rep = document.getElementById('selfcheck-report')
        const copyBtn = document.getElementById('copy-selfcheck')
        const lines = localSelfcheck()
        const fails = lines.filter(l => l.indexOf('FAIL') === 0).length
        rep.textContent = 'Самопроверка ChatHub — ' + new Date().toLocaleString('ru-RU') + '\n' + lines.join('\n') + '\n\nИТОГ: ' + (lines.length - fails) + ' PASS, ' + fails + ' FAIL'
        rep.style.display = 'block'
        if (copyBtn) {
          copyBtn.disabled = false
          copyBtn.onclick = () => {
            const txt = rep.textContent
            try { navigator.clipboard.writeText(txt).then(() => toast('Отчёт скопирован')).catch(() => toast('Не удалось скопировать')) } catch (e) { toast('Не удалось скопировать') }
          }
        }
      }
    }
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
