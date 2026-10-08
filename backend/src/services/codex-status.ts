import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const runFile = promisify(execFile)
export async function findCodex(): Promise<string> {
  const configured = process.env.HUOBAO_CODEX_BIN
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(dir => dir && !dir.includes(`node_modules${path.sep}.bin`))
  const windowsDirs = [...pathDirs, path.join(process.env.APPDATA || homedir(), 'npm')]
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const packageName = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64'
  // npm's Windows shim cannot be spawned directly by the SDK. Locate its native binary.
  const windowsNative = windowsDirs.flatMap(dir => [
    path.join(dir, 'node_modules', '@openai', packageName, 'vendor', triple, 'codex', 'codex.exe'),
    path.join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', packageName, 'vendor', triple, 'codex', 'codex.exe'),
    path.join(dir, 'node_modules', '@openai', 'codex', 'vendor', triple, 'codex', 'codex.exe'),
  ])
  const candidates = configured ? [configured] : [
    // npm adds dependency shims to PATH; these are SDK dependencies, not the user's CLI.
    ...pathDirs.map(dir => path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex')),
    ...(process.platform === 'win32' ? windowsNative : []),
    path.join(homedir(), '.local', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
  ]
  for (const candidate of [...new Set(candidates)]) {
    try { await access(candidate, constants.X_OK); await runFile(candidate, ['--version'], { timeout: 5000 }); return candidate } catch {}
  }
  throw new Error('Codex CLI not found. Install and sign in to Codex, or set HUOBAO_CODEX_BIN.')
}
export async function codexStatus() {
  try {
    const executable = await findCodex()
    const version = await runFile(executable, ['--version'], { timeout: 10000 })
    try {
      const login = await runFile(executable, ['login', 'status'], { timeout: 10000 })
      const loggedIn = /chatgpt/i.test(login.stdout + login.stderr)
      return { installed: true, logged_in: loggedIn, version: version.stdout.trim(), message: loggedIn ? null : 'Sign in to Codex with ChatGPT.' }
    } catch { return { installed: true, logged_in: false, version: version.stdout.trim(), message: 'Sign in to Codex with ChatGPT.' } }
  } catch (error) { return { installed: false, logged_in: false, version: null, message: (error as Error).message } }
}
