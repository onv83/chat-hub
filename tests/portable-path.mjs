import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8')
function extractFrom(text, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{')
  const m = re.exec(text)
  assert.ok(m, name + ' missing')
  let depth = 0
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(m.index, i + 1)
  }
  throw Error(name + ' unterminated')
}
const extract = name => extractFrom(source, name)

test('portable distribution keeps its data beside ChatHub.exe', () => {
  const ctx = vm.createContext({ path: path.win32 })
  vm.runInContext(extract('portableUserDataPath'), ctx)
  assert.equal(
    ctx.portableUserDataPath('C:/Apps/ChatHub/resources', 'C:/Apps/ChatHub/ChatHub.exe', 'C:/Apps/ChatHub/resources/app', true),
    path.win32.normalize('C:/Apps/ChatHub/data')
  )
  assert.equal(
    ctx.portableUserDataPath('C:/Apps/ChatHub/resources', 'C:/Apps/ChatHub/ChatHub.exe', 'C:/Apps/ChatHub/resources/app', false),
    ''
  )
  assert.equal(
    ctx.portableUserDataPath('C:/Apps/ChatHub/resources', 'C:/Apps/ChatHub/ChatHub.exe', 'C:/Users/Lenovo/chat-hub', true),
    ''
  )
})

test('portable packager validates the branded x64 launcher before archiving', () => {
  const packager = fs.readFileSync(new URL('../scripts/package-portable.mjs', import.meta.url), 'utf8')
  assert.match(packager, /process\.platform !== 'win32' \|\| process\.arch !== 'x64'/)
  const launcherProbe = extractFrom(packager, 'installedLauncher')
  assert.match(launcherProbe, /for \(const name of \['electron\.exe'\]\)/)
  assert.doesNotMatch(launcherProbe, /ChatHub\.exe/)
  assert.match(packager, /const launcherPath = await ensureBrandedLauncher\(\{ resolveElectron: \(\) => ensureElectronRuntime\(\) \}\)/)
  assert.match(packager, /ensureBrandedLauncher/)
  assert.match(packager, /electronDist, 'version'/)
  assert.match(packager, /async function smokePortable/)
  assert.match(packager, /createServer/)
  assert.match(packager, /pathToFileURL/)
  assert.match(packager, /await rm\(appDir, \{ recursive: true, force: true \}\)/)
  assert.match(packager, /await rmWithRetry\(outDir\)/)
  assert.match(packager, /await rmWithRetry\(zipPath\)/)
  assert.match(packager, /rename\(/)
  assert.match(packager, /await rm\(path\.join\(outDir, 'electron\.exe'\), \{ force: true \}\)/)
  assert.match(packager, /await rm\(path\.join\(outDir, '\.chathub-launcher\.json'\), \{ force: true \}\)/)
  assert.match(packager, /portable\.json/)
  assert.doesNotMatch(packager, /service-health\.js/)
  assert.match(packager, /async function ensureElectronRuntime/)
  assert.match(packager, /node_modules', 'electron', 'install\.js'/)
  assert.match(packager, /process\.execPath/)
})

test('portable packager retries delayed Windows data cleanup after smoke exit', async () => {
  const packager = fs.readFileSync(new URL('../scripts/package-portable.mjs', import.meta.url), 'utf8')
  let calls = 0, waits = 0
  const ctx = vm.createContext({
    rm: async () => {
      calls++
      if (calls < 3) {
        const error = Error('busy')
        error.code = 'EBUSY'
        throw error
      }
    },
    sleep: async () => { waits++ }
  })
  vm.runInContext(extractFrom(packager, 'rmWithRetry'), ctx)
  await ctx.rmWithRetry('C:/fixture/data')
  assert.equal(calls, 3)
  assert.equal(waits, 2)
})

test('portable smoke does not inherit a development profile path', async () => {
  const packager = fs.readFileSync(new URL('../scripts/package-portable.mjs', import.meta.url), 'utf8')
  let spawned
  const ctx = vm.createContext({
    Date,
    outDir: 'C:/stage',
    freePort: async () => 9229,
    spawn(...args) { spawned = args; return { pid: 0 } },
    sleep: async () => {},
    fetch: async () => ({ json: async () => [{ type: 'page', url: 'file:///C:/stage/resources/app/index.html' }] }),
    stat: async () => ({}),
    rmWithRetry: async () => {},
    execFileSync() {},
    process: { env: { CHATHUB_DEV_DATA: 'C:/live-profile', chathub_dev_data: 'C:/case-variant-profile' } }
  })
  vm.runInContext(extractFrom(packager, 'smokePortable'), ctx)
  await ctx.smokePortable('C:/stage/ChatHub.exe', 'C:/stage/data', 'file:///C:/stage/resources/app/index.html')
  assert.ok(spawned[2].env, 'smoke spawn must use an explicit sanitized environment')
  assert.equal(Object.keys(spawned[2].env).some(key => key.toUpperCase() === 'CHATHUB_DEV_DATA'), false)
})
