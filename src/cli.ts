#!/usr/bin/env node
import { runCommand } from './commands.js'

try {
  await runCommand(process.argv.slice(2))
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  console.error(
    code === 'ENOENT' || code === 'ECONNREFUSED'
      ? 'Break Delegate is offline. Start the OpenClaw Gateway with this plugin enabled.'
      : error instanceof Error
        ? error.message
        : 'Break Delegate failed.',
  )
  process.exitCode = 1
}
