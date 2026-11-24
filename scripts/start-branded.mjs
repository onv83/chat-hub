import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureBrandedLauncher } from './ensure-branded-launcher.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const launchArguments = args => ['.', ...args]

export async function startBranded({ args = process.argv.slice(2), resolveLauncher = ensureBrandedLauncher, spawnImpl = spawn } = {}) {
  const launcher = await resolveLauncher()
  return spawnImpl(launcher, launchArguments(args), { cwd: root, stdio: 'inherit', windowsHide: false })
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const child = await startBranded()
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { try { child.kill(signal) } catch {} })
  }
  child.on('error', error => { console.error(error); process.exitCode = 1 })
  child.on('exit', (code, signal) => process.exitCode = signal ? 1 : (code ?? 1))
}
