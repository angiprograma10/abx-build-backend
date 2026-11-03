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
    assert.equal(mega.getMegaTier('mega-max').qaPasses, 1);
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

    assert.equal(requests.length, 1, 'a clear single-domain task should skip the director round trip');
    const specialistSystem = requests[0].systemInstruction.parts[0].text;
    const specialistTask = requests[0].contents.at(-1).parts[0].text;
    assert.match(specialistSystem, /No agregues mecánicas, objetos, sistemas/);
    assert.match(specialistSystem, /NO significa crear un trampolín/);
    assert.match(specialistSystem, /paleta armónica de 2 a 4 colores/);
    assert.match(specialistTask, /PETICIÓN ORIGINAL/);
    assert.equal(mega.inferFastSpecialist('Por cada salto que dé el jugador, gana 5 coins.'), 'mega-scripting');
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

test('retries temporary 503 overloads and automatically switches to a fallback Gemini model', async () => {
  const env = {
    url: process.env.MEGA_INFERENCE_URL,
    key: process.env.GEMINI_API_KEY,
    primary: process.env.MEGA_BOOTSTRAP_MODEL,
    fallback: process.env.MEGA_BOOTSTRAP_FALLBACK_MODELS,
    delay: process.env.MEGA_RETRY_BASE_MS,
    liteModel: process.env.MEGA_LITE_MODEL,
    lite2Model: process.env.MEGA_LITE_2_MODEL,
    lite35Model: process.env.MEGA_LITE_3_5_MODEL
  };
  const oldFetch = global.fetch;
  delete process.env.MEGA_INFERENCE_URL;
  process.env.GEMINI_API_KEY = 'temporary-test-key';
  process.env.MEGA_BOOTSTRAP_MODEL = 'primary-test-model';
  process.env.MEGA_BOOTSTRAP_FALLBACK_MODELS = 'backup-test-model';
  process.env.MEGA_RETRY_BASE_MS = '0';
  const calls = [];
  global.fetch = async url => {
    calls.push(String(url));
    if (calls.length <= 2) {
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => ({ error: { status: 'UNAVAILABLE', message: 'high demand' } })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Resuelto con respaldo', actions: [] }) }] } }]
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
    assert.equal(result.reply, 'Resuelto con respaldo');
    assert.equal(calls.length, 3);
    assert.match(calls[0], /primary-test-model/);
    assert.match(calls[1], /primary-test-model/);
    assert.match(calls[2], /backup-test-model/);
  } finally {
    global.fetch = oldFetch;
    for (const [key,value] of Object.entries({
      MEGA_INFERENCE_URL:env.url,
      GEMINI_API_KEY:env.key,
      MEGA_BOOTSTRAP_MODEL:env.primary,
      MEGA_BOOTSTRAP_FALLBACK_MODELS:env.fallback,
      MEGA_RETRY_BASE_MS:env.delay,
      MEGA_LITE_MODEL:env.liteModel,
      MEGA_LITE_2_MODEL:env.lite2Model,
      MEGA_LITE_3_5_MODEL:env.lite35Model
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('switches model when one Gemini model has exhausted quota', async () => {
  const env = {
    url: process.env.MEGA_INFERENCE_URL,
    key: process.env.GEMINI_API_KEY,
    primary: process.env.MEGA_BOOTSTRAP_MODEL,
    fallback: process.env.MEGA_BOOTSTRAP_FALLBACK_MODELS,
    delay: process.env.MEGA_RETRY_BASE_MS
  };
  const oldFetch = global.fetch;
  delete process.env.MEGA_INFERENCE_URL;
  process.env.GEMINI_API_KEY = 'temporary-test-key';
  process.env.MEGA_BOOTSTRAP_MODEL = 'quota-test-model';
  process.env.MEGA_BOOTSTRAP_FALLBACK_MODELS = 'available-test-model';
  process.env.MEGA_RETRY_BASE_MS = '0';
  const calls = [];
  global.fetch = async url => {
    calls.push(String(url));
    if (calls.length === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        json: async () => ({ error: { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota. Check your plan and billing details.' } })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'Resuelto con respaldo de cuota', actions: [] }) }] } }]
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
    assert.equal(result.reply, 'Resuelto con respaldo de cuota');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /quota-test-model/);
    assert.match(calls[1], /available-test-model/);
  } finally {
    global.fetch = oldFetch;
    for (const [key,value] of Object.entries({
      MEGA_INFERENCE_URL:env.url,
      GEMINI_API_KEY:env.key,
      MEGA_BOOTSTRAP_MODEL:env.primary,
      MEGA_BOOTSTRAP_FALLBACK_MODELS:env.fallback,
      MEGA_RETRY_BASE_MS:env.delay
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('sanitizes final quota and overload errors instead of surfacing provider text', async () => {
  const env = {
    url: process.env.MEGA_INFERENCE_URL,
    key: process.env.GEMINI_API_KEY,
    primary: process.env.MEGA_BOOTSTRAP_MODEL,
    fallback: process.env.MEGA_BOOTSTRAP_FALLBACK_MODELS,
    delay: process.env.MEGA_RETRY_BASE_MS
  };
  const oldFetch = global.fetch;
  delete process.env.MEGA_INFERENCE_URL;
  process.env.GEMINI_API_KEY = 'temporary-test-key';
  process.env.MEGA_BOOTSTRAP_MODEL = 'quota-test-model';
  process.env.MEGA_BOOTSTRAP_FALLBACK_MODELS = 'backup-1,backup-2';
  process.env.MEGA_RETRY_BASE_MS = '0';
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return {
      ok: false,
      status: 429,
      headers: { get: () => null },
      json: async () => ({ error: { status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota. Check your plan and billing details.' } })
    };
  };
  try {
    await assert.rejects(
      () => mega.generateMegaResponse({
        selectedModel: 'mega-build',
        message: 'Analiza una construcción',
        history: [],
        buildMode: 'standard',
        systemInstruction: 'Test',
        signal: undefined
      }),
      error => {
        assert.equal(error.code, 'MEGA_QUOTA_EXHAUSTED');
        assert.equal(error.message.includes('quota'), false);
        assert.equal(error.message.includes('billing'), false);
        return true;
      }
    );
    assert.equal(calls, 3);
  } finally {
    global.fetch = oldFetch;
    for (const [key,value] of Object.entries({
      MEGA_INFERENCE_URL:env.url,
      GEMINI_API_KEY:env.key,
      MEGA_BOOTSTRAP_MODEL:env.primary,
      MEGA_BOOTSTRAP_FALLBACK_MODELS:env.fallback,
      MEGA_RETRY_BASE_MS:env.delay
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('runs independent specialists in parallel to reduce MEGA response time', async () => {
  const env = {
    url: process.env.MEGA_INFERENCE_URL,
    key: process.env.GEMINI_API_KEY,
    primary: process.env.MEGA_BOOTSTRAP_MODEL,
    fallback: process.env.MEGA_BOOTSTRAP_FALLBACK_MODELS,
    delay: process.env.MEGA_RETRY_BASE_MS
  };
  const oldFetch = global.fetch;
  delete process.env.MEGA_INFERENCE_URL;
  process.env.GEMINI_API_KEY = 'temporary-test-key';
  process.env.MEGA_BOOTSTRAP_MODEL = 'parallel-test-model';
  process.env.MEGA_BOOTSTRAP_FALLBACK_MODELS = 'parallel-test-model';
  process.env.MEGA_RETRY_BASE_MS = '0';

  let active = 0;
  let maxActive = 0;
  let callCount = 0;
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    callCount++;
    const isDirector = body.contents.at(-1).parts[0].text.includes('Analiza esta solicitud como director');
    if (isDirector) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  reply: 'Plan',
                  projectBrief: 'Trabajo independiente de construcción y UI.',
                  tasks: [
                    { specialist: 'mega-build', task: 'Construye el elemento solicitado.', dependsOn: [] },
                    { specialist: 'mega-ui', task: 'Construye la interfaz solicitada.', dependsOn: [] }
                  ]
                })
              }]
            }
          }]
        })
      };
    }
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 25));
    active--;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: JSON.stringify({ reply: 'Listo', actions: [] }) }] }
        }]
      })
    };
  };

  try {
    const result = await mega.generateMegaResponse({
      selectedModel: 'mega-lite-2',
      message: 'Crea una casa y una interfaz de bienvenida',
      history: [],
      buildMode: 'standard',
      systemInstruction: 'Test',
      signal: undefined
    });
    assert.equal(result.modelUsed, 'MEGA Lite 2.0');
    assert.equal(callCount, 3);
    assert.equal(maxActive, 2, 'both independent specialists should overlap');
  } finally {
    global.fetch = oldFetch;
    for (const [key,value] of Object.entries({
      MEGA_INFERENCE_URL:env.url,
      GEMINI_API_KEY:env.key,
      MEGA_BOOTSTRAP_MODEL:env.primary,
      MEGA_BOOTSTRAP_FALLBACK_MODELS:env.fallback,
      MEGA_RETRY_BASE_MS:env.delay
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
