import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, open, realpath } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const names = {
  win32: { chromium: ['chrome.exe', 'chromium.exe', 'headless_shell.exe'], chrome: ['chrome.exe'], edge: ['msedge.exe'] },
  linux: { chromium: ['chrome', 'chromium', 'chromium-browser', 'headless_shell'], chrome: ['chrome', 'google-chrome', 'google-chrome-stable'], edge: ['msedge', 'microsoft-edge', 'microsoft-edge-stable'] },
  darwin: { chromium: ['Chromium', 'chrome-headless-shell', 'headless_shell'], chrome: ['Google Chrome'], edge: ['Microsoft Edge'] },
}
const fail = (message) => { throw new Error(`Verifier browser: ${message}`) }
const supportedName = (browser, file, platform) => {
  const name = (platform === 'win32' ? path.win32 : path.posix).basename(file)
  return names[platform][browser].includes(platform === 'win32' ? name.toLowerCase() : name)
}
const supportedPath = (browser, file, platform) =>
  typeof file === 'string' && file.length <= 1024 && !/[\0\r\n]/u.test(file) &&
  (platform === 'win32' ? path.win32.isAbsolute(file) && /^[A-Za-z]:[\\/]/u.test(file) : path.posix.isAbsolute(file)) &&
  supportedName(browser, file, platform)

export function validateBrowserPolicy(policy, platform = process.platform, host = hostname()) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('policy must be an object')
  if (Object.keys(policy).some((key) => !['version', 'host', 'platform', 'browser', 'executable', 'sha256'].includes(key))) {
    fail('unknown policy field; browser arguments and shell commands are not supported')
  }
  if (policy.version !== 1 || policy.host !== host || policy.platform !== platform || !Object.hasOwn(names, platform)) {
    fail('policy version or host/platform does not match this runner')
  }
  if (typeof policy.browser !== 'string' || !Object.hasOwn(names[platform], policy.browser)) {
    fail('only chromium, chrome and edge are supported')
  }
  if (typeof policy.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(policy.sha256)) {
    fail('an explicit lowercase SHA-256 executable pin is required')
  }
  if (Object.hasOwn(policy, 'executable')) {
    if (!supportedPath(policy.browser, policy.executable, platform)) {
      fail('expected one absolute supported browser executable path, not a command')
    }
  } else if (policy.browser !== 'chromium') {
    fail('installed Chrome/Edge selection requires an explicit executable path')
  }
  return policy
}

function outsideWorkspace(candidate, workspace, label) {
  const relative = path.relative(workspace, candidate)
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    fail(`${label} must be operator-controlled outside the task workspace: ${candidate}`)
  }
}

async function fileDigest(file, maximumBytes) {
  const handle = await open(file, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size === 0 || before.size > maximumBytes) fail(`invalid file size/type: ${file}`)
    const hash = createHash('sha256')
    let total = 0
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      total += bytes.length
      if (total > maximumBytes) fail(`file exceeded the byte limit: ${file}`)
      hash.update(bytes)
    }
    const after = await handle.stat()
    if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      fail(`file changed during preflight: ${file}`)
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

export async function resolveVerifierBrowser({ policyPath, chromiumExecutable, workspace = process.cwd() }) {
  if (typeof policyPath !== 'string' || !path.isAbsolute(policyPath)) fail('an absolute policy path is required')
  const root = await realpath(workspace)
  outsideWorkspace(policyPath, root, 'policy')
  const policyFile = await realpath(policyPath)
  outsideWorkspace(policyFile, root, 'policy')
  const info = await lstat(policyPath)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8192) {
    fail(`policy must be a regular, unlinked file of at most 8192 bytes: ${policyPath}`)
  }
  const handle = await open(policyFile, 'r')
  let bytes
  try {
    const buffer = Buffer.alloc(8193)
    const read = await handle.read(buffer)
    if (read.bytesRead > 8192) fail(`policy exceeded 8192 bytes: ${policyPath}`)
    bytes = buffer.subarray(0, read.bytesRead)
  } finally {
    await handle.close()
  }
  let policy
  try {
    policy = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    fail(`invalid policy JSON: ${policyPath}`)
  }
  validateBrowserPolicy(policy)
  const executable = policy.executable ?? chromiumExecutable
  if (!supportedPath(policy.browser, executable, process.platform)) {
    fail('Playwright-managed Chromium is unavailable; supply its native executablePath(), never download implicitly')
  }
  outsideWorkspace(executable, root, 'browser')
  const resolved = await realpath(executable)
  outsideWorkspace(resolved, root, 'browser')
  if (!supportedPath(policy.browser, resolved, process.platform)) {
    fail(`resolved target is not a supported browser executable: ${resolved}`)
  }
  await access(resolved, process.platform === 'win32' ? constants.R_OK : constants.R_OK | constants.X_OK)
  const sha256 = await fileDigest(resolved, 1024 * 1024 * 1024)
  if (sha256 !== policy.sha256) fail(`executable SHA-256 differs from the authorized pin: ${resolved}`)
  return {
    launchOptions: { executablePath: resolved, headless: true, timeout: 30_000 },
    evidence: {
      schemaVersion: 1, host: hostname(), platform: process.platform, browser: policy.browser,
      selection: policy.executable === undefined ? 'playwright-managed' : 'declared-executable',
      executable: resolved, sha256, policySha256: createHash('sha256').update(bytes).digest('hex'),
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let selection
  try {
    const args = process.argv.slice(2)
    if (![2, 4].includes(args.length) || args[0] !== '--policy' ||
        (args.length === 4 && args[2] !== '--chromium-executable')) {
      fail('usage: node verifier_browser.mjs --policy ABSOLUTE_JSON [--chromium-executable ABSOLUTE_PATH]')
    }
    selection = await resolveVerifierBrowser({ policyPath: args[1], chromiumExecutable: args[3] })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
  if (selection) process.stdout.write(`${JSON.stringify(selection)}\n`)
}
