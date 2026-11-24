import { copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resolveNativeElectron = () => require('electron')
const defaultIconPath = path.join(root, 'build', 'icon.ico')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const defaultFsOps = { copyFile, readFile, rename, rm, stat, writeFile }
const defaultEditResources = async (target, options) => {
  const { rcedit } = await import('rcedit')
  await rcedit(target, options)
}

export async function ensureBrandedLauncher({
  platform = process.platform,
  resolveElectron = resolveNativeElectron,
  editResources = defaultEditResources,
  iconPath = defaultIconPath,
  fsOps = defaultFsOps
} = {}) {
  const { copyFile, readFile, rename, rm, stat, writeFile } = fsOps
  const source = await Promise.resolve().then(resolveElectron)
  if (typeof source !== 'string' || !source) throw new Error('Electron resolver returned no executable path')
  if (platform !== 'win32') return source

  const sourceName = path.basename(source).toLowerCase()
  if (sourceName === 'chathub.exe') return source
  if (sourceName !== 'electron.exe') throw new Error(`Unexpected Windows Electron launcher: ${source}`)
  const sourceBytes = await readFile(source)
  const sourceHash = sha256(sourceBytes)
  const versionStrings = {
    FileDescription: 'ChatHub',
    ProductName: 'ChatHub',
    InternalName: 'ChatHub',
    OriginalFilename: 'ChatHub.exe'
  }
  const iconHash = sha256(await readFile(iconPath))
  const brandingHash = sha256(JSON.stringify({ iconHash, versionStrings }))
  const directory = path.dirname(source)
  const target = path.join(directory, 'ChatHub.exe')
  const marker = path.join(directory, '.chathub-launcher.json')
  try {
    const saved = JSON.parse(await readFile(marker, 'utf8'))
    const targetBytes = await readFile(target)
    if (saved?.sourceSha256 === sourceHash && saved?.launcherSha256 === sha256(targetBytes) && saved?.brandingSha256 === brandingHash && saved?.version === 3) return target
  } catch {}

  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  const markerTemporary = `${marker}.${process.pid}.${Date.now()}.tmp`
  const backup = `${target}.${process.pid}.${Date.now()}.bak`
  let restoreBackup = false
  try {
    await rm(temporary, { force: true })
    await rm(markerTemporary, { force: true })
    await rm(backup, { force: true })
    await copyFile(source, temporary)
    if (sha256(await readFile(temporary)) !== sourceHash) throw new Error('Branded launcher temporary copy verification failed')
    await editResources(temporary, {
      icon: iconPath,
      'version-string': versionStrings
    })
    const launcherHash = sha256(await readFile(temporary))
    let hasTarget = false
    try {
      await stat(target)
      hasTarget = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (hasTarget) {
      await rename(target, backup)
      restoreBackup = true
    }
    try {
      await rename(temporary, target)
      restoreBackup = false
    } catch (error) {
      if (restoreBackup) {
        try {
          await rename(backup, target)
          restoreBackup = false
        } catch (rollbackError) {
          error.rollbackError = rollbackError
        }
      }
      throw error
    }
    await writeFile(markerTemporary, JSON.stringify({ version: 3, sourceSha256: sourceHash, launcherSha256: launcherHash, brandingSha256: brandingHash }) + '\n', 'utf8')
    await rm(marker, { force: true })
    await rename(markerTemporary, marker)
    await rm(backup, { force: true })
    return target
  } finally {
    if (restoreBackup) {
      try {
        await rename(backup, target)
        restoreBackup = false
      } catch {}
    }
    await rm(temporary, { force: true }).catch(() => {})
    await rm(markerTemporary, { force: true }).catch(() => {})
    if (!restoreBackup) await rm(backup, { force: true }).catch(() => {})
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const launcher = await ensureBrandedLauncher()
  console.log(JSON.stringify({ launcher }))
}
