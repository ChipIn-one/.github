# Team notifications

Owned by `ChipIn-one/.github`. This page is the single source for team notifications in Slack: which events post where, which secret each repository needs, and how to add a new one. Part of [#276](https://github.com/ChipIn-one/.github/issues/276); the page itself is [#290](https://github.com/ChipIn-one/.github/issues/290).

## Decision

Owner decision, 2026-11-14:

- There is no separate repository or service for team notifications. They are steps in GitHub Actions workflows, built on the shared action `automation/slack-notify-action`.
- A standalone service is reconsidered only when one of two things happens:
  1. an event source outside GitHub cannot be wrapped in a workflow;
  2. Slack needs state: deduplication, digests or routing.
- End-user notifications (push, email, Telegram) are out of scope. They are tracked in [chipin-frontend#222](https://github.com/ChipIn-one/chipin-frontend/issues/222).

The repository `chipin-notifications` held the design of a standalone service that was never built. It is archived once this page is merged.

## Earlier decisions D21 to D24

These were taken on 2026-10-20 in `chipin-notifications`. Only the parts that still apply are kept here.

- D21: no standalone service now. The CTO review found that a Workers, database and queue service is sized for the wrong team. Notifications run as GitHub Actions steps.
- D22: no money. Notifications must run on free allowances only: free runners, free Slack Incoming Webhooks, `GITHUB_TOKEN`. A design that fits a free tier only conditionally does not qualify.
- D23: plan for a team of two or three people and at most one QA person. QA handoff is bound to one commit SHA through a QA Issue. QA never gates a merge. Automatic QA assignment is not built.
- D24: Slack delivery uses one dedicated Slack App with Incoming Webhooks, one webhook per channel, stored as repository secrets. Delivery is at-least-once, so an occasional duplicate is acceptable. No threads, message updates or direct messages.

The 2026-11-14 decision above supersedes D21 where the two differ: the Slack logic now lives in one shared action in this repository, not in inline workflow code.

## Channels

Owner decision, 2026-11-25: releases and CI never share a channel.

| Channel | What posts there | Secret |
| --- | --- | --- |
| `#ci` | red CI and failed deploys from every repository | `SLACK_WEBHOOK_CI` |
| `#fe-releases` | frontend release QA (handoff and results) and production release announcements | `SLACK_WEBHOOK_FE_RELEASES` |
| `#be-releases` | reserved for backend release announcements; nothing posts there yet | none yet |
| `#ci-releases` | the GitHub Slack app feed; no workflow writes there | none |

A secret name always means the same channel in every repository. A new kind of message that fits neither `#ci` nor a release channel gets a new channel, a new webhook and a new secret name.

## Events

| Repository | Workflow | Event | Channel | Secret |
| --- | --- | --- | --- | --- |
| `chipin-frontend` | `frontend-ci.yml`, job `notify-master-failure` | `frontend-ci` fails on a push to `master` | `#ci` | `SLACK_WEBHOOK_CI` |
| `chipin-frontend` | `prepare-release-qa.yml` | release candidate QA handoff: mentions the assigned QA, or says the owner checks, or says no QA is needed | `#fe-releases` | `SLACK_WEBHOOK_FE_RELEASES` |
| `chipin-frontend` | `release-qa-result.yml` | a QA result is posted or withdrawn on the QA Issue | `#fe-releases` | `SLACK_WEBHOOK_FE_RELEASES` |
| `chipin-frontend` | `release-on-production.yml`, job `notify` | production release announcement, rollback, or not released ([chipin-frontend#484](https://github.com/ChipIn-one/chipin-frontend/issues/484)) | `#fe-releases` | `SLACK_WEBHOOK_FE_RELEASES` |
| `chipin-backend` | `notify-deploy-failure.yml` ([chipin-backend#312](https://github.com/ChipIn-one/chipin-backend/issues/312), in progress) | `Deploy Staging`, `Redeploy Staging` or `Deploy Production` fails or times out | `#ci` | `SLACK_WEBHOOK_CI` |

There is no feed of successes. Only failures, QA handoffs and results, and production releases post.

## Secrets

- Each repository stores its own webhook secret. Organization secrets are not available to private repositories on the Free plan.
- `SLACK_WEBHOOK_CI` holds the `#ci` webhook and `SLACK_WEBHOOK_FE_RELEASES` the `#fe-releases` webhook. The same URL is stored in every repository that posts to that channel, always under the same secret name.
- A webhook URL posts to exactly one channel, so pointing a secret at another channel means storing that channel's webhook URL; the workflows do not change.
- A missing secret means the step is skipped. It is never a failure.
- The URL must come from `secrets.*`, never `vars.*`: variables are not secret and are not masked in logs.
- The URL is never printed, echoed or written to a summary.

## Add a caller

1. Pick the channel and the secret from the [channels table](#channels). A new channel needs a new webhook and a new secret name; add its row to the channels table in the same pull request.
2. Add a separate job, or at least a separate step, for the notification.
3. Build the message text in a step that reads external values from `env:`.
4. Escape `&`, `<` and `>` in every external value (Slack mrkdwn rules) before it goes into the text.
5. Pass multi-line text through `$GITHUB_OUTPUT` with a random heredoc delimiter.
6. Call the action pinned by full commit SHA with a version comment, with `continue-on-error: true`.
7. Add a row to the events table.

Minimal example:

```yaml
notify:
  runs-on: ubuntu-24.04
  permissions: {}
  steps:
    - name: Build the message
      id: message
      env:
        PR_TITLE: ${{ github.event.pull_request.title }}
      run: |
        set -euo pipefail
        title="$(printf '%s' "$PR_TITLE" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
        delimiter="EOF_$(openssl rand -hex 8)"
        { echo "text<<$delimiter"; echo "Merged: $title"; echo "$delimiter"; } >> "$GITHUB_OUTPUT"
    - name: Notify Slack
      continue-on-error: true
      uses: ChipIn-one/.github/automation/slack-notify-action@<full-commit-sha> # vX.Y.Z
      with:
        webhook-url: ${{ secrets.SLACK_WEBHOOK_CI }}
        text: ${{ steps.message.outputs.text }}
```

The step that posts holds the webhook and nothing else: no write token in that step, and its job never checks out pull request code or runs `npm install`. Inputs, the `result` output and the exact failure contract are in the [Slack notification section of the automation README](../../automation/README.md#slack-notification). They are not repeated here.

## Security rules

- Workflow inputs are untrusted data: pull request and Issue titles, bodies, comments, branch names and commit messages. Pass them through `env:`, never through `${{ }}` inside `run:`.
- Escape `&`, `<` and `>` before external text goes into a message. Mentions come from a fixed map of GitHub login to Slack user ID, never from message content.
- The webhook URL lives only in `secrets.*`. It is never logged, put in a summary, an artifact or a message.
- The webhook never shares a step with write tokens, and never shares a job with pull request code or install scripts (`npm install`, build steps).
- A notification never gates anything. It is not a required check, its step uses `continue-on-error: true`, and a Slack outage cannot block CI, QA or a release.
- A message is a hint, not evidence. A release announcement is sent only from a verified production deployment, and a QA result is bound to one full commit SHA. A message never grants QA, merge or release authority.
- Pin the action by full commit SHA. Dependabot raises the pin in repositories that enable its `github-actions` ecosystem.
