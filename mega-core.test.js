'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./mega-core');

test('detecta recompensa exacta por salto', () => {
  assert.deepEqual(core.detectJumpRewardRequest('Haz que por cada salto gane 5 coins'), { event: 'jump', amount: 5, currencyName: 'Coins' });
});

test('genera un script de servidor sin trampolines ni cambios de salto', () => {
  const result = core.buildOfflineResponse('Por cada salto que dé me gano 5 monedas');
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, 'CREATE_SCRIPT');
  assert.equal(result.actions[0].location, 'ServerScriptService');
  assert.match(result.actions[0].source, /REWARD_PER_JUMP = 5/);
  assert.doesNotMatch(result.actions[0].source, /Trampoline|JumpPower\s*=|JumpHeight\s*=/);
});

test('no inventa una cantidad ni convierte preguntas en construcción', () => {
  assert.equal(core.buildOfflineResponse('¿Cómo funciona el salto en Roblox?'), null);
  assert.equal(core.buildOfflineResponse('Haz que cada salto dé monedas'), null);
});
