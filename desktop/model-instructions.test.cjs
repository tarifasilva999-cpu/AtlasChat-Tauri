'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadModelInstructions, withModelInstructions } = require('./model-instructions.cjs');

for (const choice of ['apex-ultra', 'ultra-code', 'forge']) {
  test(`${choice} uses one leading system message and one profile`, async () => {
    const profile = await loadModelInstructions(choice);
    const user = { role: 'user', content: 'Hello' };
    const result = withModelInstructions([{ role: 'system', content: 'Existing instructions' }, user], choice, profile);
    assert.deepEqual(result.map(message => message.role), ['system', 'user']);
    assert.ok(result[0].content.includes('Existing instructions'));
    assert.equal(result[0].content.split(profile.marker).length - 1, 1);
    assert.deepEqual(withModelInstructions(result, choice, profile), result);
  });
}
