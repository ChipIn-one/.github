import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateDevReadiness } from './dev-readiness.mjs';

const scenarios = JSON.parse(
  await readFile(new URL('./scenarios.json', import.meta.url), 'utf8'),
);

for (const scenario of scenarios) {
  test(`dry-run: ${scenario.name}`, () => {
    const result = evaluateDevReadiness(scenario.input);
    assert.equal(result.state, scenario.expected, result.reason);
  });
}
