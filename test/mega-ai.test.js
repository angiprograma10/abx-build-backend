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
    'mega-gameplay',
    'mega-lite',
    'mega-lite-2',
    'mega-lite-3-5',
    'mega-go',
    'mega-max'
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
      ['mega-lite', 'mega-lite-2', 'mega-lite-3-5', 'mega-go', 'mega-max']
    );
    assert.deepEqual(
      catalog.map(model => model.name),
      ['MEGA Lite', 'MEGA Lite 2.0', 'MEGA Lite 3.5', 'MEGA GO', 'MEGA MAX']
    );
    assert.equal(catalog.every(model => model.provider === 'mega'), true);
    assert.equal(catalog.filter(model => !model.requiresPaidPlan).every(model => model.available), true);
    assert.equal(catalog.filter(model => model.requiresPaidPlan).every(model => !model.available), true);
    assert.equal(catalog.filter(model => !model.requiresPaidPlan).length, 3);
    assert.equal(catalog.filter(model => model.requiresPaidPlan).length, 2);
    assert.equal(mega.isPaidMegaTier('mega-go'), true);
    assert.equal(mega.isPaidMegaTier('mega-max'), true);
    assert.equal(mega.isPaidMegaTier('mega-lite'), false);
    assert.equal(mega.getMegaTier('mega-max').qaPasses, 2);
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

test('routes MEGA Lite through the director and coordinates the selected specialists', async () => {
  const oldUrl = process.env.MEGA_INFERENCE_URL;
  const oldKey = process.env.GEMINI_API_KEY;
  const oldModel = process.env.MEGA_BOOTSTRAP_MODEL;
  const oldFetch = global.fetch;
  delete process.env.MEGA_INFERENCE_URL;
  process.env.GEMINI_API_KEY = 'temporary-test-key';
  process.env.MEGA_BOOTSTRAP_MODEL = 'test-model';

  const responses = [
    {
      reply: 'Plan breve',
      projectBrief: 'Construcción y lógica para una base.',
      tasks: [
        { specialist: 'mega-build', task: 'Construye la base.', dependsOn: [] },
        { specialist: 'mega-scripting', task: 'Programa la interacción.', dependsOn: [] },
        { specialist: 'mega-ui', task: 'Diseña la interfaz.', dependsOn: [] }
      ]
    },
    { reply: 'Base preparada', actions: [] },
    { reply: 'Interacción preparada', actions: [] }
  ];
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const next = responses.shift();
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ text: JSON.stringify(next) }]
          }
        }]
      })
    };
  };

  try {
    const result = await mega.generateMegaResponse({
      selectedModel: 'mega-lite',
      message: 'Crea una base con una interacción sencilla',
      history: [],
      buildMode: 'standard',
      systemInstruction: 'Test',
      signal: undefined
    });

    assert.equal(result.modelUsed, 'MEGA Lite');
    assert.equal(requests.length, 3, 'Lite should plan once and call two specialists');
    assert.deepEqual(
      result.agentTrace.map(agent => agent.specialist),
      ['mega-build', 'mega-scripting']
    );
    assert.match(requests[0].contents.at(-1).parts[0].text, /Máximo 2 tareas/);
    assert.deepEqual(result.actions, []);
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

test('includes strict scope fidelity and intentional color rules in director and specialist prompts', async () => {
  const oldUrl = process.env.MEGA_INFERENCE_URL;
  const oldKey = process.env.GEMINI_API_KEY;
  const oldModel = process.env.MEGA_BOOTSTRAP_MODEL;
  const oldFetch = global.fetch;
  delete process.env.MEGA_INFERENCE_URL;
  process.env.GEMINI_API_KEY = 'temporary-test-key';
  process.env.MEGA_BOOTSTRAP_MODEL = 'test-model';

  const responses = [
    {
      reply: 'Plan de monedas por salto.',
      projectBrief: 'Alcance: detectar saltos normales y sumar 5 monedas. No crear trampolines.',
      tasks: [
        { specialist: 'mega-scripting', task: 'Detecta el salto normal y suma 5 monedas.', dependsOn: [] }
      ]
    },
    { reply: 'Sistema de monedas preparado.', actions: [] }
  ];
  const requests = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const next = responses.shift();
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(next) }] } }]
      })
    };
  };

  try {
    await mega.generateMegaResponse({
      selectedModel: 'mega-lite',
      message: 'Por cada salto que dé el jugador, gana 5 coins.',
      history: [],
      buildMode: 'standard',
      systemInstruction: 'Test',
      signal: undefined
    });

    assert.equal(requests.length, 2);
    const directorSystem = requests[0].systemInstruction.parts[0].text;
    const specialistSystem = requests[1].systemInstruction.parts[0].text;
    const specialistTask = requests[1].contents.at(-1).parts[0].text;
    for (const prompt of [directorSystem, specialistSystem]) {
      assert.match(prompt, /No agregues mecánicas, objetos, sistemas/);
      assert.match(prompt, /NO significa crear un trampolín/);
      assert.match(prompt, /paleta armónica de 2 a 4 colores/);
    }
    assert.match(specialistTask, /BLOQUEO DE ALCANCE/);
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

test('uses a user-friendly failure after all structured-output repairs are exhausted', async () => {
  const oldUrl = process.env.MEGA_INFERENCE_URL;
  const oldKey = process.env.GEMINI_API_KEY;
  const oldFetch = global.fetch;
  delete process.env.MEGA_INFERENCE_URL;
  process.env.GEMINI_API_KEY = 'temporary-test-key';
  let attempts = 0;
  global.fetch = async () => {
    attempts++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'texto sin estructura utilizable' }] } }]
      })
    };
  };

  try {
    await assert.rejects(
      () => mega.generateMegaResponse({
        selectedModel: 'mega-build',
        message: 'Construye una estructura',
        history: [],
        buildMode: 'standard',
        systemInstruction: 'Test',
        signal: undefined
      }),
      error => {
        assert.equal(error.code, 'MEGA_OUTPUT_RETRY_EXHAUSTED');
        assert.match(error.message, /MEGA no pudo completar esta solicitud/);
        assert.equal(error.message.includes('JSON'), false);
        return true;
      }
    );
    assert.equal(attempts, 3);
  } finally {
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.MEGA_INFERENCE_URL;
    else process.env.MEGA_INFERENCE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey;
  }
});
