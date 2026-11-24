import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fssync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ensureBrandedLauncher } from '../scripts/ensure-branded-launcher.mjs'
import { launchArguments, startBranded } from '../scripts/start-branded.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'hermes', 'cache', 'scratch')

const sha256 = value => createHash('sha256').update(value).digest('hex')

test('branded source launcher mirrors Electron bytes and npm start uses it', async t => {
  await fs.mkdir(scratch, { recursive: true })
  const dir = await fs.mkdtemp(path.join(scratch, 'chathub-brand-launcher-'))
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const dist = path.join(dir, 'dist')
  await fs.mkdir(dist)
  const original = Buffer.from('fixture-electron-runtime-bytes')
  const icon = path.join(dir, 'icon.ico')
  await fs.writeFile(path.join(dist, 'electron.exe'), original)
  await fs.writeFile(icon, Buffer.from('fixture-icon'))

  let brandingCall
  const launcher = await ensureBrandedLauncher({
    platform: 'win32',
    resolveElectron: () => path.join(dist, 'electron.exe'),
    iconPath: icon,
    editResources: async (target, options) => { brandingCall = { target, options } }
  })
  assert.equal(launcher, path.join(dist, 'ChatHub.exe'))
  assert.equal(sha256(await fs.readFile(launcher)), sha256(original))
  assert.match(path.basename(brandingCall.target), /^ChatHub\.exe\.\d+\.\d+\.tmp$/)
  assert.equal(brandingCall.options.icon, icon)
  assert.equal(brandingCall.options['version-string'].FileDescription, 'ChatHub')
  assert.equal(await ensureBrandedLauncher({ platform: 'win32', resolveElectron: () => path.join(dist, 'electron.exe'), iconPath: icon, editResources: async () => {} }), launcher, 'existing matching launcher is reusable')

  const native = await ensureBrandedLauncher({ platform: 'linux', resolveElectron: () => '/fixture/electron' })
  assert.equal(native, '/fixture/electron', 'non-Windows uses the native Electron launcher unchanged')

  const bootDist = path.join(dir, 'boot-dist')
  await fs.mkdir(bootDist)
  let resolverCalls = 0
  const bootLauncher = await ensureBrandedLauncher({
    platform: 'win32',
    resolveElectron: async () => {
      resolverCalls++
      const source = path.join(bootDist, 'electron.exe')
      await fs.writeFile(source, Buffer.from('lazy-installed-runtime'))
      return source
    },
    iconPath: icon,
    editResources: async () => {}
  })
  assert.equal(resolverCalls, 1)
  assert.equal(sha256(await fs.readFile(bootLauncher)), sha256(Buffer.from('lazy-installed-runtime')))

  const pkg = JSON.parse(fssync.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.start, 'node scripts/start-branded.mjs')
  assert.equal(pkg.scripts.postinstall, 'node scripts/ensure-branded-launcher.mjs')
  const starter = fssync.readFileSync(path.join(root, 'scripts', 'start-branded.mjs'), 'utf8')
  assert.match(starter, /ensureBrandedLauncher/)
  assert.deepEqual(launchArguments(['--disable-gpu']), ['.', '--disable-gpu'])
  let launched
  const child = { on() {} }
  await startBranded({
    args: ['--disable-gpu'],
    resolveLauncher: async () => 'C:/fixture/ChatHub.exe',
    spawnImpl(executable, args, options) { launched = { executable, args, options }; return child }
  })
  assert.deepEqual(launched, {
    executable: 'C:/fixture/ChatHub.exe',
    args: ['.', '--disable-gpu'],
    options: { cwd: root, stdio: 'inherit', windowsHide: false }
  })
})

test('branded launcher verifies cached resources and never replaces a good launcher before editing succeeds', async t => {
  await fs.mkdir(scratch, { recursive: true })
  const dir = await fs.mkdtemp(path.join(scratch, 'chathub-brand-cache-'))
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const dist = path.join(dir, 'dist')
  await fs.mkdir(dist)
  const source = path.join(dist, 'electron.exe')
  const icon = path.join(dir, 'icon.ico')
  await fs.writeFile(source, Buffer.from('electron-v1'))
  await fs.writeFile(icon, Buffer.from('icon-v1'))
  let edits = 0
  const edit = async target => { edits++; await fs.appendFile(target, Buffer.from('|brand-' + edits)) }
  const first = await ensureBrandedLauncher({ platform: 'win32', resolveElectron: () => source, iconPath: icon, editResources: edit })
  assert.equal(edits, 1)
  const good = await fs.readFile(first)
  await fs.writeFile(first, Buffer.from('tampered'))
  const second = await ensureBrandedLauncher({ platform: 'win32', resolveElectron: () => source, iconPath: icon, editResources: edit })
  assert.equal(second, first)
  assert.equal(edits, 2, 'corrupted cached launcher must be regenerated')
  assert.equal(sha256(await fs.readFile(first)), sha256(Buffer.concat([Buffer.from('electron-v1'), Buffer.from('|brand-2')])))

  await fs.writeFile(icon, Buffer.from('icon-v2'))
  const afterIconChange = await ensureBrandedLauncher({ platform: 'win32', resolveElectron: () => source, iconPath: icon, editResources: edit })
  assert.equal(afterIconChange, first)
  assert.equal(edits, 3, 'a changed icon must invalidate the branded launcher cache')
  assert.equal(sha256(await fs.readFile(first)), sha256(Buffer.concat([Buffer.from('electron-v1'), Buffer.from('|brand-3')])))

  await fs.writeFile(source, Buffer.from('electron-v2'))
  await assert.rejects(
    ensureBrandedLauncher({ platform: 'win32', resolveElectron: () => source, iconPath: icon, editResources: async () => { throw Error('resource edit failed') } }),
    /resource edit failed/
  )
  assert.equal(sha256(await fs.readFile(first)), sha256(Buffer.concat([Buffer.from('electron-v1'), Buffer.from('|brand-3')])), 'failed edit must retain the prior good launcher')
})

test('branded launcher restores the prior valid executable when replacement fails', async t => {
  await fs.mkdir(scratch, { recursive: true })
  const dir = await fs.mkdtemp(path.join(scratch, 'chathub-brand-replace-'))
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const dist = path.join(dir, 'dist')
  await fs.mkdir(dist)
  const source = path.join(dist, 'electron.exe')
  const target = path.join(dist, 'ChatHub.exe')
  const icon = path.join(dir, 'icon.ico')
  const prior = Buffer.from('previous-good-launcher')
  await fs.writeFile(source, Buffer.from('electron-v2'))
  await fs.writeFile(target, prior)
  await fs.writeFile(icon, Buffer.from('fixture-icon'))
  const fsOps = {
    copyFile: fs.copyFile,
    readFile: fs.readFile,
    rename: async (from, to) => {
      if (path.basename(from).includes('.tmp') && path.basename(to) === 'ChatHub.exe') {
        const error = new Error('forced replacement failure')
        error.code = 'EPERM'
        throw error
      }
      return fs.rename(from, to)
    },
    rm: fs.rm,
    stat: fs.stat,
    writeFile: fs.writeFile
  }

  await assert.rejects(
    ensureBrandedLauncher({ platform: 'win32', resolveElectron: () => source, iconPath: icon, editResources: async () => {}, fsOps }),
    /forced replacement failure/
  )
  assert.equal(sha256(await fs.readFile(target)), sha256(prior), 'replacement failure must leave the prior launcher in place')
})
