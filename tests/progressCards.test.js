/**
 * Progress card hand helpers (CK-32 same-turn lock).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isProgressCardBoughtThisTurn,
  progressCardHandModifiers,
  unplayedProgressCards
} from '../public/js/progressCards.js';

describe('CK-32 progress card bought-this-turn lock', () => {
  it('treats a card with boughtTurn === current turn as locked', () => {
    const card = { id: 'c1', type: 'crane', played: false, boughtTurn: 4 };
    assert.equal(isProgressCardBoughtThisTurn(card, 4), true);
    const mods = progressCardHandModifiers(card, 4);
    assert.equal(mods.locked, true);
    assert.equal(mods.extraClass, 'progress-card-locked');
    assert.equal(mods.titleKey, 'CANNOT_PLAY_TURN_BOUGHT');
    assert.equal(mods.badgeKey, 'PROGRESS_LOCKED_THIS_TURN');
  });

  it('does not lock cards acquired on a previous turn', () => {
    const card = { id: 'c2', type: 'alchemist', played: false, boughtTurn: 3 };
    assert.equal(isProgressCardBoughtThisTurn(card, 4), false);
    const mods = progressCardHandModifiers(card, 4);
    assert.equal(mods.locked, false);
    assert.equal(mods.extraClass, '');
    assert.equal(mods.titleKey, null);
    assert.equal(mods.badgeKey, null);
  });

  it('keeps locked cards in the unplayed hand so the UI can show the lock', () => {
    const cards = [
      { id: 'new', type: 'crane', played: false, boughtTurn: 2 },
      { id: 'old', type: 'merchant', played: false, boughtTurn: 1 },
      { id: 'done', type: 'crane', played: true, boughtTurn: 1 }
    ];
    const unplayed = unplayedProgressCards(cards);
    assert.deepEqual(unplayed.map(c => c.id), ['new', 'old']);
    assert.equal(progressCardHandModifiers(unplayed[0], 2).locked, true);
    assert.equal(progressCardHandModifiers(unplayed[1], 2).locked, false);
  });
});
