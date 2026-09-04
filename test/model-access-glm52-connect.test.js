// v3.9.30 advertised glm-5.2 for selector glm-5-2. Operator allow/block
// lists that still carry glm-5.1 (the v3.9.29 discovery id) must match
// glm-5.2 on the Connect path. Cascade keeps distinct uids — no fold.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getModelAccessConfig,
  isModelAllowed,
  setModelAccessList,
  setModelAccessMode,
} from '../src/dashboard/model-access.js';

const original = getModelAccessConfig();
const originalConnect = process.env.DEVIN_CONNECT;
after(() => {
  if (originalConnect === undefined) delete process.env.DEVIN_CONNECT;
  else process.env.DEVIN_CONNECT = originalConnect;
  setModelAccessMode(original.mode);
  setModelAccessList(original.list);
});

describe('isModelAllowed glm-5.1/glm-5.2 Connect discovery pair', () => {
  test('Connect allowlist: glm-5.1 entry allows glm-5.2', () => {
    process.env.DEVIN_CONNECT = '1';
    setModelAccessMode('allowlist');
    setModelAccessList(['glm-5.1']);
    assert.equal(isModelAllowed('glm-5.1').allowed, true);
    assert.equal(isModelAllowed('glm-5.2').allowed, true,
      'v3.9.30 discovery id must inherit a v3.9.29 glm-5.1 allowlist entry');
  });

  test('Connect allowlist: glm-5.2 entry allows glm-5.1', () => {
    process.env.DEVIN_CONNECT = '1';
    setModelAccessMode('allowlist');
    setModelAccessList(['glm-5.2']);
    assert.equal(isModelAllowed('glm-5.2').allowed, true);
    assert.equal(isModelAllowed('glm-5.1').allowed, true);
  });

  test('Connect blocklist: glm-5.1 entry blocks glm-5.2', () => {
    process.env.DEVIN_CONNECT = '1';
    setModelAccessMode('blocklist');
    setModelAccessList(['glm-5.1']);
    assert.equal(isModelAllowed('glm-5.1').allowed, false);
    assert.equal(isModelAllowed('glm-5.2').allowed, false,
      'blocking glm-5.1 must still stop auto-discovered glm-5.2');
  });

  test('Connect blocklist: glm-5.2 entry blocks glm-5.1', () => {
    process.env.DEVIN_CONNECT = '1';
    setModelAccessMode('blocklist');
    setModelAccessList(['glm-5.2']);
    assert.equal(isModelAllowed('glm-5.2').allowed, false);
    assert.equal(isModelAllowed('glm-5.1').allowed, false);
  });

  test('Cascade does not fold glm-5.1 with glm-5.2', () => {
    process.env.DEVIN_CONNECT = '0';
    setModelAccessMode('allowlist');
    setModelAccessList(['glm-5.1']);
    assert.equal(isModelAllowed('glm-5.1').allowed, true);
    assert.equal(isModelAllowed('glm-5.2').allowed, false,
      'Cascade uids glm-5-1 and glm-5-2 stay distinct');
  });

  test('Connect does not generalize to other alias pairs', () => {
    process.env.DEVIN_CONNECT = '1';
    setModelAccessMode('allowlist');
    setModelAccessList(['gpt-5.5']);
    assert.equal(isModelAllowed('gpt-5.5').allowed, true);
    assert.equal(isModelAllowed('gpt-5.5-low').allowed, false);
  });
});
