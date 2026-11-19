#!/usr/bin/env node
import { runCommand } from './commands.js'

try {
  await runCommand(process.argv.slice(2))
} catch (error) {
  // Hook failures leave the human prompt in Claude's terminal. Administrators receive an actionable failure.
  if (!process.argv.slice(2).includes('hook')) {
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
}
