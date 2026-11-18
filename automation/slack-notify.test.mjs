import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SlackNotifyError,
  buildPayload,
  escapeMrkdwn,
  parseTimeoutSeconds,
  postToSlack,
  run,
} from "./slack-notify.mjs";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secretTokenValue123";
const MODULE = fileURLToPath(new URL("./slack-notify.mjs", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./slack-notify-cli.mjs", import.meta.url));

function capture() {
  const lines = [];
  return { stream: { write: (chunk) => { lines.push(String(chunk)); return true; } }, text: () => lines.join("") };
}

function okFetch(calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return { status: 200, text: async () => "ok" };
  };
}

// Output must not contain the webhook URL anywhere except the `::add-mask::` command, which the runner consumes.
function assertUrlNotPrinted(output) {
  const withoutMask = output.split("\n").filter((line) => !line.startsWith("::add-mask::")).join("\n");
  assert.ok(!withoutMask.includes(WEBHOOK), "webhook WEBHOOK printed: " + withoutMask);
  assert.ok(!withoutMask.includes("secretTokenValue123"), "webhook token printed");
}

async function runWith(env, fetchImpl) {
  const out = capture();
  const dir = mkdtempSync(join(tmpdir(), "slack-notify-"));
  const outputFile = join(dir, "output");
  try {
    const result = await run({ env: { GITHUB_OUTPUT: outputFile, ...env }, stdout: out.stream, fetchImpl });
    let githubOutput = "";
    try { githubOutput = readFileSync(outputFile, "utf8"); } catch { githubOutput = ""; }
    return { result, output: out.text(), githubOutput };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("escapeMrkdwn escapes &, < and > and nothing else", () => {
  assert.equal(escapeMrkdwn("a & b <@U123> > c *bold*"), "a &amp; b &lt;@U123&gt; &gt; c *bold*");
  assert.equal(escapeMrkdwn("&amp;"), "&amp;amp;");
  assert.equal(escapeMrkdwn(undefined), "");
  assert.equal(escapeMrkdwn(42), "42");
});

test("buildPayload: text only, blocks string, blocks array, empty blocks", () => {
  assert.deepEqual(buildPayload({ text: "hi" }), { text: "hi" });
  assert.deepEqual(buildPayload({ text: "hi", blocks: "" }), { text: "hi" });
  assert.deepEqual(buildPayload({ text: "hi", blocks: "  " }), { text: "hi" });
  assert.deepEqual(buildPayload({ text: "hi", blocks: "[]" }), { text: "hi" });
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: "x" } }];
  assert.deepEqual(buildPayload({ text: "hi", blocks: JSON.stringify(blocks) }), { text: "hi", blocks });
  assert.deepEqual(buildPayload({ text: "hi", blocks }), { text: "hi", blocks });
});

test("buildPayload rejects empty text, invalid JSON and non-array blocks", () => {
  assert.throws(() => buildPayload({ text: "" }), (error) => error instanceof SlackNotifyError && error.code === "INVALID_TEXT");
  assert.throws(() => buildPayload({ text: "  " }), /text is empty/u);
  assert.throws(() => buildPayload({ text: "hi", blocks: "[{" }), (error) => error.code === "INVALID_BLOCKS" && /not valid JSON/u.test(error.message));
  assert.throws(() => buildPayload({ text: "hi", blocks: "{\"type\":\"section\"}" }), /must be a JSON array/u);
  assert.throws(() => buildPayload({ text: "hi", blocks: "null" }), /must be a JSON array/u);
});

test("parseTimeoutSeconds: default, value, cap and invalid", () => {
  assert.equal(parseTimeoutSeconds(""), 10);
  assert.equal(parseTimeoutSeconds(undefined), 10);
  assert.equal(parseTimeoutSeconds("2.5"), 2.5);
  assert.equal(parseTimeoutSeconds("600"), 60);
  assert.throws(() => parseTimeoutSeconds("0"), /positive number/u);
  assert.throws(() => parseTimeoutSeconds("abc"), /positive number/u);
});

test("postToSlack posts JSON to the webhook with an abort signal", async () => {
  const calls = [];
  const answer = await postToSlack({ url: WEBHOOK, payload: { text: "hi" }, timeoutMs: 1000, fetchImpl: okFetch(calls) });
  assert.deepEqual(answer, { status: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WEBHOOK);
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].init.headers["content-type"], /^application\/json/u);
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: "hi" });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("postToSlack: timeout aborts the request", async () => {
  const hanging = (url, init) => new Promise((resolvePromise, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  await assert.rejects(
    postToSlack({ url: WEBHOOK, payload: { text: "hi" }, timeoutMs: 20, fetchImpl: hanging }),
    (error) => error.code === "TIMEOUT",
  );
});

test("postToSlack: non-2xx is an error with the status and a short safe snippet", async () => {
  const body = "invalid_payload " + WEBHOOK + " " + "x".repeat(500) + "\u0007";
  const fetchImpl = async () => ({ status: 400, text: async () => body });
  await assert.rejects(postToSlack({ url: WEBHOOK, payload: { text: "hi" }, timeoutMs: 1000, fetchImpl }), (error) => {
    assert.equal(error.code, "HTTP_STATUS");
    assert.match(error.message, /HTTP 400 \(invalid_payload \*\*\*/u);
    assert.ok(!error.message.includes(WEBHOOK));
    assert.ok(error.message.length < 160);
    return true;
  });
});

test("postToSlack rejects a non-Slack URL before any request", async () => {
  const calls = [];
  await assert.rejects(
    postToSlack({ url: "https://example.com/hook", payload: { text: "hi" }, timeoutMs: 1000, fetchImpl: okFetch(calls) }),
    (error) => error.code === "INVALID_WEBHOOK",
  );
  assert.equal(calls.length, 0);
});

test("run: empty webhook is skipped without a request", async () => {
  const calls = [];
  for (const webhook of [undefined, "", "   "]) {
    const { result, output, githubOutput } = await runWith({ SLACK_WEBHOOK_URL: webhook, SLACK_TEXT: "hi" }, okFetch(calls));
    assert.equal(result, "skipped");
    assert.match(output, /Slack webhook not configured; skipping/u);
    assert.equal(githubOutput, "result=skipped\n");
  }
  assert.equal(calls.length, 0);
});

test("run: a non-Slack webhook fails without a request and is never printed", async () => {
  const bad = "http://hooks.slack.com/services/T000/B000/secretTokenValue123";
  for (const webhook of [bad, "https://evil.example/hooks.slack.com/x", "https://hooks.slack.com.evil.example/x"]) {
    const calls = [];
    const { result, output, githubOutput } = await runWith({ SLACK_WEBHOOK_URL: webhook, SLACK_TEXT: "hi" }, okFetch(calls));
    assert.equal(result, "failed");
    assert.equal(calls.length, 0);
    assert.equal(githubOutput, "result=failed\n");
    assert.match(output, /^::warning title=Slack notification::/mu);
    assert.ok(!output.includes(webhook), "rejected webhook printed");
    assert.ok(!output.includes("::add-mask::"), "rejected webhook must not be echoed even as a mask");
    assert.ok(!output.includes("secretTokenValue123"));
  }
});

test("run: success is sent, masks the URL first and never prints it otherwise", async () => {
  const calls = [];
  const { result, output, githubOutput } = await runWith(
    { SLACK_WEBHOOK_URL: WEBHOOK + "\n", SLACK_TEXT: "Release *v1.2.3* " + escapeMrkdwn("<x>"), SLACK_BLOCKS: "" },
    okFetch(calls),
  );
  assert.equal(result, "sent");
  assert.equal(githubOutput, "result=sent\n");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, WEBHOOK);
  assert.equal(JSON.parse(calls[0].init.body).text, "Release *v1.2.3* &lt;x&gt;");
  const lines = output.split("\n");
  assert.equal(lines[0], "::add-mask::" + WEBHOOK);
  assertUrlNotPrinted(output);
});

test("run: invalid blocks fail without a request", async () => {
  const calls = [];
  const { result, output, githubOutput } = await runWith({ SLACK_WEBHOOK_URL: WEBHOOK, SLACK_TEXT: "hi", SLACK_BLOCKS: "{oops" }, okFetch(calls));
  assert.equal(result, "failed");
  assert.equal(githubOutput, "result=failed\n");
  assert.equal(calls.length, 0);
  assert.match(output, /::warning title=Slack notification::Slack notification not sent: input blocks is not valid JSON/u);
  assertUrlNotPrinted(output);
});

test("run: timeout fails with a warning", async () => {
  const hanging = (url, init) => new Promise((resolvePromise, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted " + url)));
  });
  const { result, output } = await runWith({ SLACK_WEBHOOK_URL: WEBHOOK, SLACK_TEXT: "hi", SLACK_TIMEOUT_SECONDS: "0.05" }, hanging);
  assert.equal(result, "failed");
  assert.match(output, /::warning title=Slack notification::Slack notification not sent: Slack did not answer within 50 ms/u);
  assertUrlNotPrinted(output);
});

test("run: non-2xx fails with the status and no URL", async () => {
  const fetchImpl = async () => ({ status: 404, text: async () => "no_service for " + WEBHOOK });
  const { result, output } = await runWith({ SLACK_WEBHOOK_URL: WEBHOOK, SLACK_TEXT: "hi" }, fetchImpl);
  assert.equal(result, "failed");
  assert.match(output, /HTTP 404 \(no_service for \*\*\*\)/u);
  assertUrlNotPrinted(output);
});

test("run: a network error carrying the URL fails without printing it", async () => {
  const fetchImpl = async (url) => { throw new TypeError("fetch failed for " + url); };
  const { result, output } = await runWith({ SLACK_WEBHOOK_URL: WEBHOOK, SLACK_TEXT: "hi" }, fetchImpl);
  assert.equal(result, "failed");
  assert.match(output, /request to Slack failed \(TypeError\)/u);
  assertUrlNotPrinted(output);
});

test("run: an unexpected throw inside fetch is reported as failed", async () => {
  const fetchImpl = () => { throw Object.assign(new Error(WEBHOOK), { name: WEBHOOK }); };
  const { result, output } = await runWith({ SLACK_WEBHOOK_URL: WEBHOOK, SLACK_TEXT: "hi" }, fetchImpl);
  assert.equal(result, "failed");
  assertUrlNotPrinted(output);
});

test("run: empty text fails without a request", async () => {
  const calls = [];
  const { result, output } = await runWith({ SLACK_WEBHOOK_URL: WEBHOOK, SLACK_TEXT: "" }, okFetch(calls));
  assert.equal(result, "failed");
  assert.equal(calls.length, 0);
  assert.match(output, /input text is empty/u);
  assertUrlNotPrinted(output);
});

test("CLI exits 0 and prints nothing secret for a rejected webhook", () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-notify-cli-"));
  const outputFile = join(dir, "output");
  try {
    const bad = "https://example.com/services/secretTokenValue123";
    const child = spawnSync(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: outputFile, SLACK_WEBHOOK_URL: bad, SLACK_TEXT: "hi" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0);
    assert.ok(!(child.stdout + child.stderr).includes("secretTokenValue123"));
    assert.equal(readFileSync(outputFile, "utf8"), "result=failed\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI exits 0 and skips without a webhook", () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-notify-cli-"));
  const outputFile = join(dir, "output");
  try {
    const child = spawnSync(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: outputFile, SLACK_TEXT: "hi" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0);
    assert.match(child.stdout, /Slack webhook not configured; skipping/u);
    assert.equal(child.stderr, "");
    assert.equal(readFileSync(outputFile, "utf8"), "result=skipped\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importing slack-notify.mjs has no side effects, even with SLACK_* env and the module path in argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-notify-import-"));
  const outputFile = join(dir, "output");
  try {
    const child = spawnSync(process.execPath, [
      "--input-type=module", "-e",
      "const m = await import(process.argv[1]); process.stdout.write(m.escapeMrkdwn('<a>'));",
      MODULE,
    ], {
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: outputFile, SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/x", SLACK_TEXT: "hi" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0);
    assert.equal(child.stdout, "&lt;a&gt;");
    assert.equal(child.stderr, "");
    assert.throws(() => readFileSync(outputFile, "utf8"), { code: "ENOENT" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postToSlack: a non-2xx body that never arrives fails within the timeout", async () => {
  const fetchImpl = async () => ({ status: 500, text: () => new Promise(() => {}) });
  const started = Date.now();
  await assert.rejects(
    postToSlack({ url: WEBHOOK, payload: { text: "hi" }, timeoutMs: 50, fetchImpl }),
    (error) => error.code === "HTTP_STATUS" && /HTTP 500 \(body not read before the timeout\)/u.test(error.message),
  );
  assert.ok(Date.now() - started < 1000);
});

test("postToSlack: a 2xx answer is sent even when its body stalls, and the body is read", async () => {
  let read = 0;
  const stalled = async () => ({ status: 200, text: () => { read += 1; return new Promise(() => {}); } });
  assert.deepEqual(await postToSlack({ url: WEBHOOK, payload: { text: "hi" }, timeoutMs: 50, fetchImpl: stalled }), { status: 200 });
  const normal = async () => ({ status: 200, text: async () => { read += 1; return "ok"; } });
  assert.deepEqual(await postToSlack({ url: WEBHOOK, payload: { text: "hi" }, timeoutMs: 1000, fetchImpl: normal }), { status: 200 });
  assert.equal(read, 2);
});

test("run: a non-2xx body that never arrives gives failed within the timeout", async () => {
  const fetchImpl = async () => ({ status: 503, text: () => new Promise(() => {}) });
  const { result, output } = await runWith({ SLACK_WEBHOOK_URL: WEBHOOK, SLACK_TEXT: "hi", SLACK_TIMEOUT_SECONDS: "0.05" }, fetchImpl);
  assert.equal(result, "failed");
  assert.match(output, /HTTP 503/u);
  assertUrlNotPrinted(output);
});

test("run: GITHUB_OUTPUT unset or unwritable still returns the result", async () => {
  const out = capture();
  assert.equal(await run({ env: { SLACK_TEXT: "hi" }, stdout: out.stream, fetchImpl: okFetch() }), "skipped");
  assert.match(out.text(), /result=skipped/u);
  const dir = mkdtempSync(join(tmpdir(), "slack-notify-ro-"));
  try {
    const out2 = capture();
    const result = await run({
      env: { GITHUB_OUTPUT: join(dir, "missing", "output"), SLACK_WEBHOOK_URL: WEBHOOK, SLACK_TEXT: "hi" },
      stdout: out2.stream,
      fetchImpl: okFetch(),
    });
    assert.equal(result, "sent");
    assertUrlNotPrinted(out2.text());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function actionRunScript() {
  const action = readFileSync(new URL("./slack-notify-action/action.yml", import.meta.url), "utf8");
  const lines = action.split("\n");
  const start = lines.findIndex((line) => line.trim() === "run: |");
  assert.ok(start > 0, "action has a run block");
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith("        ")) break;
    body.push(line.slice(8));
  }
  return { action, script: body.join("\n") };
}

test("action.yml passes inputs only through env and calls the CLI entry", () => {
  const { action, script } = actionRunScript();
  assert.doesNotMatch(script, /\$\{\{/u);
  assert.match(script, /^set -euo pipefail$/mu);
  assert.match(script, /\$GITHUB_ACTION_PATH\/\.\.\/slack-notify-cli\.mjs/u);
  for (const name of ["SLACK_WEBHOOK_URL: ${{ inputs.webhook-url }}", "SLACK_TEXT: ${{ inputs.text }}", "SLACK_BLOCKS: ${{ inputs.blocks }}", "SLACK_TIMEOUT_SECONDS: ${{ inputs.timeout-seconds }}"]) {
    assert.ok(action.includes(name), name);
  }
  assert.match(action, /value: \$\{\{ steps\.notify\.outputs\.result \}\}/u);
});

test("action.yml step: a notifier that cannot start still exits 0 with result=failed", () => {
  const { script } = actionRunScript();
  const dir = mkdtempSync(join(tmpdir(), "slack-notify-action-"));
  try {
    const actionPath = join(dir, "slack-notify-action");
    mkdirSync(actionPath);
    const outputFile = join(dir, "output");
    const child = spawnSync("bash", ["-c", script], {
      env: { PATH: process.env.PATH, GITHUB_ACTION_PATH: actionPath, GITHUB_OUTPUT: outputFile, SLACK_TEXT: "hi" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0);
    assert.match(child.stdout, /::warning title=Slack notification::Slack notification not sent: notifier did not run/u);
    assert.equal(readFileSync(outputFile, "utf8"), "result=failed\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
