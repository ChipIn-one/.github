// CLI entry of the Slack notification (automation/slack-notify.mjs), called by slack-notify-action.
// Always exits 0: a notification must never fail the caller job.

import process from "node:process";

import { run } from "./slack-notify.mjs";

try {
  await run();
} catch {
  process.stdout.write("::warning title=Slack notification::Slack notification not sent: unexpected error\n");
}
process.exitCode = 0;
