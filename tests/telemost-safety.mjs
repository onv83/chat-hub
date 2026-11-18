import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
function windowFixture(initialUrl = '') {
  const app = new EventEmitter(); const wc = new EventEmitter(); let destroyed = 0, currentUrl = initialUrl;
  const queued = [];
  wc.getURL = () => currentUrl;
  const win = { webContents: wc, destroy() { destroyed++; } };
  const code = main.slice(main.indexOf("app.on('browser-window-created'"), main.indexOf('if (!app.requestSingleInstanceLock())'));
  vm.runInNewContext(code, {
    app, URL, logOpen() {}, AUTH_HOSTS:['passport.yandex.ru'],
    isAuthUrl: raw => { try { return new URL(raw).hostname === 'passport.yandex.ru' } catch { return false } },
    isConfiguredServiceUrl: raw => { try { return new URL(raw).origin === 'https://telemost.yandex.ru' } catch { return false } },
    setImmediate: fn => queued.push(fn)
  });
  app.emit('browser-window-created', {}, win);
  return {
    wc,
    destroyed:()=>destroyed,
    setURL(url) { currentUrl = url },
    flush() { while (queued.length) queued.shift()() }
  };
}
test('Telemost subframes must never destroy a native window', () => {
  const f = windowFixture();
  f.wc.emit('did-start-navigation', {}, 'https://telemost.yandex.ru/', false, false);
  assert.equal(f.destroyed(), 0);
});
test('OAuth main-frame redirect back to Telemost survives', () => {
  const f = windowFixture();
  f.wc.emit('did-start-navigation', {}, 'https://passport.yandex.ru/auth', false, true);
  f.wc.emit('did-start-navigation', {}, 'https://telemost.yandex.ru/callback?code=secret', false, true);
  assert.equal(f.destroyed(), 0);
});
test('server redirect auth provenance survives callback and subframes cannot grant it', () => {
  const f = windowFixture();
  f.wc.emit('did-redirect-navigation', {}, 'https://passport.yandex.ru/auth', false, true);
  f.wc.emit('did-start-navigation', {}, 'https://telemost.yandex.ru/callback', false, true);
  assert.equal(f.destroyed(), 0);
  const other = windowFixture();
  other.wc.emit('did-start-navigation', {}, 'https://passport.yandex.ru/auth', false, false);
  other.wc.emit('did-start-navigation', {}, 'https://telemost.yandex.ru/', false, true);
  assert.equal(other.destroyed(), 1);
});
test('unapproved direct Telemost top-level window is blocked', () => {
  const f = windowFixture();
  f.wc.emit('did-start-navigation', {}, 'https://telemost.yandex.ru/', false, true);
  assert.equal(f.destroyed(), 1);
});
test('late direct Telemost target is blocked after a native window starts blank', () => {
  const f = windowFixture();
  f.setURL('https://telemost.yandex.ru/chats/0%2F0%2F00000000-0000-4000-8000-000000000123');
  f.flush();
  assert.equal(f.destroyed(), 1);
});
test('will-navigate blocks a direct Telemost window before it renders', () => {
  const f = windowFixture(); let prevented = false;
  f.wc.emit('will-navigate', { preventDefault() { prevented = true } }, 'https://telemost.yandex.ru/', false, true);
  assert.equal(prevented, true);
  assert.equal(f.destroyed(), 1);
});
test('OAuth popup blocks a foreign redirect but keeps the configured callback', () => {
  const f = windowFixture();
  f.wc.emit('will-navigate', { preventDefault() {} }, 'https://passport.yandex.ru/auth', false, true)
  let blocked = false
  f.wc.emit('will-redirect', { preventDefault() { blocked = true } }, 'https://foreign.example.test/sso', false, true)
  assert.equal(blocked, true)
  blocked = false
  f.wc.emit('will-redirect', { preventDefault() { blocked = true } }, 'https://telemost.yandex.ru/callback', false, true)
  assert.equal(blocked, false)
});

test('window-open log records only origins, never URL query or fragment', () => {
  let line = '';
  const start = main.indexOf('const OPEN_LOG');
  const end = main.indexOf("app.on('web-contents-created'", start);
  const ctx = vm.createContext({
    app: { getPath: () => 'C:/fixture' }, path: { join: () => 'C:/fixture/window-open.log' },
    fs: { appendFileSync(_path, value) { line = value } }, URL, Date
  });
  vm.runInContext(main.slice(start, end), ctx);
  vm.runInContext(`logOpen('browser', 'https://outside.example/path?token=private#fragment', 'https://web.max.ru/chat?code=private')`, ctx)
  assert.match(line, /https:\/\/outside\.example/);
  assert.match(line, /https:\/\/web\.max\.ru/);
  assert.doesNotMatch(line, /token=|code=|fragment|private/);
});

function routingFixture(from = 'https://im.astralinux.ru/astralinux/channels/example') {
  const app = new EventEmitter(); app.getPath = () => '';
  let handler, loaded = [], external = [];
  const contents = new EventEmitter();
  Object.assign(contents, { getURL: () => from, setWindowOpenHandler(fn) { handler = fn }, loadURL(url) { loaded.push(url) } });
  const code = main.slice(main.indexOf('const SERVICE_HOSTS'), main.indexOf('// Запасной барьер'));
  vm.runInNewContext(code, { app, URL, path: { join: () => '' }, fs: { appendFileSync() {} },
    config: { services: [{ id: 'mm', url: 'https://im.astralinux.ru' }] },
    shell: { openExternal(url) { external.push(url) } }, setImmediate: fn => fn() });
  app.emit('web-contents-created', {}, contents);
  return { handler, loaded, external };
}
test('chat links use the external browser while only messenger hosts stay in their webview', () => {
  const f = routingFixture();
  assert.equal(f.handler({ url: 'https://jira.astralinux.ru/browse/PROJECT-1' }).action, 'deny');
  assert.equal(f.handler({ url: 'https://life.astralinux.ru/pages/viewpage.action?pageId=1' }).action, 'deny');
  assert.deepEqual(f.external, ['https://jira.astralinux.ru/browse/PROJECT-1', 'https://life.astralinux.ru/pages/viewpage.action?pageId=1']);
  assert.equal(f.handler({ url: 'https://im.astralinux.ru/astralinux/channels/other' }).action, 'deny');
  assert.deepEqual(f.loaded, ['https://im.astralinux.ru/astralinux/channels/other']);
});

function webviewHardeningFixture() {
  const app = new EventEmitter(); app.getPath = () => '';
  const host = new EventEmitter();
  host.getType = () => 'window';
  host.getURL = () => 'file:///app/index.html';
  host.setWindowOpenHandler = () => {}
  const external = [];
  const shellContents = new WeakSet(); shellContents.add(host)
  const code = main.slice(main.indexOf('const SERVICE_HOSTS'), main.indexOf('// Запасной барьер'));
  const context = {
    app, URL, path: { join: () => '' }, fs: { appendFileSync() {} },
    config: { services: [{ id: 'mm', url: 'https://im.astralinux.ru', partition: 'persist:mm' }] },
    shellContents,
    isShellDocumentUrl: raw => raw === 'file:///app/index.html',
    isConfiguredGuestAttachment: params => {
      const src = String(params?.src || 'about:blank')
      return params?.partition === 'persist:mm' && (src === 'about:blank' || /^https:\/\/im\.astralinux\.ru(?:\/|$)/.test(src))
    },
    shell: { openExternal(url) { external.push(url) } }, dialog: { showMessageBox: async () => ({ response: 1 }) }, setImmediate: fn => fn()
  };
  vm.runInNewContext(code, context);
  app.emit('web-contents-created', {}, host);
  return { host, external, context };
}
test('guest webviews reject unsafe URLs and receive locked-down preferences', () => {
  const f = webviewHardeningFixture();
  const prefs = { nodeIntegration: true, nodeIntegrationInWorker: true, contextIsolation: false, sandbox: false, webSecurity: false, allowRunningInsecureContent: true, preload: 'C:/evil.js' };
  let blocked = false;
  f.host.emit('will-attach-webview', { preventDefault() { blocked = true } }, prefs, { src: 'https://im.astralinux.ru/astralinux/channels/example', partition: 'persist:mm' });
  assert.equal(blocked, false);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInWorker, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.allowRunningInsecureContent, false);
  assert.equal(prefs.preload, undefined);
  for (const unsafe of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'http://im.astralinux.ru/']) {
    let denied = false;
    f.host.emit('will-attach-webview', { preventDefault() { denied = true } }, {}, { src: unsafe, partition: 'persist:mm' });
    assert.equal(denied, true, unsafe);
  }
});
test('unknown auth redirects are blocked until a bounded explicit grant', () => {
  const f = webviewHardeningFixture();
  f.host.getType = () => 'webview'
  f.host.getURL = () => 'https://im.astralinux.ru/astralinux';
  let blocked = false;
  f.host.emit('will-redirect', { preventDefault() { blocked = true } }, 'https://login.example.test/auth', false, true);
  assert.equal(blocked, true);
  assert.equal(f.context.isTemporaryAuthUrl(f.host, 'https://login.example.test/auth'), false);
  assert.equal(f.context.grantRedirectedAuthOrigin(f.host, 'https://login.example.test/auth'), true);
  assert.equal(f.context.isTemporaryAuthUrl(f.host, 'https://login.example.test/auth'), true);
  f.host.getURL = () => 'https://login.example.test/auth';
  assert.equal(f.context.grantRedirectedAuthOrigin(f.host, 'https://second-login.example.test/auth'), false);
  let denied = false;
  const stranger = webviewHardeningFixture();
  stranger.host.getType = () => 'webview'
  stranger.host.getURL = () => 'https://outside.example.test/';
  assert.equal(stranger.context.grantRedirectedAuthOrigin(stranger.host, 'https://login.example.test/auth'), false);
  stranger.host.emit('will-redirect', { preventDefault() { denied = true } }, 'https://login.example.test/auth', false, true);
  assert.equal(denied, true);
});
test('initial configured-service redirect can receive an explicit grant before first commit', () => {
  const f = webviewHardeningFixture();
  f.host.getType = () => 'webview'
  f.host.getURL = () => 'about:blank'
  f.host.emit('did-start-navigation', {}, 'https://im.astralinux.ru/astralinux', false, true)
  let blocked = false
  f.host.emit('will-redirect', { preventDefault() { blocked = true } }, 'https://login.example.test/auth', false, true)
  assert.equal(blocked, true)
  assert.equal(f.context.grantRedirectedAuthOrigin(f.host, 'https://login.example.test/auth'), true)
  assert.equal(f.context.isTemporaryAuthUrl(f.host, 'https://login.example.test/auth'), true)
});
