/** Progress card metadata for Cities & Knights hand UI (CK-12). */

export const PROGRESS_DECK_BY_TYPE = {
  commercial_harbor: 'trade',
  master_merchant: 'trade',
  merchant: 'trade',
  merchant_fleet: 'trade',
  resource_monopoly: 'trade',
  trade_monopoly: 'trade',
  bishop: 'politics',
  constitution: 'politics',
  deserter: 'politics',
  diplomat: 'politics',
  intrigue: 'politics',
  saboteur: 'politics',
  spy: 'politics',
  warlord: 'politics',
  wedding: 'politics',
  alchemist: 'science',
  crane: 'science',
  engineer: 'science',
  inventor: 'science',
  irrigation: 'science',
  medicine: 'science',
  mining: 'science',
  printer: 'science',
  road_building: 'science',
  smith: 'science'
};

export const PROGRESS_CARD_ICONS = {
  commercial_harbor: '⚓',
  master_merchant: '⚖',
  merchant: '🐪',
  merchant_fleet: '⛵',
  resource_monopoly: '♦',
  trade_monopoly: '💰',
  bishop: '✝',
  constitution: '📜',
  deserter: '🏃',
  diplomat: '🤝',
  intrigue: '🗡',
  saboteur: '💣',
  spy: '🕵',
  warlord: '⚔',
  wedding: '💍',
  alchemist: '⚗',
  crane: '🏗',
  engineer: '🧱',
  inventor: '🔧',
  irrigation: '🌾',
  medicine: '✚',
  mining: '⛏',
  printer: '🖨',
  road_building: '🛣',
  smith: '🔨'
};

export const PROGRESS_VP_TYPES = new Set(['constitution', 'printer']);

export function getProgressDeck(type) {
  return PROGRESS_DECK_BY_TYPE[type] || 'trade';
}

export function isRevealedProgressCard(card) {
  if (!card) return false;
  return Boolean(card.revealed) || (card.played && PROGRESS_VP_TYPES.has(card.type));
}

export function unplayedProgressCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.filter(c => !c.played && !c.revealed);
}

/** Official C&K: a progress card cannot be played the turn it is acquired. */
export function isProgressCardBoughtThisTurn(card, turnNumber) {
  return Boolean(card) && card.boughtTurn === turnNumber;
}

export function progressCardHandModifiers(card, turnNumber) {
  const locked = isProgressCardBoughtThisTurn(card, turnNumber);
  return {
    locked,
    extraClass: locked ? 'progress-card-locked' : '',
    titleKey: locked ? 'CANNOT_PLAY_TURN_BOUGHT' : null,
    badgeKey: locked ? 'PROGRESS_LOCKED_THIS_TURN' : null
  };
}

export function revealedProgressCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.filter(isRevealedProgressCard).map(c => ({
    id: c.id,
    type: c.type,
    revealed: true,
    played: true
  }));
}
