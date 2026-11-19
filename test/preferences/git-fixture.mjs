import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Keep every fixture Git command and hook inside the temporary test directory.
 * @example fixtureGit(root,repo,['init','--quiet'])
 */
export function fixtureGit(root, cwd, args) {
  const hooks = join(root, 'empty-git-hooks')
  mkdirSync(hooks, { recursive: true })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  )
  execFileSync('git', ['-c', 'core.hooksPath=' + hooks, '-C', cwd, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}
