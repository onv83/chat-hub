import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8')
function extract(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{')
  const m = re.exec(source)
  assert.ok(m, name + ' missing')
  let depth = 0
  for (let i = m.index + m[0].length - 1; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(m.index, i + 1)
  }
  throw Error(name + ' unterminated')
}

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
  assert.match(packager, /electronDist, 'ChatHub\.exe'/)
  assert.match(packager, /await stat\(launcherPath\)/)
  assert.match(packager, /async function smokePortable/)
  assert.match(packager, /createServer/)
  assert.match(packager, /pathToFileURL/)
  assert.match(packager, /await rm\(appDir, \{ recursive: true, force: true \}\)/)
  assert.match(packager, /rename\(/)
  assert.match(packager, /portable\.json/)
})
