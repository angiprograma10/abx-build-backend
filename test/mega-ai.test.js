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

test('publishes five MEGA specialists and hides internal inference credentials', () => {
  const oldUrl = process.env.MEGA_INFERENCE_URL;
  const oldKey = process.env.GEMINI_API_KEY;
  delete process.env.MEGA_INFERENCE_URL;
  process.env.GEMINI_API_KEY = 'test-secret-that-must-not-be-returned';
  try {
    const status = mega.getMegaStatus();
    const catalog = mega.getMegaCatalog();
    assert.equal(status.configured, true);
    assert.equal(status.endpointConfigured, false);
    assert.equal(status.runtimeMode, 'temporary-bootstrap');
    assert.equal(status.models.length, 5);
    assert.equal(catalog.length, 5);
    assert.deepEqual(
      catalog.map(model => model.id),
      ['mega-scripting', 'mega-build', 'mega-fx', 'mega-ui', 'mega-gameplay']
    );
    assert.deepEqual(
      catalog.map(model => model.name),
      ['MEGA SCRIPTING', 'MEGA BUILD', 'MEGA VFX', 'MEGA UI', 'MEGA JUEGO']
    );
    assert.equal(catalog.every(model => model.provider === 'mega' && model.available), true);
    assert.equal(catalog.some(model => model.id === 'mega-director'), false);
    assert.equal(mega.isMegaModel('mega-director'), true, 'Director remains available internally');
    assert.equal(JSON.stringify(status).includes('test-secret-that-must-not-be-returned'), false);
  } finally {
    if (oldUrl === undefined) delete process.env.MEGA_INFERENCE_URL;
    else process.env.MEGA_INFERENCE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
  }
});

test('rejects generation clearly when the self-hosted endpoint is missing', async () => {
  const oldUrl = process.env.MEGA_INFERENCE_URL;
  const oldKey = process.env.GEMINI_API_KEY;
  delete process.env.MEGA_INFERENCE_URL;
  delete process.env.GEMINI_API_KEY;
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
    if (oldKey !== undefined) process.env.GEMINI_API_KEY = oldKey;
  }
});

test('runs a MEGA specialist through the temporary runtime when no GPU endpoint exists', async () => {
  const oldUrl = process.env.MEGA_INFERENCE_URL;
  const oldKey = process.env.GEMINI_API_KEY;
  const oldModel = process.env.MEGA_BOOTSTRAP_MODEL;
  const oldFetch = global.fetch;
  delete process.env.MEGA_INFERENCE_URL;
  process.env.GEMINI_API_KEY = 'temporary-test-key';
  process.env.MEGA_BOOTSTRAP_MODEL = 'test-model';
  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ text: JSON.stringify({ reply: 'Especialista listo', actions: [] }) }]
          }
        }]
      })
    };
  };
  try {
    const result = await mega.generateMegaResponse({
      selectedModel: 'mega-build',
      message: 'Analiza una construcción',
      history: [],
      buildMode: 'standard',
      systemInstruction: 'Test',
      signal: undefined
    });
    assert.equal(result.reply, 'Especialista listo');
    assert.equal(result.modelUsed, 'MEGA BUILD');
    assert.match(captured.url, /test-model:generateContent$/);
    assert.equal(captured.options.headers['x-goog-api-key'], 'temporary-test-key');
    assert.equal(JSON.parse(captured.options.body).generationConfig.responseMimeType, 'application/json');
    assert.equal(result.agentTrace[0].model, 'MEGA_TEMPORARY_BASE');
  } finally {
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.MEGA_INFERENCE_URL;
    else process.env.MEGA_INFERENCE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.MEGA_BOOTSTRAP_MODEL;
    else process.env.MEGA_BOOTSTRAP_MODEL = oldModel;
  }
});

test('repairs malformed and incomplete model output before returning MEGA actions', async () => {
  const oldUrl = process.env.MEGA_INFERENCE_URL;
  const oldKey = process.env.GEMINI_API_KEY;
  const oldModel = process.env.MEGA_BOOTSTRAP_MODEL;
  const oldFetch = global.fetch;
  delete process.env.MEGA_INFERENCE_URL;
  process.env.GEMINI_API_KEY = 'temporary-test-key';
  process.env.MEGA_BOOTSTRAP_MODEL = 'test-model';

  const responses = [
    'No puedo devolverlo en ese formato.',
    JSON.stringify({ reply: 'Respuesta parcial, faltan acciones.' }),
    'Resultado:\n```json\n' +
      '{"reply":"Construcción preparada","action":{"type":"CREATE_PART","name":"Base",},}\n' +
      '```'
  ];
  const requests = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const text = responses.shift();
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text }] } }]
      })
    };
  };

  try {
    const result = await mega.generateMegaResponse({
      selectedModel: 'mega-build',
      message: 'Construye una base',
      history: [],
      buildMode: 'standard',
      systemInstruction: 'Test',
      signal: undefined
    });
    assert.equal(requests.length, 3, 'MEGA should retry twice after invalid output');
    assert.equal(result.reply, 'Construcción preparada');
    assert.deepEqual(result.actions, [{ type: 'CREATE_PART', name: 'Base' }]);
    assert.match(requests[1].contents.at(-1).parts[0].text, /REINTENTO DE FORMATO/);
    assert.match(requests[2].contents.at(-1).parts[0].text, /REINTENTO DE FORMATO/);
  } finally {
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.MEGA_INFERENCE_URL;
    else process.env.MEGA_INFERENCE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.MEGA_BOOTSTRAP_MODEL;
    else process.env.MEGA_BOOTSTRAP_MODEL = oldModel;
  }
});
