'use strict';

// CPU-only deterministic request analysis for MEGA. This is not a trained LLM.
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

module.exports = { normalizeText, detectJumpRewardRequest };
