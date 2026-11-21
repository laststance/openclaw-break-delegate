import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin'
import { Type } from 'typebox'
import { commandDescription, commandNames, runCommand } from './commands.js'
import { isAbsolute } from 'node:path'
import { dataDirectory, isObject } from './ipc.js'
import { installedHookExecutable } from './settings.js'
import { createJudge } from './model.js'
import { startService } from './service.js'

const workloadFields = [
  'threshold',
  'activePointsPerMinute',
  'additionalPointsPerMinute',
  'humanReplyPoints',
] as const
const scoreWeight = Type.Optional(Type.Number({ minimum: 0, maximum: 1000 }))
const localRoot = Type.Optional(Type.String({ pattern: '^/' }))
// The host packer reads the SDK authoring metadata even for service-only plugins.
const entry = defineToolPlugin({
  id: 'break-delegate',
  name: 'Break Delegate',
  description:
    'Take a macOS break while OpenClaw answers familiar Claude Code questions.',
  activation: { onStartup: true },
  configSchema: Type.Object(
    {
      agentId: Type.Optional(
        Type.String({
          minLength: 1,
          description: 'Configured agent for tool-free confirmation.',
        }),
      ),
      maxConfirmationsPerBreak: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10000,
          description:
            'Maximum model confirmation requests during one delegated break (default 60).',
        }),
      ),
      workload: Type.Optional(
        Type.Object(
          {
            threshold: Type.Optional(
              Type.Number({ exclusiveMinimum: 0, maximum: 10000 }),
            ),
            activePointsPerMinute: scoreWeight,
            additionalPointsPerMinute: scoreWeight,
            humanReplyPoints: scoreWeight,
          },
          {
            additionalProperties: false,
            description: 'Break invitation score and weights.',
          },
        ),
      ),
      historyRoots: Type.Optional(
        Type.Object(
          { claude: localRoot, codex: localRoot, gstack: localRoot },
          {
            additionalProperties: false,
            description:
              'Absolute local state roots. Only specified sources are imported.',
          },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  tools: () => [],
})
const registerAuthoringSurface = entry.register
entry.register = (api) => {
  registerAuthoringSurface(api)
  let stop: (() => Promise<void>) | undefined
  api.registerService({
    id: 'break-delegate',
    async start(ctx) {
      const agentId =
        typeof api.pluginConfig?.agentId === 'string'
          ? api.pluginConfig.agentId
          : 'main'
      const configured = api.pluginConfig?.historyRoots
      const roots = isObject(configured)
        ? Object.fromEntries(
            Object.entries(configured).filter(
              ([name, path]) =>
                ['claude', 'codex', 'gstack'].includes(name) &&
                typeof path === 'string' &&
                isAbsolute(path),
            ),
          )
        : undefined
      const rawWorkload = api.pluginConfig?.workload
      const workload = isObject(rawWorkload)
        ? Object.fromEntries(
            workloadFields.flatMap((field) => {
              const value = rawWorkload[field]
              return typeof value === 'number' &&
                Number.isFinite(value) &&
                (field === 'threshold' ? value > 0 : value >= 0)
                ? [[field, value]]
                : []
            }),
          )
        : undefined
      stop = await startService({
        workload,
        maxConfirmationsPerBreak:
          typeof api.pluginConfig?.maxConfirmationsPerBreak === 'number'
            ? api.pluginConfig.maxConfirmationsPerBreak
            : undefined,
        directory: dataDirectory(ctx.stateDir),
        roots,
        judge: createJudge(api, agentId),
        log: (message) => ctx.logger.warn(message),
      })
    },
    async stop() {
      const close = stop
      stop = undefined
      await close?.()
    },
  })
  api.registerCli(
    ({ program }) => {
      const root = program
        .command('break-delegate')
        .description(commandDescription)
      for (const name of commandNames) {
        const cmd = root
          .command(name)
          .description(
            {
              setup: 'Install hooks in Claude Code settings',
              'uninstall-hooks': "Remove this installation's Claude hooks",
              'authorize-notifications': 'Request macOS notification access',
              status:
                'Show activity coverage, current break and native permission',
              review: 'Show locally retained held questions and answers',
              return: 'End the active delegated break',
              import: 'Import explicit human answers from local histories',
              replay:
                'Report historical agreement and coverage by question type',
            }[name],
          )
          .option('--state-dir <path>', 'Plugin state directory')
        if (name === 'setup' || name === 'uninstall-hooks')
          cmd.option('--settings <path>', 'Claude settings JSON file')
        if (name === 'review') cmd.argument('[break-id]', 'A particular break')
        cmd.action(async () => {
          const flags = cmd.opts<{ stateDir?: string; settings?: string }>()
          const args: string[] = [name]
          if (name === 'review' && cmd.args[0]) args.push(cmd.args[0])
          if (flags.stateDir) args.push('--state-dir', flags.stateDir)
          if (flags.settings) args.push('--settings', flags.settings)
          await runCommand(
            args,
            undefined,
            installedHookExecutable(api.rootDir),
          )
        })
      }
    },
    {
      commands: ['break-delegate'],
      descriptors: [
        {
          name: 'break-delegate',
          description: commandDescription,
          hasSubcommands: true,
        },
      ],
    },
  )
}

export default entry
