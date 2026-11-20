// Slack notification: post one message to a Slack Incoming Webhook (.github#276).
//
//   SLACK_WEBHOOK_URL=... SLACK_TEXT="..." [SLACK_BLOCKS='[...]'] [SLACK_TIMEOUT_SECONDS=10] node automation/slack-notify-cli.mjs
//
// This module has no side effects on import (callers may import `escapeMrkdwn`); the CLI entry is
// slack-notify-cli.mjs.
// A notification must never fail the caller job: every outcome exits 0 and is reported as
// `result=sent|skipped|failed` in $GITHUB_OUTPUT. An empty webhook is `skipped`; a webhook that is not
// `https://hooks.slack.com/...`, an invalid payload, a timeout, a network error or a non-2xx answer is
// `failed` with a `::warning::` line. The webhook URL is a secret: it is masked (`::add-mask::`) before any
// network call and is never printed otherwise, not even when it is rejected.
// `text` is Slack mrkdwn built by the caller; the caller escapes external values with `escapeMrkdwn`.

import fs from "node:fs";
import process from "node:process";

export const SLACK_WEBHOOK_PATTERN = /^https:\/\/hooks\.slack\.com\//u;
export const DEFAULT_TIMEOUT_SECONDS = 10;
export const MAX_TIMEOUT_SECONDS = 60;
const RESPONSE_SNIPPET_LENGTH = 80;

export class SlackNotifyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Slack mrkdwn control characters: https://api.slack.com/reference/surfaces/formatting#escaping
export function escapeMrkdwn(value) {
  return String(value ?? "").replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function buildPayload({ text, blocks } = {}) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new SlackNotifyError("INVALID_TEXT", "input text is empty");
  }
  const payload = { text };
  if (blocks === undefined || blocks === null || (typeof blocks === "string" && blocks.trim() === "")) return payload;
  let parsed = blocks;
  if (typeof blocks === "string") {
    try {
      parsed = JSON.parse(blocks);
    } catch {
      throw new SlackNotifyError("INVALID_BLOCKS", "input blocks is not valid JSON");
    }
  }
  if (!Array.isArray(parsed)) throw new SlackNotifyError("INVALID_BLOCKS", "input blocks must be a JSON array");
  if (parsed.length > 0) payload.blocks = parsed;
  return payload;
}

export function parseTimeoutSeconds(value) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_TIMEOUT_SECONDS;
  const seconds = Number(String(value).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new SlackNotifyError("INVALID_TIMEOUT", "input timeout-seconds must be a positive number");
  }
  return Math.min(seconds, MAX_TIMEOUT_SECONDS);
}

export function isSlackWebhookUrl(url) {
  return typeof url === "string" && SLACK_WEBHOOK_PATTERN.test(url) && !/\s/u.test(url);
}

// Short, printable, single-line excerpt of a Slack answer (for example `invalid_payload`), with the URL removed.
function safeSnippet(body, url) {
  let text = String(body ?? "");
  if (url) text = text.split(url).join("***");
  text = text.replace(/[^\x20-\x7E]+/gu, " ").trim();
  if (text.length > RESPONSE_SNIPPET_LENGTH) text = text.slice(0, RESPONSE_SNIPPET_LENGTH) + "...";
  return text;
}

// One deadline covers the request, the headers and the body read, so a stalled answer cannot hang the job.
export async function postToSlack({ url, payload, timeoutMs, fetchImpl = globalThis.fetch }) {
  if (!isSlackWebhookUrl(url)) throw new SlackNotifyError("INVALID_WEBHOOK", "webhook URL is not a Slack Incoming Webhook URL");
  if (typeof fetchImpl !== "function") throw new SlackNotifyError("NO_FETCH", "fetch is not available in this runtime");
  const controller = new AbortController();
  const timeoutError = () => new SlackNotifyError("TIMEOUT", "Slack did not answer within " + timeoutMs + " ms");
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  deadline.catch(() => {});
  const withinDeadline = (promise) => Promise.race([promise, deadline]);
  try {
    let response;
    try {
      response = await withinDeadline(Promise.resolve().then(() => fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })));
    } catch (error) {
      if (error instanceof SlackNotifyError) throw error;
      if (controller.signal.aborted) throw timeoutError();
      const name = error && typeof error.name === "string" ? error.name : "Error";
      throw new SlackNotifyError("NETWORK", "request to Slack failed (" + safeSnippet(name, url) + ")");
    }
    if (!response || typeof response.status !== "number") throw new SlackNotifyError("NETWORK", "Slack returned no response");
    // Read the body (2xx too, so the connection is released) under the same deadline.
    let body = "";
    try {
      body = typeof response.text === "function" ? String(await withinDeadline(Promise.resolve().then(() => response.text()))) : "";
    } catch (error) {
      if (error instanceof SlackNotifyError && error.code === "TIMEOUT") {
        if (response.status >= 200 && response.status <= 299) return { status: response.status };
        throw new SlackNotifyError("HTTP_STATUS", "Slack answered HTTP " + response.status + " (body not read before the timeout)");
      }
      body = "";
    }
    if (response.status < 200 || response.status > 299) {
      const snippet = safeSnippet(body, url);
      throw new SlackNotifyError("HTTP_STATUS", "Slack answered HTTP " + response.status + (snippet ? " (" + snippet + ")" : ""));
    }
    return { status: response.status };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function writeOutput(env, result) {
  if (!env.GITHUB_OUTPUT) return;
  try {
    fs.appendFileSync(env.GITHUB_OUTPUT, "result=" + result + "\n", "utf8");
  } catch {
    // The result line is best effort; the action step falls back to `failed` when it is missing.
  }
}

// Never throws and never returns a non-zero code; returns the result string.
export async function run({ env = process.env, stdout = process.stdout, fetchImpl = globalThis.fetch } = {}) {
  const url = String(env.SLACK_WEBHOOK_URL ?? "").trim();
  const log = (line) => stdout.write(line + "\n");
  const warn = (message) => log("::warning title=Slack notification::" + (url ? String(message).split(url).join("***") : String(message)));
  let result;
  try {
    if (url === "") {
      log("Slack webhook not configured; skipping");
      result = "skipped";
    } else if (!isSlackWebhookUrl(url)) {
      warn("Slack notification not sent: the webhook is not a https://hooks.slack.com/ URL");
      result = "failed";
    } else {
      log("::add-mask::" + url);
      const payload = buildPayload({ text: env.SLACK_TEXT, blocks: env.SLACK_BLOCKS });
      const timeoutMs = Math.round(parseTimeoutSeconds(env.SLACK_TIMEOUT_SECONDS) * 1000);
      const { status } = await postToSlack({ url, payload, timeoutMs, fetchImpl });
      log("Slack notification sent (HTTP " + status + ")");
      result = "sent";
    }
  } catch (error) {
    const message = error instanceof SlackNotifyError ? error.message : "unexpected error (" + (error && error.name ? error.name : "Error") + ")";
    warn("Slack notification not sent: " + message);
    result = "failed";
  }
  writeOutput(env, result);
  log("result=" + result);
  return result;
}
