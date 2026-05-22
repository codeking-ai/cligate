import '../test-env.js';
/**
 * Unit tests for route handlers (no server required).
 * Uses lightweight mock req/res objects to test handler logic in isolation.
 *
 * Covers:
 *  - settings-route.js  (GET/POST /settings/haiku-model)
 *  - claude-config-route.js (POST /claude/config/direct validation)
 *  - accounts-route.js  (POST /accounts/switch validation)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; }
  };
  return res;
}

function mockReq(body = {}, params = {}, query = {}) {
  return { body, params, query };
}

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

process.env.CLIGATE_CONFIG_DIR = createTempDir('cligate-route-handlers-');
process.env.CLAUDE_CONFIG_PATH = createTempDir('cligate-route-handlers-claude-');

// ─── settings-route ───────────────────────────────────────────────────────────

const { handleGetHaikuModel, handleSetHaikuModel, handleGetAppRouting, handleSetAppRouting, handleGetStrictCodexCompatibility, handleSetStrictCodexCompatibility, handleGetStrictTranslatorCompatibility, handleSetStrictTranslatorCompatibility, handleGetAssistantAgentConfig, handleSetAssistantAgentConfig } = await import('../../src/routes/settings-route.js');
const { handleGetPricing, handleUpdatePricing, handleResetPricing } = await import('../../src/routes/pricing-route.js');
const { handleGetApiKey } = await import('../../src/routes/api-keys-route.js');
const { _testExports: codexConfigTestExports } = await import('../../src/routes/codex-config-route.js');
const {
  handleListSkills,
  handleGetSkillSettings,
  handleUpdateSkillSettings,
  handleSetSkillEnabled,
  handleGetSkillContent,
  handleImportSkill,
  handleCreateSkill,
  handleUpdateSkill,
  handleDeleteSkill
} = await import('../../src/routes/skills-route.js');
const {
  handleGetAssistantAgentStatus,
  handleTestAssistantBinding,
  handleGetAssistantBindingCatalog,
  handleSetAssistantBinding,
  handleResetAssistantBreaker
} = await import('../../src/routes/assistant-agent-route.js');

test('handleGetHaikuModel: returns current haikuKiloModel', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetHaikuModel(req, res);
  assert.ok(res._body !== null);
  assert.ok('haikuKiloModel' in res._body);
  // Default is now the full model ID
  assert.ok(typeof res._body.haikuKiloModel === 'string');
});

test('handleGetAppRouting: exposes antigravity binding targets', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetAppRouting(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(Array.isArray(res._body.targets?.bindingTypes));
  assert.ok(res._body.targets.bindingTypes.includes('antigravity-account'));
  assert.ok(Array.isArray(res._body.targets?.antigravityAccounts));
});

test('handleSetAppRouting: rejects enabled binding without selected targets', () => {
  const req = mockReq({
    appRouting: {
      codex: {
        enabled: true,
        bindings: [{ type: 'api-key', targetIds: [] }]
      }
    }
  });
  const res = mockRes();
  handleSetAppRouting(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
  assert.match(res._body.error, /at least one targetId is required/);
});

test('handleGetStrictCodexCompatibility: returns current strict compatibility flag', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetStrictCodexCompatibility(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(typeof res._body.strictCodexCompatibility, 'boolean');
});

test('handleSetStrictCodexCompatibility: rejects non-boolean payload', () => {
  const req = mockReq({ strictCodexCompatibility: 'yes' });
  const res = mockRes();
  handleSetStrictCodexCompatibility(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleGetStrictTranslatorCompatibility: returns current strict translator flag', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetStrictTranslatorCompatibility(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(typeof res._body.strictTranslatorCompatibility, 'boolean');
});

test('handleSetStrictTranslatorCompatibility: rejects non-boolean payload', () => {
  const req = mockReq({ strictTranslatorCompatibility: 'yes' });
  const res = mockRes();
  handleSetStrictTranslatorCompatibility(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleGetAssistantAgentConfig: returns current assistant agent settings', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetAssistantAgentConfig(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(typeof res._body.assistantAgent?.enabled, 'boolean');
  assert.equal(typeof res._body.assistantAgent?.sources?.anthropicApiKey, 'boolean');
});

test('handleSetAssistantAgentConfig: rejects malformed payload', () => {
  const req = mockReq({
    assistantAgent: {
      enabled: 'yes',
      sources: {}
    }
  });
  const res = mockRes();
  handleSetAssistantAgentConfig(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleSetAssistantAgentConfig: accepts complete boolean source map', () => {
  const req = mockReq({
    assistantAgent: {
      enabled: true,
      sources: {
        chatgptAccount: false,
        claudeAccount: false,
        anthropicApiKey: true,
        openaiApiKeyBridge: true,
        azureOpenaiApiKeyBridge: false
      }
    }
  });
  const res = mockRes();
  handleSetAssistantAgentConfig(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.assistantAgent.enabled, true);
  assert.equal(res._body.assistantAgent.sources.azureOpenaiApiKeyBridge, false);
});

test('handleSetAssistantAgentConfig: accepts new binding fields without legacy sources', () => {
  const req = mockReq({
    assistantAgent: {
      enabled: true,
      boundModelSource: { type: 'api-key', id: 'key-primary', model: 'gpt-5.4' },
      fallbacks: [{ type: 'chatgpt-account', id: 'user@example.com', model: 'gpt-5.4-mini' }],
      circuitBreaker: { failureThreshold: 4, probeIntervalMs: 180000 }
    }
  });
  const res = mockRes();
  handleSetAssistantAgentConfig(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.assistantAgent.bindingConfigured, true);
  assert.deepEqual(res._body.assistantAgent.boundModelSource, { type: 'api-key', id: 'key-primary', model: 'gpt-5.4' });
  assert.deepEqual(res._body.assistantAgent.boundCredential, { type: 'api-key', id: 'key-primary', model: 'gpt-5.4' });
  assert.deepEqual(res._body.assistantAgent.fallbacks, [{ type: 'chatgpt-account', id: 'user@example.com', model: 'gpt-5.4-mini' }]);
  assert.equal(res._body.assistantAgent.circuitBreaker.failureThreshold, 4);
  assert.equal(res._body.assistantAgent.circuitBreaker.probeIntervalMs, 180000);
});

test('handleSetAssistantAgentConfig: preserves new binding chain when legacy sources are updated', () => {
  const seed = handleSetAssistantBinding(mockReq({
    enabled: true,
    boundCredential: { type: 'api-key', id: 'key-primary' },
    fallbacks: [{ type: 'chatgpt-account', id: 'user@example.com' }],
    circuitBreaker: { failureThreshold: 5, probeIntervalMs: 120000 }
  }), mockRes());

  const req = mockReq({
    assistantAgent: {
      enabled: false,
      sources: {
        chatgptAccount: true,
        claudeAccount: false,
        anthropicApiKey: false,
        openaiApiKeyBridge: true,
        azureOpenaiApiKeyBridge: false
      }
    }
  });
  const res = mockRes();
  handleSetAssistantAgentConfig(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.assistantAgent.enabled, false);
  assert.deepEqual(res._body.assistantAgent.boundCredential, { type: 'api-key', id: 'key-primary' });
  assert.deepEqual(res._body.assistantAgent.fallbacks, [{ type: 'chatgpt-account', id: 'user@example.com' }]);
  assert.equal(res._body.assistantAgent.circuitBreaker.failureThreshold, 5);
  assert.equal(res._body.assistantAgent.circuitBreaker.probeIntervalMs, 120000);
});

test('handleGetAssistantAgentStatus: returns status payload shape', async () => {
  const req = mockReq();
  const res = mockRes();
  await handleGetAssistantAgentStatus(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(typeof res._body.status?.enabled, 'boolean');
  assert.ok(Array.isArray(res._body.status?.statuses));
  assert.ok(Array.isArray(res._body.status?.tiers));
  assert.ok(res._body.status?.catalog && typeof res._body.status.catalog === 'object');
});

test('handleTestAssistantBinding: reports failure when descriptor is invalid', async () => {
  const req = mockReq({});
  const res = mockRes();
  await handleTestAssistantBinding(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, false);
  assert.match(String(res._body.reason || ''), /not found|disabled|no descriptor/i);
});

test('handleTestAssistantBinding: reports failure for non-existent api key', async () => {
  const req = mockReq({ type: 'api-key', id: 'no-such-key-anywhere' });
  const res = mockRes();
  await handleTestAssistantBinding(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, false);
});

test('handleGetAssistantBindingCatalog: returns inventory groups', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetAssistantBindingCatalog(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(res._body.catalog?.apiKeys);
  assert.ok(Array.isArray(res._body.catalog?.claudeAccounts));
  assert.ok(Array.isArray(res._body.catalog?.chatgptAccounts));
});

test('skills routes list discovered skills and update skill settings', () => {
  const cwd = createTempDir('cligate-route-skills-cwd-');
  const skillDir = join(cwd, '.cligate', 'skills', 'demo');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---
name: demo
description: Demo skill
---
Body
`, 'utf8');

  const listReq = mockReq({}, {}, { cwd });
  const listRes = mockRes();
  handleListSkills(listReq, listRes);
  assert.equal(listRes._status, 200);
  assert.equal(listRes._body.success, true);
  assert.equal(Array.isArray(listRes._body.skills), true);
  assert.equal(listRes._body.skills.some((entry) => entry.name === 'demo'), true);

  const settingsRes = mockRes();
  handleGetSkillSettings(mockReq(), settingsRes);
  assert.equal(settingsRes._status, 200);
  assert.equal(settingsRes._body.success, true);
  assert.equal(typeof settingsRes._body.skills.enabled, 'boolean');

  const toggleReq = mockReq({
    name: 'demo',
    enabled: false
  });
  const toggleRes = mockRes();
  handleSetSkillEnabled(toggleReq, toggleRes);
  assert.equal(toggleRes._status, 200);
  assert.equal(toggleRes._body.success, true);

  const globalSettingsReq = mockReq({ enabled: true });
  const globalSettingsRes = mockRes();
  handleUpdateSkillSettings(globalSettingsReq, globalSettingsRes);
  assert.equal(globalSettingsRes._status, 200);
  assert.equal(globalSettingsRes._body.success, true);

  const listAfterRes = mockRes();
  handleListSkills(listReq, listAfterRes);
  const demo = listAfterRes._body.skills.find((entry) => entry.name === 'demo');
  assert.equal(Boolean(demo), true);
  assert.equal(demo.enabled, false);
});

test('skills routes create, read, update, and delete a user skill', () => {
  const cwd = createTempDir('cligate-route-skills-manage-cwd-');
  const createReq = mockReq({
    cwd,
    scope: 'user',
    name: 'new-skill',
    description: 'New skill',
    shortDescription: 'Short',
    whenToUse: 'Use when testing',
    tags: ['test', 'skill'],
    conflictsWith: ['other-skill'],
    body: 'Follow the instructions'
  });
  const createRes = mockRes();
  handleCreateSkill(createReq, createRes);
  assert.equal(createRes._status, 200);
  assert.equal(createRes._body.success, true);
  assert.equal(createRes._body.skill?.name, 'new-skill');

  const contentReq = mockReq({}, {}, { cwd, path: createRes._body.skill.pathToSkillMd });
  const contentRes = mockRes();
  handleGetSkillContent(contentReq, contentRes);
  assert.equal(contentRes._status, 200);
  assert.equal(contentRes._body.success, true);
  assert.equal(contentRes._body.skill?.whenToUse, 'Use when testing');
  assert.deepEqual(contentRes._body.skill?.tags, ['test', 'skill']);

  const updateReq = mockReq({
    cwd,
    path: createRes._body.skill.pathToSkillMd,
    name: 'new-skill',
    description: 'Updated skill',
    shortDescription: 'Updated short',
    whenToUse: 'Use when updating',
    tags: ['updated'],
    conflictsWith: [],
    body: 'Updated body'
  });
  const updateRes = mockRes();
  handleUpdateSkill(updateReq, updateRes);
  assert.equal(updateRes._status, 200);
  assert.equal(updateRes._body.success, true);
  assert.equal(updateRes._body.skill?.description, 'Updated skill');

  const deleteReq = mockReq({
    cwd,
    path: createRes._body.skill.pathToSkillMd
  });
  const deleteRes = mockRes();
  handleDeleteSkill(deleteReq, deleteRes);
  assert.equal(deleteRes._status, 200);
  assert.equal(deleteRes._body.success, true);
});

test('skills routes return fallback detail for legacy skill packages', () => {
  const cwd = createTempDir('cligate-route-skills-legacy-cwd-');
  const skillDir = join(cwd, '.cligate', 'skills', 'legacy-pptx-demo');
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), 'gAAAAABlegacypayload', 'utf8');
  writeFileSync(join(skillDir, 'editing.md'), '# 编辑演示文稿\n\nLegacy body', 'utf8');

  const listRes = mockRes();
  handleListSkills(mockReq({}, {}, { cwd }), listRes);
  assert.equal(listRes._status, 200);
  assert.equal(listRes._body.success, true);
  const skill = listRes._body.legacyRepoSkills.find((entry) => entry.name === 'legacy-pptx-demo');
  assert.ok(skill);

  const contentRes = mockRes();
  handleGetSkillContent(mockReq({}, {}, { cwd, path: skill.pathToSkillMd }), contentRes);
  assert.equal(contentRes._status, 200);
  assert.equal(contentRes._body.success, true);
  assert.equal(contentRes._body.skill.name, 'legacy-pptx-demo');
  assert.equal(contentRes._body.skill.shortDescription, '编辑演示文稿');
  assert.match(contentRes._body.skill.rawContent, /gAAAAABlegacypayload/);
});

test('skills routes import a directory-style repo skill package', () => {
  const cwd = createTempDir('cligate-route-skills-import-cwd-');
  writeFileSync(join(cwd, 'package.json'), '{"name":"skills-import-test"}', 'utf8');

  const importReq = mockReq({
    cwd,
    scope: 'repo',
    mode: 'directory',
    rootName: 'imported-demo',
    files: [
      {
        relativePath: 'imported-demo/SKILL.md',
        content: `---
name: imported-demo
description: Imported demo skill
---
Follow imported instructions
`,
        encoding: 'utf8'
      },
      {
        relativePath: 'imported-demo/assets/readme.txt',
        content: 'asset payload',
        encoding: 'utf8'
      }
    ]
  });
  const importRes = mockRes();
  handleImportSkill(importReq, importRes);
  assert.equal(importRes._status, 200);
  assert.equal(importRes._body.success, true);
  assert.equal(importRes._body.skill?.name, 'imported-demo');

  const listRes = mockRes();
  handleListSkills(mockReq({}, {}, { cwd }), listRes);
  assert.equal(listRes._body.installedSkills.some((entry) => entry.name === 'imported-demo'), true);
});

test('handleSetAssistantBinding: rejects non-object body', () => {
  const req = { body: null };
  const res = mockRes();
  handleSetAssistantBinding(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleSetAssistantBinding: rejects malformed boundCredential', () => {
  const req = mockReq({ boundCredential: { type: 'api-key' } });
  const res = mockRes();
  handleSetAssistantBinding(req, res);
  assert.equal(res._status, 400);
  assert.match(String(res._body.error || ''), /boundCredential/);
});

test('handleSetAssistantBinding: rejects malformed fallbacks', () => {
  const req = mockReq({ fallbacks: 'nope' });
  const res = mockRes();
  handleSetAssistantBinding(req, res);
  assert.equal(res._status, 400);
  assert.match(String(res._body.error || ''), /fallbacks/);
});

test('handleSetAssistantBinding: accepts boundCredential = null (clear binding)', () => {
  const req = mockReq({ boundCredential: null });
  const res = mockRes();
  handleSetAssistantBinding(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.assistantAgent.bindingConfigured, true);
  assert.equal(res._body.assistantAgent.boundModelSource, null);
  assert.equal(res._body.assistantAgent.boundCredential, null);
});

test('handleSetAssistantBinding: accepts boundModelSource as the Phase 2 primary field', () => {
  const req = mockReq({
    boundModelSource: { type: 'api-key', id: 'key-primary', model: 'gpt-5.4' }
  });
  const res = mockRes();
  handleSetAssistantBinding(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.deepEqual(res._body.assistantAgent.boundModelSource, { type: 'api-key', id: 'key-primary', model: 'gpt-5.4' });
  assert.deepEqual(res._body.assistantAgent.boundCredential, { type: 'api-key', id: 'key-primary', model: 'gpt-5.4' });
});

test('handleResetAssistantBreaker: resets all when no descriptor given', () => {
  const req = mockReq({});
  const res = mockRes();
  handleResetAssistantBreaker(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(res._body.breaker && typeof res._body.breaker === 'object');
});

test('handleResetAssistantBreaker: rejects malformed descriptor', () => {
  const req = mockReq({ descriptor: { id: 42 } });
  const res = mockRes();
  handleResetAssistantBreaker(req, res);
  assert.equal(res._status, 400);
});

test('handleSetHaikuModel: rejects empty body with 400', async () => {
  const req = mockReq({});
  const res = mockRes();
  await handleSetHaikuModel(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleSetHaikuModel: rejects null body gracefully', async () => {
  const req = { body: null };
  const res = mockRes();
  await handleSetHaikuModel(req, res);
  assert.equal(res._status, 400);
});

test('handleSetHaikuModel: rejects non-string model with 400', async () => {
  const req = mockReq({ haikuKiloModel: 123 });
  const res = mockRes();
  await handleSetHaikuModel(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleGetPricing: returns pricing summary and entries', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetPricing(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(Array.isArray(res._body.entries));
  assert.ok(res._body.entries.length > 0);
  assert.ok(typeof res._body.summary?.models === 'number');
});

test('handleUpdatePricing + handleResetPricing: manage override lifecycle', () => {
  const updateReq = mockReq({
    provider: 'openai',
    model: 'gpt-5.4',
    input: 9.99,
    output: 19.99,
    cacheRead: 0.1,
    cacheWrite: 0.2
  });
  const updateRes = mockRes();
  handleUpdatePricing(updateReq, updateRes);
  assert.equal(updateRes._status, 200);
  assert.equal(updateRes._body.success, true);
  assert.equal(updateRes._body.entry.hasOverride, true);
  assert.equal(updateRes._body.entry.effective.input, 9.99);

  const resetReq = mockReq({ provider: 'openai', model: 'gpt-5.4' });
  const resetRes = mockRes();
  handleResetPricing(resetReq, resetRes);
  assert.equal(resetRes._status, 200);
  assert.equal(resetRes._body.success, true);
  assert.equal(resetRes._body.entry.hasOverride, false);
});

// ─── claude-config-route ──────────────────────────────────────────────────────

import { handleSetDirectMode } from '../../src/routes/claude-config-route.js';

test('handleSetDirectMode: allows missing apiKey and restores direct mode', async () => {
  const req = mockReq({});
  const res = mockRes();
  await handleSetDirectMode(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(res._body.config);
});

test('handleSetDirectMode: allows null body and restores direct mode', async () => {
  const req = { body: null };
  const res = mockRes();
  await handleSetDirectMode(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(res._body.config);
});

// ─── accounts-route ───────────────────────────────────────────────────────────

const { handleSwitchAccount, handleRemoveAccount, handleAddAccountManual } = await import('../../src/routes/accounts-route.js');
const { handleAddAntigravityAccount } = await import('../../src/routes/antigravity-accounts-route.js');
const { handleRemoveClaudeAccount } = await import('../../src/routes/claude-accounts-route.js');
const { saveAccounts: saveChatGptAccounts } = await import('../../src/account-manager.js');
const { saveAccounts: saveClaudeAccounts } = await import('../../src/claude-account-manager.js');
const { getServerSettings, setServerSettings } = await import('../../src/server-settings.js');

test('handleSwitchAccount: rejects missing email with 400', () => {
  const req = mockReq({});
  const res = mockRes();
  handleSwitchAccount(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
  assert.equal(res._body.message, 'Email is required');
});

test('handleSwitchAccount: rejects null body with 400', () => {
  const req = { body: null };
  const res = mockRes();
  handleSwitchAccount(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.message, 'Email is required');
});

test('handleSwitchAccount: returns result for non-existent email (graceful)', () => {
  // The account doesn't exist, but the handler should still return a JSON response
  const req = mockReq({ email: 'nonexistent@example.com' });
  const res = mockRes();
  handleSwitchAccount(req, res);
  // Should return a response (success or failure) but not throw
  assert.ok(res._body !== null);
  assert.ok('success' in res._body);
});

test('handleAddAntigravityAccount: returns oauth url even when ANTIGRAVITY_GOOGLE_CLIENT_SECRET is unset', async () => {
  const previousSecret = process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET;
  delete process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET;

  const req = mockReq({});
  const res = mockRes();
  const { handleAntigravityOAuthCleanup } = await import('../../src/routes/antigravity-accounts-route.js');

  try {
    await handleAddAntigravityAccount(req, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.status, 'oauth_url');
    assert.equal(res._body.pkce, true);
    assert.match(String(res._body.oauth_url || ''), /^https:\/\/accounts\.google\.com\//);
  } finally {
    handleAntigravityOAuthCleanup({}, mockRes());
    if (previousSecret === undefined) {
      delete process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET;
    } else {
      process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET = previousSecret;
    }
  }
});

test('handleRemoveAccount: prunes ChatGPT bindings from routing and assistant settings', () => {
  saveChatGptAccounts({
    accounts: [{
      email: 'chatgpt@example.com',
      accessToken: 'token',
      refreshToken: 'refresh',
      addedAt: new Date().toISOString(),
      lastUsed: new Date().toISOString()
    }],
    activeAccount: 'chatgpt@example.com',
    version: 1
  });
  setServerSettings({
    appRouting: {
      codex: {
        enabled: true,
        fallbackToDefault: true,
        bindings: [
          { type: 'chatgpt-account', targetId: 'chatgpt@example.com' },
          { type: 'api-key', targetId: 'key-still-there' }
        ]
      }
    },
    assistantAgent: {
      ...getServerSettings().assistantAgent,
      enabled: true,
      boundCredential: { type: 'chatgpt-account', id: 'chatgpt@example.com' },
      boundModelSource: { type: 'chatgpt-account', id: 'chatgpt@example.com' },
      fallbacks: [
        { type: 'chatgpt-account', id: 'chatgpt@example.com' },
        { type: 'api-key', id: 'key-still-there' }
      ]
    }
  });

  const req = mockReq({}, { email: encodeURIComponent('chatgpt@example.com') });
  const res = mockRes();
  handleRemoveAccount(req, res);

  assert.equal(res._body.success, true);
  const settings = getServerSettings();
  assert.deepEqual(
    settings.appRouting.codex.bindings.map((binding) => ({ type: binding.type, targetId: binding.targetId })),
    [{ type: 'api-key', targetId: 'key-still-there' }]
  );
  assert.equal(settings.assistantAgent.boundCredential, null);
  assert.equal(settings.assistantAgent.boundModelSource, null);
  assert.deepEqual(settings.assistantAgent.fallbacks, [{ type: 'api-key', id: 'key-still-there' }]);
});

test('handleRemoveClaudeAccount: prunes Claude bindings from routing and assistant settings', () => {
  saveClaudeAccounts({
    accounts: [{
      email: 'claude@example.com',
      accessToken: 'token',
      refreshToken: 'refresh',
      addedAt: new Date().toISOString(),
      lastUsed: new Date().toISOString()
    }],
    activeAccount: 'claude@example.com',
    version: 1
  });
  setServerSettings({
    appRouting: {
      'claude-code': {
        enabled: true,
        fallbackToDefault: true,
        bindings: [
          { type: 'claude-account', targetId: 'claude@example.com' },
          { type: 'api-key', targetId: 'key-still-there' }
        ]
      }
    },
    assistantAgent: {
      ...getServerSettings().assistantAgent,
      enabled: true,
      boundCredential: { type: 'claude-account', id: 'claude@example.com' },
      boundModelSource: { type: 'claude-account', id: 'claude@example.com' },
      fallbacks: [
        { type: 'claude-account', id: 'claude@example.com' },
        { type: 'api-key', id: 'key-still-there' }
      ]
    }
  });

  const req = mockReq({}, { email: encodeURIComponent('claude@example.com') });
  const res = mockRes();
  handleRemoveClaudeAccount(req, res);

  assert.equal(res._body.success, true);
  const settings = getServerSettings();
  assert.deepEqual(
    settings.appRouting['claude-code'].bindings.map((binding) => ({ type: binding.type, targetId: binding.targetId })),
    [{ type: 'api-key', targetId: 'key-still-there' }]
  );
  assert.equal(settings.assistantAgent.boundCredential, null);
  assert.equal(settings.assistantAgent.boundModelSource, null);
  assert.deepEqual(settings.assistantAgent.fallbacks, [{ type: 'api-key', id: 'key-still-there' }]);
});

test('handleAddAntigravityAccount: allows OAuth setup when client secret is missing', async () => {
  const previousSecret = process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET;
  delete process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET;
  const req = mockReq({});
  const res = mockRes();
  const { handleAntigravityOAuthCleanup } = await import('../../src/routes/antigravity-accounts-route.js');

  try {
    await handleAddAntigravityAccount(req, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.status, 'oauth_url');
    assert.equal(res._body.pkce, true);
    assert.match(String(res._body.oauth_url || ''), /^https:\/\/accounts\.google\.com\//);
  } finally {
    handleAntigravityOAuthCleanup({}, mockRes());
    if (previousSecret === undefined) {
      delete process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET;
    } else {
      process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET = previousSecret;
    }
  }
});

const { handleGetConfigFile } = await import('../../src/routes/config-files-route.js');
const { handleListResources, handleGetResourceSummary, handleGetResourceById } = await import('../../src/routes/resources-route.js');

test('handleAddAccountManual: rejects missing code with 400', async () => {
  const req = mockReq({});
  const res = mockRes();
  await handleAddAccountManual(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
  assert.equal(res._body.error, 'Code is required');
});

test('handleGetConfigFile: rejects unsupported tool with 404', () => {
  const req = mockReq({}, { tool: 'unknown-tool' });
  const res = mockRes();
  handleGetConfigFile(req, res);
  assert.equal(res._status, 404);
  assert.equal(res._body.success, false);
});

test('handleGetConfigFile: returns file payload for codex', () => {
  const req = mockReq({}, { tool: 'codex' });
  const res = mockRes();
  handleGetConfigFile(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.tool, 'codex');
  assert.ok(typeof res._body.file?.path === 'string' && res._body.file.path.length > 0);
  assert.ok(typeof res._body.file?.exists === 'boolean');
  assert.ok(typeof res._body.file?.content === 'string');
});

test('handleGetApiKey: returns 404 for unknown API key id', () => {
  const req = mockReq({}, { id: 'nonexistent-key-id' });
  const res = mockRes();
  handleGetApiKey(req, res);
  assert.equal(res._status, 404);
  assert.equal(res._body.success, false);
});

test('handleListResources: returns catalog list and summary', () => {
  const req = mockReq({}, {}, { category: 'free', status: 'all', q: '' });
  const res = mockRes();
  handleListResources(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(Array.isArray(res._body.items));
  assert.ok(res._body.items.length > 0);
  assert.ok(typeof res._body.summary?.total === 'number');
});

test('handleGetResourceSummary: returns counts', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetResourceSummary(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(typeof res._body.summary?.free === 'number');
});

test('handleGetResourceById: returns item for openrouter', () => {
  const req = mockReq({}, { id: 'openrouter' });
  const res = mockRes();
  handleGetResourceById(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.item?.id, 'openrouter');
});

test('codex config bootstrap auth uses local API-key mode when no account is available', () => {
  const auth = codexConfigTestExports.buildApiKeyBootstrapAuthJson();
  assert.equal(auth.auth_mode, 'apikey');
  assert.equal(auth.OPENAI_API_KEY, codexConfigTestExports.CODEX_PROXY_BOOTSTRAP_API_KEY);
  assert.equal(auth.tokens, null);
  assert.equal(codexConfigTestExports.isCodexAuthReady(auth), true);
});

test('codex config chatgpt auth payload preserves token strings for Codex auth.json', () => {
  const auth = codexConfigTestExports.buildChatgptAuthJson({
    idToken: 'header.payload.signature',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accountId: 'workspace-1'
  });
  assert.equal(auth.auth_mode, 'chatgpt');
  assert.equal(auth.OPENAI_API_KEY, null);
  assert.equal(auth.tokens.id_token, 'header.payload.signature');
  assert.equal(auth.tokens.access_token, 'access-token');
  assert.equal(auth.tokens.refresh_token, 'refresh-token');
  assert.equal(auth.tokens.account_id, 'workspace-1');
  assert.equal(codexConfigTestExports.isCodexAuthReady(auth), true);
});

test('codex managed auth payloads are marked for cleanup on direct restore', () => {
  const bootstrap = codexConfigTestExports.buildApiKeyBootstrapAuthJson();
  const account = codexConfigTestExports.buildChatgptAuthJson({
    idToken: 'header.payload.signature',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accountId: 'workspace-1'
  });
  assert.equal(codexConfigTestExports.isCligateManagedAuth(bootstrap), true);
  assert.equal(codexConfigTestExports.isCligateManagedAuth(account), true);
  assert.equal(codexConfigTestExports.isCligateManagedAuth({ auth_mode: 'apikey', OPENAI_API_KEY: 'user-key' }), false);
});
