# Break Delegate for OpenClaw

Break Delegate offers a macOS break when supervising coding agents has taken sustained attention. Choose **Take a 15-minute break** and OpenClaw can answer familiar work-planning questions in the Claude Code terminals already open. When you return, review which answers it sent and which questions still need you.

## Install the release candidate

Use macOS 13 or later, an interactive Claude Code terminal, and OpenClaw 2026.11.5 or later with a configured agent that supports fresh, tool-free inference. The package includes a universal native notification helper. Codex Desktop and CLI contribute observable workload. The status command reports the available coverage on your Mac.

To build from this checkout, install pnpm 12 and Xcode Command Line Tools. CI uses Node.js 24.x, with 24.16 as the package minimum. The package also accepts Node.js 26.1 or later. Run these commands in the repository root.

```sh
pnpm install --frozen-lockfile
pnpm run pack:release
openclaw plugins install ./release/laststance-openclaw-break-delegate-0.1.0.tgz
openclaw plugins enable break-delegate
```

Apply the plugin change to your Gateway. Start it with `openclaw gateway run` if you run it in a terminal, or use `openclaw gateway restart` for a managed Gateway. Then register the Claude hooks and authorize notifications on the Mac where your agents run.

```sh
openclaw break-delegate setup
openclaw break-delegate authorize-notifications
openclaw break-delegate status
```

`setup` preserves existing Claude settings and registers the hook executable from this install. Run it again after moving or updating the installation. A custom settings file can be selected with `setup --settings /absolute/path/to/settings.json`. Installing against a settings file hands its Break Delegate hooks to that profile. Removal affects hooks owned by the selected profile. Setup compares the file immediately before replacing it; another editor writing at that exact instant cannot share its lock. Start an interactive Claude session to establish an identifiable terminal instance. Notification permission can also be granted from the Break Delegate menu.

## Take a break

The plugin uses a rolling 60-minute window. Each minute with an active session earns 1 point plus 0.1 per additional concurrent session. A verified human response earns 4 points. A terminal waiting for input contributes no running time. At 45 points the Mac offers a break. Four agents testing unattended for 30 minutes earn 39 points. One agent running for 30 minutes with five human answers earns 50.

Dismiss the invitation to silence it until the score falls below 45 and reaches it again, or snooze it for 15 minutes. Accepting fixes the participating terminals at that moment. New question cards in those terminals can receive replies for up to 15 minutes. Existing cards, execution approvals, conflicting instructions and questions with insufficient evidence wait for you. Other work continues. On return the workload score starts at zero.

Choose **I'm back** in the Mac menu or run `openclaw break-delegate return` in the terminal. The local review shows the questions associated with the break and the disposition of each reply.

```sh
openclaw break-delegate return
openclaw break-delegate review
openclaw break-delegate review <break-id>
```

## How the delegate learns

The Gateway imports locally attributable human answers from Claude Code, Codex and gstack. It deduplicates the same original question across sources and excludes decisions made by automation. Unclear authorship leaves the historical answer out of the evidence. The importer runs on startup and periodically. To refresh and inspect the scores yourself, run the following commands.

```sh
openclaw break-delegate import
openclaw break-delegate replay
```

A question type qualifies after at least 20 chronological test predictions with at least 95% agreement with the person's actual answers. Each live card also needs at least five comparable human answers in the current repository with 80% agreement on one available choice. For example, enough verified choices to fix an unrelated bug in the current PR can support that answer to a new card. Held-out agreement and the share of questions the policy could answer are reported together. A new installation may initially hold every question.

The local policy supplies an eligible choice to the configured OpenClaw agent for confirmation. Its fresh, tool-free call receives the current question, its options and a summary with counts. Original history, workspace paths, transcripts and historical free text stay on the Mac. A model timeout or disagreement leaves the original Claude prompt available for the person. Multi-question cards require every choice to qualify.

## Configuration and removal

Plugin configuration lives under `plugins.entries.break-delegate.config`. `agentId` selects the configured OpenClaw agent (default `main`). `historyRoots` can override the local state directories for `claude`, `codex` and `gstack`. If you supply this object, only its listed history sources are imported. State and review data are stored in a user-private `break-delegate` directory under the local OpenClaw profile. The service and installed hooks must use the same Mac account and profile.

To change when the invitation appears, set `workload.threshold` (default 45), `workload.activePointsPerMinute` (1), `workload.additionalPointsPerMinute` (0.1), or `workload.humanReplyPoints` (4) in the plugin configuration, then restart the Gateway. A break runs for up to 15 minutes. Snoozing asks for a reminder 15 minutes later if the score still qualifies and you are still supervising.

To stop delegating immediately, use `return`. To disable the integration, remove the hooks before unloading the plugin. If you installed the hooks with `setup --settings`, pass the same `--settings` path to `uninstall-hooks`.

```sh
openclaw break-delegate uninstall-hooks
openclaw plugins disable break-delegate
```

Apply the change by restarting the Gateway. To resume later, enable `break-delegate`, restart the Gateway and run `setup` with the original settings path if you used one.

## Verify or prepare publication

`pnpm validate` builds and checks the plugin. On macOS, `pnpm run pack:release` builds and verifies the native helper, runs the tests, and writes the npm-compatible archive under `release/`. `pnpm run smoke:install` installs that archive into a disposable OpenClaw profile and exercises its command surface. The native build accepts `BREAK_DELEGATE_SIGN_IDENTITY` for a Developer ID Application identity. The default local build uses an ad-hoc signature.

The release uses OpenClaw’s regular package installer. It keeps the signed Mac application and the Claude hook executable at stable paths inside the installed package. For Developer ID signing, notarization and packaging the stapled app, see the [macOS helper guide](native/README.md).

To verify the original Claude session on a Mac with Claude Code installed, run `node scripts/qa-claude-terminal.mjs "$(mktemp -d)" "$(command -v claude)"` after building. The interactive CLI talks to an isolated loopback model. The runner supplies synthetic human history and native consent, and verifies the model’s next request, the terminal’s completion message, and the Gateway’s delivery record.

Preview the ClawHub release from the repository root with this read-only publication command. A maintainer can use the same archive for the eventual release.

```sh
pnpm dlx clawhub@0.26.0 package publish ./release/laststance-openclaw-break-delegate-0.1.0.tgz --family code-plugin --owner laststance --source-repo laststance/openclaw-break-delegate --source-commit "$(git rev-parse HEAD)" --dry-run --json
```

For requirements, terminology and release history, see the [design](DESIGN.md), [glossary](GLOSSARY.md) and [changelog](CHANGELOG.md).
