'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mega = require('../mega-ai');

test('recognizes each MEGA specialist identifier', () => {
  for (const id of [
    'mega-director',
    'mega-build',
    'mega-scripting',
    'mega-ui',
    'mega-fx',
    'mega-gameplay'
  ]) {
    assert.equal(mega.isMegaModel(id), true, id);
  }
  assert.equal(mega.isMegaModel('gemini-3.6-flash'), false);
  assert.equal(mega.isMegaModel('unknown-model'), false);
});

test('publishes six specialist entries without exposing secrets', () => {
  const oldUrl = process.env.MEGA_INFERENCE_URL;
  const oldKey = process.env.MEGA_INFERENCE_API_KEY;
  delete process.env.MEGA_INFERENCE_URL;
  process.env.MEGA_INFERENCE_API_KEY = 'test-secret-that-must-not-be-returned';
  try {
    const status = mega.getMegaStatus();
    const catalog = mega.getMegaCatalog();
    assert.equal(status.configured, false);
    assert.equal(status.models.length, 6);
    assert.equal(catalog.length, 6);
    assert.deepEqual(
      catalog.map(model => model.id),
      ['mega-director', 'mega-build', 'mega-scripting', 'mega-ui', 'mega-fx', 'mega-gameplay']
    );
    assert.equal(catalog.every(model => model.provider === 'mega'), true);
    assert.equal(JSON.stringify(status).includes('test-secret-that-must-not-be-returned'), false);
  } finally {
    if (oldUrl === undefined) delete process.env.MEGA_INFERENCE_URL;
    else process.env.MEGA_INFERENCE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.MEGA_INFERENCE_API_KEY;
    else process.env.MEGA_INFERENCE_API_KEY = oldKey;
  }
});

test('rejects generation clearly when the self-hosted endpoint is missing', async () => {
  const oldUrl = process.env.MEGA_INFERENCE_URL;
  delete process.env.MEGA_INFERENCE_URL;
  try {
    await assert.rejects(
      () => mega.generateMegaResponse({
        selectedModel: 'mega-build',
        message: 'Crea una casa',
        history: [],
        buildMode: 'standard',
        systemInstruction: 'Test',
        signal: undefined
      }),
      error => error && error.code === 'MEGA_NOT_CONFIGURED'
    );
  } finally {
    if (oldUrl !== undefined) process.env.MEGA_INFERENCE_URL = oldUrl;
  }
});
