'use strict'

const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const PROJECT_MARKERS = ['social_copilot', 'memory', 'scripts']
const CLI_DIRNAME = '.socialclaw'
const STACK_DIRNAME = '.socialclaw-stack'
const CONFIG_FILENAME = 'config.json'
const GLOBAL_CONFIG_FILENAME = 'global-cli.json'
const DEFAULT_VISUAL_MONITOR_PYTHON = '/Applications/miniconda3/envs/social_copilot/bin/python'
const DEFAULT_BOOTSTRAP_DIR = path.join(os.homedir(), 'SocialClaw')
const REPOSITORY_URL = 'https://github.com/EnigmaYYYY/SocialClaw.git'

function findProjectRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir)
  while (true) {
    const isRoot = PROJECT_MARKERS.every((entry) => fs.existsSync(path.join(current, entry)))
    if (isRoot) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

function getCliDir(rootDir) {
  return path.join(rootDir, CLI_DIRNAME)
}

function getStackDir(rootDir) {
  return path.join(rootDir, STACK_DIRNAME)
}

function getCliConfigPath(rootDir) {
  return path.join(getCliDir(rootDir), CONFIG_FILENAME)
}

function getGlobalConfigPath() {
  return path.join(os.homedir(), CLI_DIRNAME, GLOBAL_CONFIG_FILENAME)
}

function defaultCliConfig(rootDir) {
  const resolvedVisualMonitorPython = fs.existsSync(DEFAULT_VISUAL_MONITOR_PYTHON)
    ? DEFAULT_VISUAL_MONITOR_PYTHON
    : process.env.VISUAL_MONITOR_PYTHON || ''
  const nodeExe = process.execPath || ''
  const npmCmd = process.platform === 'win32'
    ? path.join(path.dirname(nodeExe), 'npm.cmd')
    : 'npm'

  return {
    version: 1,
    frontendDir: 'social_copilot/frontend',
    frontendPackageManager: 'npm',
    visualMonitorPython: resolvedVisualMonitorPython,
    everMemOSPython: resolvedVisualMonitorPython,
    nodeExe,
    npmCmd,
    preferredShellStartScript: process.platform === 'win32'
      ? 'scripts/start_social_stack.ps1'
      : 'scripts/start_socialclaw.sh',
    preferredShellStopScript: process.platform === 'win32'
      ? 'scripts/stop_social_stack.ps1'
      : 'scripts/stop_socialclaw.sh',
    rootDir
  }
}

async function loadCliConfig(rootDir) {
  const configPath = getCliConfigPath(rootDir)
  const defaults = defaultCliConfig(rootDir)
  try {
    const raw = await fsp.readFile(configPath, 'utf8')
    return { ...defaults, ...JSON.parse(raw) }
  } catch {
    return defaults
  }
}

async function saveCliConfig(rootDir, config) {
  await fsp.mkdir(getCliDir(rootDir), { recursive: true })
  await fsp.writeFile(getCliConfigPath(rootDir), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

async function loadGlobalConfig() {
  try {
    const raw = await fsp.readFile(getGlobalConfigPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function saveGlobalConfig(config) {
  const configPath = getGlobalConfigPath()
  await fsp.mkdir(path.dirname(configPath), { recursive: true })
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

async function resolveProjectRoot(startDir = process.cwd()) {
  const directRoot = findProjectRoot(startDir)
  if (directRoot) {
    return directRoot
  }
  const globalConfig = await loadGlobalConfig()
  const configuredRoot = typeof globalConfig.rootDir === 'string' ? path.resolve(globalConfig.rootDir) : ''
  if (!configuredRoot) {
    return null
  }
  return findProjectRoot(configuredRoot) === configuredRoot ? configuredRoot : null
}

async function ensureTemplateFile(targetPath, templatePath) {
  try {
    await fsp.access(targetPath)
    return false
  } catch {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true })
    await fsp.copyFile(templatePath, targetPath)
    return true
  }
}

async function ensureBootstrapFiles(rootDir) {
  const created = []
  if (await ensureTemplateFile(path.join(rootDir, '.env'), path.join(rootDir, '.env.example'))) {
    created.push('.env')
  }
  if (
    await ensureTemplateFile(
      path.join(rootDir, 'memory/evermemos/.env'),
      path.join(rootDir, 'memory/evermemos/env.template')
    )
  ) {
    created.push('memory/evermemos/.env')
  }
  await fsp.mkdir(getCliDir(rootDir), { recursive: true })
  await fsp.mkdir(getStackDir(rootDir), { recursive: true })
  return created
}

function commandExists(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return result.status === 0
}

function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath)
    return true
  } catch {
    return false
  }
}

function readPid(pidPath) {
  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim()
    const pid = Number(raw)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isPidRunning(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function formatCheck(status, label, detail) {
  const prefix = status === 'ok' ? 'OK' : status === 'warn' ? 'WARN' : 'ERROR'
  return `[${prefix}] ${label}${detail ? ` - ${detail}` : ''}`
}

async function runDoctor(rootDir, config) {
  const checks = []
  checks.push(['ok', 'Project root', rootDir])
  checks.push([commandExists('node') ? 'ok' : 'error', 'Node.js', commandExists('node') ? process.version : 'not found'])
  checks.push([commandExists(process.platform === 'win32' ? 'npm.cmd' : 'npm') ? 'ok' : 'error', 'npm', commandExists(process.platform === 'win32' ? 'npm.cmd' : 'npm') ? 'available' : 'not found'])
  checks.push([commandExists('uv') ? 'ok' : 'error', 'uv', commandExists('uv') ? 'available' : 'not found'])
  checks.push([commandExists('docker') ? 'ok' : 'error', 'Docker CLI', commandExists('docker') ? 'available' : 'not found'])
  checks.push([
    commandExists('docker', ['info']) ? 'ok' : 'warn',
    'Docker daemon',
    commandExists('docker', ['info']) ? 'running' : 'not running or not accessible'
  ])

  const visualMonitorPython = config.visualMonitorPython || DEFAULT_VISUAL_MONITOR_PYTHON
  checks.push([
    visualMonitorPython && fs.existsSync(visualMonitorPython) ? 'ok' : 'warn',
    'Visual Monitor Python',
    visualMonitorPython && fs.existsSync(visualMonitorPython)
      ? visualMonitorPython
      : 'not configured; run socialclaw init'
  ])
  const everMemOSPython = config.everMemOSPython || visualMonitorPython
  checks.push([
    everMemOSPython && fs.existsSync(everMemOSPython) ? 'ok' : 'warn',
    'EverMemOS Python',
    everMemOSPython && fs.existsSync(everMemOSPython)
      ? everMemOSPython
      : 'not configured; run socialclaw init'
  ])
  checks.push([
    fs.existsSync(getCliConfigPath(rootDir)) ? 'ok' : 'warn',
    'CLI config',
    fs.existsSync(getCliConfigPath(rootDir))
      ? getCliConfigPath(rootDir)
      : 'missing; run socialclaw init'
  ])

  checks.push([
    fs.existsSync(path.join(rootDir, '.env')) ? 'ok' : 'warn',
    'Root .env',
    fs.existsSync(path.join(rootDir, '.env')) ? 'present' : 'missing; can be generated by init'
  ])
  checks.push([
    fs.existsSync(path.join(rootDir, 'memory/evermemos/.env')) ? 'ok' : 'warn',
    'EverMemOS .env',
    fs.existsSync(path.join(rootDir, 'memory/evermemos/.env')) ? 'present' : 'missing; can be generated by init'
  ])
  checks.push([
    fs.existsSync(path.join(rootDir, config.frontendDir, 'node_modules')) ? 'ok' : 'warn',
    'Frontend dependencies',
    fs.existsSync(path.join(rootDir, config.frontendDir, 'node_modules'))
      ? 'installed'
      : `missing; run "cd ${config.frontendDir} && npm install"`
  ])

  const hasError = checks.some(([status]) => status === 'error')
  return {
    hasError,
    lines: checks.map(([status, label, detail]) => formatCheck(status, label, detail))
  }
}

async function runInit(rootDir) {
  await saveGlobalConfig({ rootDir })
  const createdFiles = await ensureBootstrapFiles(rootDir)
  const config = await loadCliConfig(rootDir)
  await saveCliConfig(rootDir, config)
  return {
    rootDir,
    globalConfigPath: getGlobalConfigPath(),
    configPath: getCliConfigPath(rootDir),
    createdFiles
  }
}

async function bootstrapProjectRoot(targetDir = DEFAULT_BOOTSTRAP_DIR) {
  const resolvedTarget = path.resolve(targetDir)
  if (findProjectRoot(resolvedTarget) === resolvedTarget) {
    await saveGlobalConfig({ rootDir: resolvedTarget })
    return { rootDir: resolvedTarget, cloned: false }
  }

  if (pathExists(resolvedTarget)) {
    const entries = await fsp.readdir(resolvedTarget)
    if (entries.length > 0) {
      throw new Error(
        `Target directory is not an empty SocialClaw project: ${resolvedTarget}. Choose an empty directory or clone path.`
      )
    }
  } else {
    await fsp.mkdir(path.dirname(resolvedTarget), { recursive: true })
  }

  if (!commandExists('git')) {
    throw new Error('git is required for npm-installed bootstrap mode. Please install git or clone the repository manually.')
  }

  runCommand('git', ['clone', REPOSITORY_URL, resolvedTarget])
  await saveGlobalConfig({ rootDir: resolvedTarget })
  return { rootDir: resolvedTarget, cloned: true }
}

function getNpmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function getFrontendDevCommand(rootDir, config) {
  const frontendDir = path.join(rootDir, config.frontendDir)
  return {
    command: config.nodeExe || process.execPath,
    args: [path.join(frontendDir, 'scripts', 'dev-electron.cjs')],
    cwd: frontendDir
  }
}

function getManagedStopTargets(pid, platform = process.platform) {
  if (!pid) {
    return []
  }
  if (platform === 'win32') {
    return [pid]
  }
  return [-pid, pid]
}

function listFrontendProcessGroups(rootDir, psOutput) {
  const frontendDir = path.join(rootDir, 'social_copilot', 'frontend')
  const normalizedFrontendDir = frontendDir.replace(/\\/g, '/')
  return String(psOutput || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (!match) {
        return []
      }
      const [, pidText, pgidText, command] = match
      const normalizedCommand = command.replace(/\\/g, '/')
      const touchesFrontendDir = normalizedCommand.includes(normalizedFrontendDir)
      const isManagedFrontendProcess =
        normalizedCommand.includes('electron-vite.js dev') ||
        normalizedCommand.includes('Electron .') ||
        normalizedCommand.includes('--app-path=') ||
        normalizedCommand.includes('dev-electron.cjs')
      if (!touchesFrontendDir || !isManagedFrontendProcess) {
        return []
      }
      const pid = Number(pidText)
      const pgid = Number(pgidText)
      if (!Number.isInteger(pid) || !Number.isInteger(pgid) || pgid <= 0) {
        return []
      }
      return [pgid]
    })
    .filter((pgid, index, array) => array.indexOf(pgid) === index)
}

async function terminateManagedPid(pid, platform = process.platform) {
  const stopTargets = getManagedStopTargets(pid, platform)
  for (const target of stopTargets) {
    try {
      process.kill(target, 'SIGTERM')
    } catch {
      // best-effort termination
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1000))
  if (!isPidRunning(pid)) {
    return
  }
  for (const target of stopTargets) {
    try {
      process.kill(target, 'SIGKILL')
    } catch {
      // best-effort forced termination
    }
  }
}

function getPsCommand() {
  return ['ps', ['-Ao', 'pid,pgid,command']]
}

function getFrontendFallbackGroups(rootDir) {
  if (process.platform === 'win32') {
    return []
  }
  const [command, args] = getPsCommand()
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    return []
  }
  return listFrontendProcessGroups(rootDir, result.stdout)
}

async function startFrontendDev(rootDir, config) {
  const stackDir = getStackDir(rootDir)
  const pidPath = path.join(stackDir, 'frontend.pid')
  const existingPid = readPid(pidPath)
  if (existingPid && isPidRunning(existingPid)) {
    return { alreadyRunning: true, pid: existingPid, logPath: path.join(stackDir, 'frontend.log') }
  }

  const frontendDir = path.join(rootDir, config.frontendDir)
  if (!fs.existsSync(frontendDir)) {
    throw new Error(`Frontend directory not found: ${frontendDir}`)
  }
  if (!fs.existsSync(path.join(frontendDir, 'node_modules'))) {
    throw new Error(`Frontend dependencies not installed. Run "cd ${config.frontendDir} && npm install" first.`)
  }

  await fsp.mkdir(stackDir, { recursive: true })
  const logPath = path.join(stackDir, 'frontend.log')
  const logFd = fs.openSync(logPath, 'a')
  const launch = getFrontendDevCommand(rootDir, config)
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd]
  })
  child.unref()
  await fsp.writeFile(pidPath, `${child.pid}\n`, 'utf8')
  fs.closeSync(logFd)
  return { alreadyRunning: false, pid: child.pid, logPath }
}

async function stopFrontendDev(rootDir) {
  const pidPath = path.join(getStackDir(rootDir), 'frontend.pid')
  const pid = readPid(pidPath)
  if (pid && isPidRunning(pid)) {
    await terminateManagedPid(pid)
  }
  for (const pgid of getFrontendFallbackGroups(rootDir)) {
    await terminateManagedPid(pgid)
  }
  await fsp.rm(pidPath, { force: true })
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options
  })
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? 1}`)
  }
}

async function runStart(rootDir, config, options = {}) {
  await ensureBootstrapFiles(rootDir)

  if (process.platform === 'win32') {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(rootDir, 'scripts/start_social_stack.ps1')
    ]
    if (config.visualMonitorPython) {
      args.push('-VisualMonitorPython', config.visualMonitorPython)
    }
    if (config.everMemOSPython) {
      args.push('-EverMemOSPython', config.everMemOSPython)
    }
    if (config.nodeExe && config.nodeExe !== 'node') {
      args.push('-NodeExe', config.nodeExe)
    }
    if (config.npmCmd && config.npmCmd !== 'npm') {
      args.push('-NpmCmd', config.npmCmd)
    }
    runCommand('powershell.exe', args, { cwd: rootDir })
    return { frontend: null }
  }

  const env = { ...process.env }
  if (config.visualMonitorPython) {
    env.VISUAL_MONITOR_PYTHON = config.visualMonitorPython
  }
  runCommand('bash', [path.join(rootDir, 'scripts/start_socialclaw.sh')], { cwd: rootDir, env })

  if (options.backendOnly) {
    return { frontend: null }
  }

  return { frontend: await startFrontendDev(rootDir, config) }
}

async function runStop(rootDir) {
  await stopFrontendDev(rootDir)

  if (process.platform === 'win32') {
    runCommand('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(rootDir, 'scripts/stop_social_stack.ps1')
    ], { cwd: rootDir })
    return
  }

  runCommand('bash', [path.join(rootDir, 'scripts/stop_socialclaw.sh')], { cwd: rootDir })
}

function helpText() {
  return [
    'SocialClaw CLI',
    '',
    'Commands:',
    '  socialclaw doctor        Check local runtime prerequisites',
    '  socialclaw init          Clone/bootstrap SocialClaw (outside repo) or generate local config (inside repo)',
    '  socialclaw start         Start Docker deps, EverMemOS, Visual Monitor, and frontend',
    '  socialclaw start --backend-only',
    '  socialclaw stop          Stop the managed SocialClaw stack',
    '',
    'Options:',
    '  socialclaw init --project-dir <path>   Bootstrap or initialize a specific project directory'
  ].join(os.EOL)
}

module.exports = {
  findProjectRoot,
  resolveProjectRoot,
  defaultCliConfig,
  loadCliConfig,
  saveCliConfig,
  loadGlobalConfig,
  saveGlobalConfig,
  ensureBootstrapFiles,
  runDoctor,
  runInit,
  runStart,
  runStop,
  bootstrapProjectRoot,
  getGlobalConfigPath,
  getFrontendDevCommand,
  getManagedStopTargets,
  listFrontendProcessGroups,
  helpText
}
