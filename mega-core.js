'use strict';

// CPU-only deterministic request analysis and narrow, reviewed Roblox recipes.
// This is a rule/recipe engine, not a trained language model.

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function detectJumpRewardRequest(message) {
  const text = normalizeText(message);
  const hasJump = /\b(salto|saltar|salte|salta|brinco|brincar|jump)\b/.test(text);
  const hasReward = /\b(moneda|monedas|coin|coins|recompensa)\b/.test(text);
  const repeats = /\b(por cada|cada vez que|cada que|cuando|al)\b/.test(text);
  const amountMatch = String(message || '').match(/\b(\d{1,7})\s*(?:coins?|monedas?)\b/i);
  const amount = amountMatch ? Number(amountMatch[1]) : null;
  if (!hasJump || !hasReward || !repeats || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) return null;
  if (/\b(no|nunca)\s+(?:agregues|quiero|crees)?\s*(?:monedas?|coins?)\b/.test(text)) return null;
  return { event: 'jump', amount, currencyName: 'Coins' };
}

function buildJumpRewardResponse(amount) {
  const source = [
    '-- MEGA CORE: recompensa por salto; ejecutar en el servidor.',
    '-- No cambia la fuerza, altura ni física del salto.',
    'local Players = game:GetService("Players")',
    '',
    'local REWARD_PER_JUMP = ' + String(amount),
    'local JUMP_COOLDOWN = 0.4',
    'local STAT_NAME = "Coins"',
    '',
    'local function bindCharacter(player, character)',
    '    local humanoid = character:WaitForChild("Humanoid", 10)',
    '    if not humanoid then return end',
    '    local lastRewardAt = 0',
    '    local wasJumping = false',
    '    humanoid.StateChanged:Connect(function(_, newState)',
    '        if newState == Enum.HumanoidStateType.Jumping and not wasJumping then',
    '            wasJumping = true',
    '            local now = os.clock()',
    '            if now - lastRewardAt >= JUMP_COOLDOWN then',
    '                local stats = player:FindFirstChild("leaderstats")',
    '                local coins = stats and stats:FindFirstChild(STAT_NAME)',
    '                if coins and (coins:IsA("IntValue") or coins:IsA("NumberValue")) then',
    '                    coins.Value = coins.Value + REWARD_PER_JUMP',
    '                    lastRewardAt = now',
    '                end',
    '            end',
    '        elseif newState ~= Enum.HumanoidStateType.Jumping then',
    '            wasJumping = false',
    '        end',
    '    end)',
    'end',
    '',
    'local function setupPlayer(player)',
    '    local stats = player:FindFirstChild("leaderstats")',
    '    if not stats then',
    '        stats = Instance.new("Folder")',
    '        stats.Name = "leaderstats"',
    '        stats.Parent = player',
    '    end',
    '    local coins = stats:FindFirstChild(STAT_NAME)',
    '    if not coins then',
    '        coins = Instance.new("IntValue")',
    '        coins.Name = STAT_NAME',
    '        coins.Value = 0',
    '        coins.Parent = stats',
    '    end',
    '    player.CharacterAdded:Connect(function(character)',
    '        bindCharacter(player, character)',
    '    end)',
    '    if player.Character then bindCharacter(player, player.Character) end',
    'end',
    '',
    'Players.PlayerAdded:Connect(setupPlayer)',
    'for _, player in ipairs(Players:GetPlayers()) do setupPlayer(player) end'
  ].join('\n');

  return {
    reply: 'MEGA CORE preparó el sistema: cada salto válido suma exactamente ' + amount +
      ' Coins. Se ejecuta en el servidor y utiliza leaderstats; no crea trampolines ni cambia el salto normal. Las monedas no se guardan entre sesiones.',
    actions: [{
      type: 'CREATE_SCRIPT',
      name: 'MEGA_JumpCoinReward',
      location: 'ServerScriptService',
      source
    }],
    modelUsed: 'MEGA CORE (CPU, sin GPU)',
    agentTrace: [{ specialist: 'mega-core-offline', actionCount: 1 }]
  };
}

function buildOfflineResponse(message) {
  const intent = detectJumpRewardRequest(message);
  return intent ? buildJumpRewardResponse(intent.amount) : null;
}

module.exports = {
  normalizeText,
  detectJumpRewardRequest,
  buildOfflineResponse
};
