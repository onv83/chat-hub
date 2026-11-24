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
    await evaluate(`document.head.innerHTML = '<style>' + ${JSON.stringify(css)} + '</style>'; document.body.innerHTML = '<div class="chat-list" id="chat-list" style="width:420px;height:180px !important;max-height:180px !important;overflow-y:scroll !important;display:block !important;scroll-behavior:auto !important;background:var(--panel)"></div>'`)
    const functions = ['cloneConfigForSave', 'queueConfigSave', 'saveConfig', 'showAnnotationDialog', 'closeAllRowMenus', 'makeChatRow', 'setRowPreview', 'setRowAvatar', 'setRowBadge', 'applyFavFilter', 'syncChatSelection', 'renderChatList', 'selectChat', 'sortFavoritesByActivity', 'removePin', 'applyFavouriteDensity', 'initSettingsTabs', 'buildSettings', 'renderSvcRows', 'renderCssRows', 'renderZoomRows', 'renderPinRows'].map(extract).join('\n') + '\n' + source.slice(source.indexOf('const escapeHtml ='), source.indexOf('let toastTimer ='))
    await evaluate(`
      var state = { activePinId: '', cfg: { selectedPinId: 'pin-mm', services: ['mm','tg','max','ydx'].map(id => ({ id, name: id.toUpperCase() })), pinned: ['mm','tg','max','ydx'].map(id => ({ id: 'pin-'+id, serviceId: id, title: 'Synthetic '+id.toUpperCase(), url: 'https://fixture.invalid/'+id })) }, svcIcons: {}, lastMsgPreview: {}, lastMsgAt: {}, liveAct: {}, rankAct: {}, pinViews: {}, lastUsed: {} };
      window.hub = { saveConfig: async () => {}, configPath: async () => '', getVersion: async () => '0.0.0' };
      function badgeColor() { return '#5865f2' }
      function trimPinViews() {}
      function enqueueLoad() {}
      function renderViewHead() {}
      async function queueSelectedUnread() { window.__readProbes = (window.__readProbes || 0) + 1 } // polling is tested separately in polling.mjs
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
    assert.equal(await evaluate(`document.querySelectorAll('.selected').length`), 0, 'saved startup selection stays empty')
    const annotation = await evaluate(`(async () => {
      const pin = state.cfg.pinned.find(p => p.id === 'pin-mm')
      pin.title = 'Филипп Асанов'
      pin.annotation = 'Инженер'
      window.__annotationSaves = 0
      window.hub.saveConfig = async () => { window.__annotationSaves++ }
      renderChatList()
      const before = document.querySelector('[data-pin="pin-mm"] .chat-row-title').textContent
      const beforeComment = document.querySelector('[data-pin="pin-mm"] .chat-row-comment').textContent
      const row = document.querySelector('[data-pin="pin-mm"]')
      const more = row.querySelector('.row-more')
      more.click()
      const menu = row.querySelector('.row-menu')
      const menuOpen = menu.classList.contains('open') && !menu.classList.contains('hidden')
      const actionLabel = menu.querySelector('[data-act="annotation"] span').textContent
      const comment = row.querySelector('[data-act="annotation"]')
      comment.click()
      await new Promise(resolve => setTimeout(resolve, 0))
      const dialog = document.querySelector('#annotation-dialog')
      const dialogOpen = !!dialog && !dialog.classList.contains('hidden')
      const input = dialog.querySelector('input')
      input.value = 'Руководитель'
      dialog.querySelector('[data-act="save-annotation"]').click()
      await new Promise(resolve => setTimeout(resolve, 0))
      state.favQuery = 'руководитель'
      applyFavFilter()
      const updated = document.querySelector('[data-pin="pin-mm"]')
      return {
        before,
        beforeComment,
        after: updated.querySelector('.chat-row-title').textContent,
        afterComment: updated.querySelector('.chat-row-comment').textContent,
        annotation: pin.annotation,
        saves: window.__annotationSaves,
        menuOpen,
        actionLabel,
        dialogOpen,
        menuClosed: !updated.querySelector('.row-menu').classList.contains('open') && updated.querySelector('.row-menu').classList.contains('hidden'),
        focusAfterSave: document.activeElement === updated.querySelector('.row-more'),
        filteredOut: updated.classList.contains('filtered-out'),
        activePinId: state.activePinId,
        pinViewCount: Object.keys(state.pinViews).length,
        readProbes: window.__readProbes || 0
      }
    })()`)
    assert.deepEqual(annotation, {
      before: 'Филипп Асанов',
      beforeComment: '(Инженер)',
      after: 'Филипп Асанов',
      afterComment: '(Руководитель)',
      annotation: 'Руководитель',
      saves: 1,
      menuOpen: true,
      actionLabel: 'Изменить комментарий',
      dialogOpen: true,
      menuClosed: true,
      focusAfterSave: true,
      filteredOut: false,
      activePinId: '',
      pinViewCount: 0,
      readProbes: 0
    })
    const dialogLifecycle = await evaluate(`(async () => {
      state.cfg = { services: [{ id: 'mm', name: 'MM' }], pinned: [{ id: 'pin-mm', serviceId: 'mm', title: 'Филипп Асанов', url: 'https://fixture.invalid/mm' }] }
      state.activePinId = ''
      state.pinViews = {}
      state.lastUsed = {}
      state.favQuery = ''
      window.hub.saveConfig = async () => {}
      renderChatList()
      const row = document.querySelector('[data-pin="pin-mm"]')
      const more = row.querySelector('.row-more')
      more.click()
      row.querySelector('[data-act="annotation"]').click()
      await new Promise(resolve => setTimeout(resolve, 0))
      const overlay = document.querySelector('#annotation-dialog')
      const dialog = overlay?.querySelector('[role="dialog"]')
      return { open: !!dialog, labelledby: dialog?.getAttribute('aria-labelledby') || '', describedby: dialog?.getAttribute('aria-describedby') || '' }
    })()`)
    assert.deepEqual(dialogLifecycle, { open: true, labelledby: 'annotation-dialog-title', describedby: 'annotation-dialog-hint' })
    const ax = await call('Accessibility.getFullAXTree')
    const dialogNode = ax.nodes.find(node => node.role?.value === 'dialog')
    const textboxNode = ax.nodes.find(node => node.role?.value === 'textbox')
    const rowActionNode = ax.nodes.find(node => node.role?.value === 'button' && node.name?.value === 'Действия с чатом')
    assert.equal(dialogNode?.name?.value, 'Комментарий к чату')
    assert.equal(dialogNode?.description?.value, 'Комментарий виден только в ChatHub и помогает искать чат.')
    assert.equal(textboxNode?.name?.value, 'Комментарий')
    assert.ok(rowActionNode, 'chat row action button has an explicit accessible name')
    const dialogDismissal = await evaluate(`(async () => {
      const dialog = document.querySelector('#annotation-dialog')
      dialog.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
      const more = document.querySelector('[data-pin="pin-mm"] .row-more')
      return { closed: !document.querySelector('#annotation-dialog'), focusRestored: document.activeElement === more }
    })()`)
    assert.deepEqual(dialogDismissal, { closed: true, focusRestored: true })
    const dialogOtherDismissals = await evaluate(`(async () => {
      const openDialog = async () => {
        const row = document.querySelector('[data-pin="pin-mm"]')
        const more = row.querySelector('.row-more')
        more.click()
        row.querySelector('[data-act="annotation"]').click()
        await new Promise(resolve => setTimeout(resolve, 0))
        return { overlay: document.querySelector('#annotation-dialog'), more }
      }
      let current = await openDialog()
      current.overlay.querySelector('button:not([data-act="save-annotation"])').click()
      await new Promise(resolve => setTimeout(resolve, 0))
      const cancel = { closed: !document.querySelector('#annotation-dialog'), focusRestored: document.activeElement === current.more }
      current = await openDialog()
      current.overlay.click()
      await new Promise(resolve => setTimeout(resolve, 0))
      const backdrop = { closed: !document.querySelector('#annotation-dialog'), focusRestored: document.activeElement === current.more }
      return { cancel, backdrop }
    })()`)
    assert.deepEqual(dialogOtherDismissals, { cancel: { closed: true, focusRestored: true }, backdrop: { closed: true, focusRestored: true } })
    const dialogRedrawDismissals = await evaluate(`(async () => {
      const dismissAfterRedraw = async mode => {
        const row = document.querySelector('[data-pin="pin-mm"]')
        row.querySelector('.row-more').click()
        row.querySelector('[data-act="annotation"]').click()
        await new Promise(resolve => setTimeout(resolve, 0))
        renderChatList()
        const currentMore = document.querySelector('[data-pin="pin-mm"] .row-more')
        const overlay = document.querySelector('#annotation-dialog')
        if (mode === 'escape') overlay.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        else if (mode === 'cancel') overlay.querySelector('button:not([data-act="save-annotation"])').click()
        else overlay.click()
        await new Promise(resolve => setTimeout(resolve, 10))
        return { closed: !document.querySelector('#annotation-dialog'), focusRestored: document.activeElement === currentMore }
      }
      return { escape: await dismissAfterRedraw('escape'), cancel: await dismissAfterRedraw('cancel'), backdrop: await dismissAfterRedraw('backdrop') }
    })()`)
    assert.deepEqual(dialogRedrawDismissals, { escape: { closed: true, focusRestored: true }, cancel: { closed: true, focusRestored: true }, backdrop: { closed: true, focusRestored: true } })
    const keyboardCancelSetup = await evaluate(`(async () => {
      const row = document.querySelector('[data-pin="pin-mm"]')
      const more = row.querySelector('.row-more')
      more.click()
      row.querySelector('[data-act="annotation"]').click()
      await new Promise(resolve => setTimeout(resolve, 0))
      const cancel = document.querySelector('#annotation-dialog button:not([data-act="save-annotation"])')
      cancel.focus()
      return { open: !!document.querySelector('#annotation-dialog'), focused: document.activeElement === cancel }
    })()`)
    assert.deepEqual(keyboardCancelSetup, { open: true, focused: true })
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    const keyboardCancelIntercept = await evaluate(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
      return { remainsOpen: !!document.querySelector('#annotation-dialog'), saves: window.__annotationSaves }
    })()`)
    assert.deepEqual(keyboardCancelIntercept, { remainsOpen: true, saves: 1 })
    const keyboardCancel = await evaluate(`(async () => {
      const cancel = document.querySelector('#annotation-dialog button:not([data-act="save-annotation"])')
      cancel.click()
      await new Promise(resolve => setTimeout(resolve, 10))
      const more = document.querySelector('[data-pin="pin-mm"] .row-more')
      return { closed: !document.querySelector('#annotation-dialog'), focusRestored: document.activeElement === more, saves: window.__annotationSaves }
    })()`)
    assert.deepEqual(keyboardCancel, { closed: true, focusRestored: true, saves: 1 })
    const settings = await evaluate(`(() => {
      const sec=document.createElement('section'); document.body.appendChild(sec); window.__settingsSec=sec;
      state.cfg={layout:'tabs',theme:'dark',services:[],pinned:[],columnCss:{},zoom:{},maxLiveViews:5,badgeVisible:true,svcBadgeVisible:true,svcNameVisible:true,favBadgeAlways:false,tabIcons:false,pinBackgroundActive:false,favAvatarSize:'large',favPreviewVisible:true,favPreviewLines:2};
      buildSettings(sec);
      return { tabs:[...sec.querySelectorAll('.settings-tab')].map(x=>x.dataset.settingsTab), visible:[...sec.querySelectorAll('.settings-pane:not(.hidden)')].map(x=>x.dataset.settingsPane) };
    })()`)
    assert.deepEqual(settings.tabs, ['view','theme','services','chat-style','zoom','memory','favorites','diagnostics'])
    assert.deepEqual(settings.visible, ['view'])
    const settingsAfterClick = await evaluate(`(() => { document.querySelector('.settings-tab[data-settings-tab="memory"]').click(); return { visible:[...document.querySelectorAll('.settings-pane:not(.hidden)')].map(x=>x.dataset.settingsPane), active:[...document.querySelectorAll('.settings-tab.active')].map(x=>x.dataset.settingsTab) } })()`)
    assert.deepEqual(settingsAfterClick.visible, ['memory'])
    assert.deepEqual(settingsAfterClick.active, ['memory'])
    await t.test('comment visibility redraws a hidden annotation immediately when enabled', async () => {
      const visibility = await evaluate(`(() => {
        const sec=window.__settingsSec;
        state.cfg={layout:'tabs',theme:'dark',services:[{id:'mm',name:'Mattermost'}],pinned:[{id:'comment-visibility-mm',serviceId:'mm',title:'Title stays put',url:'https://fixture.invalid/mm',annotation:'Searchable annotation'}],columnCss:{},zoom:{},maxLiveViews:5,badgeVisible:true,svcBadgeVisible:true,svcNameVisible:true,favBadgeAlways:false,tabIcons:false,pinBackgroundActive:false,favAvatarSize:'large',favPreviewVisible:true,favPreviewLines:2,favCommentVisible:false,favCommentStyle:'muted',favCommentPlacement:'right'};
        state.lastMsgPreview={}; state.lastMsgAt={}; state.unreadTotals={}; state.unreadDots={}; state.pinAvatars={}; state.favQuery='';
        applyFavouriteDensity(); renderChatList(); buildSettings(sec);
        const hiddenRow=document.querySelector('[data-pin="comment-visibility-mm"]');
        const titleBefore=hiddenRow.querySelector('.chat-row-title').textContent;
        const hiddenComment=hiddenRow.querySelector('.chat-row-comment');
        const hidden={comment:hiddenComment.textContent,displayNone:getComputedStyle(hiddenComment).display==='none'};
        const commentToggle=sec.querySelector('#fav-comment-visible');
        commentToggle.checked=true; commentToggle.dispatchEvent(new Event('change',{bubbles:true}));
        const shownRow=document.querySelector('[data-pin="comment-visibility-mm"]');
        state.favQuery='searchable annotation'; applyFavFilter();
        const searchFindsAnnotation=!shownRow.classList.contains('filtered-out');
        state.favQuery=''; applyFavFilter();
        const shownComment=shownRow.querySelector('.chat-row-comment');
        return {hidden,titleBefore,titleAfter:shownRow.querySelector('.chat-row-title').textContent,shown:{comment:shownComment.textContent,visible:getComputedStyle(shownComment).display!=='none'},searchFindsAnnotation};
      })()`)
      assert.deepEqual(visibility, { hidden:{comment:'',displayNone:true},titleBefore:'Title stays put',titleAfter:'Title stays put',shown:{comment:'(Searchable annotation)',visible:true},searchFindsAnnotation:true })
    })
    const density = await evaluate(`(async()=>{
      const sec=window.__settingsSec; sec.innerHTML='';
      const stale=document.createElement('section'); stale.innerHTML='<button id="save-settings"></button><button id="reset-pins"></button><input id="live-views"><b id="live-views-label"></b><input id="pin-bg-active"><button id="run-selfcheck"></button><button id="copy-selfcheck"></button><pre id="selfcheck-report"></pre><div id="svc-rows"></div><div id="css-rows"></div><div id="zoom-rows"></div><div id="pin-rows"></div>'; document.body.prepend(stale);
      state.cfg={layout:'tabs',theme:'dark',services:[{id:'mm',name:'Mattermost'}],pinned:[{id:'density-mm',serviceId:'mm',title:'Density',url:'https://fixture.invalid/mm',annotation:'Initial comment'}],columnCss:{},zoom:{},maxLiveViews:5,badgeVisible:true,svcBadgeVisible:true,svcNameVisible:true,favBadgeAlways:false,tabIcons:false,pinBackgroundActive:false,favAvatarSize:'large',favPreviewVisible:true,favPreviewLines:2,favCommentVisible:true,favCommentStyle:'muted',favCommentPlacement:'right'};
      state.lastMsgPreview={'density-mm':'Author: preview'}; state.lastMsgAt={}; state.unreadTotals={}; state.unreadDots={}; state.pinAvatars={};
      renderChatList(); buildSettings(sec);
      const mutedRow=document.querySelector('[data-pin="density-mm"]');
      const muted={title:mutedRow.querySelector('.chat-row-title').textContent,comment:mutedRow.querySelector('.chat-row-comment').textContent};
      const avatars=[...sec.querySelectorAll('input[name="fav-avatar-size"]')].map(x=>x.value);
      const lines=[...sec.querySelectorAll('input[name="fav-preview-lines"]')].map(x=>x.value);
      const commentStyles=[...sec.querySelectorAll('input[name="fav-comment-style"]')].map(x=>x.value);
      const commentPlacements=[...sec.querySelectorAll('input[name="fav-comment-placement"]')].map(x=>x.value);
      const viewPane=sec.querySelector('[data-settings-pane="view"]');
      const favoritesPane=sec.querySelector('[data-settings-pane="favorites"]');
      const organization={layout:!!viewPane.querySelector('[data-setting-group="layout"]'),unread:!!viewPane.querySelector('[data-setting-group="unread-badges"]'),favoriteAppearance:!!viewPane.querySelector('[data-setting-group="favorite-appearance"]'),viewHasFavoriteControls:!!viewPane.querySelector('#fav-preview-visible, #fav-comment-visible'),favoritesHasAllControls:['svcbadge-visible','svcname-visible','fav-preview-visible','fav-comment-visible'].every(id=>!!favoritesPane.querySelector('#'+id))};
      const small=sec.querySelector('input[name="fav-avatar-size"][value="small"]'); small.checked=true; small.dispatchEvent(new Event('change',{bubbles:true}));
      const one=sec.querySelector('input[name="fav-preview-lines"][value="1"]'); one.checked=true; one.dispatchEvent(new Event('change',{bubbles:true}));
      const titleStyle=sec.querySelector('input[name="fav-comment-style"][value="title"]'); titleStyle.checked=true; titleStyle.dispatchEvent(new Event('change',{bubbles:true}));
      const inlinePlacement=sec.querySelector('input[name="fav-comment-placement"][value="inline"]'); inlinePlacement.checked=true; inlinePlacement.dispatchEvent(new Event('change',{bubbles:true}));
      const commentInput=sec.querySelector('#pin-rows .f-comment'); commentInput.value='System '; commentInput.dispatchEvent(new Event('input',{bubbles:true}));
      const draft={value:commentInput.value,stored:state.cfg.pinned[0].annotation};
      commentInput.value='System comment   '; commentInput.dispatchEvent(new Event('input',{bubbles:true})); commentInput.dispatchEvent(new Event('blur',{bubbles:true})); await new Promise(resolve=>setTimeout(resolve,0));
      renderChatList();
      const inlineRow=document.querySelector('[data-pin="density-mm"]');
      const measure=row=>{const line=row.querySelector('.row-line1').getBoundingClientRect(),t=row.querySelector('.chat-row-title').getBoundingClientRect(),c=row.querySelector('.chat-row-comment').getBoundingClientRect(),ts=getComputedStyle(row.querySelector('.chat-row-title')),cs=getComputedStyle(row.querySelector('.chat-row-comment'));return {title:row.querySelector('.chat-row-title').textContent,comment:row.querySelector('.chat-row-comment').textContent,sameFont:ts.fontSize===cs.fontSize,sameColor:ts.color===cs.color,adjacent:c.left>=t.right&&c.left-t.right<=8,rightAligned:line.right-c.right<=8}};
      const inline=measure(inlineRow);
      const mutedStyle=sec.querySelector('input[name="fav-comment-style"][value="muted"]'); mutedStyle.checked=true; mutedStyle.dispatchEvent(new Event('change',{bubbles:true}));
      renderChatList();
      const inlineMuted=measure(document.querySelector('[data-pin="density-mm"]'));
      titleStyle.checked=true; titleStyle.dispatchEvent(new Event('change',{bubbles:true}));
      const rightPlacement=sec.querySelector('input[name="fav-comment-placement"][value="right"]'); rightPlacement.checked=true; rightPlacement.dispatchEvent(new Event('change',{bubbles:true}));
      renderChatList();
      let row=document.querySelector('[data-pin="density-mm"]');
      const right=measure(row);
      const preview=sec.querySelector('#fav-preview-visible'); preview.checked=false; preview.dispatchEvent(new Event('change',{bubbles:true}));
      const commentToggle=sec.querySelector('#fav-comment-visible'); commentToggle.checked=false; commentToggle.dispatchEvent(new Event('change',{bubbles:true}));
      renderChatList(); row=document.querySelector('[data-pin="density-mm"]'); state.favQuery='system comment'; applyFavFilter(); const hiddenCommentSearchable=!row.classList.contains('filtered-out'); state.favQuery=''; applyFavFilter();
      const scopedHandlers={save:typeof sec.querySelector('#save-settings').onclick==='function',reset:typeof sec.querySelector('#reset-pins').onclick==='function',liveViews:typeof sec.querySelector('#live-views').oninput==='function',pinBackground:typeof sec.querySelector('#pin-bg-active').onchange==='function',diagnostic:typeof sec.querySelector('#run-selfcheck').onclick==='function'};
      const cfg={avatar:state.cfg.favAvatarSize,preview:state.cfg.favPreviewVisible,lines:state.cfg.favPreviewLines,commentVisible:state.cfg.favCommentVisible,commentStyle:state.cfg.favCommentStyle,commentPlacement:state.cfg.favCommentPlacement,comment:state.cfg.pinned[0].annotation};
      const serviceHosts={serviceRows:sec.querySelectorAll('#svc-rows .form-row').length,cssRows:sec.querySelectorAll('#css-rows .css-row').length,zoomRows:sec.querySelectorAll('#zoom-rows .form-row').length};
      sec.querySelector('#pin-rows .del').click();
      const deleteRerender=/Пока ничего в избранном/.test(sec.querySelector('#pin-rows').textContent);
      state.cfg.pinned=[{id:'reset-pin',serviceId:'mm',title:'Reset',url:'https://fixture.invalid/reset'}]; renderPinRows(sec.querySelector('#pin-rows'));
      window.confirm=()=>true; sec.querySelector('#reset-pins').click(); await new Promise(resolve=>setTimeout(resolve,0));
      const resetRerender=/Пока ничего в избранном/.test(sec.querySelector('#pin-rows').textContent);
      return {avatars,lines,commentStyles,commentPlacements,organization,serviceHosts,scopedHandlers,deleteRerender,resetRerender,previewLinesDisabled:[...sec.querySelectorAll('input[name="fav-preview-lines"]')].every(x=>x.disabled),commentStylesDisabled:[...sec.querySelectorAll('input[name="fav-comment-style"]')].every(x=>x.disabled),previewControl:!!preview,commentControl:!!commentToggle,commentInput:!!commentInput,draft,muted,inline,inlineMuted,right,hiddenCommentSearchable,cfg,classes:{small:document.body.classList.contains('fav-avatar-small'),hidePreview:document.body.classList.contains('hide-chat-preview'),oneLine:document.body.classList.contains('fav-preview-one-line'),hideComment:document.body.classList.contains('hide-chat-comment'),titleComment:document.body.classList.contains('fav-comment-title'),inlineComment:document.body.classList.contains('fav-comment-inline'),rightComment:document.body.classList.contains('fav-comment-right')},avatarWidth:getComputedStyle(row.querySelector('.row-avatar')).width,previewDisplay:getComputedStyle(row.querySelector('.chat-row-preview')).display,titleText:row.querySelector('.chat-row-title').textContent,commentText:row.querySelector('.chat-row-comment').textContent,commentDisplay:getComputedStyle(row.querySelector('.chat-row-comment')).display};
    })()`)
    assert.deepEqual(density.avatars, ['large','medium','small'])
    assert.deepEqual(density.lines, ['1','2'])
    assert.deepEqual(density.commentStyles, ['muted','title'])
    assert.deepEqual(density.commentPlacements, ['inline','right'])
    assert.deepEqual(density.organization, { layout:true, unread:true, favoriteAppearance:true, viewHasFavoriteControls:true, favoritesHasAllControls:false })
    assert.deepEqual(density.scopedHandlers, { save:true, reset:true, liveViews:true, pinBackground:true, diagnostic:true })
    assert.deepEqual(density.serviceHosts, { serviceRows:1, cssRows:1, zoomRows:1 })
    assert.equal(density.deleteRerender, true)
    assert.equal(density.resetRerender, true)
    assert.equal(density.previewLinesDisabled, true)
    assert.equal(density.commentStylesDisabled, true)
    assert.equal(density.previewControl, true)
    assert.equal(density.commentControl, true)
    assert.equal(density.commentInput, true)
    assert.deepEqual(density.draft, { value:'System ', stored:'System ' })
    assert.deepEqual(density.muted, { title:'Density', comment:'(Initial comment)' })
    assert.deepEqual(density.inline, { title:'Density', comment:'(System comment)', sameFont:true, sameColor:true, adjacent:true, rightAligned:false })
    assert.deepEqual(density.inlineMuted, { title:'Density', comment:'(System comment)', sameFont:false, sameColor:false, adjacent:true, rightAligned:false })
    assert.deepEqual(density.right, { title:'Density', comment:'(System comment)', sameFont:true, sameColor:true, adjacent:true, rightAligned:true })
    assert.equal(density.hiddenCommentSearchable, true)
    assert.deepEqual(density.cfg, { avatar:'small', preview:false, lines:1, commentVisible:false, commentStyle:'title', commentPlacement:'right', comment:'System comment' })
    assert.deepEqual(density.classes, { small:true, hidePreview:true, oneLine:true, hideComment:true, titleComment:true, inlineComment:false, rightComment:true })
    assert.equal(density.avatarWidth, '32px')
    assert.equal(density.previewDisplay, 'none')
    assert.equal(density.titleText, 'Density')
    assert.equal(density.commentText, '')
    assert.equal(density.commentDisplay, 'none')
    await t.test('MCP project column: real input persists mcpProject without touching the active chat or the table geometry', async () => {
      const before = await evaluate(`(() => {
        const sec = window.__settingsSec; sec.innerHTML = '';
        document.querySelectorAll('#pin-rows').forEach(node => node.remove());
        state.cfg = { layout:'tabs', theme:'dark', services:[{id:'mm',name:'Mattermost'}],
          pinned:[{id:'project-mm',serviceId:'mm',title:'Проект',url:'https://fixture.invalid/mm',annotation:'Комментарий'}],
          columnCss:{}, zoom:{}, maxLiveViews:5, badgeVisible:true, svcBadgeVisible:true, svcNameVisible:true,
          favBadgeAlways:false, tabIcons:false, pinBackgroundActive:false, favAvatarSize:'large',
          favPreviewVisible:true, favPreviewLines:2, favCommentVisible:true, favCommentStyle:'muted', favCommentPlacement:'right' };
        state.lastMsgPreview={}; state.lastMsgAt={}; state.unreadTotals={}; state.unreadDots={}; state.pinAvatars={}; state.favQuery='';
        state.activePinId=''; state.pinViews={};
        window.__projectSaves = [];
        window.hub.saveConfig = async cfg => { window.__projectSaves.push(JSON.parse(JSON.stringify(cfg))) };
        renderChatList(); buildSettings(sec);
        sec.querySelector('.settings-tab[data-settings-tab="favorites"]').click();
        const host = sec.querySelector('#pin-rows');
        const input = host.querySelector('.f-mcp-project');
        const head = host.querySelector('.pin-row-head').textContent;
        const row = document.querySelector('[data-pin="project-mm"]');
        const readProbes = window.__readProbes || 0;
        input.focus();
        return { focused: document.activeElement === input, head,
          ariaLabel: input.getAttribute('aria-label'), maxLength: input.maxLength,
          placeholder: input.getAttribute('placeholder'), projectValue: input.value,
          tabs: getComputedStyle(host.querySelector('.pin-row')).gridTemplateColumns.split(' ').length,
          projectNode: !!row.querySelector('.chat-row-project'),
          search: row.dataset.search,
          activePinId: state.activePinId, pinViewCount: Object.keys(state.pinViews).length, readProbes };
      })()`)
      assert.equal(before.focused, true, 'the project input accepts focus')
      assert.match(before.head, /Комментарий 2 \(проект для MCP\)/, 'the settings table labels the project column')
      assert.equal(before.ariaLabel, 'Комментарий 2 (проект для MCP)')
      assert.equal(before.maxLength, 80)
      assert.ok(before.placeholder && before.placeholder.length > 0, 'a project placeholder exists')
      assert.equal(before.projectValue, '', 'a config without the field opens empty')
      assert.equal(before.tabs, 6, 'the favourites table has six columns after the project column')
      assert.equal(before.projectNode, false, 'the chat list creates no project node')
      assert.equal(before.search, 'проект комментарий mattermost', 'the search string is unchanged by the project')

      await call('Input.insertText', { text: 'Портал-Юг  для   MCP' })
      const typed = await evaluate(`(() => ({ value: document.querySelector('#pin-rows .f-mcp-project').value }))()`)
      assert.equal(typed.value, 'Портал-Юг  для   MCP', 'real typing reaches the project input')

      const after = await evaluate(`(async () => {
        const sec = window.__settingsSec;
        const input = sec.querySelector('#pin-rows .f-mcp-project');
        input.blur();
        await new Promise(resolve => setTimeout(resolve, 20));
        const row = document.querySelector('[data-pin="project-mm"]');
        const host = sec.querySelector('#pin-rows');
        const pin = state.cfg.pinned[0];
        const rowEl = host.querySelector('.pin-row:not(.pin-row-head)');
        const fields = [...rowEl.children].filter(node => node.tagName === 'INPUT').map(node => node.getBoundingClientRect());
        const hostRect = host.getBoundingClientRect();
        const rowRect = rowEl.getBoundingClientRect();
        const overlapping = fields.some((a, i) => fields.some((b, j) => i < j && a.right > b.left + 0.5 && b.right > a.left + 0.5));
        return { stored: pin.mcpProject, value: input.value,
          payloads: (window.__projectSaves || []).map(cfg => cfg.pinned[0]),
          rowText: row.textContent, projectNode: !!row.querySelector('.chat-row-project'),
          overlap: overlapping,
          overflow: rowRect.right - hostRect.right > 1,
          horizontalScroll: host.scrollWidth - host.clientWidth,
          widths: fields.map(rect => Math.round(rect.width)),
          activePinId: state.activePinId, pinViewCount: Object.keys(state.pinViews).length,
          readProbes: window.__readProbes || 0, selected: document.querySelectorAll('.selected').length };
      })()`)
      assert.equal(after.stored, 'Портал-Юг для MCP', 'blur trims and collapses spaces')
      assert.equal(after.value, 'Портал-Юг для MCP')
      assert.equal(after.payloads.length, 1, 'exactly one facade save carried the project')
      assert.equal(after.payloads[0].mcpProject, 'Портал-Юг для MCP', 'the saved payload contains mcpProject')
      assert.equal(after.payloads[0].annotation, 'Комментарий', 'the first comment is untouched by the project save')
      assert.equal(after.rowText.includes('Портал-Юг'), false, 'the project never appears in the chat list')
      assert.equal(after.projectNode, false)
      assert.equal(after.overflow, false, 'the six-column table fits the standard settings width')
      assert.equal(after.horizontalScroll <= 0, true, 'the favourites table has no horizontal overflow')
      assert.equal(after.overlap, false, 'the table columns do not overlap')
      assert.equal(after.widths.length, 4)
      assert.ok(after.widths.every(width => width >= 60), 'every editable column keeps a usable width: ' + after.widths)
      assert.equal(after.activePinId, before.activePinId, 'saving the project does not open a chat')
      assert.equal(after.pinViewCount, before.pinViewCount, 'saving the project creates no guest view')
      assert.equal(after.readProbes, before.readProbes, 'saving the project starts no read verification')
      assert.equal(after.selected, 0)
      await evaluate(`window.hub.saveConfig = async () => {}`)
    })
    const scrollState = await evaluate(`state.favQuery=''; state.cfg.pinned = Array.from({length:100},(_,i)=>({id:'scroll-'+i,serviceId:'mm',title:'Scroll '+i,url:'https://fixture.invalid/'+i})); renderChatList(); const list=document.getElementById('chat-list'); list.scrollTop=240; const before=list.scrollTop; const beforeHeight=list.scrollHeight; renderChatList(); ({before,after:list.scrollTop,beforeHeight,afterHeight:list.scrollHeight,clientHeight:list.clientHeight})`)
    assert.equal(scrollState.before, 240, JSON.stringify(scrollState))
    assert.equal(scrollState.after, 240, 'background redraw preserves the user scroll position')
    await evaluate(`state.cfg={selectedPinId:'pin-mm',services:['mm','tg','max','ydx'].map(id=>({id,name:id.toUpperCase()})),pinned:['mm','tg','max','ydx'].map(id=>({id:'pin-'+id,serviceId:id,title:'Synthetic '+id.toUpperCase(),url:'https://fixture.invalid/'+id}))}; state.activePinId=''; renderChatList();`)
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
