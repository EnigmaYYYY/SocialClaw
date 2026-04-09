#!/usr/bin/env node
'use strict'

const {
  resolveProjectRoot,
  loadCliConfig,
  runDoctor,
  runInit,
  runStart,
  runStop,
  bootstrapProjectRoot,
  helpText
} = require('../lib/socialclaw-cli')

async function main() {
  const command = process.argv[2] || 'help'
  const args = process.argv.slice(3)
  const projectDirFlagIndex = args.findIndex((arg) => arg === '--project-dir')
  const projectDir =
    projectDirFlagIndex >= 0 && args[projectDirFlagIndex + 1]
      ? args[projectDirFlagIndex + 1]
      : undefined

  const rootDir = await resolveProjectRoot(process.cwd())

  switch (command) {
    case 'doctor': {
      if (!rootDir) {
        throw new Error('Could not find a SocialClaw project. Run "socialclaw init" first or use the command inside a cloned repository.')
      }
      const config = await loadCliConfig(rootDir)
      const result = await runDoctor(rootDir, config)
      console.log(result.lines.join('\n'))
      process.exitCode = result.hasError ? 1 : 0
      return
    }
    case 'init': {
      const bootstrapResult = rootDir
        ? { rootDir, cloned: false }
        : await bootstrapProjectRoot(projectDir)
      const result = await runInit(bootstrapResult.rootDir)
      if (bootstrapResult.cloned) {
        console.log(`Repository cloned: ${bootstrapResult.rootDir}`)
      } else {
        console.log(`Project root: ${result.rootDir}`)
      }
      console.log(`Bootstrap complete.`)
      console.log(`Global config: ${result.globalConfigPath}`)
      console.log(`Config: ${result.configPath}`)
      console.log(
        result.createdFiles.length > 0
          ? `Generated: ${result.createdFiles.join(', ')}`
          : 'Generated: no new files'
      )
      return
    }
    case 'start': {
      if (!rootDir) {
        throw new Error('Could not find a SocialClaw project. Run "socialclaw init" first or use the command inside a cloned repository.')
      }
      const config = await loadCliConfig(rootDir)
      const backendOnly = process.argv.includes('--backend-only')
      const result = await runStart(rootDir, config, { backendOnly })
      console.log('SocialClaw stack started.')
      if (result.frontend) {
        if (result.frontend.alreadyRunning) {
          console.log(`Frontend already running (PID ${result.frontend.pid}).`)
        } else {
          console.log(`Frontend started (PID ${result.frontend.pid}).`)
        }
        console.log(`Frontend log: ${result.frontend.logPath}`)
      }
      return
    }
    case 'stop':
      if (!rootDir) {
        throw new Error('Could not find a SocialClaw project. Run "socialclaw init" first or use the command inside a cloned repository.')
      }
      await runStop(rootDir)
      console.log('SocialClaw stack stopped.')
      return
    case 'help':
    case '--help':
    case '-h':
      console.log(helpText())
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

main().catch((error) => {
  console.error(`SocialClaw CLI failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
