import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(`Portable build requires win32-x64 tooling; got ${process.platform}-${process.arch}`)
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const distRoot = path.join(root, 'dist')
const folderName = `ChatHub-${version}-win64`
const outDir = path.join(distRoot, folderName)
const zipPath = path.join(distRoot, `${folderName}.zip`)
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')
async function installedLauncher() {
  let runtimeVersion
  try { runtimeVersion = (await readFile(path.join(electronDist, 'version'), 'utf8')).trim().replace(/^v/, '') } catch { return '' }
  if (runtimeVersion !== String(pkg.devDependencies?.electron || '').replace(/^v/, '')) return ''
  for (const name of ['ChatHub.exe', 'electron.exe']) {
    const candidate = path.join(electronDist, name)
    try { await stat(candidate); return candidate } catch {}
  }
  return ''
}
async function ensureElectronRuntime() {
  const existing = await installedLauncher()
  if (existing) return existing
  const installer = path.join(root, 'node_modules', 'electron', 'install.js')
  await stat(installer)
  execFileSync(process.execPath, [installer], { cwd: root, stdio: 'inherit' })
  const installed = await installedLauncher()
  if (!installed) throw new Error('Electron runtime installation completed without a Windows launcher')
  return installed
}
const launcherPath = await ensureElectronRuntime()

const appFiles = [
  'package.json', 'main.js', 'preload.js', 'renderer.js', 'styles.css', 'index.html',
  'guest-notification-policy.js', 'build', 'LICENSE', 'NOTICE', 'README.md'
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function rmWithRetry(target, attempts = 20) {
  let last
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      last = error
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || attempt === attempts - 1) throw error
      await sleep(250)
    }
  }
  throw last
}
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(error => error ? reject(error) : resolve(port))
  })
})
async function smokePortable(launcher, dataDir, expectedShellUrl) {
  const port = await freePort()
  const smokeEnv = { ...process.env }
  for (const key of Object.keys(smokeEnv)) {
    if (key.toUpperCase() === 'CHATHUB_DEV_DATA') delete smokeEnv[key]
  }
  const child = spawn(launcher, [`--remote-debugging-port=${port}`], { cwd: outDir, windowsHide: true, stdio: 'ignore', env: smokeEnv })
  try {
    const deadline = Date.now() + 15000
    let ready = false
    while (Date.now() < deadline) {
      await sleep(500)
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        if (targets.some(t => t.type === 'page' && String(t.url || '') === expectedShellUrl)) {
          ready = true
          break
        }
      } catch (e) {}
    }
    if (!ready) throw new Error('Portable smoke failed: ChatHub shell did not open')
    await stat(dataDir)
  } finally {
    if (child.pid) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch (e) {}
    }
    await sleep(400)
    await rmWithRetry(dataDir)
  }
}

for (const file of appFiles) {
  try { await stat(path.join(root, file)) }
  catch { throw new Error(`Packaging input is missing: ${file}`) }
}

await rmWithRetry(outDir)
await rm(zipPath, { force: true })
await mkdir(distRoot, { recursive: true })
const appDir = path.join(outDir, 'resources', 'app')
await cp(electronDist, outDir, { recursive: true, force: true })
await rm(appDir, { recursive: true, force: true })
await mkdir(appDir, { recursive: true })

const packagedLauncher = path.join(outDir, 'ChatHub.exe')
if (path.basename(launcherPath).toLowerCase() !== 'chathub.exe') {
  await rename(path.join(outDir, 'electron.exe'), packagedLauncher)
}
await stat(packagedLauncher)
try {
  await stat(path.join(outDir, 'data'))
  throw new Error('Portable staging unexpectedly contains user data')
} catch (e) {
  if (e && e.code !== 'ENOENT') throw e
}

for (const file of appFiles) {
  await cp(path.join(root, file), path.join(appDir, file), { recursive: true, force: true })
}
await writeFile(path.join(appDir, 'portable.json'), JSON.stringify({ product: pkg.productName, version }, null, 2) + '\n', 'utf8')

await writeFile(path.join(outDir, 'README-PORTABLE.txt'), [
  `ChatHub ${version} — portable Windows build`,
  '',
  '1. Extract the entire archive into a writable folder.',
  '2. Start ChatHub.exe.',
  '3. The portable build stores its settings and messenger sessions in the data folder next to ChatHub.exe.',
  '4. Do not copy the data folder between people: it contains their own local sessions.'
].join('\r\n') + '\r\n', 'utf8')

const manifest = {
  product: pkg.productName,
  version,
  platform: 'win32-x64',
  entry: 'ChatHub.exe',
  appFiles
}
await writeFile(path.join(outDir, 'BUILD-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

await smokePortable(
  packagedLauncher,
  path.join(outDir, 'data'),
  pathToFileURL(path.join(appDir, 'index.html')).href
)

const ps = `Compress-Archive -LiteralPath '${outDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'inherit' })

const archive = await readFile(zipPath)
const sha256 = createHash('sha256').update(archive).digest('hex')
await writeFile(`${zipPath}.sha256`, `${sha256}  ${path.basename(zipPath)}\n`, 'utf8')
console.log(JSON.stringify({ outDir, zipPath, sha256, version }))
