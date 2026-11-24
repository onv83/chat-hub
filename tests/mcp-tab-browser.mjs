// Изолированный браузерный тест вкладки MCP. Без Electron, живого профиля,
// сети и мессенджеров. Запуск: node --test tests/mcp-tab-browser.mjs
// (CHATHUB_TEST_BROWSER может задать путь к Chromium).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(root, 'renderer.js'), 'utf8')
const css = readFileSync(path.join(root, 'styles.css'), 'utf8')

function extract(name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(source)
  assert.ok(match, name)
  let depth = 0
  for (let i = match.index + match[0].length - 1; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(match.index, i + 1)
  }
  throw new Error('Unclosed function: ' + name)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let child = null
let ws = null
let call = null
let evaluate = null
let profile = ''

before(async () => {
  const browser = [process.env.CHATHUB_TEST_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(candidate => candidate && existsSync(candidate))
  assert.ok(browser, 'Set CHATHUB_TEST_BROWSER to a Chromium executable')
  const scratch = process.env.CHATHUB_TEST_SCRATCH || path.join(process.env.LOCALAPPDATA || root, 'hermes', 'cache', 'scratch')
  mkdirSync(scratch, { recursive: true })
  profile = mkdtempSync(path.join(scratch, 'chathub-mcp-tab-'))
  child = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })

  const portFile = path.join(profile, 'DevToolsActivePort')
  let port = ''
  for (let i = 0; i < 150 && !port; i++) {
    if (existsSync(portFile)) {
      try { port = readFileSync(portFile, 'utf8').split('\n')[0] } catch (error) {
        if (error?.code !== 'EBUSY') throw error
      }
    }
    if (!port) await sleep(100)
  }
  assert.ok(port, 'isolated Chromium started')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find(target => target.type === 'page')
  assert.ok(page)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map()
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (!pending.has(message.id)) return
    const entry = pending.get(message.id)
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result)
  }
  call = (method, params = {}) => new Promise((resolve, reject) => {
    const number = ++id
    const timer = setTimeout(() => { pending.delete(number); reject(new Error('CDP timeout: ' + method)) }, 5000)
    pending.set(number, { resolve, reject, timer })
    ws.send(JSON.stringify({ id: number, method, params }))
  })
  evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
    return result.result.value
  }

  await call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false })
  await call('DOM.enable')
  await call('CSS.enable')
  await call('Accessibility.enable')
  await evaluate(`document.head.innerHTML = '<style>' + ${JSON.stringify(css)} + '</style>';
    document.body.innerHTML = '<div class="chat-list" id="chat-list" style="width:420px;height:180px !important;max-height:180px !important;overflow-y:scroll !important;display:block !important;scroll-behavior:auto !important;background:var(--panel)"></div>';
    document.body.style.display = 'block';
    document.body.style.overflow = 'visible';`)

  const functions = [
    'cloneConfigForSave', 'queueConfigSave', 'saveConfig', 'showAnnotationDialog', 'closeAllRowMenus',
    'makeChatRow', 'setRowPreview', 'setRowAvatar', 'setRowBadge', 'applyFavFilter', 'syncChatSelection',
    'renderChatList', 'selectChat', 'sortFavoritesByActivity', 'removePin', 'applyFavouriteDensity',
    'initSettingsTabs', 'buildSettings', 'renderSvcRows', 'renderCssRows', 'renderZoomRows', 'renderPinRows',
    'mcpEl', 'normalizeMcpDepth', 'mcpDepthText', 'mcpShortText', 'mcpConnectorStatusText', 'mcpErrorExplanation',
    'mcpExportBlockedReason', 'mcpReportLines', 'mcpProgressLine', 'mcpBaseName', 'mcpServiceName',
    'mcpChatStatusText', 'mcpCoverageText', 'setMcpReport', 'renderMcpReport', 'refreshMcpConnectorStatuses',
    'mcpPanelNode', 'mcpProgressRemember', 'mcpProgressAppend',
    'mcpExportSubscribe', 'mcpExportUnsubscribe', 'mcpApplyRunControls', 'mcpSyncRunControls', 'mcpRenderRunResult',
    'renderMcpSettings', 'initMcpSettings'
  ].map(extract).join('\n') + '\n' + source.slice(source.indexOf('const escapeHtml ='), source.indexOf('let toastTimer ='))

  await evaluate(`
    var mcpProgressOff = null;
    var mcpExportRun = { running: false, startedAt: 0, progress: [], report: null };
    var state = { activePinId: '', cfg: { selectedPinId: 'pin-mm',
      services: ['mm','tg','max','ydx'].map(id => ({ id, name: id.toUpperCase() })),
      pinned: ['mm','tg','max','ydx'].map(id => ({ id: 'pin-'+id, serviceId: id, title: 'Synthetic '+id.toUpperCase(), url: 'https://fixture.invalid/'+id })),
      columnCss: {}, zoom: {}, maxLiveViews: 5, mcpExportDir: '', mcpExportDepthDays: 7 },
      svcIcons: {}, lastMsgPreview: {}, lastMsgAt: {}, liveAct: {}, rankAct: {}, pinViews: {}, lastUsed: {} };
    window.hub = {
      saveConfig: async () => {},
      configPath: async () => '',
      getVersion: async () => '0.0.0',
      mcpChooseDir: async () => ({ canceled: true, path: '' }),
      mcpConnectorInstall: async service => ({ ok: true, entry: { tools: [] } }),
      mcpConnectorConnect: async service => ({ ok: false, code: 'CANCELLED' }),
      mcpProbe: async service => ({ ok: true, tools: [] }),
      mcpConnectorStatus: async service => ({ service, installed: false, path: null, mode: null, tools: [] }),
      mcpExport: async () => ({ ok: true, files: [], chats: [], truncated: false, errors: [] }),
      mcpCancel: async () => true,
      onMcpProgress: cb => { window.__mcpProgress = cb; return () => { window.__mcpProgress = null } }
    };
    function badgeColor() { return '#5865f2' }
    function trimPinViews() {}
    function enqueueLoad() {}
    function renderViewHead() {}
    async function queueSelectedUnread() { window.__readProbes = (window.__readProbes || 0) + 1 }
    function updateSvcBar() {}
    function toast() {}
    function applyLayout() {}
    function applyBadgeVisibility() {}
    function applyTabIcons() {}
    function applyTheme() {}
    function maxLiveViews() { return 5 }
    function localSelfcheck() { return [] }
    function fmtRowTime() { return '12:34' }
    function ensurePinView(p) { return state.pinViews[p.id] ||= Object.assign(document.createElement('div'), { executeJavaScript() {} }) }
    function destroyPinView(id) { delete state.pinViews[id] }
    ${functions}
    renderChatList();
  `)
})

after(async () => {
  if (call) { try { await call('Browser.close') } catch {} }
  try { ws?.close() } catch {}
  await sleep(400)
  if (child && child.exitCode === null) child.kill()
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch {} }
})

test('MCP: вкладка открывается, видны три карточки, ползунок и кнопка выгрузки', async () => {
  const result = await evaluate(`(() => {
    const sec = document.createElement('section');
    document.body.appendChild(sec);
    window.__mcpSec = sec;
    state.cfg = {
      layout: 'tabs', theme: 'dark',
      services: [{ id: 'mm', name: 'Mattermost' }],
      pinned: [{ id: 'mcp-mm', serviceId: 'mm', title: 'Проект', url: 'https://fixture.invalid/team/channels/dev', mcpProject: '14544' }],
      columnCss: {}, zoom: {}, maxLiveViews: 5, badgeVisible: true, svcBadgeVisible: true,
      svcNameVisible: true, favBadgeAlways: false, tabIcons: false, pinBackgroundActive: false,
      favAvatarSize: 'large', favPreviewVisible: true, favPreviewLines: 2,
      mcpExportDir: 'C:/Экспорт', mcpExportDepthDays: 7
    };
    state.lastMsgPreview = {}; state.lastMsgAt = {}; state.unreadTotals = {}; state.unreadDots = {};
    state.pinAvatars = {}; state.favQuery = ''; state.activePinId = ''; state.pinViews = {}; state.settingsTab = '';
    window.__mcpStatusCalls = [];
    window.hub.mcpConnectorStatus = async service => {
      window.__mcpStatusCalls.push(service);
      return { service, installed: service === 'mm', tools: service === 'mm' ? ['mmchat_read_channel'] : [] };
    };
    buildSettings(sec);
    const tabs = [...sec.querySelectorAll('.settings-tab')].map(tab => tab.dataset.settingsTab);
    sec.querySelector('.settings-tab[data-settings-tab="mcp"]').click();
    const pane = sec.querySelector('[data-settings-pane="mcp"]');
    return {
      tabs,
      visible: [...sec.querySelectorAll('.settings-pane:not(.hidden)')].map(item => item.dataset.settingsPane),
      cards: [...pane.querySelectorAll('[data-mcp-card]')].map(card => card.dataset.mcpCard),
      headings: [...pane.querySelectorAll('[data-mcp-card] h4')].map(node => node.textContent),
      hasRange: !!pane.querySelector('#mcp-depth'),
      rangeMin: pane.querySelector('#mcp-depth').min,
      rangeMax: pane.querySelector('#mcp-depth').max,
      depthLabel: pane.querySelector('#mcp-depth-label').textContent,
      runSelector: !!document.querySelector('#mcp-export-run'),
      runDisabled: document.querySelector('#mcp-export-run').disabled,
      ydxButtonsDisabled: [...pane.querySelectorAll('[data-mcp-card="ydx"] button')].every(button => button.disabled),
      telegram: /Telegram|mcp-status-tg/.test(pane.textContent),
      activePinId: state.activePinId,
      pinViewCount: Object.keys(state.pinViews).length,
      readProbes: window.__readProbes || 0
    };
  })()`)
  assert.deepEqual(result.tabs, ['view', 'theme', 'services', 'chat-style', 'zoom', 'memory', 'favorites', 'mcp', 'diagnostics'])
  assert.deepEqual(result.visible, ['mcp'])
  assert.deepEqual(result.cards, ['mm', 'max', 'ydx'])
  assert.deepEqual(result.headings, ['Mattermost', 'MAX', 'Яндекс Телемост'])
  assert.equal(result.hasRange, true)
  assert.equal(result.rangeMin, '1')
  assert.equal(result.rangeMax, '30')
  assert.equal(result.depthLabel, '7 дн.')
  assert.equal(result.runSelector, true)
  assert.equal(result.runDisabled, false)
  assert.equal(result.ydxButtonsDisabled, false, 'кнопки Яндекса активны, как у mm/max')
  assert.equal(result.telegram, false)

  await sleep(80)
  const statuses = await evaluate(`(() => ({
    mm: document.querySelector('#mcp-status-mm').textContent,
    max: document.querySelector('#mcp-status-max').textContent,
    ydx: document.querySelector('#mcp-status-ydx').textContent,
    calls: [...new Set(window.__mcpStatusCalls)].sort()
  }))()`)
  assert.equal(statuses.mm, 'готов')
  assert.equal(statuses.max, 'не установлен')
  assert.equal(statuses.ydx, 'не установлен')
  assert.deepEqual(statuses.calls, ['max', 'mm', 'ydx'])
})

test('MCP: переключение вкладки не смещает геометрию списка избранного', async () => {
  const result = await evaluate(`(() => {
    const sec = window.__mcpSec;
    const rect = node => { const box = node.getBoundingClientRect(); return { top: box.top, left: box.left, width: box.width, height: box.height } };
    const list = document.getElementById('chat-list');
    const row = document.querySelector('.chat-row');
    sec.querySelector('.settings-tab[data-settings-tab="view"]').click();
    const before = { list: rect(list), row: rect(row) };
    const activeBefore = state.activePinId;
    const probesBefore = window.__readProbes || 0;
    sec.querySelector('.settings-tab[data-settings-tab="mcp"]').click();
    const after = { list: rect(list), row: rect(row) };
    return { before, after, activeBefore, activeAfter: state.activePinId,
      pinViewCount: Object.keys(state.pinViews).length, probesBefore, probesAfter: window.__readProbes || 0 };
  })()`)
  assert.deepEqual(result.after, result.before, 'геометрия списка и строки не меняется')
  assert.equal(result.activeAfter, result.activeBefore)
  assert.equal(result.pinViewCount, 0)
  assert.equal(result.probesAfter, result.probesBefore)
})

test('MCP: у поля глубины и кнопки выбора папки есть доступные имена', async () => {
  const labels = await evaluate(`(() => {
    const pane = document.querySelector('[data-settings-pane="mcp"]');
    const choose = pane.querySelector('#mcp-choose-dir');
    const range = pane.querySelector('#mcp-depth');
    const rangeLabel = pane.querySelector('label[for="mcp-depth"]');
    const dirLabel = pane.querySelector('label[for="mcp-export-dir"]');
    range.focus();
    return {
      chooseAria: choose.getAttribute('aria-label'),
      chooseText: choose.textContent,
      rangeLabel: rangeLabel ? rangeLabel.textContent : '',
      rangeValueText: range.getAttribute('aria-valuetext'),
      dirLabel: dirLabel ? dirLabel.textContent : '',
      rangeFocused: document.activeElement === range
    };
  })()`)
  assert.ok(labels.chooseAria && labels.chooseAria.length > 0, 'у кнопки выбора папки есть aria-label')
  assert.match(labels.chooseText, /Выбрать папку/)
  assert.equal(labels.rangeLabel, 'Глубина выгрузки')
  assert.equal(labels.rangeValueText, '7 дн.')
  assert.equal(labels.dirLabel, 'Папка выгрузки')
  assert.equal(labels.rangeFocused, true)

  const tree = await call('Accessibility.getFullAXTree')
  const slider = tree.nodes.find(node => node.role?.value === 'slider')
  const button = tree.nodes.find(node => node.role?.value === 'button' && /Выбрать папку/.test(node.name?.value || ''))
  assert.ok(slider, 'в дереве доступности есть ползунок')
  assert.equal(slider.name?.value, 'Глубина выгрузки')
  assert.ok(button, 'в дереве доступности есть кнопка выбора папки')
})
