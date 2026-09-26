import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
    for (const heading of ["Problem", "Outcome", "Acceptance", "Dependencies", "References"]) {
      assert.match(text, new RegExp(`label: ${heading}`));
    }
  });
}
