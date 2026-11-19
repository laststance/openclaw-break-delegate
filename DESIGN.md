# OpenClaw break delegation

*Initial plugin design confirmed on November 20, 2026.*

An OpenClaw plugin offers a break through a macOS notification when sustained work with coding agents has demanded the person's attention. Accepting the invitation lets OpenClaw answer questions on the person's behalf while each agent continues in its existing session.

## When to offer a break

The first release measures identifiable active sessions in Claude Code and in Codex Desktop and CLI on the Mac. Cursor and other clients can be added later. The ability to measure a session and the ability to answer its questions are separate capabilities.

Use a rolling 60-minute window. Each minute with at least one active session contributes 1 point, plus 0.1 point for each additional concurrent session that minute. A session running tests counts as active. A session blocked waiting for the person's input stops contributing running time until work resumes. Each human response contributes 4 points. Offer a break when the total reaches 45. These are adjustable starting values.

| Activity in the window | Score | Invitation |
| --- | ---: | --- |
| Four sessions run unattended for 30 minutes | 30 × (1 + 3 × 0.1) = 39 | Below threshold |
| One session runs for 30 minutes and the person answers five times | 30 + 5 × 4 = 50 | Threshold reached |

Dismissing the invitation silences it until the score falls below 45 and crosses the threshold again. Choosing “Remind me in 15 minutes” requests one further invitation if the score is still at least 45 and the person is still supervising. Acceptance starts the break. When the break ends, start counting at zero using only activity after the person's return.

## What happens during a break

Choosing “Take a 15-minute break and delegate” in the Mac notification starts the delegation for every supported Claude Code session open at that instant. Keep that set of sessions fixed for the break. A session opened later can be included in a subsequent break.

Only new question cards from those sessions can receive a delegated answer. A card already on screen when the person accepts the break remains waiting for their return. Delegation ends after 15 minutes or as soon as the person chooses “I'm back.” At delivery, check that the break is still active and that the same question is still waiting in its original session. Deliver at most one delegated answer to each question. On return, the person can review held questions and the answers OpenClaw sent.

OpenClaw can answer a question about how to proceed when the person's preference is clear. If the evidence is too weak, hold that question until the person returns. Other sessions can continue. Requests for execution approval, such as permission to deploy to production, always wait for the person.

## How previous answers inform a reply

Use explicit human replies and selections from gstack, Claude Code, and Codex. Give the current repository's comparable examples priority. Other repositories can supply supporting evidence. An answer recorded in more than one history counts once. Some gstack entries originate in the Codex transcript itself. [gstack's Codex importer](https://github.com/garrytan/gstack/blob/2714e9f7f3eadf886dc974908aeca78ccfdf48a3/bin/gstack-codex-session-import#L130-L207)

For each question, identify the repository, the kind of decision, and the meaning of its available choices. Group equivalent choices even when the wording or the order changes. Count how often the person selected each choice in comparable situations, with separate counts for the current repository and for other repositories. Keep the underlying question and answer linked locally so a repeated import or a copy from another tool contributes a single observation.

For example, an agent discovers an unrelated bug and asks whether to fix it in the current pull request or open a separate issue. In a fictional history, the person chose the current pull request in 24 of 26 comparable cases here and 7 of 12 elsewhere. The local preference summary can carry both counts and the leading choice. The historical fraction and the predictor's agreement on held-out answers describe different things.

### Testing a preference

Replay historical questions in time order on the Mac. Hide the person's answer to each test question and use only information that was available before it was asked. Apply the same choice rule and repository evidence requirements that govern a live answer. Count hypothetical predictions before enabling the type for live use. For each question type, record the number of distinct predictions and how many matched the person's answers. Track held questions separately so the share of questions covered is visible alongside agreement.

Enable a question type after at least 20 predictions and at least 95% agreement. A result of 19 matches in 20 predictions qualifies. A perfect 19 out of 19 falls short of the minimum sample. These figures are the initial eligibility criteria. The person's actual results will come from replaying their history.

For every new card in an eligible type, require at least five distinct comparable human answers from the current repository, with at least 80% supporting the same available choice. Four matching answers out of five meet this local requirement. Four out of four need another example. Answers from other repositories may help interpret the preference, but only answers from the current repository enter these two counts. Hold the card if the evidence is insufficient or the choice conflicts with the person's current instructions.

### What an external model can see

Keep the original gstack, Claude Code, and Codex histories on the Mac. The input to an external model consists of the current question, its choices, and a summary of past preferences with counts. Prepare the historical summaries locally.

## First integration to verify

Start with structured question cards in Claude Code in the terminal on the Mac. The acceptance check is that a question reaches OpenClaw during a delegated break, OpenClaw answers it, and the very same waiting Claude Code session continues. Ordinary questions embedded in conversation text are outside this first integration. Claude Code documents a hook for supplying answers to a structured `AskUserQuestion` call. [Claude Code hooks](https://code.claude.com/docs/en/hooks#tools-that-require-user-interaction)

For example, two supported terminals are open when the person accepts a break. The first already shows a bug-fix question and stays ready for the person to answer it. The second asks a new question during the break and can receive a delegated answer if it passes the evidence checks. A third terminal opened during the break receives no delegation from that invitation.

Verify the notification response separately. OpenClaw documents local notifications through a paired Mac node. Its published notification options cover title, body, priority, sound, and delivery. Binding the user's choice to the start of delegation still needs an end-to-end check on macOS. [OpenClaw node notifications](https://docs.openclaw.ai/cli/nodes#notify-push-location-screen)

Activity detection also needs a live check against the desktop app and terminal. OpenClaw marks a stored Codex thread with no live status as activity unknown. Count a confirmed active session once across views, and surface missing coverage when its activity cannot be established. [Codex session supervision](https://docs.openclaw.ai/plugins/codex-supervision)

## Related documents

- [Glossary](GLOSSARY.md)
- [Learn decision preferences from human answers](docs/adr/0001-learn-preferences-from-human-answers.md)
- [Keep original histories on the Mac](docs/adr/0002-keep-original-histories-on-the-mac.md)
