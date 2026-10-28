import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateBody } from "./issue-admission.mjs";
import { parseYamlSubset } from "./registry.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forms = {
  "bug.yml": "Bug",
  "enhancement.yml": "Feature",
  "docs.yml": "Task",
  "research.yml": "Task",
  "tests.yml": "Task",
};

for (const [file, issueType] of Object.entries(forms)) {
  test(`${file} stays on the shared canonical issue schema`, async () => {
    const text = await readFile(resolve(root, ".github/ISSUE_TEMPLATE", file), "utf8");
    assert.match(text, new RegExp(`^type: ${issueType}$`, "m"));
    assert.doesNotMatch(text, /^labels:/m);
    assert.doesNotMatch(text, /^milestone:/m);
    assert.doesNotMatch(text, /^projects:/m);
    assert.match(text, /Issue metadata finalizer/);
    assert.match(text, /Priority/);
    assert.match(text, /Milestone is optional/);
    assert.doesNotMatch(text, /Release scope|release_scope|releaseScope/);
    for (const heading of ["Problem", "Outcome", "Acceptance", "Dependencies", "References"]) {
      assert.match(text, new RegExp(`label: ${heading}`));
    }
  });
}

// QA bug form for frontend release QA rounds (#229). It deliberately presets
// type/labels/assignees/projects, so it is not part of the generic schema above.
// parseYamlSubset has no block scalars; lift `key: |` blocks out first and put
// them back after parsing.
function parseIssueForm(text) {
  const blocks = [];
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)([\w-]+): \|$/.exec(lines[i]);
    if (!match) { out.push(lines[i]); continue; }
    const indent = match[1].length;
    const body = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === "" || lines[i + 1].search(/\S/) > indent)) body.push(lines[++i]);
    const cut = Math.min(...body.filter(line => line.trim()).map(line => line.search(/\S/)));
    blocks.push(body.map(line => line.slice(cut)).join("\n").replace(/\n*$/, "\n"));
    out.push(`${match[1]}${match[2]}: '__BLOCK_${blocks.length - 1}__'`);
  }
  const restore = value => {
    if (typeof value === "string") return value.replace(/^__BLOCK_(\d+)__$/, (_, n) => blocks[Number(n)]);
    if (Array.isArray(value)) return value.map(restore);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restore(v)]));
    return value;
  };
  return restore(parseYamlSubset(out.join("\n")));
}

// Same shape GitHub uses for the submitted body: one `### <label>` per
// non-markdown field, answer below, `_No response_` for an empty field.
function renderIssueFormBody(form, answers) {
  return form.body
    .filter(element => element.type !== "markdown")
    .map(element => `### ${element.attributes.label}\n\n${answers[element.id]?.trim() || "_No response_"}`)
    .join("\n\n");
}

const qaForm = parseIssueForm(await readFile(resolve(root, ".github/ISSUE_TEMPLATE/qa-bug.yml"), "utf8"));
const qaAnswers = {
  problem: "1. Открыл Preview и вошёл в аккаунт.\n2. Нажал «Добавить расход» в группе «Поездка».\n3. Ввёл 100 и нажал «Сохранить».\nУвидел: расход не появился в списке.",
  device: "Android Chrome",
  "preview-url": "https://chipin-frontend-git-master-chipin.vercel.app",
  impact: "мешает, но есть обход",
  media: "",
  outcome: "После «Сохранить» расход сразу виден в списке группы.",
  acceptance: "- [ ] QA: добавить расход 100 в группе => расход виден в списке",
  references: "https://github.com/ChipIn-one/chipin-frontend/issues/560",
};

test("qa-bug.yml presets type, label, assignee, project and title prefix", () => {
  assert.equal(qaForm.name, "QA bug (frontend Preview)");
  assert.equal(qaForm.type, "Bug");
  assert.deepEqual(qaForm.labels, ["Frontend"]);
  assert.deepEqual(qaForm.assignees, ["syllik"]);
  assert.deepEqual(qaForm.projects, ["ChipIn-one/5"]);
  assert.equal(qaForm.title, "QA: ");
});

test("qa-bug.yml keeps the issue field order and required flags", () => {
  const fields = qaForm.body.filter(element => element.type !== "markdown");
  assert.deepEqual(fields.map(f => [f.attributes.label, f.type, f.validations.required]), [
    ["Problem", "textarea", true],
    ["Устройство", "dropdown", true],
    ["Preview URL", "input", true],
    ["Насколько мешает", "dropdown", true],
    ["Скриншоты или видео", "textarea", false],
    ["Outcome", "textarea", true],
    ["Acceptance", "textarea", true],
    ["References", "input", true],
  ]);
  const acceptance = fields.find(f => f.id === "acceptance");
  assert.equal(acceptance.attributes.value, "- [ ] QA: <шаг> => <как должно быть>");
  assert.match(acceptance.attributes.description, /угловы/);
  const ids = fields.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("qa-bug.yml rendered body passes canonical admission validateBody", () => {
  const body = renderIssueFormBody(qaForm, qaAnswers);
  assert.match(body, /^### Скриншоты или видео\n\n_No response_$/m);
  assert.deepEqual(validateBody("QA: расход не сохраняется", body), []);
});

test("qa-bug.yml rendered body with an empty Outcome is rejected", () => {
  const body = renderIssueFormBody(qaForm, { ...qaAnswers, outcome: "" });
  assert.ok(validateBody("QA: расход не сохраняется", body).includes("Issue body needs substantive ## outcome."));
});

test("qa-bug.yml Problem is guarded by the form, not by admission", () => {
  // Устройство / Preview URL / Насколько мешает render as `###` headings that
  // admission does not know, so they fall inside ## Problem and keep it
  // substantive. An empty Problem is stopped only by `required: true`.
  assert.equal(qaForm.body.find(element => element.id === "problem").validations.required, true);
  const body = renderIssueFormBody(qaForm, { ...qaAnswers, problem: "" });
  assert.deepEqual(validateBody("QA: расход не сохраняется", body), []);
});
