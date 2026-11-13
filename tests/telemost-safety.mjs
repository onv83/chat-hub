import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
function windowFixture() {
  const app = new EventEmitter(); const wc = new EventEmitter(); let destroyed = 0;
  wc.getURL = () => '';
  const win = { webContents: wc, destroy() { destroyed++; } };
  const code = main.slice(main.indexOf("app.on('browser-window-created'"), main.indexOf('if (!app.requestSingleInstanceLock())'));
  vm.runInNewContext(code, { app, URL, logOpen() {}, AUTH_HOSTS:['passport.yandex.ru'], setImmediate });
  app.emit('browser-window-created', {}, win);
  return { wc, destroyed:()=>destroyed };
}
test('health diagnosis never treats login/loading/chat/error as an empty root', async () => {
  const file = new URL('../service-health.js', import.meta.url);
  assert.ok(fs.existsSync(file), 'bounded service-health module is missing');
  const { classify } = (await import(file)).default;
  const blank = { root:true, ready:'complete', bodyChildren:0, scripts:0, login:false };
  assert.equal(classify(blank), 'empty-root');
  assert.equal(classify({...blank, root:false}), 'other-page');
  assert.equal(classify({...blank, blank:true}), 'about-blank');
  assert.equal(classify({...blank, loading:true}), 'loading');
  assert.equal(classify({...blank, login:true}), 'login');
  assert.equal(classify({...blank, error:-105}), 'load-error');
  assert.equal(classify({...blank, bodyChildren:4}), 'content');
  assert.equal(classify({...blank, scripts:12}), 'indeterminate');
});
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

function routingFixture(from = 'https://im.astralinux.ru/astralinux/channels/example') {
  const app = new EventEmitter(); app.getPath = () => '';
  let handler, loaded = [], external = [];
  const contents = { getURL: () => from, setWindowOpenHandler(fn) { handler = fn }, loadURL(url) { loaded.push(url) } };
  const code = main.slice(main.indexOf('const SERVICE_HOSTS'), main.indexOf('// Запасной барьер'));
  vm.runInNewContext(code, { app, URL, path: { join: () => '' }, fs: { appendFileSync() {} },
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
