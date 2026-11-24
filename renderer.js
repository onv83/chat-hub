/* ChatHub — renderer
   Вкладки мессенджеров (живые веб-версии) + «сборная вкладка» —
   классический мессенджер: слева список избранного, справа содержание чата.
   Непрочитанные: красный бейдж-счётчик; упоминания (@) — отдельным стилем.

   Правка модулей мессенджеров — обязательная запись в CHANGELOG-MESSENGERS.md
   (дата, сервис, что изменено, почему, какими тестами закрыто). */

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
  unreadTotalsAt: {},   // pinId -> Date.now() последнего достоверного замера непрочитанных
  maxSession: { state: 'unknown', streak: 0, since: 0, lastOkAt: 0, noticeSent: false },
  serviceSessionLog: { mm: [], max: [], tg: [], ydx: [] }, // serviceId -> журнал сеансов (переживает перезапуск)
  serviceTimeFallbackLog: []                              // фолбэки времени строки, последние 50 записей
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

function cloneConfigForSave(cfg) {
  return JSON.parse(JSON.stringify(cfg))
}

function queueConfigSave(task) {
  const previous = state.configSaveQueue || Promise.resolve()
  const run = previous.then(task)
  state.configSaveQueue = run.catch(() => {})
  return run
}

function saveConfig(cfg = state.cfg) {
  const bridge = window.hub.saveConfig
  return queueConfigSave(() => bridge(cloneConfigForSave(cfg)))
}

function showAnnotationDialog(initial, opener = document.activeElement) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.id = 'annotation-dialog'
    overlay.className = 'annotation-dialog-backdrop'
    const card = document.createElement('section')
    card.className = 'annotation-dialog'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-modal', 'true')
    card.setAttribute('aria-labelledby', 'annotation-dialog-title')
    card.setAttribute('aria-describedby', 'annotation-dialog-hint')
    const title = document.createElement('h2')
    title.id = 'annotation-dialog-title'
    title.textContent = 'Комментарий к чату'
    const hint = document.createElement('p')
    hint.id = 'annotation-dialog-hint'
    hint.textContent = 'Комментарий виден только в ChatHub и помогает искать чат.'
    const label = document.createElement('label')
    label.htmlFor = 'annotation-dialog-input'
    label.textContent = 'Комментарий'
    const input = document.createElement('input')
    input.id = 'annotation-dialog-input'
    input.type = 'text'
    input.maxLength = 80
    input.value = initial || ''
    input.placeholder = 'Например: Инженер'
    input.dataset.annotationInput = 'true'
    const actions = document.createElement('div')
    actions.className = 'annotation-dialog-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'Отмена'
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'primary'
    save.dataset.act = 'save-annotation'
    save.textContent = 'Сохранить'
    actions.append(cancel, save)
    card.append(title, hint, label, input, actions)
    overlay.appendChild(card)
    let settled = false
    const close = value => {
      if (settled) return
      settled = true
      overlay.removeEventListener('keydown', onKey)
      overlay.remove()
      setTimeout(() => {
        const target = typeof opener === 'function' ? opener() : opener
        if (target?.isConnected) {
          try { target.focus?.() } catch (e) {}
        } else {
          const list = document.getElementById('chat-list')
          if (list) {
            list.tabIndex = -1
            try { list.focus?.() } catch (e) {}
          }
        }
        resolve(value)
      }, 0)
    }
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(null)
        return
      }
      if (event.key === 'Enter' && event.target === cancel) {
        event.preventDefault()
        return
      }
      if (event.key === 'Enter' && (event.target === input || event.target === save)) {
        event.preventDefault()
        close(input.value)
        return
      }
      if (event.key === 'Tab') {
        const controls = [input, cancel, save]
        const index = controls.indexOf(document.activeElement)
        if (event.shiftKey && index <= 0) {
          event.preventDefault()
          save.focus()
        } else if (!event.shiftKey && index === controls.length - 1) {
          event.preventDefault()
          input.focus()
        }
      }
    }
    overlay.addEventListener('keydown', onKey)
    overlay.addEventListener('click', event => { if (event.target === overlay) close(null) })
    cancel.onclick = () => close(null)
    save.onclick = () => close(input.value)
    document.body.appendChild(overlay)
    input.focus()
    input.select()
  })
}

init()

async function init() {
  state.cfg = await window.hub.getConfig()
  // Политика памяти фиксируется сразу после получения конфига и дальше не
  // меняется: галочки в «Настройках» пишут только state.cfg. Снимок неизменяем.
  const initialPolicy = state.cfg || {}
  state.serviceMemoryPolicy = Object.freeze({
    backgroundThrottling: initialPolicy.serviceBackgroundThrottling === true,
    idleUnload: initialPolicy.serviceIdleUnload === true,
    memoryGuard: initialPolicy.serviceMemoryGuard === true
  })
  state.activePinId = ''
  ensureKeys(state.cfg)
  // Базовая точка простоя — время старта. Автоматическое создание, опрос и
  // пересоздание вкладок её НЕ сдвигают, только явный клик по вкладке.
  const startedAt = Date.now()
  state.svcIdleAt = {}
  state.svcGuardCooldown = {}
  for (const svc of state.cfg.services) state.svcIdleAt[svc.id] = startedAt
  // Активность уже восстановлена из cfg.activity; сортируем ДО первой
  // отрисовки «Сборной», иначе Telegram догоняет порядок только после
  // первого фонового pollUnread (через несколько секунд после старта).
  sortFavoritesByActivity()
  buildTabs()
  applyTheme()
  applyLayout()
  applyBadgeVisibility()
  applyFavouriteDensity()
  refreshTabIcons()
  activateTab('combined')
  // Сразу очистить старый системный badge или восстановить сохранённый итог
  // избранного, не дожидаясь первого опроса через пять секунд.
  refreshUnreadPresentation()
  initListSplitter()
  // вкладки мессенджеров грузим сразу при старте (панели скрыты через visibility,
  // но разложены — webview правильного размера): переключение вкладки мгновенное.
  // deferSrc + очередь — чтобы 4 мессенджера не стартовали одновременно.
  // Коллекторы всегда стартуют все: закрыть вкладку может только таймер простоя
  // (serviceIdleUnload) или защита памяти (serviceMemoryGuard), не навигация.
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
  // Telemost может потерять realtime-соединение, пока чат остаётся загруженным.
  // Только фиксируем точный баннер и показываем локальное предупреждение: не
  // перезагружаем страницу и не трогаем очередь исходящих сообщений.
  setInterval(() => checkTelemostReconnect().catch(() => {}), 10000)
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
    const wv = state.svcViews.tg
    const svc = state.cfg.services.find(s => s.id === 'tg')
    if (!wv || !svc) return
    try {
      // проба с таймаутом: замороженная вьюха не отвечает никогда — лечим как пустую
      Promise.race([
        wv.executeJavaScript('document.querySelectorAll(".row-clickable").length'),
        new Promise(resolve => setTimeout(() => resolve('FROZEN'), 8000))
      ]).then(n => {
        // Вьюху могли выгрузить, пока проба ждала ответа: не воскрешаем её.
        if (state.svcViews.tg !== wv || wv.isConnected === false) return
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
        if (!svc || !sec || state.svcViews.tg !== wv || wv.isConnected === false) return
        const nv = document.createElement('webview')
        nv.setAttribute('partition', svc.partition)
        nv.setAttribute('allowpopups', '')
        if (!(state.serviceMemoryPolicy && state.serviceMemoryPolicy.backgroundThrottling)) nv.setAttribute('webpreferences', 'backgroundThrottling=no')
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
  // Политика памяти действует с этого запуска. Выключенный переключатель не
  // создаёт ни таймера, ни запроса метрик.
  if (state.serviceMemoryPolicy.idleUnload) setInterval(serviceIdleWatch, SERVICE_IDLE_CHECK_MS)
  if (state.serviceMemoryPolicy.memoryGuard) setInterval(serviceMemoryGuardWatch, SERVICE_MEMORY_GUARD_POLL_MS)
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
    saveConfig(state.cfg)
  }
  split.addEventListener('pointerup', end)
  split.addEventListener('pointercancel', end)
  // двойной клик — вернуть стандартную ширину
  split.addEventListener('dblclick', () => {
    wrap.style.width = '360px'
    state.cfg.listWidth = 360
    saveConfig(state.cfg)
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
    // Журнал сеансов и журнал фолбэков времени строки: белый список —
    // только известные сервисы и проверенные поля записей, лимиты те же.
    if (typeof restoreServiceSessionLog === 'function') {
      state.serviceSessionLog = restoreServiceSessionLog(A.serviceSessionLog)
    }
    if (typeof restoreServiceTimeFallbackLog === 'function') {
      state.serviceTimeFallbackLog = restoreServiceTimeFallbackLog(A.serviceTimeFallbackLog)
    }
    for (const key of ['unreadTotals', 'unreadTotalsAt', 'unreadDots', 'svcTabTotals']) {
      state[key] = state[key] || {}
      merge(state[key], A[key])
    }
    // Older versions persisted virtual-list totals without marking them as a
    // partial lower bound. They must not block a fresh observation forever.
    let droppedLegacyTabTotal = false
    for (const [serviceId, total] of Object.entries(state.svcTabTotals || {})) {
      if (serviceId !== 'mm' && total?.partial !== true) {
        delete state.svcTabTotals[serviceId]
        droppedLegacyTabTotal = true
      }
    }
    if (droppedLegacyTabTotal && state.cfg.activity) state.cfg.activity.svcTabTotals = { ...state.svcTabTotals }
    console.log('[hub] активность восстановлена из конфига:', Object.keys(A.lastMsgAt || {}).length, 'времён')
  }
  // РАЗОВЫЙ сброс испорченной активности: баг «дельт» записал backlog как новые
  // сообщения (liveAct = сейчас для старых чатов) и сломал сортировку по активности
  if (!state.cfg.actReset1) {
    state.cfg.actReset1 = true
    state.liveAct = {}
    state.prevUnread = {}
    if (state.cfg.activity) state.cfg.activity.liveAct = {}
    try { saveConfig(state.cfg).catch(() => {}) } catch (e) {}
  }
  // сброс №5: в кэше pid были отравленные записи (два разных чата получали
  // один peer-id из нечёткого матча и одинаковые аватарки) — чистим кэши
  if (!state.cfg.actReset5) {
    state.cfg.actReset5 = true
    state.tgPeerOf = {}
    state.pinAvatars = {}
    try { saveConfig(state.cfg).catch(() => {}) } catch (e) {}
  }
  // сброс №4: авторство последних сообщений теперь берётся из открытого чата
  if (!state.cfg.actReset4) {
    state.cfg.actReset4 = true
    state.lastMsgPreview = {}
    if (state.cfg.activity) state.cfg.activity.lastMsgPreview = {}
    try { saveConfig(state.cfg).catch(() => {}) } catch (e) {}
  }
  // сброс №3: старые сохранённые превью содержат удвоенные названия/неверных авторов —
  // чистим, пусть пересоберутся с мессенджеров по новым правилам
  if (!state.cfg.actReset3) {
    state.cfg.actReset3 = true
    state.lastMsgPreview = {}
    if (state.cfg.activity) state.cfg.activity.lastMsgPreview = {}
    try { saveConfig(state.cfg).catch(() => {}) } catch (e) {}
  }
  // сброс №2: первый запуск после фикса успел заново испортить liveAct
  // (бамп сработал на «прыжке» чисел, когда API MM ответил позже сайдбара)
  if (!state.cfg.actReset2) {
    state.cfg.actReset2 = true
    state.liveAct = {}
    state.prevUnread = {}
    if (state.cfg.activity) state.cfg.activity.liveAct = {}
    try { saveConfig(state.cfg).catch(() => {}) } catch (e) {}
  }
  // Сброс №6: компактное «ЧЧ:ММ» из stale Telegram pin-view могло быть
  // прочитано как сегодняшнее будущее время и поднять старый чат выше свежих.
  // Сообщение не может быть из будущего, поэтому такие сохранённые метки
  // недостоверны и должны быть переучены из service-view/проверенного cache.
  if (!state.cfg.actReset6) {
    state.cfg.actReset6 = true
    const future = Date.now() + 60000
    for (const p of (state.cfg.pinned || [])) {
      const id = p && p.id
      if (!id || state.lastMsgDayOnly[id] === true || !(state.lastMsgAt[id] > future)) continue
      delete state.lastMsgAt[id]
      delete state.lastMsgDayOnly[id]
      delete state.lastMsgText[id]
      delete state.lastMsgSource[id]
      delete state.liveAct[id]
    }
    if (state.cfg.activity) {
      state.cfg.activity.lastMsgAt = state.lastMsgAt
      state.cfg.activity.lastMsgDayOnly = state.lastMsgDayOnly
      state.cfg.activity.lastMsgText = state.lastMsgText
      state.cfg.activity.lastMsgSource = state.lastMsgSource
      state.cfg.activity.liveAct = state.liveAct
    }
    try { saveConfig(state.cfg).catch(() => {}) } catch (e) {}
  }
}

// П.13: сохранение накопленной активности в config.json — дебаунс 20 с,
// пишем только когда что-то реально накопили (времена/pid/liveAct)
let actSaveTimer = 0
function activitySnapshot() {
  const snapshot = {
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
    svcTabTotals: { ...state.svcTabTotals }
  }
  // Журналы сеансов и фолбэков времени входят в накопленную активность, но
  // пустыми config.json не засоряют: ключи появляются только с записями.
  if (typeof snapshotServiceSessionLog === 'function') {
    const sessionLog = snapshotServiceSessionLog()
    const ids = typeof SERVICE_SESSION_IDS === 'object' ? SERVICE_SESSION_IDS : ['mm', 'max', 'tg', 'ydx']
    if (ids.some(id => sessionLog[id] && sessionLog[id].length)) snapshot.serviceSessionLog = sessionLog
  }
  if (typeof snapshotServiceTimeFallbackLog === 'function') {
    const fallbackLog = snapshotServiceTimeFallbackLog()
    if (fallbackLog.length) snapshot.serviceTimeFallbackLog = fallbackLog
  }
  return snapshot
}
function scheduleActSave() {
  if (actSaveTimer) return
  actSaveTimer = setTimeout(() => {
    actSaveTimer = 0
    try {
      state.cfg.activity = activitySnapshot()
      saveConfig(state.cfg)
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
    // Явный клик по вкладке мессенджера — единственное событие, сдвигающее
    // срок простоя этого сервиса (автосоздание и опрос его не трогают).
    b.onclick = () => {
      if (id.indexOf('svc:') === 0) markServiceTabOpened(id.slice(4))
      activateTab(id)
    }
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
    if (cached) updateBadge2(svc.id, cached.t || 0, cached.m || 0, cached.partial === true)
  }
  let total = 0, mentions = 0
  for (const p of state.cfg.pinned) {
    const cached = (state.unreadTotals || {})[p.id]
    if (cached) { total += cached.c || 0; mentions += cached.m || 0 }
    if ((state.unreadDots || {})[p.id]) total++
  }
  updateBadge2('combined', total, mentions)
  // построенная заново панель вкладок должна сразу показать разлогин MAX
  if (typeof applyMaxSessionUi === 'function') applyMaxSessionUi()
  mk('settings', 'Настройки')
}

/* ---------- вид «панель слева» (как в Ferdium) + тема ---------- */

// иконки вкладок: Сборная ★, настройки ⚙, мессенджеры — favicon (data-URL)
// или первая буква названия, пока favicon не захвачен
function isSafeSvcIconDataUrl(value) {
  return typeof value === 'string' && value.length <= 400000 &&
    /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)
}
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
      if (isSafeSvcIconDataUrl(url)) {
        ic.textContent = ''
        const img = document.createElement('img')
        img.alt = ''
        img.src = url
        ic.appendChild(img)
      } else ic.textContent = firstLetter(id.slice(4))
    }
  })
}

function applyBadgeVisibility() {
  document.body.classList.toggle('hide-badges', state.cfg.badgeVisible === false)
  document.body.classList.toggle('hide-svc-badge', state.cfg.svcBadgeVisible === false)
  document.body.classList.toggle('hide-chat-source', state.cfg.svcNameVisible === false)
  document.body.classList.toggle('fav-badge-always', state.cfg.favBadgeAlways === true)
}

function applyFavouriteDensity() {
  const size = ['large', 'medium', 'small'].includes(state.cfg.favAvatarSize) ? state.cfg.favAvatarSize : 'large'
  const lines = state.cfg.favPreviewLines === 1 ? 1 : 2
  document.body.classList.toggle('fav-avatar-medium', size === 'medium')
  document.body.classList.toggle('fav-avatar-small', size === 'small')
  document.body.classList.toggle('hide-chat-preview', state.cfg.favPreviewVisible === false)
  document.body.classList.toggle('fav-preview-one-line', lines === 1)
  document.body.classList.toggle('hide-chat-comment', state.cfg.favCommentVisible === false)
  document.body.classList.toggle('fav-comment-title', state.cfg.favCommentStyle === 'title')
  document.body.classList.toggle('fav-comment-inline', state.cfg.favCommentPlacement === 'inline')
  document.body.classList.toggle('fav-comment-right', state.cfg.favCommentPlacement !== 'inline')
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
      saveConfig(state.cfg).catch(() => {})
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
  const svc = state.cfg.services.find(s => 'svc:' + s.id === id)
  let built = false
  if (!sec) {
    sec = buildSection(id)
    content.appendChild(sec)
    built = true
  }
  // пользователь сам открыл вкладку — если её webview ещё ждёт в очереди
  // предзагрузки, грузим сразу, не дожидаясь очереди. ВАЖНО: для TG — начальный
  // адрес (глубокая ссылка на чат), НЕ корень k/: корень уводит webk в пустой
  // скелет, и вкладка перезагружалась прямо при клике
  const wv = svc && state.svcViews[svc.id]
  for (const serviceId of ['tg', 'max', 'ydx']) {
    const view = state.svcViews[serviceId]
    if (!view) continue
    try { Promise.resolve(view.executeJavaScript('window.__hubVirtualSweepBlocked = ' + (id === 'svc:' + serviceId))).catch(() => {}) } catch {}
  }
  if (svc && wv && !built && !wv.dataset.loadedSrc) enqueueLoad(wv, initialSvcUrl(svc), true)
  // «Сборная» и «Настройки» — это только выбор вкладки, а не безопасный простой:
  // сервисные вьюхи здесь не выгружаются (это делает лишь таймер простоя).
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

/* ---------- политика памяти мессенджеров ----------
   Три независимых переключателя из «Настроек» → «Память». Значения читаются
   ОДИН раз сразу после getConfig(): до «Сохранить и перезапустить» галочки
   меняют только state.cfg и не трогают текущий жизненный цикл. Легаси-флаг
   «экономии памяти» здесь не читается — рендерер его игнорирует. */
const SERVICE_IDLE_DEADLINE_MS = 900000
const SERVICE_IDLE_CHECK_MS = 30000
const SERVICE_MEMORY_GUARD_POLL_MS = 30000
const SERVICE_MEMORY_GUARD_SINGLE_MIB = 1536
const SERVICE_MEMORY_GUARD_TOTAL_MIB = 3072
const SERVICE_MEMORY_GUARD_COOLDOWN_MS = 900000

// Снимок неизменяем: даже если state.cfg поменяют до перезапуска, поведение
// останется тем, каким было на старте.
function serviceMemoryPolicy() {
  return state.serviceMemoryPolicy ||
    Object.freeze({ backgroundThrottling: false, idleUnload: false, memoryGuard: false })
}

// Явный клик по вкладке мессенджера — единственное, что сдвигает срок простоя.
function markServiceTabOpened(svcId) {
  if (!state.svcIdleAt) state.svcIdleAt = {}
  state.svcIdleAt[svcId] = Date.now()
}

// Снять сервисную вьюху: убрать работу из очереди, закрыть активный загрузчик,
// сделать устаревшие колбэки инертными, убрать только свою секцию и запись
// состояния. Кэши непрочитанных не трогаются.
function retireServiceView(svcId) {
  const wv = state.svcViews[svcId]
  if (!wv) return null
  const sec = wv.parentElement
  for (let i = preloadQueue.length - 1; i >= 0; i--) {
    if (preloadQueue[i].wv === wv) preloadQueue.splice(i, 1)
  }
  state.svcRetireDepth = (state.svcRetireDepth || 0) + 1
  try { if (typeof wv.__hubPreloadDone === 'function') wv.__hubPreloadDone() } catch (e) {} finally { state.svcRetireDepth -= 1 }
  delete state.svcViews[svcId]
  try { wv.remove() } catch (e) {}
  if (sec && sec.dataset && sec.dataset.tab === 'svc:' + svcId) {
    try { sec.remove() } catch (e) {}
  }
  // Очередь продолжается уже без закрытой вьюхи.
  if (!state.svcRetireDepth) pumpPreload()
  return wv
}

// Новый экземпляр той же вкладки: тот же partition и безопасный адрес сервиса
// (initialSvcUrl — для Telegram корень, без глубокой ссылки на чат).
function recreateServiceView(svcId) {
  const svc = state.cfg.services.find(s => s.id === svcId)
  if (!svc) return null
  const content = document.getElementById('content')
  const stale = content.querySelector('section[data-tab="svc:' + svcId + '"]')
  if (stale) { try { stale.remove() } catch (e) {} }
  const sec = buildSection('svc:' + svcId, true)
  content.appendChild(sec)
  const wv = state.svcViews[svcId]
  if (wv) enqueueLoad(wv, initialSvcUrl(svc))
  return wv || null
}

// Простой: закрываем только скрытый сервис без единого избранного чата, у
// которого истёк срок после последнего явного открытия вкладки.
function serviceIdleTick(now) {
  if (!serviceMemoryPolicy().idleUnload) return []
  const at = now === undefined ? Date.now() : now
  const retired = []
  state.svcRetireDepth = (state.svcRetireDepth || 0) + 1
  try {
    for (const svc of state.cfg.services) {
      const wv = state.svcViews[svc.id]
      if (!wv || wv.isConnected === false) continue
      const pane = document.querySelector('section[data-tab="svc:' + svc.id + '"]')
      if (pane && pane.classList.contains('visible')) continue
      const favs = (state.cfg.pinned || []).filter(p => p.serviceId === svc.id)
      if (favs.length) continue
      const since = (state.svcIdleAt || {})[svc.id]
      if (typeof since !== 'number' || at - since < SERVICE_IDLE_DEADLINE_MS) continue
      retireServiceView(svc.id)
      retired.push(svc.id)
    }
  } finally {
    state.svcRetireDepth -= 1
  }
  if (!state.svcRetireDepth) pumpPreload()
  return retired
}

function serviceIdleWatch() {
  try { serviceIdleTick() } catch (e) {}
}

// Защита памяти: перезапускаем одну самую тяжёлую скрытую вкладку и сразу
// создаём её заново — сборщик переподключится сам, вкладка не останется пустой.
async function serviceMemoryGuardTick() {
  if (!serviceMemoryPolicy().memoryGuard) return null
  if (typeof (window.hub && window.hub.getServiceMemoryMetrics) !== 'function') return null
  if (state.svcGuardBusy) return null
  state.svcGuardBusy = true
  let metrics = null
  try { metrics = await window.hub.getServiceMemoryMetrics() } catch (e) { metrics = null } finally { state.svcGuardBusy = false }
  if (!metrics || !Array.isArray(metrics.services)) return null
  const total = Number(metrics.totalMiB) || 0
  const now = Date.now()
  if (!state.svcGuardCooldown) state.svcGuardCooldown = {}
  let victim = null
  // Ответ мог устареть: кандидат проверяется по ТЕКУЩЕМУ состоянию вьюхи.
  for (const entry of metrics.services) {
    const id = entry && entry.id
    const mem = Number(entry && entry.memoryMiB)
    if (!id || !isFinite(mem) || mem <= 0) continue
    const wv = state.svcViews[id]
    if (!wv || wv.isConnected !== true) continue
    const pane = document.querySelector('section[data-tab="svc:' + id + '"]')
    if (pane && pane.classList.contains('visible')) continue
    if (now - (state.svcGuardCooldown[id] || 0) < SERVICE_MEMORY_GUARD_COOLDOWN_MS) continue
    if (!victim || mem > victim.mem) victim = { id, mem }
  }
  if (!victim) return null
  if (victim.mem < SERVICE_MEMORY_GUARD_SINGLE_MIB && total < SERVICE_MEMORY_GUARD_TOTAL_MIB) return null
  state.svcGuardCooldown[victim.id] = now
  state.svcRetireDepth = (state.svcRetireDepth || 0) + 1
  try {
    retireServiceView(victim.id)
    recreateServiceView(victim.id)
  } finally {
    state.svcRetireDepth -= 1
  }
  if (!state.svcRetireDepth) pumpPreload()
  return victim.id
}

function serviceMemoryGuardWatch() {
  try { serviceMemoryGuardTick().catch(() => {}) } catch (e) {}
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
    <button class="btn return-service" title="Вернуться к исходной странице сервиса">↻ К исходной странице</button>
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
  // По умолчанию сервисный коллектор не тормозится в фоне
  // (backgroundThrottling=no). Переключатель «Уменьшать нагрузку от
  // мессенджеров в фоне» убирает это переопределение у вновь создаваемых и
  // пересоздаваемых вкладок. Живучесть вкладок не зависит от него.
  if (!(state.serviceMemoryPolicy && state.serviceMemoryPolicy.backgroundThrottling)) wv.setAttribute('webpreferences', 'backgroundThrottling=no')
  wv.className = 'svc-webview'
  sec.appendChild(wv)
  state.svcViews[svc.id] = wv

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
    // MAX (основная вкладка): оставляем родную левую навигацию MAX. В пин-вьюхах
    // «Избранного» её по-прежнему скрывает ensurePinView; в сервисной вкладке
    // пользователь должен видеть обычный интерфейс мессенджера.

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
  const returnBtn = bar.querySelector('.return-service')
  returnBtn.onclick = async () => {
    if (returnBtn.disabled) return
    returnBtn.disabled = true
    try { await returnServiceToOrigin(svc) } finally { returnBtn.disabled = false }
  }
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
function tabBadgeTotal(res) {
  const n = value => Math.max(0, Math.floor(Number(value) || 0))
  if (res?.svcTotals && typeof res.svcTotals === 'object') {
    return { t: n(res.svcTotals.total), m: n(res.svcTotals.mentions), partial: false }
  }
  if (res?.observedTotals && typeof res.observedTotals === 'object') {
    const t = n(res.observedTotals.total), m = n(res.observedTotals.mentions)
    if (t > 0 || m > 0) return { t, m, partial: true }
  }
  return null
}
function updateBadge2(svcId, total, mentions, partial = false) {
  const b = document.querySelector(svcId === 'combined' ? '.tab[data-tab="combined"] .badge' : '.tab[data-tab="svc:' + svcId + '"] .badge')
  const m = b && b.parentElement && b.parentElement.querySelector('.badge.badge-m')
  if (!b || !m) return
  const count = Math.max(0, Math.floor(Number(total) || 0))
  const mentionCount = Math.max(0, Math.floor(Number(mentions) || 0))
  b.textContent = count > 0 ? String(count) + (partial ? '+' : '') : ''
  b.title = partial && count > 0 ? 'Не менее ' + count + ' непрочитанных' : ''
  b.classList.toggle('on', count > 0)
  b.classList.remove('mention')
  m.textContent = mentionCount > 0 ? '@' + mentionCount + (partial ? '+' : '') : ''
  m.title = partial && mentionCount > 0 ? 'Не менее ' + mentionCount + ' упоминаний' : ''
  m.classList.toggle('on', mentionCount > 0)
  m.classList.add('mention')
}

/* ---------- журнал сеансов (общий для всех мессенджеров) ----------
   Разлогин по DOM умеет распознавать только MAX; у mm/tg/ydx детектора пока
   нет, но журнал всё равно общий: каждый сервис фиксирует своё наблюдение.
   Запись появляется только при СМЕНЕ состояния (или при первом наблюдении
   сервиса) — повторные опросы журнал не раздувают. Журнал сеансов и журнал
   фолбэков времени строки входят в cfg.activity и переживают перезапуск. */
const SERVICE_SESSION_IDS = ['mm', 'max', 'tg', 'ydx']
const SERVICE_SESSION_LOG_LIMIT = 20
const SERVICE_TIME_FALLBACK_LIMIT = 50
const SERVICE_SESSION_LABELS = { mm: 'Mattermost', max: 'MAX', tg: 'Telegram', ydx: 'Телемост' }
const SERVICE_SESSION_STATE_LABELS = { ok: 'есть', auth: 'завершён', unknown: 'неизвестно' }

function serviceSessionLogStore() {
  if (!state.serviceSessionLog || typeof state.serviceSessionLog !== 'object') {
    state.serviceSessionLog = { mm: [], max: [], tg: [], ydx: [] }
  }
  for (const id of SERVICE_SESSION_IDS) {
    if (!Array.isArray(state.serviceSessionLog[id])) state.serviceSessionLog[id] = []
  }
  return state.serviceSessionLog
}

function serviceSessionEntries(serviceId) {
  const id = String(serviceId || '')
  if (SERVICE_SESSION_IDS.indexOf(id) < 0) return []
  return serviceSessionLogStore()[id]
}

// Текущее состояние сервиса = последняя запись журнала: журнал пишет только
// смены, поэтому последняя запись и есть текущее состояние. Записей нет —
// «неизвестно» (сервис ещё ни разу не наблюдали).
function serviceSessionState(serviceId) {
  const entries = serviceSessionEntries(serviceId)
  return entries.length ? entries[entries.length - 1].state : 'unknown'
}

function serviceSessionStateLabel(stateValue) {
  return SERVICE_SESSION_STATE_LABELS[stateValue] || SERVICE_SESSION_STATE_LABELS.unknown
}

function serviceSessionLastOkAt(serviceId) {
  const entries = serviceSessionEntries(serviceId)
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].state === 'ok') return entries[i].at
  }
  return 0
}

// Журналы живут в состоянии страницы, а сохраняются в cfg.activity: пишем
// сквозь конфиг и просим дебаунсное сохранение активности (как msgAuth).
function writeThroughServiceActivity() {
  if (!state.cfg) return
  if (!state.cfg.activity) state.cfg.activity = {}
  state.cfg.activity.serviceSessionLog = snapshotServiceSessionLog()
  state.cfg.activity.serviceTimeFallbackLog = snapshotServiceTimeFallbackLog()
  if (typeof scheduleActSave === 'function') scheduleActSave()
}

// Единая точка записи для ВСЕХ сервисов. Возвращает
// { state, previous, changed, entry }; entry = null — журнал не менялся.
function noteServiceSession(serviceId, observation) {
  const id = String(serviceId || '')
  const raw = observation && observation.state
  const next = raw === 'ok' || raw === 'auth' ? raw : 'unknown'
  const previous = serviceSessionState(id)
  if (SERVICE_SESSION_IDS.indexOf(id) < 0) return { state: next, previous, changed: false, entry: null }
  const entries = serviceSessionEntries(id)
  if (entries.length && previous === next) return { state: next, previous, changed: false, entry: null }
  const at = Date.now()
  const entry = { at, state: next }
  // lastOkAt — последний успешный опрос: для «auth» берём из журнала, а если
  // журнал пуст — из наблюдения (MAX знает его и без записей).
  if (next === 'ok') entry.lastOkAt = at
  else {
    const observedOkAt = Number(observation && observation.lastOkAt)
    const lastOkAt = serviceSessionLastOkAt(id) || (Number.isFinite(observedOkAt) && observedOkAt > 0 ? observedOkAt : 0)
    if (lastOkAt) entry.lastOkAt = lastOkAt
  }
  entries.push(entry)
  while (entries.length > SERVICE_SESSION_LOG_LIMIT) entries.shift()
  writeThroughServiceActivity()
  return { state: next, previous, changed: true, entry }
}

function serviceTimeFallbackLogStore() {
  if (!Array.isArray(state.serviceTimeFallbackLog)) state.serviceTimeFallbackLog = []
  return state.serviceTimeFallbackLog
}

// Фолбэк времени строки. Вызывающий пишет только сам переход (время строки
// не разобралось, а непрочитанное выросло впервые), поэтому журнал не
// пополняется на каждом опросе.
function noteServiceTimeFallback(serviceId, pinId, title) {
  const id = String(serviceId || '')
  if (SERVICE_SESSION_IDS.indexOf(id) < 0) return null
  const pin = state.cfg && Array.isArray(state.cfg.pinned) ? state.cfg.pinned.find(p => p && p.id === pinId) : null
  const entry = {
    at: Date.now(),
    service: id,
    pinId: String(pinId || ''),
    title: String((pin && pin.title) || title || pinId || '')
  }
  const log = serviceTimeFallbackLogStore()
  log.push(entry)
  while (log.length > SERVICE_TIME_FALLBACK_LIMIT) log.shift()
  writeThroughServiceActivity()
  return entry
}

function normalizeServiceSessionEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const at = Number(raw.at)
  if (!Number.isFinite(at) || at <= 0) return null
  const entry = { at, state: raw.state === 'ok' || raw.state === 'auth' ? raw.state : 'unknown' }
  const lastOkAt = Number(raw.lastOkAt)
  if (Number.isFinite(lastOkAt) && lastOkAt > 0) entry.lastOkAt = lastOkAt
  return entry
}

function snapshotServiceSessionLog() {
  const store = state.serviceSessionLog || {}
  const out = {}
  for (const id of SERVICE_SESSION_IDS) {
    out[id] = (Array.isArray(store[id]) ? store[id] : []).map(entry => ({ ...entry }))
  }
  return out
}

// Белый список восстановления: только известные сервисы и проверенные поля
// записи, лимиты те же, что при записи.
function restoreServiceSessionLog(raw) {
  const out = {}
  for (const id of SERVICE_SESSION_IDS) {
    const list = raw && Array.isArray(raw[id]) ? raw[id] : []
    out[id] = list.map(normalizeServiceSessionEntry).filter(Boolean).slice(-SERVICE_SESSION_LOG_LIMIT)
  }
  return out
}

function normalizeServiceTimeFallbackEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const at = Number(raw.at)
  const service = String(raw.service || '')
  if (!Number.isFinite(at) || at <= 0 || SERVICE_SESSION_IDS.indexOf(service) < 0) return null
  return { at, service, pinId: String(raw.pinId || ''), title: String(raw.title || '') }
}

function snapshotServiceTimeFallbackLog() {
  return (Array.isArray(state.serviceTimeFallbackLog) ? state.serviceTimeFallbackLog : []).map(entry => ({ ...entry }))
}

function restoreServiceTimeFallbackLog(raw) {
  const list = Array.isArray(raw) ? raw : []
  return list.map(normalizeServiceTimeFallbackEntry).filter(Boolean).slice(-SERVICE_TIME_FALLBACK_LIMIT)
}

// Локальное время записи журнала: детерминированный формат (без toLocaleString,
// чтобы «Диагностика» одинаково читалась в тестах и на машине пользователя).
function formatSessionLogTime(at) {
  const d = new Date(Number(at))
  if (!Number.isFinite(d.getTime())) return '—'
  const two = n => String(n).padStart(2, '0')
  return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + two(d.getHours()) + ':' + two(d.getMinutes())
}

// Блок «Состояние сеансов» в «Диагностике»: текущее состояние каждого сервиса,
// последние 3 записи журнала и последние 3 фолбэка времени строки.
// Только textContent — данные наружу в HTML не попадают.
function renderServiceSessionDiagnostics(root) {
  const doc = root && typeof root.querySelector === 'function' ? root
    : (typeof document !== 'undefined' ? document : null)
  if (!doc || typeof doc.createElement !== 'function') return null
  const host = doc.querySelector('#session-state-rows')
  if (!host) return null
  while (host.firstChild && typeof host.removeChild === 'function') host.removeChild(host.firstChild)
  if (!host.firstChild) host.textContent = ''
  const add = (className, text) => {
    const row = doc.createElement('div')
    row.className = className
    row.textContent = text
    if (typeof host.appendChild === 'function') host.appendChild(row)
    return row
  }
  for (const id of SERVICE_SESSION_IDS) {
    add('session-state-row', (SERVICE_SESSION_LABELS[id] || id) + ' — ' + serviceSessionStateLabel(serviceSessionState(id)))
    const entries = serviceSessionEntries(id).slice(-3)
    if (!entries.length) add('session-state-entry', '· записей нет')
    for (const entry of entries) {
      add('session-state-entry', '· ' + formatSessionLogTime(entry.at) + ' — ' + serviceSessionStateLabel(entry.state))
    }
  }
  add('session-state-row', 'Фолбэк времени')
  const fallbacks = (Array.isArray(state.serviceTimeFallbackLog) ? state.serviceTimeFallbackLog : []).slice(-3)
  if (!fallbacks.length) add('session-state-entry', '· записей нет')
  for (const entry of fallbacks) {
    add('session-state-entry', '· ' + (SERVICE_SESSION_LABELS[entry.service] || entry.service) +
      ' — «' + (entry.title || entry.pinId) + '» — ' + formatSessionLogTime(entry.at))
  }
  return host
}

/* ---------- MAX: разлогин — это не «нет сообщений» ----------
   MAX периодически завершает сессию сразу на всех устройствах. Пустой список
   при этом выглядит как «в чатах тихо», поэтому состояние сессии проверяем по
   DOM и показываем явно: маркер «!» на вкладке, полосу в шапке, устаревшие
   строки в «Избранном» — вместо выдуманного нуля. */
const MAX_SESSION_AUTH_TEXT = 'MAX: сеанс завершён. Сообщения и счётчики не обновляются.'
const MAX_SESSION_AUTH_LABEL = 'MAX: сеанс завершён — требуется вход'
const MAX_SESSION_STALE_TITLE = 'данные с последнего успешного опроса'

function maxSessionInfo() {
  if (!state.maxSession) state.maxSession = { state: 'unknown', streak: 0, since: 0, lastOkAt: 0, noticeSent: false }
  return state.maxSession
}

// Антидребезг: одиночное наблюдение разлогина не индицируется (страница могла
// не догрузиться). «auth» объявляется после двух последовательных опросов
// подряд или если признак держится ≥ 20 с; вход сбрасывает отсчёт.
function noteMaxSession(observation) {
  const info = maxSessionInfo()
  const raw = observation && observation.state
  const now = Date.now()
  const previous = info.state
  if (raw === 'ok') {
    info.streak = 0
    info.since = 0
    info.lastOkAt = now
    info.state = 'ok'
    info.noticeSent = false
  } else {
    if (raw === 'auth') {
      if (!info.streak) info.since = now
      info.streak = (info.streak || 0) + 1
    }
    const held = info.since > 0 && now - info.since >= 20000
    if ((info.streak || 0) >= 2 || held) info.state = 'auth'
  }
  // Общий журнал сеансов: пишем РАЗРЕШЁННОЕ состояние (с учётом антидребезга),
  // чтобы MAX жил в одной картине с mm/tg/ydx. Тексты и маркеры — ниже.
  if (typeof noteServiceSession === 'function') {
    noteServiceSession('max', { state: info.state, lastOkAt: info.lastOkAt })
  }
  let announce = false
  if (info.state === 'auth' && !info.noticeSent) { info.noticeSent = true; announce = true }
  return { state: info.state, previous, changed: info.state !== previous, announce, info }
}

function maxSessionAuth() {
  return maxSessionInfo().state === 'auth'
}

function maxSessionDiagnosticText() {
  const info = maxSessionInfo()
  if (info.state === 'auth') {
    const at = info.lastOkAt
      ? new Date(info.lastOkAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : '—'
    return 'MAX: сеанс завершён (последняя успешная проверка ' + at + ')'
  }
  if (info.state === 'ok') return 'MAX: связь есть'
  return 'MAX: состояние проверяется'
}

// Полоса-предупреждение: живёт в сервисной вкладке MAX и в шапке «Сборной».
function maxSessionBar(pane, root) {
  if (!pane || !root || typeof root.createElement !== 'function') return null
  const bar = root.createElement('div')
  bar.className = 'svc-session-bar'
  bar.setAttribute('data-max-session-bar', '')
  bar.setAttribute('role', 'status')
  const text = root.createElement('span')
  text.className = 'svc-session-text'
  text.textContent = MAX_SESSION_AUTH_TEXT
  const open = root.createElement('button')
  open.className = 'btn svc-session-open'
  open.textContent = 'Открыть MAX'
  open.onclick = () => { try { activateTab('svc:max') } catch (e) {} }
  bar.appendChild(text)
  bar.appendChild(open)
  if (typeof pane.insertBefore === 'function') pane.insertBefore(bar, pane.firstChild || null)
  else pane.appendChild(bar)
  return bar
}

// Строки MAX в «Избранном» при разлогине — устаревшие, а не «нет сообщений».
function applyMaxStaleRows(root) {
  const doc = root || (typeof document !== 'undefined' ? document : null)
  if (!doc || typeof doc.querySelectorAll !== 'function') return
  const auth = maxSessionAuth()
  const pins = (state.cfg && state.cfg.pinned) || []
  for (const row of doc.querySelectorAll('.chat-row')) {
    const pinId = row.dataset ? row.dataset.pin : ''
    const pin = pins.find(item => item.id === pinId)
    const stale = !!(auth && pin && pin.serviceId === 'max')
    const marker = typeof row.querySelector === 'function' ? row.querySelector('.row-stale') : null
    if (marker) {
      marker.title = MAX_SESSION_STALE_TITLE
      marker.classList.toggle('hidden', !stale)
    }
    if (row.classList) row.classList.toggle('stale', stale)
  }
}

function applyMaxSessionUi(root) {
  const doc = root || (typeof document !== 'undefined' ? document : null)
  if (!doc || typeof doc.querySelector !== 'function') return false
  const auth = maxSessionAuth()
  const tab = doc.querySelector('.tab[data-tab="svc:max"]')
  const badge = tab && typeof tab.querySelector === 'function' ? tab.querySelector('.badge') : null
  if (badge) {
    if (auth) {
      badge.textContent = '!'
      badge.title = MAX_SESSION_AUTH_LABEL
      badge.classList.add('on')
      badge.classList.add('auth-required')
      badge.classList.remove('mention')
      if (typeof tab.setAttribute === 'function') tab.setAttribute('aria-label', MAX_SESSION_AUTH_LABEL)
      const mention = typeof tab.querySelector === 'function' ? tab.querySelector('.badge.badge-m') : null
      if (mention) { mention.textContent = ''; mention.classList.remove('on') }
    } else if (badge.classList.contains('auth-required')) {
      // Маркер снимаем и возвращаем последние известные счётчики вкладки.
      badge.classList.remove('auth-required')
      badge.title = ''
      if (typeof tab.removeAttribute === 'function') tab.removeAttribute('aria-label')
      const cached = (state.svcTabTotals || {}).max
      if (typeof updateBadge2 === 'function') {
        updateBadge2('max', (cached && cached.t) || 0, (cached && cached.m) || 0, !!(cached && cached.partial))
      } else {
        badge.textContent = ''
        badge.classList.remove('on')
      }
    }
  }
  for (const selector of ['section[data-tab="svc:max"]', 'section[data-tab="combined"]']) {
    const pane = doc.querySelector(selector)
    if (!pane || typeof pane.querySelector !== 'function') continue
    const bar = pane.querySelector('[data-max-session-bar]')
    if (!auth) {
      if (bar && typeof bar.remove === 'function') bar.remove()
      continue
    }
    if (!bar) maxSessionBar(pane, doc)
  }
  const status = doc.querySelector('#max-session-status')
  if (status) status.textContent = maxSessionDiagnosticText()
  // Блок «Состояние сеансов» в «Диагностике» обновляется тем же наблюдением:
  // журнал общий, поэтому рядом с текстом MAX видны и остальные сервисы.
  if (typeof renderServiceSessionDiagnostics === 'function') renderServiceSessionDiagnostics(doc)
  applyMaxStaleRows(doc)
  return true
}

// Одно системное уведомление на переход в разлогин (тост дублирует его).
function showMaxSessionNotification() {
  try {
    if (typeof Notification !== 'function' || Notification.permission === 'denied') return
    const notice = new Notification(MAX_SESSION_AUTH_LABEL, {
      body: MAX_SESSION_AUTH_TEXT + ' Откройте вкладку MAX и войдите снова.',
      silent: true
    })
    notice.onclick = () => { try { if (typeof activateTab === 'function') activateTab('svc:max') } catch (e) {} }
  } catch (e) {}
}

// Единая точка применения наблюдения: состояние, индикация, уведомление при
// разлогине и тост при возврате связи.
function applyMaxSession(observation, root) {
  const transition = noteMaxSession(observation)
  try { applyMaxSessionUi(root) } catch (e) {}
  if (transition.announce) {
    try { showMaxSessionNotification() } catch (e) {}
    try { if (typeof toast === 'function') toast(MAX_SESSION_AUTH_LABEL) } catch (e) {}
  } else if (transition.changed && transition.state === 'ok' && transition.previous === 'auth') {
    try { if (typeof toast === 'function') toast('MAX снова на связи') } catch (e) {}
  }
  return transition
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
  await saveConfig(state.cfg)
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
  const savedScrollTop = list.scrollTop
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
  // Фоновые обновления времени/аватаров не должны выкидывать пользователя
  // наверх длинного списка избранного во время ручной прокрутки.
  list.scrollTop = Math.min(savedScrollTop, Math.max(0, list.scrollHeight - list.clientHeight))

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
  // Индикация разлогина MAX живёт поверх перерисовки списка.
  if (typeof applyMaxSessionUi === 'function') applyMaxSessionUi()
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
    const search = row.dataset.search || (title + ' ' + svc).toLowerCase()
    const hit = !q || search.includes(q)
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
        <span class="chat-row-comment"></span>
        <span class="row-badge hidden"></span>
        <span class="row-time"></span>
        <span class="row-stale hidden" title="данные с последнего успешного опроса">?</span>
      </div>
      <div class="row-line2">
        <div class="chat-row-src"></div>
      </div>
      <div class="chat-row-preview"></div>
    </div>
    <button class="icon-btn row-more" title="Действия" aria-label="Действия с чатом">⋮</button>
    <div class="row-menu hidden">
      <button data-act="pin">📌 <span>Закрепить</span></button>
      <button data-act="annotation">💬 <span>Добавить комментарий</span></button>
      <button data-act="del">✕ Убрать из избранного</button>
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
  const annotation = typeof p.annotation === 'string'
    ? p.annotation.trim().replace(/\s+/g, ' ').replace(/^\((.*)\)$/, '$1').trim().slice(0, 80)
    : ''
  const editAnnotation = async opener => {
    const pending = state.annotationSavePending || (state.annotationSavePending = {})
    if (pending[p.id]) {
      toast('Комментарий ещё сохраняется')
      return
    }
    pending[p.id] = true
    const resolveOpener = () => {
      const row = [...document.querySelectorAll('.chat-row')].find(item => item.dataset.pin === p.id)
      return row?.querySelector('.row-more') || opener
    }
    const restoreOpener = () => {
      const target = resolveOpener()
      if (target?.isConnected) {
        try { target.focus?.() } catch (e) {}
      }
    }
    let entered
    try {
      entered = await showAnnotationDialog(annotation, resolveOpener)
    } catch (error) {
      delete pending[p.id]
      toast('Не удалось открыть комментарий')
      return
    }
    if (entered === null) {
      delete pending[p.id]
      return
    }
    const next = String(entered).trim().replace(/\s+/g, ' ').replace(/^\((.*)\)$/, '$1').trim().slice(0, 80)
    const pinId = p.id
    try {
      await queueConfigSave(async () => {
        const live = state.cfg.pinned.find(item => item.id === pinId)
        if (!live) throw new Error('Favourite no longer exists')
        const hadAnnotation = Object.prototype.hasOwnProperty.call(live, 'annotation')
        const previous = live.annotation
        if (next) live.annotation = next
        else delete live.annotation
        const rawSave = window.hub.saveConfig
        try {
          await rawSave(cloneConfigForSave(state.cfg))
        } catch (error) {
          if (hadAnnotation) live.annotation = previous
          else delete live.annotation
          throw error
        }
      })
    } catch (error) {
      delete pending[pinId]
      try {
        renderChatList()
        restoreOpener()
      } catch {}
      toast('Не удалось сохранить комментарий')
      return
    }
    delete pending[pinId]
    try {
      renderChatList()
      restoreOpener()
    } catch (error) {
      toast('Комментарий сохранён, но список не обновился')
      return
    }
    toast(next ? 'Комментарий сохранён' : 'Комментарий убран')
  }
  const showComment = annotation && state.cfg.favCommentVisible !== false
  ttl.textContent = dispTitle
  ttl.title = p.url
  const commentEl = row.querySelector('.chat-row-comment')
  commentEl.textContent = showComment ? '(' + annotation + ')' : ''
  commentEl.title = annotation
  row.dataset.search = (dispTitle + ' ' + annotation + ' ' + svcName).toLowerCase()
  row.querySelector('.chat-row-src').textContent = svcName
  setRowPreview(row.querySelector('.chat-row-preview'), state.lastMsgPreview[p.id] || '')
  const timeEl = row.querySelector('.row-time')
  timeEl.textContent = state.lastMsgAt[p.id] ? fmtRowTime(state.lastMsgAt[p.id], state.lastMsgDayOnly?.[p.id] === true) : ''
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
      menu.querySelector('[data-act="annotation"] span').textContent = annotation ? 'Изменить комментарий' : 'Добавить комментарий'
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
  menu.querySelector('[data-act="annotation"]').onclick = async () => { const opener = more; closeAllRowMenus(); await editAnnotation(opener) }
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
  pass('настройки: галочки ★/иконки/фон pin', !!document.getElementById('fav-badge-always') && !!document.getElementById('tab-icons') && !!document.getElementById('pin-bg-active'))
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
  // «Сервисы»: диагностика режимозависимая. По умолчанию держим все четыре
  // вкладки живыми. Если включено закрытие по простою, закрытая вкладка — норма;
  // проверяем обратное: живые вьюхи правда живы, а закрытые не оставили следов
  // в DOM или очереди. Проверка только читает состояние.
  if (!(state.serviceMemoryPolicy && state.serviceMemoryPolicy.idleUnload)) {
    pass('сервисы: 4 вкладки живы', ['mm', 'tg', 'max', 'ydx'].every(id => state.svcViews[id] && state.svcViews[id].isConnected))
  } else {
    const views = state.svcViews || {}
    const liveIds = Object.keys(views).filter(id => !!views[id])
    const liveViews = liveIds.map(id => views[id])
    const visibleIds = []
    const orphanTabIds = []
    for (const pane of document.querySelectorAll('section[data-tab]')) {
      const tab = String((pane.dataset || {}).tab || '')
      if (tab.indexOf('svc:') !== 0) continue
      const svcId = tab.slice(4)
      if (!views[svcId]) orphanTabIds.push(svcId)
      if (pane.classList && pane.classList.contains('visible')) visibleIds.push(svcId)
    }
    const detached = liveIds.filter(id => views[id].isConnected !== true)
    const noSection = liveIds.filter(id => !document.querySelector('section[data-tab="svc:' + id + '"]'))
    const emptyTab = visibleIds.filter(id => liveIds.indexOf(id) < 0)
    const staleQueued = (typeof preloadQueue !== 'undefined' ? preloadQueue : [])
      .filter(job => job && job.wv && (job.wv.isConnected !== true || liveViews.indexOf(job.wv) < 0)).length
    const bad = detached.concat(noSection, emptyTab, orphanTabIds).filter((id, i, all) => all.indexOf(id) === i)
    pass('сервисы: вкладки живы или закрыты по простою', bad.length === 0 && staleQueued === 0,
      (bad.length || staleQueued) ? { views: bad, staleQueued } : undefined)
  }
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
  saveConfig(state.cfg)
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
  // A visible guest must receive focus so Telegram can acknowledge the opened
  // chat as read; merely toggling the shell-side active class leaves its DOM
  // unfocused and its sidebar counter stale.
  try { if (wv && typeof wv.focus === 'function') wv.focus() } catch (e) {}
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
  // Снятие сервисной вьюхи: очередь не должна стартовать следующий мессенджер
  // в середине teardown (иначе закрываемая вкладка успевает загрузиться).
  if (state.svcRetireDepth > 0) return
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
  // Service views stay unthrottled for background collection. Hidden pin views
  // are disposable LRU renderers, so let Chromium throttle them off-screen.
  if (state.cfg.pinBackgroundActive === true) wv.setAttribute('webpreferences', 'backgroundThrottling=no')
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
    if (isSafeSvcIconDataUrl(dataUrl) && !state.svcIcons[svcId]) {
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
    <button class="icon-btn" id="vh-return" title="Вернуться к исходной странице чата">↻</button>
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
  const returnBtn = head.querySelector('#vh-return')
  returnBtn.onclick = async () => {
    if (returnBtn.disabled) return
    returnBtn.disabled = true
    try { await returnPinToOrigin(p) } finally { returnBtn.disabled = false }
  }
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
  for (const k of ['liveAct', 'rankAct', 'prevUnread', 'lastUsed', 'lastMsgAt', 'lastMsgDayOnly', 'lastMsgSource', 'lastMsgText', 'tgPeerOf', 'tgIdentityKeys', 'pinAvatars', 'lastMsgPreview', 'msgAuth', 'unreadBaseC', 'unreadBaseM', 'unreadTotals', 'unreadTotalsAt', 'unreadDots', 'mmPinCounts', '__prevLastMsgAt']) {
    try { delete state[k][pinId] } catch (e) {}
  }
  // ...и в сохранённой активности конфига (п.13)
  if (state.cfg.activity) {
    for (const k of Object.keys(state.cfg.activity)) {
      // журналы сеансов/фолбэков — массивы и карты сервисов, а не pinId:
      // удаление пина к ним не относится, по pinId их чистить нечего
      if (k === 'serviceSessionLog' || k === 'serviceTimeFallbackLog') continue
      try { delete state.cfg.activity[k][pinId] } catch (e) {}
    }
  }
  await saveConfig(state.cfg)
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
  await saveConfig(state.cfg)
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
function sameViewUrl(current, target) {
  try { return new URL(String(current)).href === new URL(String(target)).href } catch {
    return String(current || '') === String(target || '')
  }
}
function waitForViewReload(wv, start, expectedUrl) {
  const begin = typeof start === 'function' ? start : () => wv.reload()
  return new Promise(resolve => {
    let settled = false
    let timer = null
    const done = ok => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { wv.removeEventListener('did-finish-load', finish) } catch {}
      try { wv.removeEventListener('did-fail-load', fail) } catch {}
      try { wv.removeEventListener('did-navigate-in-page', inPage) } catch {}
      resolve(ok)
    }
    const finish = event => { if (event?.isMainFrame !== false) done(true) }
    const fail = event => { if (event?.isMainFrame !== false) done(false) }
    const inPage = event => {
      if (!expectedUrl || event?.isMainFrame === false) return
      let navigated = event?.url
      if (!navigated && typeof wv.getURL === 'function') navigated = wv.getURL()
      if (sameViewUrl(navigated, expectedUrl)) done(true)
    }
    try {
      if (typeof wv.addEventListener !== 'function' || typeof wv.removeEventListener !== 'function') return done(false)
      wv.addEventListener('did-finish-load', finish)
      wv.addEventListener('did-fail-load', fail)
      wv.addEventListener('did-navigate-in-page', inPage)
      timer = setTimeout(() => done(false), 15000)
      const pending = begin()
      if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => done(false))
    } catch { done(false) }
  })
}
async function reloadOriginalView(wv, url) {
  if (!wv || !url) return false
  try {
    const target = String(url)
    const current = typeof wv.getURL === 'function' ? wv.getURL() : ''
    if (sameViewUrl(current, target) && typeof wv.reload === 'function') {
      return await waitForViewReload(wv)
    }
    return await waitForViewReload(wv, () => wv.loadURL(target), target)
  } catch { return false }
}
async function returnServiceToOrigin(svc) {
  const ok = await reloadOriginalView(state.svcViews[svc.id], svc.url)
  toast(ok ? 'Открыта исходная страница сервиса' : 'Не удалось открыть исходную страницу сервиса')
  return ok
}
async function returnPinToOrigin(p) {
  const ok = await reloadOriginalView(state.pinViews[p.id], p.url)
  toast(ok ? 'Открыта исходная страница чата' : 'Не удалось открыть исходную страницу чата')
  return ok
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

function isTelemostRetryVisible(text) {
  return /попытка\s+подключения\s+повторится\s+через\s+\d+\s+секунд/i.test(String(text || ''))
}

async function probeTelemostReconnect(view, scope) {
  if (!view || view.isConnected === false || !['pin', 'service'].includes(scope)) return
  const states = state.telemostConnectionStates || (state.telemostConnectionStates = new WeakMap())
  try {
    const retry = await unreadGuestCall(view, 'telemost-connection', () => view.executeJavaScript(
      `(${isTelemostRetryVisible.toString()})(document.body?.innerText || '')`
    ))
    const current = retry === true
    const previous = states.get(view)
    if (previous === current) return
    states.set(view, current)
    if (previous === undefined && !current) return
    const event = { state: current ? 'retry-visible' : 'retry-cleared', scope }
    try { window.hub.reportTelemostConnection?.(event).catch(() => {}) } catch {}
    if (current) toast('Яндекс Чат потерял соединение: очередь сообщений не перезагружаю')
  } catch {}
}

function checkTelemostReconnect() {
  const jobs = []
  const serviceView = state.svcViews.ydx
  if (serviceView) jobs.push(probeTelemostReconnect(serviceView, 'service'))
  const active = state.cfg.pinned.find(p => p.id === state.activePinId && p.serviceId === 'ydx')
  const pinView = active && state.pinViews[active.id]
  if (pinView && pinView !== serviceView) jobs.push(probeTelemostReconnect(pinView, 'pin'))
  return Promise.all(jobs)
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

// Открытая пин-вьюха активного чата — самый свежий DOM-источник строки:
// сервисная вкладка может быть скрыта/отставать (баг «пришло сообщение, а
// время и превью в Избранном старые»). Досматриваем её ТЕМ ЖЕ экстрактором,
// но без счётчиков и аватарок: у пин-вьюхи нет ни полного списка, ни бейджей.
async function probeActivePinView(serviceId) {
  const pin = state.cfg.pinned.find(p => p.id === state.activePinId && p.serviceId === serviceId)
  const view = pin && state.pinViews[pin.id]
  const ext = UNREAD_EXTRACTORS[serviceId]
  if (!pin || !ext || !view || view === state.svcViews[serviceId]) return null
  const source = `(async () => {
    const __grabAvatar = async () => null;
    const __chatHubScanRows = ${__chatHubScanRows.toString()};
    const __chatHubBoundedAvatar = ${__chatHubBoundedAvatar.toString()};
    const formatMaxPreview = ${formatMaxPreview.toString()};
    return (${ext.toString()})(${JSON.stringify([{ id: pin.id, url: pin.url, title: pin.title,
      pid: (state.tgPeerOf || {})[pin.id] || null, identityKey: state.tgIdentityKeys?.[pin.id] || '',
      needDialogMetadata: false, needAvatar: false, needUnread: false }])}, false);
  })()`
  try {
    const raw = await unreadGuestCall(view, 'pin-time', () => view.executeJavaScript(source))
    return (JSON.parse(raw).favs || []).find(r => r.id === pin.id) || null
  } catch { return null }
}

// Сливаем из пин-вьюхи только время последнего сообщения, превью и позицию —
// и только если наблюдение НОВЕЕ уже известного: сервисная вкладка авторитетнее
// отставшей пин-вьюхи. Счётчики непрочитанных из пин-вьюхи не берём никогда.
function mergeActivePinViewMetadata(serviceId, observation) {
  if (!observation || !observation.id) return
  const pinId = observation.id
  const pin = state.cfg.pinned.find(p => p.id === pinId && p.serviceId === serviceId)
  if (!pin || state.activePinId !== pinId) return
  const previous = (state.lastMsgAt || {})[pinId] || 0
  const exact = observation.messageTime
  const observed = exact && exact.dayOnly === false && Number.isFinite(exact.at) && exact.at > 0
    ? { at: exact.at, dayOnly: false }
    : (observation.time ? parseChatTime(observation.time) : null)
  if (!observed || !Number.isFinite(observed.at) || observed.at <= 0 || observed.at <= previous) return
  mergeLastMessageTime(pinId, observed)
  if (typeof observation.rank === 'number') {
    state.rankAct = state.rankAct || {}
    state.rankAct[pinId] = observation.rank
  }
  const preview = typeof observation.preview === 'string' ? observation.preview.trim() : ''
  if (preview) {
    state.lastMsgPreview = state.lastMsgPreview || {}
    state.lastMsgPreview[pinId] = restorePreviewAuthor(preview, (state.msgAuth || {})[pinId], observation.messageId)
  }
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
    let maxSessionObs = null
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
        // второй аргумент экстрактора: можно ли скроллить список. Скрытая
        // сервисная вкладка доскролливается ВСЕГДА, независимо от фокуса окна:
        // иначе работа пользователя в ChatHub «замораживает» сайдбар TG/MAX/
        // Телемоста, и сообщение вне видимой области не попадает в «Избранное».
        // Видимая вкладка не скроллится принудительно, как и раньше. Внутри
        // __chatHubScanRows остаётся собственная защита document.hasFocus().
        const pane = document.querySelector('section[data-tab="svc:' + svc.id + '"]')
        const allowScroll = ['tg', 'max', 'ydx'].includes(svc.id)
          && cand === state.svcViews[svc.id]
          && !(pane && pane.classList.contains('visible'))
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
            const parseChatTime = ${typeof parseChatTime === 'function' ? parseChatTime.toString() : 'null'};
            const __chatHubMaxSession = ${typeof __chatHubMaxSession === 'function' ? __chatHubMaxSession.toString() : 'null'};
            return (${ext.toString()})(${JSON.stringify(favs.map(f => ({ id: f.id, url: f.url, title: f.title, pid: (svc.id === 'tg' && state.tgPeerOf[f.id]) || null, identityKey: (svc.id === 'tg' && state.tgIdentityKeys?.[f.id]) || '', needDialogMetadata: svc.id === 'tg' && cand === state.svcViews.tg, needMessageMetadata: svc.id === 'tg' && cand === state.svcViews.tg, needMessagePreview: svc.id === 'tg' && cand === state.svcViews.tg, needMetadataAvatar: svc.id === 'tg' && cand === state.svcViews.tg, needAvatar: !state.pinAvatars[f.id], needUnread: (svc.id === 'tg' || svc.id === 'max' || svc.id === 'ydx') && ((state.activePinId && f.id === state.activePinId) || !state.unreadTotals[f.id] || Date.now() - ((state.unreadTotalsAt || {})[f.id] || 0) > 10000) })))},${JSON.stringify(allowScroll)});
          })()`
        )))
        const r = JSON.parse(out)
        if (!r || !Array.isArray(r.favs)) throw new Error('Invalid unread response')
        // MAX: состояние сессии читаем только с сервисной вкладки (полный
        // список). Пин-вьюха одного чата для решения о разлогине не годится.
        if (svc.id === 'max' && r.session && cand === state.svcViews[svc.id]) maxSessionObs = r.session
        // TG: запоминаем сопоставление пин → числовой peer-id (после первого
        // нахождения по названию дальше матчуем по pid быстро и однозначно)
        if (svc.id === 'tg' && r && r.favs) {
          const timeView = cand === state.svcViews.tg ? 'service-list' : 'pin-view'
          for (const f of r.favs) {
            f.timeView = timeView
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
    job.check()
    // mm/tg/ydx: своего детектора сеанса в этом пакете нет — в общий журнал
    // пишем «неизвестно» при первом наблюдении сервиса (повторные опросы
    // записей не добавляют), маркер в UI для них не рисуем.
    if (svc.id !== 'max' && typeof noteServiceSession === 'function') {
      noteServiceSession(svc.id, { state: 'unknown' })
    }
    // MAX: состояние сессии проверяем ДО слияния строк. При разлогине список
    // пуст — это не «нет сообщений»: не трогаем счётчики, время и превью,
    // оставляем последние достоверные значения и показываем явную индикацию.
    if (svc.id === 'max' && maxSessionObs && typeof applyMaxSession === 'function') {
      const transition = applyMaxSession(maxSessionObs)
      if (transition && transition.state === 'auth') return
    }
    // Активный пин: после наблюдения сервисной вкладки досматриваем его
    // открытую пин-вьюху — она может показать более свежее время/превью.
    let pinObservation = null
    try { pinObservation = await probeActivePinView(svc.id) } catch {}
    job.check()
    if (!res) { mergeActivePinViewMetadata(svc.id, pinObservation); return }
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
        r.unread = rawC > 0 || rawM > 0
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
              try { saveConfig(state.cfg).catch(() => {}) } catch (e) {}
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
              try { saveConfig(state.cfg).catch(() => {}) } catch (e) {}
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
      if (svc.id === 'max' && typeof mergeMaxLastMessageTime === 'function') {
        // У MAX время строки может не разбираться — тогда работает фолбэк
        // по непрочитанному (см. mergeMaxLastMessageTime).
        mergeMaxLastMessageTime(r, r.id, pin.url)
      } else if (shouldMergeDomTime(svc.id, r)) mergeLastMessageTime(r.id, parseChatTime(r.time))
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
    const tabTotal = svc.id === 'mm' ? null : tabBadgeTotal(res)
    if (svc.id === 'mm') {
      // бейдж вкладки MM — из API (mmTabCounts): два чипа «всего/@упоминаний»;
      // сайдбарные суммы здесь не трогаем (rows уже обновлены выше)
    } else if (tabTotal) {
      // Точный итог отдаётся целиком. Для виртуализированного списка есть
      // только наблюдаемая часть, поэтому показываем нижнюю границу «N+».
      state.svcTabTotals = state.svcTabTotals || {}
      const cachedTabTotal = state.svcTabTotals[svc.id]
      if (!tabTotal.partial || !cachedTabTotal || cachedTabTotal.partial === true) {
        state.svcTabTotals[svc.id] = tabTotal
        updateBadge2(svc.id, tabTotal.t, tabTotal.m, tabTotal.partial)
      }
    } else if (res.coverage && res.coverage.complete === false) {
      // Нулевой частичный снимок не доказывает ноль по всему сервису, но
      // предыдущую нижнюю границу тоже нельзя оставлять как актуальную.
      if (state.svcTabTotals?.[svc.id]?.partial === true) {
        delete state.svcTabTotals[svc.id]
        updateBadge2(svc.id, 0, 0)
      }
    } else if (mentions > 0) updateBadge(svc.id, '@' + mentions, true)
    else if (countSum > 0) updateBadge(svc.id, String(countSum), false)
    else if (unreadChats > 0) updateBadge(svc.id, String(unreadChats), false)
    else updateBadge(svc.id, '', false)
    // Свежее время/превью открытого чата — ПОСЛЕ строк сервисной вкладки,
    // чтобы отставшая вкладка не затирала наблюдение пин-вьюхи.
    mergeActivePinViewMetadata(svc.id, pinObservation)
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
  // Значок ChatHub в панели задач повторяет только непрочитанное избранного —
  // то же число, что показывает «★ Сборная». Веб-мессенджеры тоже умеют
  // ставить badge сами, поэтому после каждого цикла опроса задаём наше число.
  try {
    const nav = typeof navigator === 'undefined' ? null : navigator
    const count = Math.max(0, Math.floor(Number(favSumT) || 0))
    const call = count > 0 ? nav?.setAppBadge : nav?.clearAppBadge
    if (typeof call === 'function') {
      const pending = count > 0 ? call.call(nav, count) : call.call(nav)
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    }
  } catch (e) {}
  // время последнего сообщения в строках: «Мессенджер · 17:30»
  // (в т.ч. MM — из API; полный текст времени — в подсказке)
  for (const p of state.cfg.pinned) {
    const row = document.querySelector('.chat-row[data-pin="' + p.id + '"]')
    if (!row) continue
    const svc = state.cfg.services.find(s => s.id === p.serviceId)
    const tEl = row.querySelector('.row-time')
    if (tEl) {
      const want = state.lastMsgAt[p.id] ? fmtRowTime(state.lastMsgAt[p.id], state.lastMsgDayOnly?.[p.id] === true) : ''
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
function shouldMergeDomTime(serviceId, row) {
  if (!row || row.found === false || !row.time) return false
  // A Telegram pin-view can show stale compact clocks from its own chat
  // context. Only the actual service list is a trusted DOM source for time.
  return serviceId !== 'tg' || row.timeView === 'service-list'
}

function mergeLastMessageTime(id, observation) {
  const at = observation && observation.at
  const dayOnly = observation.dayOnly === true
  if (!Number.isFinite(at) || at <= 0) return
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

// MAX: время строки может не разбираться (в списке нет точных атрибутов).
// Тогда, если строка найдена и есть непрочитанное, поднимаем чат по факту
// нового сообщения — но только когда время пина ещё неизвестно или
// непрочитанное выросло с нуля/неизвестности впервые. Повторные опросы с тем
// же непрочитанным и его снятие время не двигают. Разобранное время строки
// всегда важнее синтетического фолбэка.
function mergeMaxLastMessageTime(row, pinId, pinUrl) {
  const parsed = row && row.time ? parseChatTime(row.time) : { at: 0 }
  if (parsed && parsed.at > 0) {
    const source = state.lastMsgSource && state.lastMsgSource[pinId]
    if (source && source.source === 'max-unread-fallback') {
      // Реальное время важнее прошлого фолбэка, даже если оно раньше.
      delete state.lastMsgAt[pinId]
      if (state.lastMsgDayOnly) delete state.lastMsgDayOnly[pinId]
    }
    mergeLastMessageTime(pinId, parsed)
    return 'dom'
  }
  if (!row || row.found === false || !(row.unread || row.count > 0)) return ''
  const known = (state.lastMsgAt && state.lastMsgAt[pinId]) || 0
  const previousTotal = state.prevUnread ? state.prevUnread[pinId] : undefined
  if (known && previousTotal !== 0) return ''
  mergeLastMessageTime(pinId, {
    at: Date.now(), dayOnly: false, source: 'max-unread-fallback', serviceId: 'max', canonicalUrl: pinUrl
  })
  // Журнал фолбэков времени: запись только на сам переход (ветка выше
  // срабатывает один раз), а не на каждый опрос.
  if (typeof noteServiceTimeFallback === 'function') noteServiceTimeFallback('max', pinId, row && row.title)
  return 'fallback'
}

function parseChatTime(text) {
  const t = String(text || '').trim()
  if (!t) return { at: 0, dayOnly: false }
  // [datetime] у MAX — ISO-строка; Date без зоны трактует её как локальное время.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) {
    const iso = new Date(t)
    return Number.isFinite(iso.getTime()) ? { at: iso.getTime(), dayOnly: false } : { at: 0, dayOnly: false }
  }
  const now = new Date()
  let m
  if ((m = t.match(/^(\d{1,2}):(\d{2})$/))) {
    if (+m[1] > 23 || +m[2] > 59) return { at: 0, dayOnly: false }
    const d = new Date(now); d.setHours(+m[1], +m[2], 0, 0)
    // A message cannot be from later today. A compact clock with a later
    // value therefore belongs to the previous day, not the future.
    if (d.getTime() > now.getTime() + 60000) d.setDate(d.getDate() - 1)
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

// Время строки избранного: сегодня — ЧЧ:ММ, вчера — «ЧЧ:ММ вчера»,
// раньше — «ЧЧ:ММ ДД.ММ(.ГГ)». Источник без точного часа остаётся day-only.
// Сортировка при этом идёт по ТОЧНОМУ времени (lastMsgAt), не по этой строке.
function fmtRowTime(ms, dayOnly = false) {
  if (!ms) return ''
  const d = new Date(ms)
  const n = new Date()
  const pad = x => ('0' + x).slice(-2)
  const clock = pad(d.getHours()) + ':' + pad(d.getMinutes())
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return dayOnly ? 'сегодня' : clock
  }
  const y = new Date(n); y.setDate(y.getDate() - 1)
  if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return dayOnly ? 'вчера' : clock + ' вчера'
  let s = pad(d.getDate()) + '.' + pad(d.getMonth() + 1)
  if (d.getFullYear() !== n.getFullYear()) s += '.' + String(d.getFullYear()).slice(-2)
  return dayOnly ? s : clock + ' ' + s
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
        const uidTasks = new Map();
        const jobs = ${JSON.stringify(mmFavs.map(f => ({ id: f.id, url: f.url })))};
        const snapshots = new Map();
        const res = new Array(jobs.length);
        const resolveUsername = async username => {
          if (Object.prototype.hasOwnProperty.call(uidCache, username)) return uidCache[username];
          let task = uidTasks.get(username);
          if (!task) {
            task = (async () => {
              let id = null;
              try {
                const user = await get('/api/v4/users/username/' + encodeURIComponent(username));
                if (user && user.username === username && user.id) id = user.id;
              } catch (e) {}
              uidCache[username] = id;
              return id;
            })();
            uidTasks.set(username, task);
          }
          return task;
        };
        const snapshotFor = ch => {
          let task = snapshots.get(ch.id);
          if (!task) {
            task = (async () => {
              let prev = "", messageId = null;
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
                  prev = (uname ? uname + ": " : "") + String(post.message).split(String.fromCharCode(13)).join(" ").split(String.fromCharCode(10)).join(" ").split("**").join("").slice(0, 90);
                } }
              } catch (e) {}
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
              return { accountId: me.id, channelId: ch.id, at: ch.last_post_at, count: unreadCount, mentions, rootCount, rootMentions, preview: prev, messageId };
            })();
            snapshots.set(ch.id, task);
          }
          return task;
        };
        const one = async (j, index) => {
          let route;
          try {
            const url = new URL(j.url);
            if (url.origin !== location.origin) return;
            const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
            if (parts.length !== 3 || !['channels', 'messages'].includes(parts[1])) return;
            route = { team: parts[0], kind: parts[1], slug: parts[2] };
          } catch (e) { return; }
          let matches = [];
          if (route.kind === 'messages' && route.slug.startsWith('@')) {
            const uid = await resolveUsername(route.slug.slice(1));
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
          if (!ch) return;
          const snapshot = await snapshotFor(ch);
          res[index] = { ...snapshot, id: j.id };
        };
        let next = 0;
        const workers = Array.from({ length: Math.min(8, jobs.length) }, async () => {
          for (;;) {
            const index = next++;
            if (index >= jobs.length) return;
            await one(jobs[index], index);
          }
        });
        await Promise.all(workers);
        // A logout/account switch during the fetch sequence invalidates the batch.
        const current = await get('/api/v4/users/me');
        if (!current || current.id !== me.id) return '';
        return JSON.stringify({ uidCache: uidCache, res: res.filter(Boolean) });
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
    const rawAct = state.lastMsgAt[p.id] || 0
    const act = rawAct > Date.now() + 60000 && state.lastMsgDayOnly?.[p.id] !== true ? 0 : rawAct
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

// Заголовки, которые мессенджеры ставят сами (вкладка, шапка сервиса): только
// их и пустое имя можно переписать удалённым названием чата. Любое другое имя
// считается пользовательским — в том числе унаследованное от ручной правки в
// старых сборках без titleCustom (например «Astra Linux» у Телемоста).
function shouldAutoRenameTitle(svcId, title, url) {
  const t = String(title || '').trim()
  const generic = /^(telegram web|mattermost|telemost|яндекс чат|веб-версия max|max|чат|чаты|новый чат|messenger|dialogs)$/i.test(t)
  if (svcId !== 'tg') return !t || generic
  if (!t) return true
  if (isUsernameFallbackName(url, t)) return true
  return generic
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
  const avatarRows = []
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
    // MM channels can have no photo at all. Do not spend one of four global
    // avatar slots on such a row; later real profiles must not starve forever.
    if (f.needAvatar && rowLi && rowLi.querySelector('img[src]')) avatarRows.push({ id: f.id, row: rowLi })
    out.push({ id: f.id, unread: unread, count: count, mentions: mentions, found: found, avatar: avatar })
  }
  if (avatarRows.length) {
    const cursor = Number.isSafeInteger(window.__hubMmAvatarCursor) ? window.__hubMmAvatarCursor : 0
    const attempts = Math.min(4, avatarRows.length)
    for (let step = 0; step < attempts; step++) {
      const candidate = avatarRows[(cursor + step) % avatarRows.length]
      const avatar = await __chatHubBoundedAvatar(candidate.row, avatarBudget)
      if (avatar) {
        const result = out.find(r => r.id === candidate.id)
        if (result) result.avatar = avatar
      }
    }
    window.__hubMmAvatarCursor = (cursor + attempts) % avatarRows.length
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
  const badgeObservation = s => {
    const text = String(s || '').trim()
    if (!text) return { known: true, count: 0, numeric: false, unreadMarker: false, mentionMarker: false }
    if (text === '@') return { known: true, count: 0, numeric: false, unreadMarker: true, mentionMarker: true }
    if (/^[•●]$/.test(text)) return { known: true, count: 0, numeric: false, unreadMarker: true, mentionMarker: false }
    const raw = text.replace(/^@/, '')
    if (!/^\d+$/.test(raw)) return { known: false, count: 0, numeric: false, unreadMarker: false, mentionMarker: false }
    const count = Number(raw)
    if (!Number.isSafeInteger(count) || count < 0) return { known: false, count: 0, numeric: false, unreadMarker: false, mentionMarker: false }
    return { known: true, count, numeric: true, unreadMarker: false, mentionMarker: false }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const collect = () => {
    const list = []
    const peers = new Map()
    // только реальные строки диалогов (a[href^="#"]); служебные строки —
    // archive-dialog, предложения подарков — пропускаем. Время — .message-time
    // (обёртка .dialog-time-pill есть лишь у закреплённых, у остальных нет).
    document.querySelectorAll('a.row-clickable[href^="#"]').forEach((r, idx) => {
      const rect = typeof r.getBoundingClientRect === 'function' ? r.getBoundingClientRect() : null
      if (rect && (rect.width <= 0 || rect.height <= 0)) return
      try {
        const style = typeof getComputedStyle === 'function' ? getComputedStyle(r) : null
        if (style?.display === 'none' || style?.visibility === 'hidden') return
      } catch {}
      const t = r.querySelector('.peer-title')
      if (!t) return
      const pid = r.getAttribute('data-peer-id') || t.getAttribute('data-peer-id') || ''
      const title = t.textContent.trim()
      if (!pid || !title) return
      const tp = r.querySelector('.message-time')
      const bd = r.querySelector('.dialog-subtitle-badge-unread')
      const badge = badgeObservation(bd ? bd.textContent : '')
      let mentions = 0
      if (bd) {
        const rgb = (getComputedStyle(bd).backgroundColor.match(/\d+/g) || []).map(Number)
        if (String(bd.className).indexOf('danger') >= 0 || (rgb.length > 2 && rgb[0] > 170 && rgb[1] < 110)) {
          if (badge.known && (badge.count > 0 || badge.mentionMarker)) mentions = badge.count || 1
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
      const observation = {
        pid: pid,
        u: r.getAttribute('href') || '',
        title: title,
        time: tp ? tp.textContent.trim() : '',
        unreadTxt: bd ? bd.textContent.trim() : '',
        badgeKnown: badge.known,
        badgeCount: badge.count,
        badgeNumeric: badge.numeric,
        badgeMarker: badge.unreadMarker,
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
      }
      const prior = peers.get(pid)
      if (prior) {
        if (prior.unreadTxt !== observation.unreadTxt || prior.mentions !== observation.mentions || prior.unreadTitle !== observation.unreadTitle) prior.ambiguous = true
        return
      }
      peers.set(pid, observation)
      list.push(observation)
    })
    return list.filter(row => !row.ambiguous)
  }
  const avatarBudget = { attempts: 0 }
  const supH = (() => { const s = document.querySelector('.search-super'); return s ? s.getBoundingClientRect().height : 0 })()
  // A lower-bound badge must come from one visible snapshot, not merged
  // virtual windows whose rows may have been recycled during the sweep.
  const observedRows = collect()
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
      if (row.badgeKnown) {
        found = true
        rank = row.idx
        if (row.time) time = row.time
        count = row.badgeCount
        mentions = row.mentions
        unread = count > 0 || mentions > 0 || (!row.badgeNumeric && (row.unreadTitle || row.badgeMarker))
      }
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
  for (const r of observedRows) {
    if (!r.badgeKnown) continue
    svcTotal += r.badgeCount
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
  if (!allowScroll || focused() || scan.busy || Date.now() - scan.at < 10000) return [...rows.values()]
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

// MAX: состояние сессии по DOM. «Вход есть» — живой профиль (кнопка с
// aria-label в шапке) или строки списка; «нужен вход» — пустой список вместе с
// телефоном/QR/текстом входа; всё прочее, включая недогруженный документ, —
// «неизвестно» (не разлогин). Решение о разлогине принимает хост с антидребезгом.
function __chatHubMaxSession() {
  const count = selector => { try { return document.querySelectorAll(selector).length } catch (e) { return 0 } }
  const out = {
    readyState: String((document && document.readyState) || ''),
    profile: count('button.main[aria-label]'),
    rows: count('aside div.item'),
    cells: count('button.cell'),
    tel: count('input[type=tel]'),
    qr: count('canvas,img[alt*="QR" i]'),
    authWords: false
  }
  // Текст страницы читаем только там, где сессии заведомо не видно.
  if (out.profile === 0 && out.rows === 0) {
    try {
      out.authWords = /войти|вход|отсканируйте|qr-код|номер телефона|код из (sms|сообщения)/i
        .test(String((document.body && document.body.innerText) || ''))
    } catch (e) {}
  }
  out.state = 'unknown'
  if (out.readyState === 'complete') {
    if (out.profile > 0 || out.rows > 0) out.state = 'ok'
    else if (out.cells === 0 && (out.tel > 0 || out.qr > 0 || out.authWords)) out.state = 'auth'
  }
  return out
}

// --- MAX: выгрузка истории из той же вкладки, где пользователь залогинен ---
// Окно 9333 больше не нужно: строка списка кликается внутри webview MAX,
// отрисованное окно истории читается там же, в конце возвращается прежний чат.
// Все функции ниже либо исполняются в оболочке (оркестрация), либо сериализуются
// в webview через executeJavaScript (доступ к DOM MAX).

// Идентичность открытого чата — порт live_browser.py (_IDENTITY_SCRIPT):
// ровно одна кнопка профиля, метка начинается с «Открыть профиль », остаток —
// заголовок. Никаких id из pin.url: маршрут после открытия может быть числовым
// peer id или слагом, сравнение идёт только по заголовку.
function __chatHubMaxChatIdentity() {
  let pathname = ''
  let title = ''
  let code = null
  try { pathname = String((location && location.pathname) || '') } catch (e) {}
  try {
    const labels = document.querySelectorAll('button.main[aria-label]')
    if (!labels || labels.length !== 1) code = 'HEADER_MISMATCH'
    else {
      const raw = String(labels[0].getAttribute('aria-label') || '')
      const prefix = 'Открыть профиль '
      if (!raw.startsWith(prefix)) code = 'HEADER_MISMATCH'
      else title = raw.slice(prefix.length).trim()
      if (!code && !title) code = 'HEADER_MISMATCH'
    }
  } catch (e) { code = 'HEADER_MISMATCH' }
  return JSON.stringify({ pathname: pathname, title: title, code: code })
}

// Клик по строке списка MAX — порт live_browser.py (_OPEN_CHAT_SCRIPT):
// production-разметка — button.cell, заголовок — h3.title .name .text, точное
// совпадение после trim. 0 совпадений — CHAT_NOT_FOUND, больше одного —
// MULTIPLE_CHATS: неоднозначную строку не угадываем и не кликаем.
function __chatHubMaxClickRow(name) {
  const wanted = String(name == null ? '' : name).trim()
  let matches = []
  try {
    matches = Array.from(document.querySelectorAll('button.cell')).filter(row => {
      const cell = row.querySelector('h3.title .name .text')
      return !!cell && String(cell.textContent || '').trim() === wanted
    })
  } catch (e) { matches = [] }
  if (!wanted || matches.length === 0) return JSON.stringify({ ok: false, code: 'CHAT_NOT_FOUND' })
  if (matches.length > 1) return JSON.stringify({ ok: false, code: 'MULTIPLE_CHATS' })
  try {
    matches[0].click()
    return JSON.stringify({ ok: true })
  } catch (e) {
    return JSON.stringify({ ok: false, code: 'CHAT_NOT_FOUND' })
  }
}

// Чтение отрисованного окна истории. Ровно один контентный корень (второй матч
// `.history` — обёртка DnD). Обход идёт в порядке документа: разделители дня
// (`div.capsuleSeparator`, дубль `span.systemCapsule`, старый `span.capsule`)
// задают дату всем последующим сообщениям `.messageWrapper[role]`; вложения и
// стикеры без текста не читаются.
// withDiag === false — не строить второй DOM-замер: он нужен отчёту один раз, а
// при обходе ленты полный проход по документу на каждом шаге был бы лишней
// работой в живом окне.
function __chatHubMaxReadWindow(withDiag) {
  const MONTHS = {
    'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6,
    'июля': 7, 'августа': 8, 'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12
  }
  const isoDate = (year, month, day) => {
    const y = Number(year), m = Number(month), d = Number(day)
    if (!(y >= 1970 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null
    const probe = new Date(Date.UTC(y, m - 1, d))
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null
    return String(y) + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d
  }
  // Разделитель дня бывает «19 ноября 2026», «19 ноября», «18.11», «18.11.2026»,
  // «Сегодня»/«Вчера»/«Позавчера», ISO и служебным («Чат готов», «Непрочитанные»);
  // служебный дату не меняет. Относительные подписи считаются от локальной даты
  // запуска чтения, а не от UTC.
  const now = new Date()
  const today = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
  const shiftDay = offset => {
    const probe = new Date(Date.UTC(today.year, today.month - 1, today.day + offset))
    return isoDate(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate())
  }
  const parseCapsule = text => {
    const raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
    // «Сегодня»/«Вчера»/«Позавчера» — подписи MAX для свежих дней.
    const relative = { 'сегодня': 0, 'вчера': -1, 'позавчера': -2 }[raw.toLowerCase()]
    if (relative !== undefined) return shiftDay(relative)
    const words = /^(\d{1,2})\s+([а-яё]+)\s+(\d{4})(?:\s*г\.?)?$/i.exec(raw)
    if (words) {
      const month = MONTHS[words[2].toLowerCase()]
      return month ? isoDate(words[3], month, words[1]) : null
    }
    // «19 ноября» без года — та же дата текущего года.
    const short = /^(\d{1,2})\s+([а-яё]+)(?:\s*г\.?)?$/i.exec(raw)
    if (short) {
      const month = MONTHS[short[2].toLowerCase()]
      return month ? isoDate(today.year, month, short[1]) : null
    }
    // «18.11» и «18.11.2026» — числовая дата разделителя; без года — текущий год.
    const numeric = /^(\d{1,2})\.(\d{2})(?:\.(\d{4}))?$/.exec(raw)
    if (numeric) return isoDate(numeric[3] || today.year, numeric[2], numeric[1])
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(raw)
    return iso ? isoDate(iso[1], iso[2], iso[3]) : null
  }
  // Мета сообщения: у сегодняшних MAX рисует только «18:28» или «ред. 20:21»,
  // у старых — дату «31 мая», «31 мая 2025», «31.05», «31.05.2025».
  // Время важнее: сообщение с часом считается сегодняшним (dayOnly=false),
  // дата без часа — днём без времени (dayOnly=true), полдень не выдумываем.
  const parseMeta = text => {
    const raw = String(text == null ? '' : text)
      // Невидимые символы MAX (маркеры направления, BOM) не должны мешать часу.
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
      .replace(/\s+/g, ' ').trim()
    if (!raw) return null
    let time = ''
    const clock = /(?:^|[^\d])(\d{1,2}):(\d{2})(?!\d)/.exec(raw)
    if (clock) {
      const hours = Number(clock[1]), minutes = Number(clock[2])
      if (hours <= 23 && minutes <= 59) time = (hours < 10 ? '0' : '') + hours + ':' + clock[2]
    }
    let date = null
    const words = /(?:^|[^\d])(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?(?![\d])/i.exec(raw)
    if (words) {
      const month = MONTHS[words[2].toLowerCase()]
      if (month) date = isoDate(words[3] || today.year, month, words[1])
    }
    if (!date) {
      const numeric = /(?:^|[^\d])(\d{1,2})\.(\d{2})(?:\.(\d{4}))?(?![\d])/.exec(raw)
      if (numeric) date = isoDate(numeric[3] || today.year, numeric[2], numeric[1])
    }
    if (!time && !date) return null
    return { time: time, date: date }
  }
  // Локальная сегодняшняя дата: час в мете бывает только у сегодняшних сообщений.
  const todayIso = isoDate(today.year, today.month, today.day)
  try {
    const roots = Array.from(document.querySelectorAll('.history.history--withBottomMargin[data-scale]'))
    // Диагностика DOM (только чтение): что реально лежит в корне истории.
    // Нужна, чтобы отличить «капсул нет» от «капсула есть, но текст другой»,
    // не гадая и не повторяя живой прогон. Счётчики и примеры ограничены,
    // чтобы отчёт не раздувался.
    const classNames = node => {
      if (!node) return ''
      const raw = typeof node.className === 'string' && node.className ? node.className : node.getAttribute('class')
      return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim()
    }
    const samples = (nodes, limit) => nodes.slice(0, limit)
      .map(node => String(node.textContent == null ? '' : node.textContent).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    const collect = selector => roots.reduce((found, root) => found.concat(Array.from(root.querySelectorAll(selector))), [])
    const capsules = collect('span.capsule')
    // Разделители дня новой версии MAX: по ним видно, откуда берётся дата.
    const separators = collect('.capsuleSeparator, .systemCapsule')
    const metas = collect('.meta')
    const diag = {
      roots: roots.length,
      capsuleCount: capsules.length,
      capsuleSamples: samples(capsules, 5),
      separatorCount: separators.length,
      separatorSamples: samples(separators, 5),
      wrapperCount: collect('.messageWrapper[role]').length,
      metaCount: metas.length,
      metaSamples: samples(metas, 3),
      // Полный className каждого .history страницы: видно, какие варианты корня
      // рисует эта версия MAX и нет ли отдельного контейнера под даты.
      historyClasses: Array.from(document.querySelectorAll('.history')).map(classNames)
    }
    // Второй замер: где в этой версии MAX лежит дата. Диагностика не должна
    // ломать чтение — при любой ошибке остаются поля первого замера и пустые
    // вторые, а не MALFORMED_DOM.
    if (withDiag !== false) {
      try {
        const dateAttrs = ['data-date', 'datetime', 'data-day', 'data-timestamp']
        // Текст-дата: относительные подписи, «19 ноября [2026]», «19.11.2026».
        const dateText = /^(сегодня|вчера|позавчера|\d{1,2}\s+[а-яё]+(\s+\d{4})?|\d{2}\.\d{2}\.\d{4})$/i
        const hasDateAttr = node => dateAttrs.some(name => {
          if (typeof node.hasAttribute === 'function') return node.hasAttribute(name)
          return typeof node.getAttribute === 'function' && node.getAttribute(name) != null
        })
        const nodeInfo = (node, limit) => ({
          tag: String(node.tagName || node.tag || '').toLowerCase(),
          cls: classNames(node),
          text: String(node.textContent == null ? '' : node.textContent).replace(/\s+/g, ' ').trim().slice(0, limit)
        })
        // Капсулы по всему документу, а не только внутри выбранного корня.
        const docCapsules = Array.from(document.querySelectorAll('.capsule'))
        // Узлы с датой-текстом или date-атрибутом — первые 8 в порядке документа.
        const dateLikeNodes = []
        for (const node of Array.from(document.querySelectorAll('*'))) {
          if (dateLikeNodes.length >= 8) break
          const text = String(node.textContent == null ? '' : node.textContent).replace(/\s+/g, ' ').trim()
          const textHit = text.length > 0 && text.length <= 40 && dateText.test(text)
          if (!textHit && !hasDateAttr(node)) continue
          dateLikeNodes.push(nodeInfo(node, 40))
        }
        diag.docCapsules = { total: docCapsules.length, texts: samples(docCapsules, 5) }
        diag.dateLikeNodes = dateLikeNodes
        // Прямые дети корня: капсула даты, обёртка сообщения или что-то ещё.
        diag.firstChildren = roots.length
          ? Array.from(roots[0].children || []).slice(0, 25).map(child => nodeInfo(child, 30))
          : []
        // Мета, где есть что-то кроме HH:MM: дата у старых сообщений была бы видна.
        diag.metaWithDate = metas
          .map(node => String(node.textContent == null ? '' : node.textContent).replace(/\s+/g, ' ').trim())
          .filter(text => text && text.replace(/\d{1,2}:\d{2}/g, '').replace(/[\s,;·•—–-]+/g, '') !== '')
          .slice(0, 5)
      } catch (e) {
        diag.docCapsules = diag.docCapsules || { total: 0, texts: [] }
        diag.dateLikeNodes = diag.dateLikeNodes || []
        diag.firstChildren = diag.firstChildren || []
        diag.metaWithDate = diag.metaWithDate || []
      }
    }
    if (roots.length !== 1) return JSON.stringify({ ok: false, code: 'MALFORMED_DOM', diag: diag })
    // Порядок документа: разделитель дня, затем сообщения до следующего раздела.
    // Тег в селекторе не фиксирован: класс разделителя может переехать с div на
    // span, а span.capsule остаётся для других версий MAX.
    const nodes = Array.from(roots[0].querySelectorAll('.capsuleSeparator, .systemCapsule, span.capsule, .messageWrapper[role]'))
    const messages = []
    let date = null
    for (const node of nodes) {
      if (node.matches('.capsuleSeparator') || node.matches('.systemCapsule') || node.matches('span.capsule')) {
        const parsed = parseCapsule(node.textContent)
        if (parsed) date = parsed
        continue
      }
      const texts = node.querySelectorAll('span.text[data-message-markup]')
      const authors = node.querySelectorAll('.author .name')
      // Два текста или два автора в одном пузыре — битая разметка, не угадываем.
      if (texts.length > 1 || authors.length > 1) return JSON.stringify({ ok: false, code: 'MALFORMED_DOM', diag: diag })
      if (!texts.length) continue
      // Мета ищется внутри пузыря: span.meta, div.meta и span.time. Части
      // .meta .text тоже читаем — старые версии MAX держат время в них.
      let time = ''
      let metaDate = null
      for (const meta of Array.from(node.querySelectorAll('span.meta, div.meta, span.time, .meta .text'))) {
        const parsed = parseMeta(meta.textContent)
        if (!parsed) continue
        if (!time && parsed.time) time = parsed.time
        if (!metaDate && parsed.date) metaDate = parsed.date
        if (time && metaDate) break
      }
      // Дата — из последнего разделителя выше по ленте; без разделителя
      // сообщение с часом сегодняшнее (MAX рисует время только у текущего дня).
      // Дата в мете старого сообщения точнее «сегодня» и остаётся запасной.
      // Время есть — день известен точно; дата без времени день знает, а час
      // нет: dayOnly, полночь, не полдень. Ни даты, ни времени — undated.
      const stampDate = date || metaDate || (time ? todayIso : null)
      const dayOnly = !time && stampDate !== null
      // У исходящих MAX не рисует имя: подписываем «Я» только по классу
      // .message--isOut. Входящее без автора остаётся «—», имя не выдумываем.
      const authorName = authors.length ? String(authors[0].textContent || '').trim() : ''
      messages.push({
        text: String(texts[0].textContent || '').trim(),
        author: authorName || (node.querySelector('.message--isOut') !== null ? 'Я' : '—'),
        date: stampDate,
        time: time,
        dayOnly: dayOnly
      })
    }
    if (!messages.length) return JSON.stringify({ ok: false, code: 'HISTORY_EMPTY', diag: diag })
    return JSON.stringify({ ok: true, messages: messages, diag: diag })
  } catch (e) {
    return JSON.stringify({ ok: false, code: 'MALFORMED_DOM' })
  }
}

// --- MAX: лента среди прокручиваемых контейнеров ---------------------------
// Живой CDP-замер: в документе MAX два '.scrollable.scrollListScrollable' —
// индекс 0 список чатов (внутри нет .messageWrapper), индекс 1 лента (есть).
// В узкой правой панели pin-view MAX держит в DOM только окно вокруг scrollTop
// (у НЭСК 6 сообщений из 30), поэтому лента читается прокруткой сверху вниз:
// метрики читаются, позиция двигается отдельной функцией.

// Метрики ленты: сколько прокручиваемых контейнеров, сколько из них с
// сообщениями, запас прокрутки и число обёрток. Прокручиваемых контейнеров нет
// вовсе — разметка без виртуализации (NO_SCROLLERS): покрытие остаётся 'window'.
// Контейнеры есть, а сообщений ни в одном нет — лента не отрисована.
function __chatHubMaxFeedMetrics() {
  let scrollers = []
  try { scrollers = Array.from(document.querySelectorAll('.scrollable.scrollListScrollable')) } catch (e) { scrollers = [] }
  const hasMessages = node => {
    try { return !!(node && typeof node.querySelector === 'function' && node.querySelector('.messageWrapper')) } catch (e) { return false }
  }
  const feeds = scrollers.filter(hasMessages)
  if (!scrollers.length) return JSON.stringify({ ok: false, code: 'NO_SCROLLERS', scrollers: 0, feeds: 0 })
  if (!feeds.length) return JSON.stringify({ ok: false, code: 'HISTORY_ROOT_MISSING', scrollers: scrollers.length, feeds: 0 })
  // Несколько контейнеров с сообщениями — берём первый по документу: лента одна,
  // а скрытый дубль не должен ломать сбор. index — позиция среди всех
  // '.scrollListScrollable' (в живой разметке 0 — список чатов, 1 — лента).
  const node = feeds[0]
  const index = scrollers.indexOf(node)
  // Число обёрток в текущем окне: по нему видно, сколько MAX отрисовал вокруг
  // scrollTop. Само чтение позицию не меняет.
  let wrapperCount = 0
  try { wrapperCount = node.querySelectorAll('.messageWrapper').length } catch (e) { wrapperCount = 0 }
  const scrollHeight = Number(node.scrollHeight) || 0
  const clientHeight = Number(node.clientHeight) || 0
  return JSON.stringify({
    ok: true,
    scrollers: scrollers.length,
    feeds: feeds.length,
    index: index,
    scrollTop: Number(node.scrollTop) || 0,
    scrollHeight: scrollHeight,
    clientHeight: clientHeight,
    // Запас прокрутки: ноль и меньше — лента целиком в DOM, догружать нечего.
    reserve: Math.max(0, scrollHeight - clientHeight),
    wrapperCount: wrapperCount
  })
}

// Запись позиции ленты. Берём ту же ленту, что и метрики: первый по документу
// '.scrollListScrollable' с .messageWrapper (список чатов сообщений не держит).
// Значение зажимается в [0, scrollHeight - clientHeight], как это сделал бы
// браузер; возвращаются метрики после записи — по ним видно, дошли ли до низа.
function __chatHubMaxScrollFeedTo(top) {
  let scrollers = []
  try { scrollers = Array.from(document.querySelectorAll('.scrollable.scrollListScrollable')) } catch (e) { scrollers = [] }
  const node = scrollers.find(item => {
    try { return !!(item && typeof item.querySelector === 'function' && item.querySelector('.messageWrapper')) } catch (e) { return false }
  })
  if (!node) return JSON.stringify({ ok: false, code: 'HISTORY_ROOT_MISSING' })
  const scrollHeight = Number(node.scrollHeight) || 0
  const clientHeight = Number(node.clientHeight) || 0
  const max = Math.max(0, scrollHeight - clientHeight)
  const value = Math.min(Math.max(0, Number(top) || 0), max)
  try { node.scrollTop = value } catch (e) {
    return JSON.stringify({ ok: false, code: 'SCROLL_FAILED' })
  }
  let wrapperCount = 0
  try { wrapperCount = node.querySelectorAll('.messageWrapper').length } catch (e) { wrapperCount = 0 }
  return JSON.stringify({
    ok: true,
    scrollTop: Number(node.scrollTop) || value,
    scrollHeight: scrollHeight,
    clientHeight: clientHeight,
    reserve: max,
    wrapperCount: wrapperCount
  })
}

// id чата MAX из pin.url (/\.?-?\d+/): в web.max.ru чат адресуется числом.
function __chatHubMaxChatId(url) {
  let pathname = ''
  try { pathname = new URL(String(url == null ? '' : url)).pathname } catch (e) { pathname = String(url == null ? '' : url) }
  const match = /\.?(-?\d+)/.exec(pathname)
  return match ? match[1] : ''
}

// Время сообщения: дата + время, Новосибирск = UTC+7.
// dayOnly — известен только день: полночь и явный флаг, полдень не выдумываем.
function __chatHubMaxStamp(date, time, dayOnly) {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date == null ? '' : date).trim())
  if (!day) return null
  const stamp = day[1] + '-' + day[2] + '-' + day[3]
  if (dayOnly === true) return stamp + 'T00:00:00+07:00'
  const clock = /^(\d{1,2}):(\d{2})$/.exec(String(time == null ? '' : time).trim())
  if (!clock) return null
  const hours = Number(clock[1]), minutes = Number(clock[2])
  if (hours > 23 || minutes > 59) return null
  return stamp + 'T' + (hours < 10 ? '0' : '') + hours + ':' + clock[2] + ':00+07:00'
}

// Ссылки из текста: только http(s), без хвостовой пунктуации; парные скобки
// внутри URL (Foo_(bar)) сохраняются.
function __chatHubMaxLinks(text) {
  const links = []
  const strip = value => {
    let link = value.replace(/[.,;:!?»"']+$/, '')
    while (link.endsWith(')') && (link.match(/\(/g) || []).length < (link.match(/\)/g) || []).length) link = link.slice(0, -1)
    while (link.endsWith(']') && (link.match(/\[/g) || []).length < (link.match(/\]/g) || []).length) link = link.slice(0, -1)
    return link
  }
  const found = String(text == null ? '' : text).match(/https?:\/\/[^\s<>"'`]+/gi) || []
  for (const match of found) {
    const link = strip(match)
    if (link && !links.includes(link)) links.push(link)
  }
  return links
}

function __chatHubMaxSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Ожидание переключения — порт live_browser.py (_wait_identity): до 25 попыток
// по 200 мс, на каждой читается identity и сравнивается заголовок. Совпало —
// успех; не совпало за весь бюджет — SWITCH_TIMEOUT с фактическим заголовком,
// чтобы отчёт чата объяснял, что было открыто на самом деле.
async function __chatHubMaxWaitSwitch(wv, expectedTitle) {
  const attempts = 25
  const intervalMs = 200
  const wanted = String(expectedTitle == null ? '' : expectedTitle).trim()
  let actual = ''
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await __chatHubMaxSleep(intervalMs)
    let identity = null
    try { identity = JSON.parse(String(await wv.executeJavaScript('(' + __chatHubMaxChatIdentity.toString() + ')()') || '')) } catch (e) { continue }
    if (!identity || typeof identity !== 'object') continue
    actual = typeof identity.title === 'string' ? identity.title.trim() : ''
    if (wanted && actual === wanted) {
      return {
        ok: true,
        pathname: typeof identity.pathname === 'string' ? identity.pathname : '',
        title: actual
      }
    }
  }
  return { ok: false, code: 'SWITCH_TIMEOUT', expected: wanted, actual: actual }
}

// --- MAX: префлайт перед обходом чатов -------------------------------------
// Живой дефект: коллектор жёстко читал state.svcViews.max, хотя человек смотрит
// избранный чат в pin-view, а пустая/разлогиненная страница давала «корней 0» и
// маскировалась кодами MALFORMED_DOM/CHAT_NOT_FOUND. Ниже — выбор рабочего окна,
// префлайт сессии, гарантия загрузки страницы и однократный перезагруз ленты.

// Ответ webview: JSON-строка или уже значение; мусор — null (не исключение).
async function __chatHubMaxJson(promise) {
  try {
    const value = await promise
    return typeof value === 'string' ? JSON.parse(value) : value
  } catch (e) { return null }
}

// URL окна: getURL() у настоящего webview, src — у ещё не загруженного тега.
function __chatHubMaxViewUrl(view) {
  if (!view) return ''
  try {
    if (typeof view.getURL === 'function') {
      const url = String(view.getURL() || '')
      if (url) return url
    }
  } catch (e) {}
  try {
    if (typeof view.src === 'string' && view.src) return view.src
  } catch (e) {}
  return ''
}

// Проба гостевой страницы: где она и что реально нарисовано. Один вызов на
// кандидата — по нему видно, есть ли лента и строки списка.
function __chatHubMaxProbeView() {
  const count = selector => { try { return document.querySelectorAll(selector).length } catch (e) { return 0 } }
  let href = ''
  try { href = String((location && location.href) || '') } catch (e) {}
  return JSON.stringify({
    href: href,
    historyRoots: count('.history.history--withBottomMargin'),
    rows: count('button.cell')
  })
}

async function __chatHubMaxProbe(view) {
  if (!view || typeof view.executeJavaScript !== 'function') return null
  const info = await __chatHubMaxJson(view.executeJavaScript('(' + __chatHubMaxProbeView.toString() + ')()'))
  if (!info || typeof info !== 'object') return null
  return {
    href: typeof info.href === 'string' ? info.href : '',
    historyRoots: Number(info.historyRoots) || 0,
    rows: Number(info.rows) || 0
  }
}

// Выбор рабочего окна: приоритет — лента (historyRoots > 0), затем строки списка,
// затем подключённое окно на web.max.ru. Подключённое, но ещё не загруженное окно
// (about:blank) не считается мёртвым: его грузит гарантия загрузки ниже. Мёртвое —
// отсутствующее или отключённое (isConnected === false).
async function __chatHubMaxChooseView(candidates) {
  const list = Array.isArray(candidates) ? candidates : []
  const probed = []
  for (const item of list) {
    if (!item || !item.view || item.view.isConnected === false) continue
    if (typeof item.view.executeJavaScript !== 'function') continue
    probed.push({ view: item.view, source: item.source, pinId: item.pinId, probe: await __chatHubMaxProbe(item.view) })
  }
  if (!probed.length) return null
  const withHistory = probed.find(item => item.probe && item.probe.historyRoots > 0)
  if (withHistory) return withHistory
  const withRows = probed.find(item => item.probe && item.probe.rows > 0)
  if (withRows) return withRows
  const onMax = probed.find(item => /^https?:\/\/web\.max\.ru(\/|$|\?|#)/i
    .test(String((item.probe && item.probe.href) || __chatHubMaxViewUrl(item.view))))
  if (onMax) return onMax
  return probed[0]
}

// Гарантия загрузки: окно отсутствует/стоит на about:blank — грузим корень MAX и
// ждём готовности (readyState complete и есть строки списка или экран входа,
// который дальше назовёт префлайт сессии). Бюджет — 15 с, как в требовании.
async function __chatHubMaxEnsureLoaded(wv) {
  if (!wv) return false
  if (/^https?:\/\/web\.max\.ru(\/|$|\?|#)/i.test(__chatHubMaxViewUrl(wv))) return true
  if (typeof wv.loadURL !== 'function') return false
  try {
    const pending = wv.loadURL('https://web.max.ru/')
    if (pending && typeof pending.then === 'function') await pending
  } catch (e) { return false }
  for (let attempt = 0; attempt < 75; attempt += 1) {
    await __chatHubMaxSleep(200)
    const info = await __chatHubMaxJson(wv.executeJavaScript('(' + __chatHubMaxSession.toString() + ')()'))
    if (!info) continue
    if (info.readyState === 'complete' &&
        (Number(info.rows) > 0 || Number(info.cells) > 0 || info.state === 'auth')) return true
  }
  return false
}

// Сколько корней ленты нарисовано сейчас; null — пробу снять не удалось.
async function __chatHubMaxHistoryRoots(wv) {
  const probe = await __chatHubMaxProbe(wv)
  return probe ? probe.historyRoots : null
}

// Однократный перезагруз URL пина после пустой ленты: loadURL и одно ожидание
// появления корня в пределах бюджета (10 с в приложении). Не цикл: вызывается
// ровно один раз на чат.
async function __chatHubMaxReloadHistory(wv, url, budgetMs) {
  if (!wv || typeof wv.loadURL !== 'function') return 0
  try {
    const pending = wv.loadURL(String(url || 'https://web.max.ru/'))
    if (pending && typeof pending.then === 'function') await pending
  } catch (e) { return 0 }
  const budget = Number(budgetMs) > 0 ? Number(budgetMs) : 10000
  const deadline = Date.now() + budget
  for (;;) {
    await __chatHubMaxSleep(250)
    const roots = await __chatHubMaxHistoryRoots(wv)
    if (Number(roots) > 0) return Number(roots)
    if (Date.now() >= deadline) return 0
  }
}

// Точка входа из main: request — JSON-строка или объект { chats:[{pinId,url,title}], timeoutMs }.
// timeoutMs больше не управляет переключением: бюджет задан в __chatHubMaxWaitSwitch
// (25 попыток по 200 мс, как в проверенном коннекторе MAX).
// Возвращает JSON-строку отчёта; всё выполняется в одном вызове без окон 9333.
async function __chatHubCollectMaxHistory(requestJson) {
  // Отчёт: чаты плюс строки состояния префлайта (session/view/notes) — по ним
  // видно причину пустоты, без догадок.
  const report = { chats: [], restored: false, session: null, view: null, notes: [] }
  let request = null
  // main встраивает JSON.stringify(...) прямо в строку вызова, поэтому на входе
  // может быть и готовая JSON-строка, и уже вычисленный объект.
  try {
    const value = typeof requestJson === 'string' ? JSON.parse(requestJson) : requestJson
    request = value && typeof value === 'object' ? value : null
  } catch (e) { request = null }
  const list = request && Array.isArray(request.chats) ? request.chats : []
  // Бюджет ожидания ленты после перезагруза. Приложение его не передаёт (10 с);
  // тесты задают меньше, чтобы отказ не ждал полный бюджет.
  const historyWaitMs = request && Number(request.historyWaitMs) > 0 ? Number(request.historyWaitMs) : 10000
  // detail попадает в отчёт чата: при SWITCH_TIMEOUT это expected/actual, по
  // которым видно, какой чат реально был открыт. diag — DOM-диагностика
  // чтения, её несёт только первый MAX-чат, чтобы отчёт не раздувался.
  const push = (chat, status, code, messages, detail, diag, coverage) => {
    const entry = {
      pinId: chat && chat.pinId !== undefined ? chat.pinId : null,
      status: status,
      code: code || null,
      // window — разметка без прокручиваемого контейнера; full — глубина
      // достигнута или запаса прокрутки нет; truncated — возможный срез:
      // ровно 30 обёрток при запасе не меньше 4 px.
      coverage: coverage === 'full' || coverage === 'truncated' ? coverage : 'window',
      messages: Array.isArray(messages) ? messages : []
    }
    if (detail && typeof detail === 'object') {
      entry.detail = {
        expected: String(detail.expected == null ? '' : detail.expected),
        actual: String(detail.actual == null ? '' : detail.actual)
      }
    }
    if (diag && typeof diag === 'object') entry.diag = diag
    report.chats.push(entry)
  }
  // Ровно одна строка состояния сессии на отчёт: «сессия ок», «сессия завершена»
  // или «состояние неизвестно» (последнее не блокирует сбор).
  const setSession = (value, info) => {
    const sessionState = value === 'ok' || value === 'auth' ? value : 'unknown'
    const line = sessionState === 'auth' ? 'MAX: сессия завершена'
      : sessionState === 'ok' ? 'MAX: сессия ок' : 'MAX: состояние неизвестно'
    report.session = {
      state: sessionState,
      readyState: info && info.readyState ? String(info.readyState) : '',
      line: line
    }
    report.notes = report.notes.filter(item => !/^MAX: (сессия |состояние неизвестно)/.test(item))
    report.notes.push(line)
  }
  // Ровно одна строка о рабочем окне: откуда взят DOM и сколько корней ленты.
  const setView = (source, pinId, roots) => {
    const kind = source === 'pin' || source === 'service' ? source : null
    const line = 'MAX: рабочий webview — ' + (kind === 'pin' ? 'pin' : kind === 'service' ? 'service' : 'нет') +
      ', лента: ' + (Number(roots) || 0)
    report.view = { source: kind, pinId: pinId || null, historyRoots: Number(roots) || 0, line: line }
    report.notes = report.notes.filter(item => !/^MAX: рабочий webview — /.test(item))
    report.notes.push(line)
  }
  // Кандидаты в порядке приоритета: активный MAX-пин (сюда смотрит человек),
  // остальные MAX-пины, затем служебная вкладка сервиса. Одно и то же окно
  // дважды не пробуем.
  const appState = typeof state !== 'undefined' && state ? state : null
  const pins = appState && appState.cfg && Array.isArray(appState.cfg.pinned) ? appState.cfg.pinned : []
  const pinViews = appState && appState.pinViews ? appState.pinViews : {}
  const candidates = []
  const seenViews = new Set()
  const addCandidate = (view, source, pinId) => {
    if (!view || seenViews.has(view)) return
    seenViews.add(view)
    candidates.push({ view: view, source: source, pinId: pinId || null })
  }
  const activePin = appState && appState.activePinId ? pins.find(pin => pin && pin.id === appState.activePinId) : null
  if (activePin && activePin.serviceId === 'max') addCandidate(pinViews[activePin.id], 'pin', activePin.id)
  for (const pin of pins) {
    if (!pin || pin.serviceId !== 'max') continue
    addCandidate(pinViews[pin.id], 'pin', pin.id)
  }
  addCandidate(appState && appState.svcViews ? appState.svcViews.max : null, 'service', null)

  // Живого окна нет вовсе — сбор невозможен, отчёт остаётся схемой.
  const picked = await __chatHubMaxChooseView(candidates)
  if (!picked) {
    setView(null, null, 0)
    setSession('unknown', null)
    for (const chat of list) push(chat, 'error', 'MAX_VIEW_MISSING')
    return JSON.stringify(report)
  }
  const wv = picked.view
  // Гарантия загрузки: about:blank и выгруженная вкладка дают пустой DOM, который
  // иначе выглядит как «корней 0» при живом MAX.
  const wasOnMax = /^https?:\/\/web\.max\.ru(\/|$|\?|#)/i.test(__chatHubMaxViewUrl(wv))
  const ready = await __chatHubMaxEnsureLoaded(wv)
  if (!ready) {
    setView(null, picked.pinId, 0)
    setSession('unknown', null)
    for (const chat of list) push(chat, 'error', 'MAX_VIEW_MISSING')
    return JSON.stringify(report)
  }
  // Лента после загрузки: число корней в отчёте должно быть фактическим.
  const viewProbe = wasOnMax ? picked.probe : await __chatHubMaxProbe(wv)
  setView(picked.source, picked.pinId, viewProbe ? viewProbe.historyRoots : 0)
  // Префлайт сессии: экран входа — не «битая разметка» и не «чат не найден».
  // «Неизвестно» (документ не догружен) сбор не блокирует.
  const session = await __chatHubMaxJson(wv.executeJavaScript('(' + __chatHubMaxSession.toString() + ')()'))
  setSession(session && session.state === 'auth' ? 'auth' : session && session.state === 'ok' ? 'ok' : 'unknown', session)
  if (report.session.state === 'auth') {
    for (const chat of list) push(chat, 'error', 'MAX_SESSION_LOST')
    return JSON.stringify(report)
  }
  const call = (fn, ...args) => wv.executeJavaScript('(' + fn.toString() + ')(' + args.map(arg => JSON.stringify(arg)).join(', ') + ')')
  const json = __chatHubMaxJson
  // Исходный чат запоминаем ДО первого переключения: путь и заголовок.
  const before = await json(call(__chatHubMaxChatIdentity))
  const original = {
    pathname: before && typeof before.pathname === 'string' ? before.pathname : '',
    title: before && typeof before.title === 'string' ? before.title.trim() : ''
  }
  let diagSeen = false
  // Трасса скроллера — ровно одна на отчёт: у первого MAX-чата, который дошёл
  // до обхода ленты. По ней видно, двигается ли контейнер и меняется ли окно.
  let traceSeen = false
  for (const chat of list) {
    const title = String(chat && chat.title != null ? chat.title : '').trim()
    if (!title) { push(chat, 'error', 'CHAT_NOT_FOUND'); continue }
    // Переключение — клик по button.cell, как в проверенном коннекторе MAX.
    // Неоднозначность и отсутствие строки — разные коды, клика нет.
    const opened = await json(call(__chatHubMaxClickRow, title))
    if (!opened || opened.ok !== true) {
      const code = opened && opened.code === 'MULTIPLE_CHATS' ? 'MULTIPLE_CHATS' : 'CHAT_NOT_FOUND'
      push(chat, 'error', code)
      continue
    }
    const switched = await __chatHubMaxWaitSwitch(wv, title)
    if (!switched || switched.ok !== true) {
      push(chat, 'error', 'SWITCH_TIMEOUT', null, {
        expected: title,
        actual: switched && typeof switched.actual === 'string' ? switched.actual : ''
      })
      continue
    }
    // MAX дорисовывает ленту после внутренней навигации не мгновенно: короткая
    // пауза только при реальной смене пути, чтобы не прочитать прошлое окно.
    if (switched.pathname && switched.pathname !== original.pathname) await __chatHubMaxSleep(250)
    // Лента могла не отрисоваться вовсе. Один перезагруз URL пина и одно
    // повторное ожидание (не цикл): пустая лента — отдельный код, а не
    // MALFORMED_DOM/CHAT_NOT_FOUND.
    let roots = await __chatHubMaxHistoryRoots(wv)
    if (roots === 0) roots = await __chatHubMaxReloadHistory(wv, chat && chat.url, historyWaitMs)
    if (roots === 0) {
      push(chat, 'error', 'HISTORY_ROOT_MISSING')
      continue
    }
    // Лента: в документе MAX два '.scrollable.scrollListScrollable' — список
    // чатов (индекс 0, без сообщений) и лента (индекс 1, с .messageWrapper).
    // Контейнеров нет вовсе — прежнее однооконное чтение (разметка без
    // виртуализации), покрытие остаётся 'window'.
    const feedMetrics = await json(call(__chatHubMaxFeedMetrics))
    if (feedMetrics && feedMetrics.ok !== true && feedMetrics.code === 'HISTORY_ROOT_MISSING') {
      push(chat, 'error', 'HISTORY_ROOT_MISSING')
      continue
    }
    const measured = !!(feedMetrics && feedMetrics.ok === true)
    // Граница глубины — та же, что у моста (depthDays из конфига).
    const windowStartMs = request && Number.isFinite(request.windowStartMs) ? Number(request.windowStartMs) : null
    // DOM-диагностику берём только у первого прочитанного MAX-чата: она
    // отвечает на вопрос «какие капсулы и мета реально в DOM».
    let diag = null
    // Накопитель окон. В узкой панели MAX рендерит только окно вокруг
    // scrollTop, поэтому лента читается шагами сверху вниз, а перекрывающиеся
    // окна склеиваются по подписи (дата+время+автор+первые 80 символов текста).
    // Одинаковый текст в разное время даёт разные подписи и не теряется.
    const collected = []
    const seenMessages = new Set()
    const messageKey = item => [
      String(item && item.date != null ? item.date : ''),
      String(item && item.time != null ? item.time : ''),
      String(item && item.author != null ? item.author : ''),
      String(item && item.text != null ? item.text : '').slice(0, 80)
    ].join('\u0001')
    const addWindow = windowData => {
      const items = Array.isArray(windowData && windowData.messages) ? windowData.messages : []
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const key = messageKey(item)
        if (seenMessages.has(key)) continue
        seenMessages.add(key)
        collected.push(item)
      }
    }
    // Сколько раз прочитано окно. 60 — потолок на случай бесконечной ленты.
    let steps = 0
    let firstWindow = null
    let coverage = 'window'
    // Строка трассы скроллера: строится в ветке обхода, а печатается ниже —
    // там, где уже известны итоговые шаги и число собранных сообщений.
    let scrollerTrace = null
    if (measured) {
      // Исходная позиция: после обхода вернём её (best effort).
      const originalTop = Number(feedMetrics.scrollTop) || 0
      // В узкой панели в DOM только окно вокруг scrollTop — начинаем с начала.
      await json(call(__chatHubMaxScrollFeedTo, 0))
      await __chatHubMaxSleep(400)
      // Метрики до первого шага: позиция, высоты ленты и окна, число обёрток.
      // Снимаются только у первого чата — трасса не растёт на каждый чат.
      let traceBefore = null
      let traceAfter = null
      if (!traceSeen) {
        const startMetrics = await json(call(__chatHubMaxFeedMetrics))
        if (startMetrics && startMetrics.ok === true) traceBefore = startMetrics
      }
      let reachedBottom = false
      for (let step = 0; step < 60; step += 1) {
        steps = step + 1
        const frame = await json(call(__chatHubMaxReadWindow, !diagSeen))
        if (step === 0) firstWindow = frame
        if (!frame || frame.ok !== true) break
        if (!diagSeen && frame.diag && typeof frame.diag === 'object') {
          diag = frame.diag
          diagSeen = true
        }
        addWindow(frame)
        const metrics = await json(call(__chatHubMaxFeedMetrics))
        if (!metrics || metrics.ok !== true) break
        const top = Number(metrics.scrollTop) || 0
        const height = Number(metrics.clientHeight) || 0
        const total = Number(metrics.scrollHeight) || 0
        // Низ ленты: дальше двигать некуда. Нулевая высота окна — не крутим
        // вслепую 60 раз, честно оставляем покрытие неполным.
        if (height <= 0) break
        if (top + height >= total - 2) { reachedBottom = true; break }
        await json(call(__chatHubMaxScrollFeedTo, top + height * 0.9))
        await __chatHubMaxSleep(500)
        // Замер после первого шага: сдвинулась ли позиция и что стало с окном.
        // Отказ замера не отменяет трассу — остаются метрики до записи позиции.
        if (step === 0 && traceBefore && !traceAfter) {
          const afterMetrics = await json(call(__chatHubMaxFeedMetrics))
          traceAfter = afterMetrics && afterMetrics.ok === true ? afterMetrics : metrics
        }
      }
      // Первое окно не прочиталось — прежние коды, частичной выдачи нет.
      if (!firstWindow || firstWindow.ok !== true) {
        const failure = firstWindow && firstWindow.code === 'HISTORY_EMPTY' ? 'HISTORY_EMPTY' : 'MALFORMED_DOM'
        try { await json(call(__chatHubMaxScrollFeedTo, originalTop)) } catch (e) {}
        push(chat, failure === 'HISTORY_EMPTY' ? 'skipped' : 'error', failure, null, null, diag)
        continue
      }
      // Самый старый timestamp собранного: по нему видно, дошла ли выгрузка
      // до границы глубины.
      let oldest = null
      for (const item of collected) {
        const stamp = __chatHubMaxStamp(item.date, item.time, item.dayOnly)
        if (!stamp) continue
        const ms = Date.parse(stamp)
        if (!Number.isFinite(ms)) continue
        if (oldest === null || ms < oldest) oldest = ms
      }
      const reachedDepth = Number.isFinite(windowStartMs) && oldest !== null && oldest <= windowStartMs
      // full — прошли от начала до низа или дошли до границы глубины;
      // truncated — упёрлись в потолок 60 шагов или лента исчезла посреди обхода.
      coverage = reachedBottom || reachedDepth ? 'full' : 'truncated'
      // Трасса одной строкой: метрики до первого шага, после него и итоги
      // обхода. Без замера «после» (лента целиком в окне) повторяем «до» —
      // это честный факт: позиция не двигалась.
      if (traceBefore && !traceSeen) {
        const after = traceAfter || traceBefore
        scrollerTrace = 'MAX: лента top=' + (Number(traceBefore.scrollTop) || 0) +
          '/sh=' + (Number(traceBefore.scrollHeight) || 0) +
          '/ch=' + (Number(traceBefore.clientHeight) || 0) +
          ' wraps=' + (Number(traceBefore.wrapperCount) || 0) +
          ' → top=' + (Number(after.scrollTop) || 0) +
          '/wraps=' + (Number(after.wrapperCount) || 0) +
          ', шагов ' + steps + ', собрано ' + collected.length
      }
      // Вернуть позицию ленты, в которой чат был до сбора (best effort).
      try { await json(call(__chatHubMaxScrollFeedTo, originalTop)) } catch (e) {}
    } else {
      firstWindow = await json(call(__chatHubMaxReadWindow, !diagSeen))
      if (!diagSeen && firstWindow && firstWindow.diag && typeof firstWindow.diag === 'object') {
        diag = firstWindow.diag
        diagSeen = true
      }
      if (!firstWindow || firstWindow.ok !== true) {
        const failure = firstWindow && firstWindow.code === 'HISTORY_EMPTY' ? 'HISTORY_EMPTY' : 'MALFORMED_DOM'
        push(chat, failure === 'HISTORY_EMPTY' ? 'skipped' : 'error', failure, null, null, diag)
        continue
      }
      addWindow(firstWindow)
      coverage = 'window'
    }
    // Диапазон — по нормализованным timestamp: дата берётся из локальной части
    // (+07:00), а не из UTC, иначе полночь уезжает на предыдущий день.
    let rangeFrom = null
    let rangeTo = null
    for (const item of collected) {
      const stamp = __chatHubMaxStamp(item.date, item.time, item.dayOnly)
      if (!stamp) continue
      if (rangeFrom === null || stamp < rangeFrom) rangeFrom = stamp
      if (rangeTo === null || stamp > rangeTo) rangeTo = stamp
    }
    const range = rangeFrom && rangeTo ? rangeFrom.slice(0, 10) + '—' + rangeTo.slice(0, 10) : '—'
    // Одна честная строка: сколько собрано, сколько шагов сделано и за какой
    // период. Шаги видны и при полном обходе, и при упоре в потолок.
    const noteLine = 'MAX: собрано ' + collected.length + ' сообщений, шагов ' +
      steps + ', диапазон ' + range + ', покрытие: ' + coverage
    if (!report.notes.includes(noteLine)) report.notes.push(noteLine)
    // Трасса скроллера — сразу за строкой «собрано»: она про тот же обход и
    // печатается один раз на отчёт (у первого чата, дошедшего до обхода).
    if (scrollerTrace) {
      if (!report.notes.includes(scrollerTrace)) report.notes.push(scrollerTrace)
      traceSeen = true
    }
    const pathname = typeof switched.pathname === 'string' ? switched.pathname : ''
    const chatId = __chatHubMaxChatId(chat && chat.url) || pathname
    const messages = []
    for (let index = 0; index < collected.length; index += 1) {
      const item = collected[index] && typeof collected[index] === 'object' ? collected[index] : {}
      const text = typeof item.text === 'string' ? item.text : ''
      messages.push({
        service: 'max',
        chatId: chatId,
        // Серверного id в DOM нет: путь чата + позиция в собранной ленте.
        messageId: 'max:' + pathname + ':' + index,
        author: typeof item.author === 'string' ? item.author : '',
        timestamp: __chatHubMaxStamp(item.date, item.time, item.dayOnly),
        // День известен, час — нет. Флаг едет в prefetched и markdown.
        dayOnly: item.dayOnly === true,
        text: text,
        links: __chatHubMaxLinks(text)
      })
    }
    push(chat, 'ok', null, messages, null, diag, coverage)
  }
  // Вернуть чат, который был открыт до выгрузки: тот же клик по button.cell и
  // проверка заголовка. Ошибки восстановления не валят отчёт.
  try {
    if (original.title) {
      const current = await json(call(__chatHubMaxChatIdentity))
      if (current && typeof current.title === 'string' && current.title.trim() === original.title) {
        report.restored = true
      } else {
        const back = await json(call(__chatHubMaxClickRow, original.title))
        if (back && back.ok === true) {
          const waited = await __chatHubMaxWaitSwitch(wv, original.title)
          report.restored = !!(waited && waited.ok === true)
        }
      }
    }
  } catch (e) { report.restored = false }
  return JSON.stringify(report)
}

// Точка входа для main: он вызывает сборщик строкой через executeJavaScript,
// поэтому функция обязана быть на window (объявление само туда не попадает).
if (typeof window !== 'undefined') window.__chatHubCollectMaxHistory = __chatHubCollectMaxHistory

async function __chatHubMaxUnread(favs, allowScroll) {
  const avatarBudget = { attempts: 0 }
  // MAX currently exposes only a virtual data-index, not immutable chat ID.
  // Keep no-href coverage until a verified adapter exists, but do not collapse
  // duplicate titles before checking ambiguity (see docs/max-telemost-identities.md).
  const visible = row => {
    const rect = typeof row.getBoundingClientRect === 'function' ? row.getBoundingClientRect() : null
    if (rect && (rect.width <= 0 || rect.height <= 0)) return false
    try {
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(row) : null
      return style?.display !== 'none' && style?.visibility !== 'hidden'
    } catch { return true }
  }
  const rowTokens = new WeakMap()
  let nextRowToken = 0
  // MAX: время строки лежит в .meta, .meta .text, datetime или title. Срезаем
  // невидимые символы и ведущие маркеры доставки (✓, ✔): иначе parseChatTime
  // не видит «17:30» и чат с новым сообщением не поднимается наверх.
  const cleanTime = value => String(value == null ? '' : value)
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^[\s✓✔✅☑·•]+/, '')
    .trim()
  const attrOf = (el, key) => {
    try { return cleanTime(el && el.getAttribute && el.getAttribute(key)) } catch (e) { return '' }
  }
  const maxRowTime = row => {
    const list = []
    const meta = row.querySelector('.meta')
    if (meta) {
      if (meta.querySelectorAll) for (const part of Array.from(meta.querySelectorAll('.text'))) list.push(cleanTime(part && part.textContent))
      list.push(cleanTime(meta.textContent))
    }
    const dated = row.querySelector('[datetime]')
    if (dated) { list.push(attrOf(dated, 'datetime')); list.push(attrOf(dated, 'title')) }
    const titled = row.querySelector('[title*=":"]')
    if (titled) list.push(attrOf(titled, 'title'))
    const usable = list.filter(Boolean)
    if (typeof parseChatTime !== 'function') return usable[0] || ''
    // Сначала пробуем строку целиком; если мешает подпись («Доставлено в
    // 17:30») — берём единственный токен ЧЧ:ММ. Дата без времени не годится.
    const pick = text => {
      if (parseChatTime(text).at > 0) return text
      const clock = text.match(/(?:^|[\s·•|])(\d{1,2}:\d{2})(?=$|[\s·•|])/)
      if (clock && parseChatTime(clock[1]).at > 0) return clock[1]
      return ''
    }
    for (const text of usable) {
      const picked = pick(text)
      if (picked) return picked
    }
    return usable[0] || ''
  }
  const collect = () => {
    return Array.from(document.querySelectorAll('aside div.item')).filter(visible).map(r => {
      const name = (r.querySelector('span.name') || r.querySelector('h3.title'))?.textContent.trim() || ''
      let token = rowTokens.get(r)
      if (!token) { token = ++nextRowToken; rowTokens.set(r, token) }
      const preview = String(r.querySelector('span.text.svelte-q2jdqb')?.textContent || '').trim()
      const time = String(r.querySelector('.meta')?.textContent || '').trim()
      const indicator = Array.from(r.querySelectorAll('.indicator')).map(x => String(x.textContent || '').trim()).join('\u0001')
      // A virtual DOM element may be recycled for a different row. Keep an
      // unchanged physical observation stable, but retain a new element or
      // changed row signature as a separate candidate so ambiguity survives.
      return { key: 'max:' + token + '\u0000' + [name, preview, time, indicator].join('\u0001'), el: r.cloneNode(true) }
    })
  }
  // The tab badge is a lower bound from one simultaneous DOM snapshot. MAX
  // has no immutable row ID, so virtual recycled rows cannot be aggregated.
  const observedCandidates = collect().map(r => r.el)
  const items = (await __chatHubScanRows(collect, '.scrollable.scrollListScrollable', 'max',
    allowScroll && favs.some(f => f.needAvatar || f.needUnread))).map(r => r.el)
  const out = []
  const nameOf = item => {
    const el = item.querySelector('span.name') || item.querySelector('h3.title')
    return el ? el.textContent.trim() : ''
  }
  // Only a plain safe integer proves an exact unread count. A rounded or
  // otherwise malformed indicator is an unknown observation, never read=0.
  const countOf = item => {
    const badges = Array.from(item.querySelectorAll('.indicator'))
    if (!badges.length) return 0
    for (const badge of badges) {
      const text = String(badge.textContent || '').trim()
      if (!text) continue
      if (!/^\d+$/.test(text)) return null
      const count = Number(text)
      return Number.isSafeInteger(count) && count >= 0 ? count : null
    }
    return 0
  }
  const observedByTitle = new Map(), ambiguousObservedTitles = new Set()
  for (const item of observedCandidates) {
    const title = nameOf(item), count = countOf(item)
    if (!title) continue
    if (count === null) { ambiguousObservedTitles.add(title); continue }
    const prior = observedByTitle.get(title)
    if (!prior) observedByTitle.set(title, { item, count })
    else if (prior.count !== count) ambiguousObservedTitles.add(title)
  }
  const observedItems = [...observedByTitle].filter(([title]) => !ambiguousObservedTitles.has(title)).map(([, row]) => row.item)
  for (const f of favs) {
    let unread = false
    let count = 0
    let rank = 9999
    let time = null
    let avatar = null
    const candidates = items.map((item, index) => ({ item, index })).filter(r => nameOf(r.item) === String(f.title).trim())
    const duplicatePin = favs.some(other => other.id !== f.id && String(other.title).trim() === String(f.title).trim())
    const idx = !duplicatePin && candidates.length === 1 ? candidates[0].index : -1
    const observedCount = idx >= 0 ? countOf(items[idx]) : null
    if (idx >= 0 && observedCount !== null) {
      rank = idx
      // время последнего сообщения («17:30», «пн», «Nov 8»)
      time = maxRowTime(items[idx])
      count = observedCount
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
    out.push({ id: f.id, found: idx >= 0 && observedCount !== null, unread: unread, count: count, mentions: 0, rank: rank, time: time, avatar: avatar, preview: preview.slice(0, 110) })
  }
  // п.20: общая сумма непрочитанных по ВСЕМУ списку MAX — на вкладку.
  // Маркеров упоминаний список MAX не показывает — только общее число.
  let svcTotal = 0
  for (const it of observedItems) {
    const count = countOf(it)
    if (count !== null) svcTotal += count
  }
  return JSON.stringify({
    favs: out, svcTotals: null, observedTotals: { total: svcTotal, mentions: 0 },
    coverage: { complete: false },
    // состояние сессии отдаём хосту: пустой список при разлогине — не «нет сообщений»
    session: typeof __chatHubMaxSession === 'function' ? __chatHubMaxSession() : null
  })
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
  const visible = row => {
    const rect = typeof row.getBoundingClientRect === 'function' ? row.getBoundingClientRect() : null
    if (rect && (rect.width <= 0 || rect.height <= 0)) return false
    try {
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(row) : null
      return style?.display !== 'none' && style?.visibility !== 'hidden'
    } catch { return true }
  }
  const collect = () => {
    const occurrences = new Map()
    return Array.from(document.querySelectorAll('.yamb-chat-list-item')).filter(visible).map((r, i) => {
      const chatId = rowId(r), base = chatId || 'unknown:' + i
      const occurrence = occurrences.get(base) || 0
      occurrences.set(base, occurrence + 1)
      return { key: base + ':' + occurrence, chatId, messageTime: rowTime(r, chatId), el: r.cloneNode(true) }
    })
  }
  const badgeObservation = item => {
    const badge = item?.querySelector('.yamb-chat-list-item__badges')
    const raw = String(badge?.textContent || '').trim()
    if (!raw) return { known: true, count: 0, unread: false }
    if (/^[•●]$/.test(raw)) return { known: true, count: 0, unread: true }
    if (!/^\d+$/.test(raw)) return { known: false, count: 0, unread: false }
    const count = Number(raw)
    if (!Number.isSafeInteger(count) || count < 0) return { known: false, count: 0, unread: false }
    return { known: true, count, unread: count > 0 }
  }
  // The lower-bound badge reflects one current snapshot; a virtual scan may
  // recycle rows before a later chunk is collected. A repeated or unknown
  // chatId cannot contribute twice to a trustworthy lower bound. Conflicting
  // duplicates are omitted rather than trusting DOM order.
  const observedById = new Map(), ambiguousObservedIds = new Set()
  for (const row of collect()) {
    if (!row.chatId) continue
    const observation = badgeObservation(row.el)
    if (!observation.known) { ambiguousObservedIds.add(row.chatId); continue }
    const prior = observedById.get(row.chatId)
    if (!prior) observedById.set(row.chatId, { row, count: observation.count })
    else if (prior.count !== observation.count) ambiguousObservedIds.add(row.chatId)
  }
  const observedRows = [...observedById].filter(([chatId]) => !ambiguousObservedIds.has(chatId)).map(([, value]) => value.row)
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
    const observation = idx >= 0 ? badgeObservation(items[idx]) : null
    if (idx >= 0 && observation?.known) {
      rank = idx
      // Displayed date may be a draft timestamp; never promote it to activity.
      count = observation.count
      unread = observation.unread
      if (f.needAvatar) avatar = await __chatHubBoundedAvatar(items[idx], avatarBudget)
    }
    const prevEl2 = idx >= 0 ? (items[idx].querySelector('[id$="_text"]') || items[idx].querySelector('.yamb-chat-list-item__preview, .yamb-chat-list-item__last-message, .ui-entity-block-text')) : null
    out.push({ id: f.id, found: idx >= 0 && observation?.known === true, unread: unread, count: count, mentions: 0, rank: rank, time: time, messageTime: idx >= 0 && rows[idx].messageTime ? { ...rows[idx].messageTime, canonicalUrl: f.url } : null, avatar: avatar, preview: prevEl2 ? String(prevEl2.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90) : '' })
  }
  // п.20: общая сумма непрочитанных по ВСЕМУ списку Телемоста — на вкладку.
  // Маркеров упоминаний список не показывает — только общее число.
  let svcTotal = 0
  for (const row of observedRows) {
    const observation = badgeObservation(row.el)
    if (observation.known) svcTotal += observation.count
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
      // titleCustom: имя задал человек в Настройках → Избранное — не перезаписываем
      // его ни шапкой, ни строкой списка. Авто-переименование флаг не ставит.
      if (name && !generic && !isUsernameFallback && !p.titleCustom && shouldAutoRenameTitle(svc.id, p.title, p.url) && name !== p.title && pinMatches(p, svc, wv.getURL(), name)) {
        p.title = name
        const t = document.querySelector('.chat-row[data-pin="' + p.id + '"] .chat-row-title')
        if (t) { t.textContent = name; t.title = p.url }
        const h = document.querySelector('#view-head .view-title')
        if (h && state.cfg.selectedPinId === p.id) { h.textContent = name; h.title = p.url }
        saveConfig(state.cfg)
      }
    }
  } catch {}
}

/* ---------- настройки ---------- */

// --- вкладка MCP: карточки коннекторов, глубина и выгрузка проектов ---
// Прогресс и отчёт запуска живут в модульном состоянии, а не только в DOM:
// панель настроек пересоздаётся при каждом входе на вкладку, и выгрузка не
// должна из-за этого «исчезать». Подписка на прогресс — одна на весь запуск,
// её жизнь не привязана к жизни панели.
let mcpExportRun = { running: false, startedAt: 0, progress: [], progressRepeat: null, report: null }
let mcpProgressOff = null

function normalizeMcpDepth(value) {
  const parsed = typeof value === 'number' ? value : parseInt(value, 10)
  if (!Number.isFinite(parsed)) return 7
  return Math.min(30, Math.max(1, Math.trunc(parsed)))
}

function mcpDepthText(value) {
  return normalizeMcpDepth(value) + ' дн.'
}

function mcpShortText(value) {
  const raw = value && typeof value.message === 'string' ? value.message : String(value || '')
  const text = raw.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 160) : 'неизвестная ошибка'
}

function mcpServiceName(service) {
  if (service === 'mm') return 'Mattermost'
  if (service === 'max') return 'MAX'
  if (service === 'ydx') return 'Яндекс Телемост'
  return service ? 'Сервис ' + service : 'Сервис'
}

function mcpConnectorStatusText(service, status) {
  if (!status || typeof status !== 'object') return 'ошибка: нет ответа'
  if (status.code) return 'ошибка: ' + String(status.code)
  if (status.installed !== true) return 'не установлен'
  if (!Array.isArray(status.tools) || !status.tools.length) return 'не настроен'
  return 'готов'
}

function mcpErrorExplanation(code) {
  switch (code) {
    case 'EXPORT_DIR_MISSING': return 'Сначала выберите папку выгрузки.'
    case 'EXPORT_DIR_FORBIDDEN': return 'Эта папка внутри профиля ChatHub или путь не абсолютный. Выберите другую папку.'
    case 'NO_PROJECTS': return 'В избранном нет чатов с заполненным проектом.'
    case 'EXPORT_BUSY': return 'Выгрузка уже идёт. Дождитесь окончания или отмените её.'
    case 'EXPORT_CANCELLED': return 'Выгрузка отменена.'
    case 'EXPORT_TIMEOUT': return 'Выгрузка не уложилась в 10 минут и была остановлена.'
    case 'BRIDGE_MISSING': return 'В этой сборке нет моста выгрузки. Нужна полная сборка ChatHub.'
    case 'EXPORT_FAILED': return 'Мост завершился с ошибкой. Подробности — в журнале приложения.'
    default: return 'Повторите выгрузку. Если ошибка повторится, проверьте папку и коннекторы.'
  }
}

// Человеческое объяснение кодов установки, подключения и проверки коннектора.
function mcpConnectorErrorText(code) {
  switch (code) {
    case 'CONNECTOR_NOT_FOUND': return 'Файл коннектора не найден. Установите пакет или выберите каталог, где он уже распакован.'
    case 'CONNECTOR_NOT_READY': return 'Коннектор этого сервиса ещё не готов.'
    case 'TOKEN_MISSING': return 'Токен Яндекса не найден в Windows SecretStore (yandex-telemost-oauth-token). Проверьте секрет и повторите.'
    case 'CONNECTOR_SPAWN': return 'Не удалось запустить коннектор. Проверьте, что файл на месте и не заблокирован.'
    case 'CONNECTOR_EXIT': return 'Коннектор завершился с ошибкой. Подробности — в журнале приложения.'
    case 'PROBE_TIMEOUT': return 'Коннектор не ответил за 45 секунд. Проверьте его настройки и повторите.'
    case 'TOOLS_MISMATCH': return 'Коннектор отвечает, но нужных инструментов нет: похоже, это другая версия.'
    case 'PROTOCOL_ERROR': return 'Коннектор нарушил протокол MCP.'
    case 'MCP_ERROR': return 'Коннектор вернул ошибку на безвредный запрос.'
    case 'REGISTRY_UNSAFE_COMMAND': return 'Файл лежит вне разрешённых каталогов. Такой коннектор подключать нельзя.'
    case 'REGISTRY_INVALID': return 'Файл реестра коннекторов повреждён. Установите коннектор заново.'
    case 'REGISTRY_WRITE_FAILED': return 'Не удалось сохранить реестр коннекторов.'
    case 'NOT_INSTALLED': return 'Коннектор не установлен. Сначала нажмите «Установить/Обновить».'
    case 'CANCELLED': return 'Выбор каталога отменён.'
    case 'INVALID_SERVICE': return 'Неизвестный сервис.'
    case 'CONNECTOR_INSTALL_FAILED':
    case 'CONNECT_FAILED':
    case 'PROBE_FAILED': return 'Действие не выполнено. Подробности — в журнале приложения.'
    default: return code ? 'Код: ' + code + '.' : 'Действие не выполнено.'
  }
}

// Одна строка журнала по действию с карточкой коннектора.
function mcpConnectorActionLine(service, action, result) {
  const name = mcpServiceName(service)
  const phrases = action === 'install'
    ? { done: 'установка прошла', fail: 'установка не удалась' }
    : action === 'connect'
      ? { done: 'подключение прошло', fail: 'подключение не удалось' }
      : { done: 'проверка прошла', fail: 'проверка не удалась' }
  if (result && result.ok === true) {
    let count = Array.isArray(result.tools) ? result.tools.length : 0
    if (!count && result.entry && Array.isArray(result.entry.tools)) count = result.entry.tools.length
    return name + ': ' + phrases.done + (count ? ', инструментов: ' + count : '')
  }
  const code = result && typeof result.code === 'string' ? result.code : ''
  return name + ': ' + phrases.fail + '. ' + mcpConnectorErrorText(code)
}

function mcpExportBlockedReason(cfg) {
  const dir = cfg && typeof cfg.mcpExportDir === 'string' ? cfg.mcpExportDir.trim() : ''
  if (!dir) return 'укажите папку'
  const pins = cfg && Array.isArray(cfg.pinned) ? cfg.pinned : []
  const hasProject = pins.some(pin => pin && typeof pin.mcpProject === 'string' && pin.mcpProject.trim() !== '')
  if (!hasProject) return 'нет чатов с проектом'
  return ''
}

// Подсказка рядом с кнопкой выгрузки: та же причина, что и в title, но
// человеческим текстом и всегда на виду — без наведения на кнопку.
// Словарь держим внутри функции: renderer-харнессы вырезают функции по одной.
function mcpRunHintText(cfg) {
  const reason = mcpExportBlockedReason(cfg)
  if (reason === 'укажите папку') return 'Укажите папку выгрузки'
  if (reason === 'нет чатов с проектом') return 'Заполните проект хотя бы у одного чата в Избранном'
  return reason ? 'Выгрузка недоступна: ' + reason : 'Готово к выгрузке'
}

function mcpBaseName(value) {
  const text = typeof value === 'string' ? value : ''
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

function mcpChatStatusText(status) {
  if (status === 'ok') return 'ок'
  if (status === 'skipped') return 'пропущен'
  if (status === 'error') return 'ошибка'
  if (status === 'bad_project') return 'неверный проект'
  return status ? String(status) : 'без статуса'
}

function mcpCoverageText(coverage) {
  if (coverage === 'full') return 'полное'
  if (coverage === 'truncated') return 'усечено'
  if (coverage === 'window') return 'окно'
  return coverage ? String(coverage) : '—'
}

// Итог отчёта — три исхода вместо двух: полный успех, частичный успех (файлы
// записаны, но часть чатов не выгрузилась) и провал. Мост ставит ok:false при
// любой ошибке чата, поэтому сам ok ещё не отвечает на вопрос «есть ли файлы».
function mcpReportLines(report) {
  if (!report || typeof report !== 'object') return ['Отчёт не получен.']
  const files = Array.isArray(report.files) ? report.files : []
  const chats = Array.isArray(report.chats) ? report.chats : []
  const errors = Array.isArray(report.errors) ? report.errors : []
  const topCode = typeof report.code === 'string' ? report.code : ''
  // Исключение моста или renderer: данных отчёта нет вовсе — печатаем исходный
  // текст/код, как раньше. Отчёт buildReport всегда несёт chats или errors,
  // поэтому этот путь не перекрывает частичный успех с записанными файлами.
  if (report.ok === false && !files.length && !chats.length && !errors.length) {
    // Ошибка, пойманная в renderer, несёт исходный текст исключения: показываем
    // его так же, как раньше, но теперь он ещё и переживает пересборку панели.
    if (typeof report.message === 'string' && report.message.trim()) {
      return ['Выгрузка не выполнена: ' + report.message.trim()]
    }
    const head = topCode ? 'Выгрузка не выполнена: ' + topCode + '.' : 'Выгрузка не выполнена.'
    return [head + ' ' + mcpErrorExplanation(topCode)]
  }

  // Название чата для строки проблемы: пин из «Избранного» по pinId. Пина нет —
  // печатаем сам pinId, а не теряем строку.
  const pinTitleOf = pinId => {
    if (pinId === null || pinId === undefined || String(pinId).trim() === '') return 'чат без пина'
    const pins = typeof state !== 'undefined' && state && state.cfg && Array.isArray(state.cfg.pinned)
      ? state.cfg.pinned
      : []
    for (const pin of pins) {
      if (!pin || String(pin.id) !== String(pinId)) continue
      if (typeof pin.title === 'string' && pin.title.trim()) return pin.title.trim()
    }
    return 'пин ' + pinId
  }

  // Человеческая причина по коду чата. SWITCH_TIMEOUT несёт detail от моста:
  // «ожидался … открыт …» отвечает на вопрос, почему чат не переключился.
  const reasonOf = chat => {
    const code = chat && chat.code ? String(chat.code) : ''
    if (code === 'SWITCH_TIMEOUT') {
      const detail = chat && chat.detail && typeof chat.detail === 'object' ? chat.detail : null
      const expected = detail && detail.expected ? String(detail.expected) : ''
      const actual = detail && detail.actual ? String(detail.actual) : ''
      if (expected && actual) return 'ожидался «' + expected + '», открыт «' + actual + '»'
      return 'чат не открылся за отведённое время'
    }
    if (code === 'CHAT_NOT_FOUND') return 'не найден среди избранных чатов'
    if (code === 'MULTIPLE_CHATS') return 'несколько избранных чатов с таким названием'
    if (code === 'TOKEN_MISSING') return 'нет токена Яндекса в Windows SecretStore'
    if (code === 'no_messages') return 'нет сообщений за период'
    if (code === 'bad_project') return 'не задан проект'
    if (code === 'adapter_missing') return 'нет адаптера сервиса'
    return ''
  }

  const problemChats = chats.filter(chat => chat && chat.status === 'error')
  const skippedChats = chats.filter(chat => chat && chat.status === 'skipped')
  // Пустой чат за период — не проблема: только такие пропуски не делают
  // выгрузку частичной.
  const meaningfulSkips = skippedChats.filter(chat => chat && String(chat.code || '') !== 'no_messages')

  // Ошибки, уже показанные строкой проблемного чата, второй раз не печатаем:
  // у чата есть название, у дубля — только код. Остаются ошибки записи файлов.
  const seenChatCodes = new Map()
  for (const chat of problemChats) {
    const code = chat && chat.code ? String(chat.code) : ''
    seenChatCodes.set(code, (seenChatCodes.get(code) || 0) + 1)
  }
  const extraErrors = []
  for (const error of errors) {
    const code = error && error.code ? String(error.code) : ''
    const left = seenChatCodes.get(code) || 0
    if (left > 0) { seenChatCodes.set(code, left - 1); continue }
    const message = error && error.message ? String(error.message) : ''
    if (code || message) extraErrors.push('Ошибка: ' + [code, message].filter(Boolean).join(' — '))
  }

  const messages = files.reduce((sum, file) => sum + (Number.isFinite(file && file.count) ? file.count : 0), 0)
  const lines = []
  if (!files.length) {
    // Файлов ноль — провал; причина обязана быть видна, иначе «повторите» ничего
    // не подсказывает.
    const reasonCode = (problemChats[0] && problemChats[0].code) || (errors[0] && errors[0].code) || topCode
    const reason = reasonCode
      ? (reasonOf(problemChats[0]) || mcpErrorExplanation(String(reasonCode)))
      : (skippedChats.length ? 'Все чаты пропущены: за период нет сообщений.' : 'Файлы не созданы.')
    lines.push(reasonCode
      ? 'Выгрузка не выполнена: ' + reasonCode + ' — ' + reason
      : 'Выгрузка не выполнена. ' + reason)
  } else if (problemChats.length || extraErrors.length || meaningfulSkips.length) {
    lines.push('Выгружено частично: файлов ' + files.length + ', сообщений ' + messages +
      '; проблемных чатов ' + problemChats.length)
  } else {
    lines.push('Готово: файлов ' + files.length + ', сообщений ' + messages)
  }

  // Перечень проблем — по названию чата, а не только по коду: так его ищут в «Избранном».
  if (problemChats.length) {
    lines.push('Проблемные чаты:')
    for (const chat of problemChats) {
      const code = chat && chat.code ? String(chat.code) : ''
      const reason = reasonOf(chat)
      lines.push('• ' + mcpServiceName(chat && chat.service) + ' — «' + pinTitleOf(chat && chat.pinId) +
        '» — ' + (code || 'ошибка') + (reason ? ': ' + reason : ''))
    }
  }
  // Пропуски — отдельной строкой: их не смешиваем с ошибками и не считаем проблемой.
  if (skippedChats.length) lines.push('Пропущено: ' + skippedChats.length)

  if (files.length) {
    lines.push('Файлы (' + files.length + '):')
    for (const file of files) {
      const name = mcpBaseName(file && file.path) || 'без имени'
      const project = String(file && file.project ? file.project : '').trim()
      const count = Number.isFinite(file && file.count) ? file.count : 0
      lines.push('• ' + name + (project ? ' — проект ' + project : '') + ', сообщений: ' + count)
    }
  }
  let undated = 0
  let incomplete = report.truncated === true
  if (!chats.length) {
    lines.push('Чатов в отчёте нет.')
  } else {
    lines.push('Чаты (' + chats.length + '):')
    for (const chat of chats) {
      const service = mcpServiceName(chat && chat.service)
      const status = mcpChatStatusText(chat && chat.status)
      const code = chat && chat.code ? ', код ' + chat.code : ''
      const coverage = chat && chat.coverage ? ', покрытие: ' + mcpCoverageText(chat.coverage) : ''
      const count = Number.isFinite(chat && chat.count) ? ', сообщений: ' + chat.count : ''
      const noDate = Number.isFinite(chat && chat.undated) ? chat.undated : 0
      if (noDate > 0) undated += noDate
      if (chat && (chat.coverage === 'truncated' || chat.coverage === 'window')) incomplete = true
      const reason = chat && (chat.status === 'error' || chat.status === 'skipped') ? reasonOf(chat) : ''
      lines.push('• ' + service + ' — ' + status + code + coverage + count +
        (noDate > 0 ? ', без даты: ' + noDate : '') + (reason ? ' — ' + reason : ''))
    }
  }
  // Строки сборщика MAX (сессия, рабочий webview, «собрано …», трасса
  // скроллера): отдельный блок после списка чатов, каждая строка своей строкой.
  const notes = (Array.isArray(report.notes) ? report.notes : [])
    .filter(line => typeof line === 'string' && line.trim())
    .map(line => line.trim())
  if (notes.length) {
    lines.push('Заметки сборщика MAX:')
    for (const note of notes) lines.push(note)
  }
  // DOM-диагностика MAX: одна строка на весь отчёт — только у первого чата,
  // который её принёс. Без diag строка не появляется вовсе.
  const diagChat = chats.find(chat => chat && chat.service === 'max' && chat.diag && typeof chat.diag === 'object')
  if (diagChat) {
    const diag = diagChat.diag
    const count = value => Number.isFinite(value) ? value : 0
    const quotes = list => {
      const texts = (Array.isArray(list) ? list : []).filter(text => typeof text === 'string' && text.trim())
      return texts.length ? texts.map(text => '«' + text + '»').join(', ') : '—'
    }
    lines.push('MAX диагностика: корней ' + count(diag.roots) + ', капсул ' + count(diag.capsuleCount) +
      ', примеры: ' + quotes(diag.capsuleSamples) + ', мета: ' + quotes(diag.metaSamples))
    // Второй замер (только если поля пришли): классы всех .history, капсулы по
    // документу, узлы с датой, прямые дети корня, мета с датой. Три компактные
    // строки: не больше 8 узлов в строке, остальное — «+N».
    if (diag.docCapsules || Array.isArray(diag.dateLikeNodes) ||
        Array.isArray(diag.firstChildren) || Array.isArray(diag.metaWithDate)) {
      const nodeName = node => String(node && node.tag ? node.tag : '?') +
        (node && node.cls ? '.' + String(node.cls).trim().replace(/\s+/g, '.') : '')
      const nodes = (items, limit) => {
        const found = (Array.isArray(items) ? items : []).filter(node => node && typeof node === 'object')
        const shown = found.slice(0, limit)
          .map(node => nodeName(node) + ' «' + String(node.text == null ? '' : node.text) + '»')
        return shown.length ? shown.join(', ') + (found.length > limit ? ', +' + (found.length - limit) : '') : '—'
      }
      const docCapsules = diag.docCapsules && typeof diag.docCapsules === 'object' ? diag.docCapsules : {}
      lines.push('MAX диагностика 2: .history: ' + quotes(diag.historyClasses) +
        '; капсул в документе: ' + count(docCapsules.total) + ', тексты: ' + quotes(docCapsules.texts))
      lines.push('MAX диагностика 2: узлы с датой: ' + nodes(diag.dateLikeNodes, 8) +
        '; мета с датой: ' + quotes(diag.metaWithDate))
      lines.push('MAX диагностика 2: первые дети: ' + nodes(diag.firstChildren, 8))
    }
  }
  if (undated > 0) lines.push('Сообщений без даты: ' + undated + '. Они сохранены, но их время неизвестно.')
  if (incomplete) lines.push('Покрытие неполное: часть истории не поместилась в окно коннектора, глубина выгрузки не гарантирована.')
  // Окно MAX могло быть закрыто или сеанс завершён: один совет на весь отчёт,
  // а не повтор человеческой строки на каждый чат.
  const maxWindowDown = chats.some(chat => chat && chat.service === 'max' &&
    (chat.code === 'NO_CDP' || chat.code === 'HEADER_MISMATCH'))
  if (maxWindowDown) {
    lines.push('Окно MAX не открыто или сеанс завершён — запустите Start-MAX-Window.cmd и войдите')
  }
  // Ошибки без своего чата (например, запись файла): отдельная строка, чтобы
  // не потерять причину и не смешать её с перечнем проблемных чатов.
  for (const line of extraErrors) lines.push(line)
  return lines
}

// Строка прогресса: только служебные поля события, без текста переписок.
function mcpProgressLine(event) {
  if (!event || typeof event !== 'object') return ''
  const service = mcpServiceName(event.service)
  const code = event.code ? ' (' + event.code + ')' : ''
  switch (event.event) {
    case 'chat_started': return service + ': читаю чат…'
    case 'chat_done': return service + ': готово, сообщений ' + (Number.isFinite(event.count) ? event.count : 0)
    case 'chat_skipped': return service + ': пропущен' + code
    case 'chat_failed': return service + ': ошибка' + code
    case 'file_written': return 'Проект ' + (event.project || '—') + ': файл записан, сообщений ' + (Number.isFinite(event.count) ? event.count : 0)
    case 'file_failed': return 'Проект ' + (event.project || '—') + ': файл не записан' + code
    case 'connector_stderr': {
      // Схлопнутая серия одинаковых диагностических строк: main присылает
      // repeat, чтобы журнал не забивался десятками копий одной строки.
      const repeat = Number.isFinite(event.repeat) && event.repeat > 1 ? ' (×' + event.repeat + ')' : ''
      // Код ошибки остаётся в строке: серию с code/error не схлопываем.
      return service + ': диагностическое сообщение коннектора' + repeat + code
    }
    case 'fatal': return 'Выгрузка прервана.'
    default: return ''
  }
}

// Небольшой конструктор узлов: разметка собирается DOM-ом, без innerHTML,
// чтобы содержимое отчёта никогда не становилось HTML.
function mcpEl(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'dataset') for (const [name, item] of Object.entries(value)) node.dataset[name] = item
    else if (key === 'attrs') for (const [name, item] of Object.entries(value)) node.setAttribute(name, item)
    else node[key] = value
  }
  for (const child of children) node.appendChild(child)
  return node
}

// Живой узел панели ищем в документе при каждом событии: после пересборки
// настроек старый список отделён, и писать в него нельзя.
function mcpPanelNode(id) {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null
  return document.getElementById(id) || null
}

// Журнал прогресса в памяти: лимит 300 строк, старые вытесняются.
function mcpProgressRemember(line) {
  mcpExportRun.progress.push(line)
  if (mcpExportRun.progress.length > 300) {
    mcpExportRun.progress.splice(0, mcpExportRun.progress.length - 300)
  }
}

// Добавляет строку в живой список панели; если панели нет — строка остаётся
// только в памяти и появится при возврате на вкладку.
function mcpProgressAppend(line) {
  const node = mcpPanelNode('mcp-progress')
  if (!node) return
  node.appendChild(mcpEl('li', { class: 'mcp-progress-line', text: line }))
  while (node.children.length > 300) node.removeChild(node.children[0])
}

// Счётчик серии обновляет последнюю строку журнала и её живой узел, но только
// если это всё ещё та же строка: панель могла быть пересобрана или вытеснена
// лимитом 300.
function mcpProgressReplaceLast(previous, next) {
  const node = mcpPanelNode('mcp-progress')
  const last = node && node.lastElementChild ? node.lastElementChild : null
  if (last && String(last.textContent || '') === previous) last.textContent = next
}

// Журнал прогресса с схлопыванием подряд идущих одинаковых подписей диагностики.
// main копит только точные копии строки stderr, а подпись в renderer у всех
// строк общая: живой прогон давал сорок строк «Mattermost: диагностическое
// сообщение коннектора». Считаем серию здесь, в пределах одного запуска
// выгрузки (mcpExportRun.progressRepeat), и обновляем одну строку счётчиком.
// Ошибки с code/error не схлопываем: их текст должен оставаться видимым.
function mcpProgressPush(event) {
  const line = mcpProgressLine(event)
  if (!line) return ''
  const collapsible = !!(event && event.event === 'connector_stderr' && !event.code && !event.error)
  const run = mcpExportRun && typeof mcpExportRun === 'object' ? mcpExportRun : null
  if (!collapsible || !run || !Array.isArray(run.progress)) {
    mcpProgressRemember(line)
    mcpProgressAppend(line)
    return line
  }
  // Подпись без счётчика: серии сравниваются по ней, а не по готовой строке.
  const base = mcpProgressLine(Object.assign({}, event, { repeat: 0 }))
  const step = Number.isFinite(event.repeat) && event.repeat > 1 ? event.repeat : 1
  const series = run.progressRepeat && run.progressRepeat.base === base ? run.progressRepeat : null
  if (series) {
    series.count += step
    const next = base + ' (×' + series.count + ')'
    // Строка ещё хвостовая — обновляем её на месте, новой не добавляем.
    if (run.progress.length && run.progress[run.progress.length - 1] === series.line) {
      run.progress[run.progress.length - 1] = next
      mcpProgressReplaceLast(series.line, next)
      series.line = next
      return ''
    }
  }
  // Новая серия: первая строка без счётчика, повторные — с (×N).
  const next = { base: base, count: step, line: step > 1 ? base + ' (×' + step + ')' : base }
  run.progressRepeat = next
  mcpProgressRemember(next.line)
  mcpProgressAppend(next.line)
  return next.line
}

// Подписка создаётся один раз на запуск: пересборка панели её не снимает и не
// дублирует. Снимается только по завершении (успех, ошибка, отмена).
function mcpExportSubscribe() {
  if (mcpProgressOff) return
  if (!window.hub || typeof window.hub.onMcpProgress !== 'function') return
  mcpProgressOff = window.hub.onMcpProgress(event => {
    // Строка считается с учётом схлопывания серии stderr; повтор серии ничего
    // не добавляет в журнал, только обновляет счётчик уже записанной строки.
    mcpProgressPush(event)
  })
}

function mcpExportUnsubscribe() {
  if (!mcpProgressOff) return
  try { mcpProgressOff() } catch {}
  mcpProgressOff = null
}

// Кнопки панели и подсказка всегда отражают текущее состояние запуска.
function mcpApplyRunControls(runBtn, cancelBtn, runHint) {
  if (!runBtn) return
  const running = mcpExportRun && mcpExportRun.running === true
  const reason = mcpExportBlockedReason(state.cfg)
  runBtn.disabled = running || reason !== ''
  runBtn.title = running
    ? 'Выгрузка идёт…'
    : (reason ? 'Выгрузка недоступна: ' + reason : 'Собрать Markdown-файлы по проектам из избранного')
  // Подсказка обновляется вместе с кнопкой: причина всегда на виду.
  if (runHint && typeof mcpRunHintText === 'function') runHint.textContent = mcpRunHintText(state.cfg)
  if (cancelBtn) {
    // «Отменить» активна, как только становится видимой; клик по ней во время
    // запуска не должен снова включать её из updateRun.
    const wasHidden = cancelBtn.hidden === true
    cancelBtn.hidden = !running
    if (!running || wasHidden) cancelBtn.disabled = false
  }
}

// Завершение может прийти, когда панель уже пересобрана: обновляем именно
// живые кнопки, а не те, что были захвачены обработчиком запуска.
function mcpSyncRunControls() {
  mcpApplyRunControls(
    mcpPanelNode('mcp-export-run'),
    mcpPanelNode('mcp-cancel'),
    mcpPanelNode('mcp-run-hint')
  )
}

// Отчёт и статус рисуем только если панель есть в документе; иначе состояние
// остаётся в mcpExportRun и восстановится при возврате на вкладку.
function mcpRenderRunResult() {
  const report = mcpPanelNode('mcp-report')
  if (!report) return
  if (mcpExportRun.report) renderMcpReport(report, mcpExportRun.report)
  else if (mcpExportRun.running) setMcpReport(report, ['Выгрузка идёт…'])
}

function renderMcpSettings(host) {
  host = host || document.getElementById('mcp-rows')
  if (!host) return
  host.textContent = ''
  // Заголовок секции ставим здесь же: так настройки остаются совместимыми со
  // старыми vm-харнессами, которые вырезают только buildSettings и не знают
  // этой функции — у них вкладки MCP просто не появляется.
  const previous = host.previousElementSibling
  if (!previous || previous.tagName !== 'H3' || previous.textContent.trim() !== 'MCP') {
    host.before(mcpEl('h3', { text: 'MCP' }))
  }
  const dir = state.cfg && typeof state.cfg.mcpExportDir === 'string' ? state.cfg.mcpExportDir : ''
  const depth = normalizeMcpDepth(state.cfg && state.cfg.mcpExportDepthDays)

  const dirLabel = mcpEl('label', { class: 'mcp-label', text: 'Папка выгрузки', attrs: { for: 'mcp-export-dir' } })
  const dirInput = mcpEl('input', {
    id: 'mcp-export-dir',
    class: 'mcp-path',
    type: 'text',
    value: dir,
    placeholder: 'не выбрана',
    attrs: { readonly: 'readonly', 'aria-label': 'Папка выгрузки' }
  })
  const chooseBtn = mcpEl('button', {
    id: 'mcp-choose-dir',
    class: 'btn',
    type: 'button',
    text: 'Выбрать папку…',
    attrs: { 'aria-label': 'Выбрать папку для выгрузки' }
  })
  const dirRow = mcpEl('div', { class: 'mcp-row' }, [dirLabel, dirInput, chooseBtn])

  const depthLabel = mcpEl('label', { class: 'mcp-label', text: 'Глубина выгрузки', attrs: { for: 'mcp-depth' } })
  const depthInput = mcpEl('input', {
    id: 'mcp-depth',
    class: 'mcp-range',
    type: 'range',
    min: '1',
    max: '30',
    step: '1',
    value: String(depth),
    attrs: { 'aria-valuetext': mcpDepthText(depth) }
  })
  const depthValue = mcpEl('span', { id: 'mcp-depth-label', class: 'mcp-depth-label', text: mcpDepthText(depth) })
  const depthRow = mcpEl('div', { class: 'mcp-depth' }, [depthLabel, depthInput, depthValue])

  const cards = mcpEl('div', { class: 'mcp-cards' })
  for (const [service, title] of [['mm', 'Mattermost'], ['max', 'MAX'], ['ydx', 'Яндекс Телемост']]) {
    const status = mcpEl('span', {
      id: 'mcp-status-' + service,
      class: 'mcp-status',
      text: 'проверяем…'
    })
    const actions = mcpEl('div', { class: 'mcp-actions' })
    for (const [action, label] of [['install', 'Установить/Обновить'], ['connect', 'Подключить существующий'], ['probe', 'Проверить']]) {
      actions.appendChild(mcpEl('button', {
        id: 'mcp-' + action + '-' + service,
        class: 'btn',
        type: 'button',
        text: label,
        disabled: true,
        title: 'появится в следующем пакете'
      }))
    }
    cards.appendChild(mcpEl('article', { class: 'mcp-card', dataset: { mcpCard: service } }, [
      mcpEl('h4', { class: 'mcp-card-title', text: title }), status, actions
    ]))
  }

  const runBtn = mcpEl('button', { id: 'mcp-export-run', class: 'btn primary', type: 'button', text: 'Выгрузить проекты в MD' })
  // Подсказка всегда видна: пользователь понимает, почему кнопка неактивна,
  // не наводя на неё курсор.
  const runHint = mcpEl('span', {
    id: 'mcp-run-hint',
    class: 'mcp-run-hint',
    text: typeof mcpRunHintText === 'function' ? mcpRunHintText(state.cfg) : '',
    attrs: { 'aria-live': 'polite' }
  })
  const cancelBtn = mcpEl('button', { id: 'mcp-cancel', class: 'btn', type: 'button', text: 'Отменить', hidden: true })
  const runRow = mcpEl('div', { class: 'mcp-run' }, [runBtn, runHint, cancelBtn])
  const progress = mcpEl('ul', { id: 'mcp-progress', class: 'mcp-progress', attrs: { 'aria-live': 'polite' } })
  const report = mcpEl('div', { id: 'mcp-report', class: 'mcp-report', attrs: { role: 'status', 'aria-live': 'polite' } })

  // Восстанавливаем сохранённый запуск: панель могла быть пересоздана посреди
  // выгрузки или уже после её завершения. Данные берём из модульного состояния,
  // а не из прежнего DOM.
  const run = mcpExportRun || { running: false, progress: [], report: null }
  for (const line of Array.isArray(run.progress) ? run.progress : []) {
    progress.appendChild(mcpEl('li', { class: 'mcp-progress-line', text: String(line) }))
  }
  if (run.report) renderMcpReport(report, run.report)
  else if (run.running) setMcpReport(report, ['Выгрузка идёт…'])
  mcpApplyRunControls(runBtn, cancelBtn, runHint)

  host.appendChild(mcpEl('fieldset', { class: 'setting-group mcp-settings', dataset: { settingGroup: 'mcp' } }, [
    mcpEl('legend', { text: 'Выгрузка в Markdown' }),
    dirRow, depthRow, cards, runRow, progress, report
  ]))
}

function setMcpReport(host, lines) {
  if (!host) return
  host.textContent = ''
  for (const line of Array.isArray(lines) ? lines : []) {
    host.appendChild(mcpEl('div', { class: 'mcp-report-line', text: String(line) }))
  }
}

function renderMcpReport(host, report) {
  setMcpReport(host, mcpReportLines(report))
}

function refreshMcpConnectorStatuses(root) {
  if (!root || typeof root.querySelector !== 'function') return
  const api = window.hub || {}
  for (const service of ['mm', 'max', 'ydx']) {
    const node = root.querySelector('#mcp-status-' + service)
    if (!node) continue
    node.textContent = 'проверяем…'
    node.title = ''
    if (typeof api.mcpConnectorStatus !== 'function') {
      node.textContent = 'ошибка: проверка недоступна'
      continue
    }
    Promise.resolve()
      .then(() => api.mcpConnectorStatus(service))
      .then(status => {
        node.textContent = mcpConnectorStatusText(service, status)
        if (status && status.code) node.title = String(status.code)
      })
      .catch(error => {
        node.textContent = 'ошибка: ' + mcpShortText(error)
      })
  }
}

function initMcpSettings(sec) {
  if (!sec) return
  const root = sec.querySelector('.settings') || sec
  const dirInput = root.querySelector('#mcp-export-dir')
  const chooseBtn = root.querySelector('#mcp-choose-dir')
  const depthInput = root.querySelector('#mcp-depth')
  const depthLabel = root.querySelector('#mcp-depth-label')
  const runBtn = root.querySelector('#mcp-export-run')
  const runHint = root.querySelector('#mcp-run-hint')
  const cancelBtn = root.querySelector('#mcp-cancel')
  const progress = root.querySelector('#mcp-progress')
  const report = root.querySelector('#mcp-report')
  if (!dirInput || !chooseBtn || !depthInput || !runBtn) return

  dirInput.value = state.cfg && typeof state.cfg.mcpExportDir === 'string' ? state.cfg.mcpExportDir : ''
  const depth = normalizeMcpDepth(state.cfg && state.cfg.mcpExportDepthDays)
  depthInput.value = String(depth)
  if (depthLabel) depthLabel.textContent = mcpDepthText(depth)
  depthInput.setAttribute('aria-valuetext', mcpDepthText(depth))

  // Пересборка панели не трогает подписку запуска: она живёт в модульной
  // переменной и снимается только по завершении выгрузки.
  const updateRun = () => mcpApplyRunControls(runBtn, cancelBtn, runHint)

  // Ползунок пишет только целое число дней; сохранение идёт через общий фасад.
  depthInput.oninput = () => {
    const value = normalizeMcpDepth(depthInput.value)
    depthInput.value = String(value)
    state.cfg.mcpExportDepthDays = value
    if (depthLabel) depthLabel.textContent = mcpDepthText(value)
    depthInput.setAttribute('aria-valuetext', mcpDepthText(value))
    saveConfig(state.cfg).catch(() => {})
  }

  chooseBtn.onclick = async () => {
    if (chooseBtn.disabled) return
    chooseBtn.disabled = true
    try {
      const result = await window.hub.mcpChooseDir()
      if (result && result.canceled === false && typeof result.path === 'string' && result.path.trim()) {
        const chosen = result.path.trim()
        state.cfg.mcpExportDir = chosen
        dirInput.value = chosen
        await saveConfig(state.cfg)
        setMcpReport(report, ['Папка выгрузки сохранена.'])
      }
    } catch (error) {
      setMcpReport(report, ['Не удалось выбрать папку: ' + mcpShortText(error)])
    } finally {
      chooseBtn.disabled = false
      updateRun()
    }
  }

  runBtn.onclick = async () => {
    if (runBtn.disabled) return
    const reason = mcpExportBlockedReason(state.cfg)
    if (reason) {
      setMcpReport(report, ['Выгрузка недоступна: ' + reason + '.'])
      updateRun()
      return
    }
    // Состояние запуска — в модуле: пересборка панели его не обнулит.
    mcpExportRun.running = true
    mcpExportRun.startedAt = Date.now()
    mcpExportRun.progress = []
    mcpExportRun.progressRepeat = null
    mcpExportRun.report = null
    // Одна подписка на запуск; панель может пересоздаваться сколько угодно.
    mcpExportSubscribe()
    updateRun()
    if (progress) progress.textContent = ''
    mcpRenderRunResult()
    try {
      // Ни путей, ни списка чатов: manifest собирает main из своего конфига.
      mcpExportRun.report = await window.hub.mcpExport()
    } catch (error) {
      const code = error && typeof error.code === 'string' && error.code ? error.code : 'EXPORT_FAILED'
      mcpExportRun.report = { ok: false, code, message: mcpShortText(error) }
    } finally {
      mcpExportRun.running = false
      // Успех, ошибка и отмена завершают запуск одинаково: подписка снимается,
      // живые кнопки и отчёт обновляются, если панель есть в документе.
      mcpExportUnsubscribe()
      mcpSyncRunControls()
      mcpRenderRunResult()
    }
  }

  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      if (cancelBtn.disabled) return
      cancelBtn.disabled = true
      try {
        await window.hub.mcpCancel()
        setMcpReport(report, ['Отмена запрошена…'])
      } catch (error) {
        setMcpReport(report, ['Не удалось отменить выгрузку: ' + mcpShortText(error)])
      } finally {
        cancelBtn.disabled = false
      }
    }
  }

  // Карточки коннекторов: кнопки включаются, только если main отдал каналы.
  // Яндекс Телемост подключается тем же коннектором избранного, что и остальные.
  const api = window.hub || {}
  const connectorActions = [
    ['install', 'mcpConnectorInstall', 'Взять готовый пакет коннектора и проверить его'],
    ['connect', 'mcpConnectorConnect', 'Выбрать каталог с уже распакованным коннектором'],
    ['probe', 'mcpProbe', 'Проверить соединение, ничего не выгружая']
  ]
  for (const service of ['mm', 'max', 'ydx']) {
    for (const [action, methodName, title] of connectorActions) {
      const button = root.querySelector('#mcp-' + action + '-' + service)
      if (!button) continue
      const method = api[methodName]
      if (typeof method !== 'function') continue
      button.disabled = false
      button.title = title
      button.onclick = async () => {
        if (button.disabled) return
        button.disabled = true
        try {
          const result = await method(service)
          if (progress) {
            progress.appendChild(mcpEl('li', { class: 'mcp-progress-line', text: mcpConnectorActionLine(service, action, result) }))
          }
          // Установка и подключение меняют реестр — статус перечитываем.
          refreshMcpConnectorStatuses(root)
        } catch (error) {
          if (progress) {
            progress.appendChild(mcpEl('li', {
              class: 'mcp-progress-line',
              text: mcpServiceName(service) + ': действие не выполнено: ' + mcpShortText(error)
            }))
          }
        } finally {
          button.disabled = false
        }
      }
    }
  }

  updateRun()
  refreshMcpConnectorStatuses(root)
  // Повторная проверка при каждом открытии вкладки: коннектор могли поставить
  // уже после построения настроек.
  const tab = sec.querySelector('[data-settings-tab="mcp"]')
  if (tab && typeof tab.addEventListener === 'function') {
    tab.addEventListener('click', () => refreshMcpConnectorStatuses(root))
  }
}

function initSettingsTabs(sec) {
  const settings = sec.querySelector('.settings')
  if (!settings) return
  const defs = [
    ['Вид', 'view', 'Вид'],
    ['Тема', 'theme', 'Тема'],
    ['Мессенджеры', 'services', 'Мессенджеры'],
    ['Сборная вкладка', 'chat-style', 'Оформление чатов'],
    ['Масштаб', 'zoom', 'Масштаб'],
    ['Память', 'memory', 'Память'],
    ['Избранное', 'favorites', 'Избранное'],
    ['MCP', 'mcp', 'MCP'],
    ['Диагностика', 'diagnostics', 'Диагностика']
  ]
  const headings = Array.from(settings.children).filter(el => el.tagName === 'H3')
  const panes = []
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]
    const nextHeading = headings[i + 1]
    const def = defs.find(([prefix]) => heading.textContent.trim().startsWith(prefix))
    if (!def) continue
    const pane = document.createElement('section')
    pane.className = 'settings-pane'
    pane.dataset.settingsPane = def[1]
    heading.before(pane)
    for (let node = heading; node && node !== nextHeading;) {
      const next = node.nextSibling
      pane.appendChild(node)
      node = next
    }
    panes.push({ key: def[1], label: def[2], pane })
  }
  if (!panes.length) return
  const tabs = document.createElement('div')
  tabs.className = 'settings-tabs'
  tabs.setAttribute('role', 'tablist')
  panes[0].pane.before(tabs)
  const select = key => {
    state.settingsTab = key
    for (const item of panes) {
      const active = item.key === key
      item.pane.classList.toggle('hidden', !active)
      const button = tabs.querySelector('[data-settings-tab="' + item.key + '"]')
      if (button) {
        button.classList.toggle('active', active)
        button.setAttribute('aria-selected', String(active))
      }
    }
  }
  for (const item of panes) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'settings-tab'
    button.dataset.settingsTab = item.key
    button.textContent = item.label
    button.onclick = () => select(item.key)
    tabs.appendChild(button)
  }
  select(panes.some(item => item.key === state.settingsTab) ? state.settingsTab : panes[0].key)
}

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
            <li>«↻ К исходной странице» на вкладке мессенджера возвращает к его начальному адресу.
            Если этот адрес уже открыт, страница перезагружается. Стрелка ↻ в открытом чате
            «★ Сборной» возвращает к сохранённому адресу этого чата.</li>
            <li>«⭐ В избранное» на вкладке мессенджера добавляет открытый чат в сборную вкладку.</li>
            <li>«★ Сборная»: избранные чаты слева, переписка справа. 📌 — закрепить наверху,
            ↗ — открыть на вкладке мессенджера, ✕ — убрать из избранного.</li>
            <li>Счётчики на вкладках: всего непрочитанных и @упоминания; на «★ Сборной» — суммы по избранным чатам. Число с «+» означает нижнюю границу: в виртуальном списке могут быть непрочитанные ниже текущей области.</li>
            <li>🔍 «Найти чат…» — поиск по избранным; список сортируется по времени последнего сообщения.</li>
            <li>В меню ⋮ у чата выберите «Добавить комментарий», чтобы сохранить локальную подпись в скобках. По этой подписи тоже работает поиск.</li>
            <li>В портативной сборке данные входа и настройки хранятся в папке <code>data</code> рядом с <code>ChatHub.exe</code>.</li>
          </ul>
        </details>
      </div>
      <h2>⚙ Настройки</h2>
      <p class="hint">Файл конфигурации: <code id="cfg-path"></code></p>

      <h3>Вид</h3>
      <fieldset class="setting-group" data-setting-group="layout">
        <legend>Навигация</legend>
        <div class="setting-options setting-radio-row">
          <label><input type="radio" name="layout" value="tabs"> Вкладки сверху</label>
          <label><input type="radio" name="layout" value="sidebar"> Панель слева</label>
        </div>
        <label class="setting-suboption"><input type="checkbox" id="tab-icons"> Показывать иконки на вкладках сверху</label>
        <p class="hint">Панель слева тянется за правый край: шире — значки с надписями, уже — только большие значки мессенджеров.</p>
      </fieldset>
      <fieldset class="setting-group" data-setting-group="unread-badges">
        <legend>Индикаторы непрочитанного</legend>
        <label><input type="checkbox" id="badge-visible"> Показывать счётчики непрочитанных на вкладках</label>
        <label class="setting-suboption"><input type="checkbox" id="fav-badge-always"> У ★ Сборной всегда показывать счётчик новых</label>
      </fieldset>
      <fieldset class="setting-group" data-setting-group="favorite-appearance">
        <legend>Отображение строк избранного</legend>
        <div class="setting-options">
          <label><input type="checkbox" id="svcbadge-visible"> Показывать значок мессенджера</label>
          <label><input type="checkbox" id="svcname-visible"> Показывать название мессенджера</label>
        </div>
        <div class="setting-choice">
          <span class="setting-choice-label">Размер аватарки</span>
          <div class="setting-radio-row">
            <label><input type="radio" name="fav-avatar-size" value="large"> Большая</label>
            <label><input type="radio" name="fav-avatar-size" value="medium"> Средняя</label>
            <label><input type="radio" name="fav-avatar-size" value="small"> Маленькая</label>
          </div>
        </div>
        <label><input type="checkbox" id="fav-preview-visible"> Показывать последнее сообщение</label>
        <div class="setting-suboption" data-fav-preview-options>
          <span class="setting-choice-label">Высота сообщения</span>
          <div class="setting-radio-row">
            <label><input type="radio" name="fav-preview-lines" value="1"> Одна строка</label>
            <label><input type="radio" name="fav-preview-lines" value="2"> Две строки</label>
          </div>
        </div>
        <label><input type="checkbox" id="fav-comment-visible"> Показывать комментарии к чатам</label>
        <div class="setting-suboption" data-fav-comment-style-options>
          <span class="setting-choice-label">Вид комментария</span>
          <div class="setting-radio-row">
            <label><input type="radio" name="fav-comment-style" value="muted"> Приглушённый</label>
            <label><input type="radio" name="fav-comment-style" value="title"> Продолжение названия</label>
          </div>
        </div>
        <div class="setting-suboption" data-fav-comment-placement-options>
          <span class="setting-choice-label">Расположение комментария</span>
          <div class="setting-radio-row">
            <label><input type="radio" name="fav-comment-placement" value="inline"> Сразу после названия</label>
            <label><input type="radio" name="fav-comment-placement" value="right"> Справа в строке</label>
          </div>
        </div>
      </fieldset>

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
      <p class="hint">Быстрый возврат к чатам расходует больше памяти. Если экономить память, возврат к чату может занять несколько секунд.</p>
      <div class="form-row">
        <label>Держать открытыми чатов: <b id="live-views-label"></b></label>
        <input type="range" id="live-views" min="2" max="20" step="1" style="flex:1">
      </div>
      <div class="form-row">
        <label><input type="checkbox" id="pin-bg-active"> Держать недавно открытые чаты готовыми к быстрому возврату</label>
      </div>
      <p class="hint">Если включить эту настройку, возврат к недавно открытым чатам будет быстрее, но памяти потребуется больше. Изменение вступит в силу после перезапуска.</p>
      <div class="form-row">
        <label><input type="checkbox" id="service-background-throttling"> Уменьшать нагрузку от мессенджеров в фоне</label>
      </div>
      <p class="hint">Мессенджеры остаются открытыми, но некоторые фоновые обновления могут приходить с задержкой. Изменение вступит в силу после «Сохранить и перезапустить».</p>
      <div class="form-row">
        <label><input type="checkbox" id="service-idle-unload"> Закрывать мессенджеры без избранных чатов через 15 минут</label>
      </div>
      <p class="hint">Если у мессенджера есть хотя бы один избранный чат, он остаётся открытым, поэтому «Сборная» продолжает получать свежие обновления. Мессенджер без избранных чатов откроется снова при выборе его вкладки. Изменение вступит в силу после «Сохранить и перезапустить».</p>
      <div class="form-row">
        <label><input type="checkbox" id="service-memory-guard"> Перезапускать вкладку мессенджера, если она заняла слишком много памяти</label>
      </div>
      <p class="hint">Пороги: 1,5 ГиБ для одной вкладки мессенджера или 3 ГиБ для всего ChatHub. Видимый мессенджер не перезапускается. Фоновый может перезагружаться несколько секунд, а неотправленный черновик может быть потерян. Сборщик автоматически переподключится, и обновление избранного продолжится. Изменение вступит в силу после «Сохранить и перезапустить».</p>

      <h3>Избранное</h3>
      <div id="pin-rows"></div>

      <div id="mcp-rows"></div>

      <h3>Диагностика</h3>
      <div class="form-row">
        <span class="hint" id="max-session-status"></span>
      </div>
      <div class="form-row"><strong>Состояние сеансов</strong></div>
      <div class="hint" id="session-state-rows"></div>
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

  const maxStatus = sec.querySelector('#max-session-status')
  if (maxStatus && typeof maxSessionDiagnosticText === 'function') maxStatus.textContent = maxSessionDiagnosticText()
  // «Состояние сеансов»: журнал общий, поэтому блок строится при каждом
  // открытии настроек, а не только по наблюдению MAX.
  if (typeof renderServiceSessionDiagnostics === 'function') renderServiceSessionDiagnostics(sec)

  window.hub.configPath().then(p => {
      const el = sec.querySelector('#cfg-path')
      if (el) el.textContent = p
    })

    // версия приложения в блоке «О программе» (из package.json через main)
    if (window.hub.getVersion) {
      window.hub.getVersion().then(v => {
        const el = sec.querySelector('#about-version')
        if (el) el.textContent = 'v' + v
      }).catch(() => {})
    }

    // вид: вкладки сверху / панель слева — применяется сразу, без перезапуска
    sec.querySelectorAll('input[name="layout"]').forEach(r => {
      r.checked = (r.value === (state.cfg.layout || 'tabs'))
      r.onchange = () => {
        if (!r.checked) return
        state.cfg.layout = r.value
        applyLayout()
        saveConfig(state.cfg).catch(() => {})
        toast(r.value === 'sidebar' ? 'Панель слева' : 'Вкладки сверху')
      }
    })
    // счётчики непрочитанных на вкладках: красные и @ — видимость
    const badgeCb = sec.querySelector('#badge-visible')
    if (badgeCb) {
      badgeCb.checked = state.cfg.badgeVisible !== false
      badgeCb.onchange = () => {
        state.cfg.badgeVisible = badgeCb.checked
        applyBadgeVisibility()
        saveConfig(state.cfg).catch(() => {})
      }
    }
    const favBadgeCb = sec.querySelector('#fav-badge-always')
    if (favBadgeCb) {
      favBadgeCb.checked = state.cfg.favBadgeAlways === true
      favBadgeCb.onchange = () => {
        state.cfg.favBadgeAlways = favBadgeCb.checked
        applyBadgeVisibility()
        saveConfig(state.cfg).catch(() => {})
      }
    }
    const tabIconsCb = sec.querySelector('#tab-icons')
    if (tabIconsCb) {
      tabIconsCb.checked = state.cfg.tabIcons === true
      tabIconsCb.onchange = () => {
        state.cfg.tabIcons = tabIconsCb.checked
        applyTabIcons()
        saveConfig(state.cfg).catch(() => {})
      }
    }
    // значок мессенджера у чатов в избранном — видимость
    const svcCb = sec.querySelector('#svcbadge-visible')
    if (svcCb) {
      svcCb.checked = state.cfg.svcBadgeVisible !== false
      svcCb.onchange = () => {
        state.cfg.svcBadgeVisible = svcCb.checked
        applyBadgeVisibility()
        saveConfig(state.cfg).catch(() => {})
      }
    }
    const svcNameCb = sec.querySelector('#svcname-visible')
    if (svcNameCb) {
      svcNameCb.checked = state.cfg.svcNameVisible !== false
      svcNameCb.onchange = () => {
        state.cfg.svcNameVisible = svcNameCb.checked
        applyBadgeVisibility()
        saveConfig(state.cfg).catch(() => {})
      }
    }
    sec.querySelectorAll('input[name="fav-avatar-size"]').forEach(input => {
      input.checked = input.value === (['large', 'medium', 'small'].includes(state.cfg.favAvatarSize) ? state.cfg.favAvatarSize : 'large')
      input.onchange = () => {
        if (!input.checked) return
        state.cfg.favAvatarSize = input.value
        applyFavouriteDensity()
        saveConfig(state.cfg).catch(() => {})
      }
    })
    const previewCb = sec.querySelector('#fav-preview-visible')
    const previewOptions = sec.querySelector('[data-fav-preview-options]')
    const commentVisibleCb = sec.querySelector('#fav-comment-visible')
    const commentStyleOptions = sec.querySelector('[data-fav-comment-style-options]')
    const commentPlacementOptions = sec.querySelector('[data-fav-comment-placement-options]')
    const updateFavoriteControlAvailability = () => {
      const previewEnabled = state.cfg.favPreviewVisible !== false
      sec.querySelectorAll('input[name="fav-preview-lines"]').forEach(input => { input.disabled = !previewEnabled })
      if (previewOptions) previewOptions.classList.toggle('is-disabled', !previewEnabled)
      const commentsEnabled = state.cfg.favCommentVisible !== false
      sec.querySelectorAll('input[name="fav-comment-style"]').forEach(input => { input.disabled = !commentsEnabled })
      sec.querySelectorAll('input[name="fav-comment-placement"]').forEach(input => { input.disabled = !commentsEnabled })
      if (commentStyleOptions) commentStyleOptions.classList.toggle('is-disabled', !commentsEnabled)
      if (commentPlacementOptions) commentPlacementOptions.classList.toggle('is-disabled', !commentsEnabled)
    }
    if (previewCb) {
      previewCb.checked = state.cfg.favPreviewVisible !== false
      previewCb.onchange = () => {
        state.cfg.favPreviewVisible = previewCb.checked
        applyFavouriteDensity()
        updateFavoriteControlAvailability()
        saveConfig(state.cfg).catch(() => {})
      }
    }
    sec.querySelectorAll('input[name="fav-preview-lines"]').forEach(input => {
      input.checked = String(state.cfg.favPreviewLines === 1 ? 1 : 2) === input.value
      input.onchange = () => {
        if (!input.checked) return
        state.cfg.favPreviewLines = Number(input.value) === 1 ? 1 : 2
        applyFavouriteDensity()
        saveConfig(state.cfg).catch(() => {})
      }
    })
    if (commentVisibleCb) {
      commentVisibleCb.checked = state.cfg.favCommentVisible !== false
      commentVisibleCb.onchange = () => {
        state.cfg.favCommentVisible = commentVisibleCb.checked
        applyFavouriteDensity()
        renderChatList()
        updateFavoriteControlAvailability()
        saveConfig(state.cfg).catch(() => {})
      }
    }
    sec.querySelectorAll('input[name="fav-comment-style"]').forEach(input => {
      input.checked = input.value === (state.cfg.favCommentStyle === 'title' ? 'title' : 'muted')
      input.onchange = () => {
        if (!input.checked) return
        state.cfg.favCommentStyle = input.value === 'title' ? 'title' : 'muted'
        applyFavouriteDensity()
        saveConfig(state.cfg).catch(() => {})
      }
    })
    sec.querySelectorAll('input[name="fav-comment-placement"]').forEach(input => {
      input.checked = input.value === (state.cfg.favCommentPlacement === 'inline' ? 'inline' : 'right')
      input.onchange = () => {
        if (!input.checked) return
        state.cfg.favCommentPlacement = input.value === 'inline' ? 'inline' : 'right'
        applyFavouriteDensity()
        renderChatList()
        saveConfig(state.cfg).catch(() => {})
      }
    })
    updateFavoriteControlAvailability()
    // тема: тёмная / светлая — тоже сразу
    sec.querySelectorAll('input[name="theme"]').forEach(r => {
      r.checked = (r.value === (state.cfg.theme || 'dark'))
      r.onchange = () => {
        if (!r.checked) return
        state.cfg.theme = r.value
        applyTheme()
        saveConfig(state.cfg).catch(() => {})
        toast(r.value === 'light' ? 'Светлая тема' : 'Тёмная тема')
      }
    })

    // кнопка «Самопроверка»: отчёт в pre, копирование в буфер
    const scBtn = sec.querySelector('#run-selfcheck')
    if (scBtn) {
      scBtn.onclick = () => {
        const rep = sec.querySelector('#selfcheck-report')
        const copyBtn = sec.querySelector('#copy-selfcheck')
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
    renderSvcRows(sec.querySelector('#svc-rows'), sec)
    renderCssRows(sec.querySelector('#css-rows'))
    renderZoomRows(sec.querySelector('#zoom-rows'))
    renderPinRows(sec.querySelector('#pin-rows'))
    // В старых vm-харнессах этой функции нет — тогда секция MCP не строится.
    if (typeof renderMcpSettings === 'function') renderMcpSettings(sec.querySelector('#mcp-rows'))

  // ползунок «чатов в памяти» (LRU): применяется сразу, без перезапуска
  const lvSlider = sec.querySelector('#live-views')
  const lvLabel = sec.querySelector('#live-views-label')
  if (lvSlider && lvLabel) {
    const show = n => { lvLabel.textContent = n }
    lvSlider.min = '2'; lvSlider.max = '20'
    lvSlider.value = String(maxLiveViews())
    show(maxLiveViews())
    lvSlider.oninput = async () => {
      const n = Math.max(2, Math.min(20, parseInt(lvSlider.value, 10) || 8))
      show(n)
      state.cfg.maxLiveViews = n
      await saveConfig(state.cfg)
      trimPinViews(state.cfg.selectedPinId)
      renderChatList()
    }
  }
  const pinBg = sec.querySelector('#pin-bg-active')
  if (pinBg) {
    pinBg.checked = state.cfg.pinBackgroundActive === true
    pinBg.onchange = async () => {
      state.cfg.pinBackgroundActive = pinBg.checked
      await saveConfig(state.cfg)
      toast(pinBg.checked ? 'Чаты в фоне будут работать в полную силу после перезапуска' : 'Чаты в фоне будут экономить ресурсы после перезапуска')
    }
  }
  // Три независимых переключателя памяти: обработчик пишет ТОЛЬКО значение в
  // state.cfg (и сохраняет его). Живые вьюхи, таймеры, очередь и текущая
  // политика не меняются — режим вступит в силу после «Сохранить и перезапустить».
  for (const [id, key] of [
    ['service-background-throttling', 'serviceBackgroundThrottling'],
    ['service-idle-unload', 'serviceIdleUnload'],
    ['service-memory-guard', 'serviceMemoryGuard']
  ]) {
    const cb = sec.querySelector('#' + id)
    if (!cb) continue
    cb.checked = state.cfg[key] === true
    cb.onchange = async () => {
      state.cfg[key] = cb.checked === true
      await saveConfig(state.cfg)
    }
  }

  sec.querySelector('#save-settings').onclick = async () => {
    await saveConfig(state.cfg)
    toast('Сохранено, перезапускаю…')
    setTimeout(() => window.location.reload(), 700)
  }
  sec.querySelector('#reset-pins').onclick = async () => {
    if (!confirm('Убрать все чаты из избранного?')) return
    state.cfg.pinned = []
    state.cfg.selectedPinId = ''
    await saveConfig(state.cfg)
    renderPinRows(sec.querySelector('#pin-rows'))
  }
  initSettingsTabs(sec)
  if (typeof initMcpSettings === 'function') initMcpSettings(sec)
}

function renderSvcRows(host, settingsRoot) {
  host = host || document.getElementById('svc-rows')
  settingsRoot = settingsRoot || host?.closest?.('section[data-tab="settings"]') || document
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
      renderSvcRows(host, settingsRoot)
      renderCssRows(settingsRoot.querySelector('#css-rows'))
      renderZoomRows(settingsRoot.querySelector('#zoom-rows'))
      renderPinRows(settingsRoot.querySelector('#pin-rows'))
    }
    host.appendChild(row)
  })
}

function renderCssRows(host) {
  host = host || document.getElementById('css-rows')
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

function renderZoomRows(host) {
  host = host || document.getElementById('zoom-rows')
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

function renderPinRows(host) {
  host = host || document.getElementById('pin-rows')
  if (!host) return
  host.innerHTML = ''
  // «Выгрузить список в MD»: локальный список избранного, без чтения
  // мессенджеров. Кнопка стоит под таблицей пинов и при пустом списке тоже:
  // пустая выгрузка — честный файл с count: 0.
  const appendExport = () => {
    const row = document.createElement('div')
    row.className = 'form-row'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn'
    button.id = 'fav-export-md'
    button.textContent = 'Выгрузить список в MD'
    button.onclick = async () => {
      if (button.disabled) return
      button.disabled = true
      try {
        const result = await window.hub.favoritesExport()
        if (result && result.ok === true) {
          const count = Number.isFinite(result.count) ? result.count : 0
          toast('Список избранного: ' + count + ' чатов → ' + result.path)
        } else {
          const code = result && typeof result.code === 'string' ? result.code : ''
          toast(favoritesExportErrorText(code))
        }
      } catch (error) {
        toast('Не удалось выгрузить список избранного')
      } finally {
        button.disabled = false
      }
    }
    row.appendChild(button)
    host.appendChild(row)
  }
  if (!state.cfg.pinned.length) {
    host.innerHTML = '<p class="hint">Пока ничего в избранном.</p>'
    appendExport()
    return
  }
  const head = document.createElement('div')
  head.className = 'pin-row pin-row-head'
  head.innerHTML = '<span></span><span>Название</span><span>Комментарий</span><span>Комментарий 2 (проект для MCP)</span><span>Ссылка</span><span></span>'
  host.appendChild(head)
  // Записи удалённых избранных не должны переживать свой пин: иначе откат
  // вернул бы значения чата, которого уже нет в конфиге.
  const baseline = state.pinEditBaseline || (state.pinEditBaseline = {})
  const liveIds = new Set(state.cfg.pinned.map(item => item.id))
  for (const key of Object.keys(baseline)) if (!liveIds.has(key)) delete baseline[key]
  state.cfg.pinned.forEach((p, i) => {
    const row = document.createElement('div')
    row.className = 'pin-row'
    row.innerHTML = `
      <span class="pin-idx"></span>
      <input class="f-title" placeholder="Название чата">
      <input class="f-comment" placeholder="Комментарий (локально)" maxlength="80">
      <input class="f-mcp-project" placeholder="Проект для MCP" maxlength="80" aria-label="Комментарий 2 (проект для MCP)">
      <input class="f-url" readonly>
      <button class="icon-btn del" title="Убрать из избранного" aria-label="Убрать из избранного">✕</button>`
    row.querySelector('.pin-idx').textContent = (i + 1) + '.'
    const titleInput = row.querySelector('.f-title')
    const commentInput = row.querySelector('.f-comment')
    // Служебное локальное поле: только для Настроек → Избранное, в список чатов,
    // превью и поиск не попадает.
    const projectInput = row.querySelector('.f-mcp-project')
    titleInput.value = typeof p.title === 'string' ? p.title : ''
    commentInput.value = typeof p.annotation === 'string' ? p.annotation : ''
    projectInput.value = typeof p.mcpProject === 'string' ? p.mcpProject : ''
    row.querySelector('.f-url').value = p.url
    const normalizeTitle = value => String(value).trim()
    const normalizeComment = value => String(value).trim().replace(/\s+/g, ' ').replace(/^\((.*)\)$/, '$1').trim().slice(0, 80)
    // Проект для MCP: trim, схлопывание пробелов, не длиннее 80. Без снятия скобок —
    // это не «комментарий» для искателя, а служебный идентификатор проекта.
    const normalizeProject = value => String(value).trim().replace(/\s+/g, ' ').slice(0, 80)
    // Точка отката — состояние, которое точно лежит в config.json. Живёт только
    // в памяти сессии: правка названия/комментариев локальна и в мессенджер не уходит.
    const snapshot = () => ({
      title: p.title,
      hasTitle: Object.prototype.hasOwnProperty.call(p, 'title'),
      // провенанс названия: ручная правка ставит titleCustom, откат возвращает
      // ровно прежнее состояние ключа (нет ключа → ключа нет)
      titleCustom: p.titleCustom,
      hasTitleCustom: Object.prototype.hasOwnProperty.call(p, 'titleCustom'),
      hasAnnotation: Object.prototype.hasOwnProperty.call(p, 'annotation'),
      annotation: p.annotation,
      hasMcpProject: Object.prototype.hasOwnProperty.call(p, 'mcpProject'),
      mcpProject: p.mcpProject
    })
    if (!baseline[p.id]) baseline[p.id] = snapshot()
    const redrawList = () => { try { renderChatList() } catch (e) {} }
    const syncInputs = () => {
      titleInput.value = typeof p.title === 'string' ? p.title : ''
      commentInput.value = typeof p.annotation === 'string' ? p.annotation : ''
      projectInput.value = typeof p.mcpProject === 'string' ? p.mcpProject : ''
    }
    // Поля таблицы избранного и их ключи в baseline: каждое коммитится и
    // откатывается само по себе.
    const FIELD_KEYS = {
      title: { has: 'hasTitle', value: 'title' },
      annotation: { has: 'hasAnnotation', value: 'annotation' },
      mcpProject: { has: 'hasMcpProject', value: 'mcpProject' }
    }
    // Применяем ровно одно поле: успешно сохранённое другое поле не трогаем.
    const applyField = (field, has, value) => {
      const meta = FIELD_KEYS[field] || FIELD_KEYS.annotation
      if (has) p[meta.value] = value
      else delete p[meta.value]
    }
    // Коммиты одного пина идут строго по очереди, а номер правки каждого поля
    // позволяет отличить актуальный результат от устаревшего. Оба живут на
    // state: перерисовка строки после ошибки не должна терять ни очередь, ни baseline.
    const commitQueues = state.pinCommitQueues || (state.pinCommitQueues = {})
    const editSeq = state.pinEditSeq || (state.pinEditSeq = {})
    const seqOf = () => editSeq[p.id] || (editSeq[p.id] = { title: 0, annotation: 0, mcpProject: 0 })
    const runEdit = async (field, input, normalize) => {
      const meta = FIELD_KEYS[field] || FIELD_KEYS.annotation
      // Значение и prior берём в момент выполнения: предыдущий коммит этого пина
      // уже завершился и обновил baseline, поэтому устаревшего снимка здесь нет.
      const prior = Object.assign({}, baseline[p.id] || (baseline[p.id] = snapshot()))
      const value = normalize(input.value)
      input.value = value
      const priorHas = Boolean(prior[meta.has])
      const priorValue = prior[meta.value]
      const nextHas = field === 'title' ? true : Boolean(value)
      const changed = nextHas !== priorHas || (nextHas && value !== priorValue)
      if (!changed) {
        applyField(field, priorHas, priorValue)
        syncInputs()
        return
      }
      const seq = seqOf()
      const ownEdit = seq[field]
      const isTitle = field === 'title'
      const priorCustomHas = Boolean(prior.hasTitleCustom)
      const priorCustom = prior.titleCustom
      // Ручное название помечается провенансом: его больше не перезапишет
      // авто-переименование при старте. Пустое поле не считается ручным именем —
      // иначе строка навсегда осталась бы без названия.
      if (isTitle) {
        if (value) p.titleCustom = true
        else delete p.titleCustom
      }
      applyField(field, nextHas, value)
      // Ждём именно нашу запись в очереди: откат выполняется до того, как
      // следующая сохранённая задача клонирует конфиг.
      try {
        await saveConfig()
      } catch (error) {
        // Если для этого поля уже есть более новая правка, устаревший откат
        // затёр бы несохранённый ввод — оставляем поле как есть, но сообщаем об ошибке.
        if (seq[field] === ownEdit) {
          applyField(field, priorHas, priorValue)
          // имя и его провенанс откатываются вместе: иначе сохранённое имя
          // снова оказалось бы перезаписано авто-переименованием
          if (isTitle) {
            if (priorCustomHas) p.titleCustom = priorCustom
            else delete p.titleCustom
          }
          syncInputs()
        }
        redrawList()
        try { renderPinRows(host) } catch (e) {}
        toast('Не удалось сохранить изменения')
        return
      }
      // Данные уже в config.json: в baseline пишем зафиксированное значение коммита,
      // а не текущее p.title/p.annotation — там может быть более поздняя правка.
      const next = Object.assign({}, baseline[p.id] || prior)
      next[meta.has] = nextHas
      next[meta.value] = nextHas ? value : undefined
      // сохранённое ручное имя фиксируем вместе с провенансом: последующий откат
      // не должен «забыть», что имя уже помечено как заданное человеком
      if (isTitle) { next.hasTitleCustom = Boolean(value); next.titleCustom = value ? true : undefined }
      baseline[p.id] = next
    }
    // Сериализация коммитов одного пина: второй blur не берёт baseline, пока
    // первое сохранение не завершилось.
    const commitEdit = (field, input, normalize) => {
      const previous = commitQueues[p.id] || Promise.resolve()
      const run = previous.then(() => runEdit(field, input, normalize))
      commitQueues[p.id] = run.then(() => {}, () => {})
      return run
    }
    titleInput.oninput = e => { p.title = String(e.target.value); seqOf().title++; redrawList() }
    commentInput.oninput = e => { p.annotation = String(e.target.value).slice(0, 80); seqOf().annotation++; redrawList() }
    // Пустой ввод сразу убирает ключ: в config.json не должно появляться mcpProject: "".
    projectInput.oninput = e => {
      const next = String(e.target.value).slice(0, 80)
      if (next.trim()) p.mcpProject = next
      else delete p.mcpProject
      seqOf().mcpProject++
      redrawList()
    }
    titleInput.onblur = () => commitEdit('title', titleInput, normalizeTitle)
    commentInput.onblur = () => commitEdit('annotation', commentInput, normalizeComment)
    projectInput.onblur = () => commitEdit('mcpProject', projectInput, normalizeProject)
    row.querySelector('.del').onclick = () => {
      state.cfg.pinned.splice(i, 1)
      renderPinRows(host)
    }
    host.appendChild(row)
  })
  appendExport()
}

// Понятный текст ошибки выгрузки избранного: коды записи и отмены диалога.
function favoritesExportErrorText(code) {
  if (code === 'CANCELLED') return 'Выгрузка избранного отменена'
  if (code === 'EXPORT_DIR_MISSING') return 'Не удалось выгрузить избранное: папка не найдена'
  if (code === 'EXPORT_DIR_NOT_DIR') return 'Не удалось выгрузить избранное: путь не является папкой'
  if (code === 'EXPORT_DIR_NOT_WRITABLE') return 'Не удалось выгрузить избранное: нет доступа к папке'
  if (code === 'EXPORT_NAME_INVALID') return 'Не удалось выгрузить избранное: недопустимое имя файла'
  return 'Не удалось выгрузить избранное' + (code ? ': ' + code : '')
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
