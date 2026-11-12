// Isolated offline Chromium CSS regression. No Electron/user profile/network/messenger access.
// Run: node --test tests/active-highlight-browser.mjs (CHATHUB_TEST_BROWSER can override browser).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(root, 'renderer.js'), 'utf8')
const css = readFileSync(path.join(root, 'styles.css'), 'utf8')
function extract(name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(source)
  assert.ok(m, name)
  let depth = 0
  for (let i = m.index + m[0].length - 1; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(m.index, i + 1)
  }
  throw new Error('Unclosed function: ' + name)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('active highlight: real dark/light CSS preserves selection through hover and keeps actions hover-only', { timeout: 45000 }, async t => {
  const browser = [process.env.CHATHUB_TEST_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p))
  assert.ok(browser, 'Set CHATHUB_TEST_BROWSER to a Chromium executable')
  const scratch = process.env.CHATHUB_TEST_SCRATCH || path.join(process.env.LOCALAPPDATA || root, 'hermes', 'cache', 'scratch')
  mkdirSync(scratch, { recursive: true })
  const profile = mkdtempSync(path.join(scratch, 'chathub-css-'))
  const artifacts = path.join(scratch, 'chathub-active-highlight')
  mkdirSync(artifacts, { recursive: true })
  const child = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
  let ws
  let call
  try {
    const portFile = path.join(profile, 'DevToolsActivePort')
    for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(100)
    assert.ok(existsSync(portFile), 'isolated Chromium started')
    const port = readFileSync(portFile, 'utf8').split('\n')[0]
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find(x => x.type === 'page')
    assert.ok(page)
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    let id = 0
    const pending = new Map()
    ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      if (!pending.has(msg.id)) return
      const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result)
    }
    call = (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id
      const timer = setTimeout(() => { pending.delete(n); reject(new Error('CDP timeout: ' + method)) }, 5000)
      pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params }))
    })
    const evaluate = async expression => {
      const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      assert.equal(r.exceptionDetails, undefined, JSON.stringify(r.exceptionDetails))
      return r.result.value
    }
    await call('Emulation.setDeviceMetricsOverride', { width: 900, height: 650, deviceScaleFactor: 1, mobile: false })
    await call('DOM.enable'); await call('CSS.enable')
    await evaluate(`document.head.innerHTML = '<style>' + ${JSON.stringify(css)} + '</style>'; document.body.innerHTML = '<div class="chat-list" id="chat-list" style="width:420px;background:var(--panel)"></div>'`)
    const functions = ['makeChatRow', 'setRowPreview', 'setRowAvatar', 'setRowBadge', 'syncChatSelection', 'renderChatList', 'selectChat', 'sortFavoritesByActivity', 'removePin'].map(extract).join('\n') + '\n' + source.slice(source.indexOf('const escapeHtml ='), source.indexOf('let toastTimer ='))
    await evaluate(`
      var state = { activePinId: '', cfg: { selectedPinId: 'pin-mm', services: ['mm','tg','max','ydx'].map(id => ({ id, name: id.toUpperCase() })), pinned: ['mm','tg','max','ydx'].map(id => ({ id: 'pin-'+id, serviceId: id, title: 'Synthetic '+id.toUpperCase(), url: 'https://fixture.invalid/'+id })) }, svcIcons: {}, lastMsgPreview: {}, lastMsgAt: {}, liveAct: {}, rankAct: {}, pinViews: {}, lastUsed: {} };
      window.hub = { saveConfig: async () => {} };
      function badgeColor() { return '#5865f2' }
      function applyFavFilter() {}
      function trimPinViews() {}
      function enqueueLoad() {}
      function renderViewHead() {}
      async function queueSelectedUnread() {} // polling is tested separately in polling.mjs
      function updateSvcBar() {}
      function toast() {}
      function fmtRowTime() { return '12:34' }
      function ensurePinView(p) { return state.pinViews[p.id] ||= Object.assign(document.createElement('div'), { executeJavaScript() {} }) }
      function destroyPinView(id) { delete state.pinViews[id] }
      ${functions}
      renderChatList();
    `)
    assert.equal(await evaluate(`document.querySelectorAll('.selected').length`), 0, 'saved startup selection stays empty')
    const results = []
    for (const theme of ['dark', 'light']) {
      await evaluate(`document.body.className = ${JSON.stringify(theme === 'light' ? 'theme-light' : '')}`)
      for (const service of ['mm', 'tg', 'max', 'ydx']) {
        const pin = 'pin-' + service
        await evaluate(`document.querySelector('[data-pin="${pin}"]').click(); state.cfg.selectedPinId='saved-other'; state.lastMsgPreview['${pin}']='Author: Synthetic latest message'; renderChatList(); state.lastMsgAt['${pin}']=Date.now(); sortFavoritesByActivity();
          var row = document.querySelector('[data-pin="${pin}"]');
          setRowPreview(row.querySelector('.chat-row-preview'), 'Author: Updated synthetic preview');
          setRowBadge(row, { count: 7 });
          setRowAvatar(row, 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="teal"/></svg>'));
        `)
        assert.equal(await evaluate(`document.querySelector('[data-pin="${pin}"] .row-badge').textContent`), '7')
        assert.match(await evaluate(`document.querySelector('[data-pin="${pin}"] .chat-row-preview').textContent`), /Updated synthetic preview/)
        assert.equal(await evaluate(`!!document.querySelector('[data-pin="${pin}"] .row-avatar img')`), true)
        assert.equal(await evaluate(`document.querySelector('.chat-row').dataset.pin`), pin, 'real activity sort moves the newest row')
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('.selected')].map(r=>r.dataset.pin)`), [pin])
        const tree = await call('DOM.getDocument')
        const { nodeId } = await call('DOM.querySelector', { nodeId: tree.root.nodeId, selector: `[data-pin="${pin}"]` })
        const other = service === 'mm' ? 'tg' : 'mm'
        const otherNode = await call('DOM.querySelector', { nodeId: tree.root.nodeId, selector: `[data-pin="pin-${other}"]` })
        const snapshot = () => evaluate(`(() => {
          const r=document.querySelector('[data-pin="${pin}"]'), o=document.querySelector('[data-pin="pin-${other}"]');
          const c=getComputedStyle(r), b=getComputedStyle(r.querySelector('.row-more'));
          return {bg:c.backgroundColor, color:c.color, preview:getComputedStyle(r.querySelector('.chat-row-preview')).color, more:b.opacity, pointer:b.pointerEvents, otherBg:getComputedStyle(o).backgroundColor, selected:[...document.querySelectorAll('.selected')].map(x=>x.dataset.pin)}
        })()`)
        const idle = await snapshot()
        assert.equal(idle.more, '0', 'active row must not reveal actions without hover')
        assert.equal(idle.pointer, 'none')
        await call('CSS.forcePseudoState', { nodeId: otherNode.nodeId, forcedPseudoClasses: ['hover'] })
        const otherHover = await snapshot()
        assert.equal(otherHover.bg, idle.bg, 'hovering another row preserves active background')
        assert.notEqual(otherHover.otherBg, idle.bg, 'hover is weaker/different than active')
        assert.deepEqual(otherHover.selected, [pin])
        await call('CSS.forcePseudoState', { nodeId: otherNode.nodeId, forcedPseudoClasses: [] })
        await call('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] })
        const hover = await snapshot()
        assert.equal(hover.bg, idle.bg, 'selected hover retains active accent')
        assert.equal(hover.more, '1'); assert.equal(hover.pointer, 'auto')
        await call('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
        assert.deepEqual(await snapshot(), idle, 'leaving row restores only hover controls')
        // Strong, opaque accent distinguishes an open chat from the weak hover fill.
        assert.match(idle.bg, /^rgb\(/, 'active background must be an opaque accent, not a weak translucent hover tint')
        assert.equal(idle.color, 'rgb(255, 255, 255)', 'active foreground is readable on the accent')
        assert.equal(idle.preview, 'rgba(255, 255, 255, 0.88)', 'preview has a readable selected-state foreground')
        results.push({ theme, service, ...idle })
      }
      const shot = await call('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path.join(artifacts, theme + '.png'), Buffer.from(shot.data, 'base64'))
    }
    await evaluate(`removePin(state.activePinId)`)
    assert.equal(await evaluate(`document.querySelectorAll('.selected').length`), 0, 'active removal clears selection')
    writeFileSync(path.join(artifacts, 'computed-styles.json'), JSON.stringify(results, null, 2))
    t.diagnostic('Verified 8 service/theme combinations; screenshots + computed styles: ' + artifacts)
  } finally {
    if (call) { try { await call('Browser.close') } catch {} }
    ws?.close()
    await sleep(500)
    if (child.exitCode === null) child.kill()
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }
})
