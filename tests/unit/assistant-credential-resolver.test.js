import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveCredential,
    describeBinding
} from '../../src/assistant-agent/credential-resolver.js';

test('resolveCredential rejects null / non-object / missing fields without I/O', async () => {
    assert.equal(await resolveCredential(null), null);
    assert.equal(await resolveCredential(undefined), null);
    assert.equal(await resolveCredential('string'), null);
    assert.equal(await resolveCredential({}), null);
    assert.equal(await resolveCredential({ type: 'api-key' }), null);
    assert.equal(await resolveCredential({ id: 'key_x' }), null);
});

test('resolveCredential rejects unknown credential types', async () => {
    assert.equal(await resolveCredential({ type: 'unknown', id: 'x' }), null);
    assert.equal(await resolveCredential({ type: '', id: 'x' }), null);
});

test('resolveCredential returns null when api-key id does not exist', async () => {
    const result = await resolveCredential({ type: 'api-key', id: 'this-id-does-not-exist-anywhere' });
    assert.equal(result, null);
});

test('resolveCredential returns null when claude account email does not exist', async () => {
    const result = await resolveCredential({ type: 'claude-account', id: 'no-such-account@nowhere.example' });
    assert.equal(result, null);
});

test('resolveCredential returns null when chatgpt account email does not exist', async () => {
    const result = await resolveCredential({ type: 'chatgpt-account', id: 'no-such-account@nowhere.example' });
    assert.equal(result, null);
});

test('describeBinding reports failure with reason when descriptor is missing', async () => {
    const result = await describeBinding(null);
    assert.equal(result.ok, false);
    assert.match(result.reason, /no descriptor/i);
});

test('describeBinding reports failure when credential is missing', async () => {
    const result = await describeBinding({ type: 'api-key', id: 'definitely-not-a-real-id' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not found|disabled/i);
    assert.deepEqual(result.descriptor, { type: 'api-key', id: 'definitely-not-a-real-id' });
});
