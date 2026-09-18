/**
 * actionValidation.test.js
 * Comprehensive unit tests for strict JSON input schema validation gateway (ARCH-04).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { server, io as serverIo } from '../server/server.js';
import {
  validateActionPayload,
  ACTION_SCHEMAS,
  VALID_RESOURCES,
  BASE_RESOURCES,
  VALID_CATEGORIES
} from '../server/game/actionSchemas.js';

describe('ARCH-04: Strict JSON input schema validation gateway', () => {
  describe('1. Valid payloads for every action', () => {
    it('validates build_road', () => {
      const res = validateActionPayload('build_road', { code: 'ABCDE', edgeId: 'edge_0_1' });
      assert.equal(res.valid, true);
      assert.equal(res.errors, undefined);
    });

    it('validates build_settlement', () => {
      const res = validateActionPayload('build_settlement', { code: 'ABCDE', vertexId: 'v_0_1' });
      assert.equal(res.valid, true);
    });

    it('validates build_city', () => {
      const res = validateActionPayload('build_city', { code: 'ABCDE', vertexId: 'v_0_1' });
      assert.equal(res.valid, true);
    });

    it('validates build_city_wall', () => {
      const res = validateActionPayload('build_city_wall', { code: 'ABCDE', vertexId: 'v_0_1' });
      assert.equal(res.valid, true);
    });

    it('validates roll_dice', () => {
      const res = validateActionPayload('roll_dice', { code: 'ABCDE' });
      assert.equal(res.valid, true);
    });

    it('validates end_turn', () => {
      const res = validateActionPayload('end_turn', { code: 'ABCDE' });
      assert.equal(res.valid, true);
    });

    it('validates bank_trade with ratio', () => {
      const res = validateActionPayload('bank_trade', {
        code: 'ABCDE',
        give: 'wood',
        receive: 'brick',
        ratio: 3
      });
      assert.equal(res.valid, true);
    });

    it('validates bank_trade without ratio (optional)', () => {
      const res = validateActionPayload('bank_trade', {
        code: 'ABCDE',
        give: 'ore',
        receive: 'wheat'
      });
      assert.equal(res.valid, true);
    });

    it('validates bank_trade with commodities', () => {
      const res = validateActionPayload('bank_trade', {
        code: 'ABCDE',
        give: 'cloth',
        receive: 'paper',
        ratio: 4
      });
      assert.equal(res.valid, true);
    });

    it('validates propose_trade with and without targetPlayerId', () => {
      const res1 = validateActionPayload('propose_trade', {
        code: 'ABCDE',
        give: { wood: 1, brick: 2 },
        want: { ore: 1 },
        targetPlayerId: 'p2'
      });
      assert.equal(res1.valid, true);

      const res2 = validateActionPayload('propose_trade', {
        code: 'ABCDE',
        give: { wheat: 1 },
        want: { cloth: 1 }
      });
      assert.equal(res2.valid, true);
    });

    it('validates accept_trade with and without tradeId', () => {
      const res1 = validateActionPayload('accept_trade', { code: 'ABCDE', tradeId: 'trade_123' });
      assert.equal(res1.valid, true);

      const res2 = validateActionPayload('accept_trade', { code: 'ABCDE' });
      assert.equal(res2.valid, true);
    });

    it('validates reject_trade with and without tradeId', () => {
      const res1 = validateActionPayload('reject_trade', { code: 'ABCDE', tradeId: 'trade_123' });
      assert.equal(res1.valid, true);

      const res2 = validateActionPayload('reject_trade', { code: 'ABCDE' });
      assert.equal(res2.valid, true);
    });

    it('validates cancel_trade', () => {
      const res = validateActionPayload('cancel_trade', { code: 'ABCDE' });
      assert.equal(res.valid, true);
    });

    it('validates discard_cards', () => {
      const res = validateActionPayload('discard_cards', {
        code: 'ABCDE',
        cards: { wood: 2, cloth: 1, ore: 0 }
      });
      assert.equal(res.valid, true);
    });

    it('validates move_robber with string and integer hexId, victimPlayerId and null', () => {
      const res1 = validateActionPayload('move_robber', {
        code: 'ABCDE',
        hexId: 'hex_4',
        victimPlayerId: 'p2'
      });
      assert.equal(res1.valid, true);

      const res2 = validateActionPayload('move_robber', {
        code: 'ABCDE',
        hexId: 7,
        victimPlayerId: null
      });
      assert.equal(res2.valid, true);

      const res3 = validateActionPayload('move_robber', {
        code: 'ABCDE',
        hexId: 0
      });
      assert.equal(res3.valid, true);
    });

    it('validates move_pirate with string and integer hexId', () => {
      const res1 = validateActionPayload('move_pirate', {
        code: 'ABCDE',
        hexId: 'hex_9',
        victimPlayerId: 'p3'
      });
      assert.equal(res1.valid, true);

      const res2 = validateActionPayload('move_pirate', {
        code: 'ABCDE',
        hexId: 5
      });
      assert.equal(res2.valid, true);
    });

    it('validates buy_dev_card', () => {
      const res = validateActionPayload('buy_dev_card', { code: 'ABCDE' });
      assert.equal(res.valid, true);
    });

    it('validates play_knight with and without victim/hexId', () => {
      const res1 = validateActionPayload('play_knight', {
        code: 'ABCDE',
        hexId: 'hex_3',
        victimPlayerId: 'player_2'
      });
      assert.equal(res1.valid, true);

      const res2 = validateActionPayload('play_knight', { code: 'ABCDE' });
      assert.equal(res2.valid, true);
    });

    it('validates play_year_of_plenty with 2-element array and record summing to 2', () => {
      const res1 = validateActionPayload('play_year_of_plenty', {
        code: 'ABCDE',
        resources: ['wood', 'brick']
      });
      assert.equal(res1.valid, true);

      const res2 = validateActionPayload('play_year_of_plenty', {
        code: 'ABCDE',
        resources: { ore: 2 }
      });
      assert.equal(res2.valid, true);

      const res3 = validateActionPayload('play_year_of_plenty', {
        code: 'ABCDE',
        resources: { wheat: 1, wool: 1 }
      });
      assert.equal(res3.valid, true);
    });

    it('validates play_monopoly with valid resource', () => {
      const res = validateActionPayload('play_monopoly', {
        code: 'ABCDE',
        resource: 'ore'
      });
      assert.equal(res.valid, true);
    });

    it('validates play_road_building with 1 or 2 edges', () => {
      const res1 = validateActionPayload('play_road_building', {
        code: 'ABCDE',
        edges: ['e_0_1']
      });
      assert.equal(res1.valid, true);

      const res2 = validateActionPayload('play_road_building', {
        code: 'ABCDE',
        edges: ['e_0_1', 'e_0_2']
      });
      assert.equal(res2.valid, true);
    });

    it('validates buy_city_improvement with categories', () => {
      for (const cat of ['POLITICS', 'SCIENCE', 'TRADE', 'politics', 'science', 'trade']) {
        const res = validateActionPayload('buy_city_improvement', {
          code: 'ABCDE',
          category: cat
        });
        assert.equal(res.valid, true, `Expected valid for category ${cat}`);
      }
    });

    it('validates additional client-emitted actions', () => {
      assert.equal(validateActionPayload('place_setup_settlement', { code: 'ABCDE', vertexId: 'v1' }).valid, true);
      assert.equal(validateActionPayload('place_setup_city', { code: 'ABCDE', vertexId: 'v1' }).valid, true);
      assert.equal(validateActionPayload('place_setup_road', { code: 'ABCDE', edgeId: 'e1' }).valid, true);
      assert.equal(validateActionPayload('upgrade_city', { code: 'ABCDE', vertexId: 'v1' }).valid, true);
      assert.equal(validateActionPayload('improve_city', { code: 'ABCDE', track: 'trade' }).valid, true);
      assert.equal(validateActionPayload('claim_aqueduct_resource', { code: 'ABCDE', resource: 'wheat' }).valid, true);
      assert.equal(validateActionPayload('choose_metropolis', { code: 'ABCDE', vertexId: 'v1' }).valid, true);
      assert.equal(validateActionPayload('place_knight', { code: 'ABCDE', vertexId: 'v1' }).valid, true);
      assert.equal(validateActionPayload('activate_knight', { code: 'ABCDE', vertexId: 'v1' }).valid, true);
      assert.equal(validateActionPayload('promote_knight', { code: 'ABCDE', vertexId: 'v1' }).valid, true);
      assert.equal(validateActionPayload('move_knight', { code: 'ABCDE', fromVertexId: 'v1', toVertexId: 'v2' }).valid, true);
      assert.equal(validateActionPayload('relocate_displaced_knight', { code: 'ABCDE', vertexId: 'v1' }).valid, true);
      assert.equal(validateActionPayload('relocate_knight', { code: 'ABCDE', vertexId: 'v1' }).valid, true);
      assert.equal(validateActionPayload('chase_robber', { code: 'ABCDE', vertexId: 'v1', hexId: 'h1', victimPlayerId: 'p2' }).valid, true);
      assert.equal(validateActionPayload('downgrade_city', { code: 'ABCDE', vertexId: 'v1' }).valid, true);
      assert.equal(validateActionPayload('choose_barbarian_reward', { code: 'ABCDE', deck: 'politics' }).valid, true);
      assert.equal(validateActionPayload('claim_barbarian_progress_card', { code: 'ABCDE', deck: 'science' }).valid, true);
      assert.equal(validateActionPayload('play_dev_card', { code: 'ABCDE', cardId: 'card_1' }).valid, true);
      assert.equal(validateActionPayload('play_progress_card', { code: 'ABCDE', cardId: 'prog_1', options: { foo: 'bar' } }).valid, true);
      assert.equal(validateActionPayload('respond_progress_choice', { code: 'ABCDE', cards: ['wood', 'brick'] }).valid, true);
      assert.equal(validateActionPayload('choose_deserter_knight', { code: 'ABCDE', vertexId: 'v1' }).valid, true);
      assert.equal(validateActionPayload('place_deserter_knight', { code: 'ABCDE', placeVertexId: 'v1', skip: false }).valid, true);
      assert.equal(validateActionPayload('discard_progress_card', { code: 'ABCDE', cardId: 'prog_1' }).valid, true);
      assert.equal(validateActionPayload('respond_trade', { code: 'ABCDE', accept: true }).valid, true);
      assert.equal(validateActionPayload('respond_trade', { code: 'ABCDE', accept: false }).valid, true);
      assert.equal(validateActionPayload('confirm_trade', { code: 'ABCDE', targetPlayerId: 'p2' }).valid, true);
    });
  });

  describe('2. Missing required fields', () => {
    it('rejects missing room code', () => {
      const actions = [
        'build_road',
        'build_settlement',
        'build_city',
        'build_city_wall',
        'roll_dice',
        'end_turn',
        'bank_trade',
        'propose_trade',
        'accept_trade',
        'reject_trade',
        'cancel_trade',
        'discard_cards',
        'move_robber',
        'move_pirate',
        'buy_dev_card',
        'play_knight',
        'play_year_of_plenty',
        'play_monopoly',
        'play_road_building',
        'buy_city_improvement'
      ];

      for (const action of actions) {
        const res = validateActionPayload(action, {});
        assert.equal(res.valid, false, `Expected missing code to fail for ${action}`);
        assert.ok(res.errors.some(e => e.includes('Missing required field "code"')));
      }
    });

    it('rejects build_road missing edgeId', () => {
      const res = validateActionPayload('build_road', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "edgeId"')));
    });

    it('rejects build_settlement missing vertexId', () => {
      const res = validateActionPayload('build_settlement', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "vertexId"')));
    });

    it('rejects build_city missing vertexId', () => {
      const res = validateActionPayload('build_city', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "vertexId"')));
    });

    it('rejects build_city_wall missing vertexId', () => {
      const res = validateActionPayload('build_city_wall', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "vertexId"')));
    });

    it('rejects bank_trade missing give and receive', () => {
      const res = validateActionPayload('bank_trade', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "give"')));
      assert.ok(res.errors.some(e => e.includes('Missing required field "receive"')));
    });

    it('rejects propose_trade missing give and want', () => {
      const res = validateActionPayload('propose_trade', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "give"')));
      assert.ok(res.errors.some(e => e.includes('Missing required field "want"')));
    });

    it('rejects discard_cards missing cards', () => {
      const res = validateActionPayload('discard_cards', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "cards"')));
    });

    it('rejects move_robber missing hexId', () => {
      const res = validateActionPayload('move_robber', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "hexId"')));
    });

    it('rejects move_pirate missing hexId', () => {
      const res = validateActionPayload('move_pirate', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "hexId"')));
    });

    it('rejects play_year_of_plenty missing resources', () => {
      const res = validateActionPayload('play_year_of_plenty', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "resources"')));
    });

    it('rejects play_monopoly missing resource', () => {
      const res = validateActionPayload('play_monopoly', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "resource"')));
    });

    it('rejects play_road_building missing edges', () => {
      const res = validateActionPayload('play_road_building', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "edges"')));
    });

    it('rejects buy_city_improvement missing category', () => {
      const res = validateActionPayload('buy_city_improvement', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "category"')));
    });

    it('rejects respond_trade missing accept', () => {
      const res = validateActionPayload('respond_trade', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Missing required field "accept"')));
    });

    it('rejects null, undefined, or non-object payloads', () => {
      assert.equal(validateActionPayload('roll_dice', null).valid, false);
      assert.equal(validateActionPayload('roll_dice', undefined).valid, false);
      assert.equal(validateActionPayload('roll_dice', 'ABCDE').valid, false);
      assert.equal(validateActionPayload('roll_dice', 12345).valid, false);
      assert.equal(validateActionPayload('roll_dice', [1, 2, 3]).valid, false);
    });

    it('rejects unknown actions', () => {
      const res = validateActionPayload('hacked_action', { code: 'ABCDE' });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Unknown action')));
    });
  });

  describe('3. Wrong data types', () => {
    it('rejects number code instead of string', () => {
      const res = validateActionPayload('roll_dice', { code: 12345 });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('must be a string')));
    });

    it('rejects boolean edgeId and vertexId', () => {
      const r1 = validateActionPayload('build_road', { code: 'ABCDE', edgeId: true });
      assert.equal(r1.valid, false);
      assert.ok(r1.errors.some(e => e.includes('must be a string')));

      const r2 = validateActionPayload('build_settlement', { code: 'ABCDE', vertexId: false });
      assert.equal(r2.valid, false);
      assert.ok(r2.errors.some(e => e.includes('must be a string')));
    });

    it('rejects string give/want in propose_trade instead of object', () => {
      const res = validateActionPayload('propose_trade', {
        code: 'ABCDE',
        give: 'wood',
        want: { brick: 1 }
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('must be an object')));
    });

    it('rejects array cards in discard_cards instead of object', () => {
      const res = validateActionPayload('discard_cards', {
        code: 'ABCDE',
        cards: ['wood', 'brick']
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('must be an object')));
    });

    it('rejects boolean or object hexId in move_robber', () => {
      const r1 = validateActionPayload('move_robber', { code: 'ABCDE', hexId: true });
      assert.equal(r1.valid, false);
      assert.ok(r1.errors.some(e => e.includes('must be a non-empty string or integer')));

      const r2 = validateActionPayload('move_robber', { code: 'ABCDE', hexId: { id: 1 } });
      assert.equal(r2.valid, false);
    });

    it('rejects number victimPlayerId in move_robber', () => {
      const res = validateActionPayload('move_robber', { code: 'ABCDE', hexId: 1, victimPlayerId: 123 });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('must be a non-empty string or null')));
    });

    it('rejects string ratio in bank_trade instead of integer', () => {
      const res = validateActionPayload('bank_trade', {
        code: 'ABCDE',
        give: 'wood',
        receive: 'brick',
        ratio: '3'
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('must be an integer')));
    });

    it('rejects float ratio in bank_trade', () => {
      const res = validateActionPayload('bank_trade', {
        code: 'ABCDE',
        give: 'wood',
        receive: 'brick',
        ratio: 3.5
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('must be an integer')));
    });

    it('rejects non-array edges in play_road_building', () => {
      const res = validateActionPayload('play_road_building', {
        code: 'ABCDE',
        edges: 'edge_1'
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('must be an array')));
    });

    it('rejects array containing numbers in play_road_building', () => {
      const res = validateActionPayload('play_road_building', {
        code: 'ABCDE',
        edges: [123]
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('must be a non-empty string')));
    });

    it('rejects string accept in respond_trade instead of boolean', () => {
      const res = validateActionPayload('respond_trade', {
        code: 'ABCDE',
        accept: 'true'
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('must be a boolean')));
    });
  });

  describe('4. Invalid resources, negative quantities, invalid room codes', () => {
    it('rejects room code of invalid length or format', () => {
      assert.equal(validateActionPayload('roll_dice', { code: 'ABC' }).valid, false);
      assert.equal(validateActionPayload('roll_dice', { code: 'ABCDEF' }).valid, false);
      assert.equal(validateActionPayload('roll_dice', { code: 'AB-12' }).valid, false);
      assert.equal(validateActionPayload('roll_dice', { code: 'AB 12' }).valid, false);
      assert.equal(validateActionPayload('roll_dice', { code: '' }).valid, false);
    });

    it('rejects invalid resource in bank_trade give and receive', () => {
      const r1 = validateActionPayload('bank_trade', {
        code: 'ABCDE',
        give: 'gold',
        receive: 'wood'
      });
      assert.equal(r1.valid, false);
      assert.ok(r1.errors.some(e => e.includes('Invalid value "gold"')));

      const r2 = validateActionPayload('bank_trade', {
        code: 'ABCDE',
        give: 'wood',
        receive: 'sheep'
      });
      assert.equal(r2.valid, false);
      assert.ok(r2.errors.some(e => e.includes('Invalid value "sheep"')));
    });

    it('rejects out-of-range ratio in bank_trade', () => {
      const r1 = validateActionPayload('bank_trade', {
        code: 'ABCDE',
        give: 'wood',
        receive: 'brick',
        ratio: 1
      });
      assert.equal(r1.valid, false);
      assert.ok(r1.errors.some(e => e.includes('must be at least 2')));

      const r2 = validateActionPayload('bank_trade', {
        code: 'ABCDE',
        give: 'wood',
        receive: 'brick',
        ratio: 5
      });
      assert.equal(r2.valid, false);
      assert.ok(r2.errors.some(e => e.includes('must be at most 4')));
    });

    it('rejects invalid resource in discard_cards', () => {
      const res = validateActionPayload('discard_cards', {
        code: 'ABCDE',
        cards: { kryptonite: 2, wood: 1 }
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Invalid resource "kryptonite"')));
    });

    it('rejects negative quantity in discard_cards', () => {
      const res = validateActionPayload('discard_cards', {
        code: 'ABCDE',
        cards: { wood: -1, brick: 2 }
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('must be a non-negative integer')));
    });

    it('rejects non-integer quantity in discard_cards', () => {
      const res = validateActionPayload('discard_cards', {
        code: 'ABCDE',
        cards: { wood: 1.5 }
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('must be an integer')));
    });

    it('rejects invalid resource and negative quantity in propose_trade', () => {
      const r1 = validateActionPayload('propose_trade', {
        code: 'ABCDE',
        give: { gold: 1 },
        want: { brick: 1 }
      });
      assert.equal(r1.valid, false);
      assert.ok(r1.errors.some(e => e.includes('Invalid resource "gold"')));

      const r2 = validateActionPayload('propose_trade', {
        code: 'ABCDE',
        give: { wood: -2 },
        want: { brick: 1 }
      });
      assert.equal(r2.valid, false);
      assert.ok(r2.errors.some(e => e.includes('must be a non-negative integer')));
    });

    it('rejects invalid resource in play_monopoly', () => {
      const res = validateActionPayload('play_monopoly', {
        code: 'ABCDE',
        resource: 'diamond'
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Invalid value "diamond"')));
    });

    it('rejects invalid resource array length or content in play_year_of_plenty', () => {
      const r1 = validateActionPayload('play_year_of_plenty', {
        code: 'ABCDE',
        resources: ['wood']
      });
      assert.equal(r1.valid, false);
      assert.ok(r1.errors.some(e => e.includes('exactly 2 resources')));

      const r2 = validateActionPayload('play_year_of_plenty', {
        code: 'ABCDE',
        resources: ['wood', 'brick', 'ore']
      });
      assert.equal(r2.valid, false);
      assert.ok(r2.errors.some(e => e.includes('exactly 2 resources')));

      const r3 = validateActionPayload('play_year_of_plenty', {
        code: 'ABCDE',
        resources: ['gold', 'wood']
      });
      assert.equal(r3.valid, false);
      assert.ok(r3.errors.some(e => e.includes('Invalid resource "gold"')));
    });

    it('rejects invalid resource record in play_year_of_plenty', () => {
      const r1 = validateActionPayload('play_year_of_plenty', {
        code: 'ABCDE',
        resources: { wood: 1 }
      });
      assert.equal(r1.valid, false);
      assert.ok(r1.errors.some(e => e.includes('must equal 2')));

      const r2 = validateActionPayload('play_year_of_plenty', {
        code: 'ABCDE',
        resources: { wood: 3 }
      });
      assert.equal(r2.valid, false);
      assert.ok(r2.errors.some(e => e.includes('must equal 2')));

      const r3 = validateActionPayload('play_year_of_plenty', {
        code: 'ABCDE',
        resources: { wood: -1, brick: 3 }
      });
      assert.equal(r3.valid, false);
      assert.ok(r3.errors.some(e => e.includes('must be a non-negative integer')));
    });

    it('rejects invalid array length in play_road_building', () => {
      const r1 = validateActionPayload('play_road_building', {
        code: 'ABCDE',
        edges: []
      });
      assert.equal(r1.valid, false);
      assert.ok(r1.errors.some(e => e.includes('must contain at least 1 item(s)')));

      const r2 = validateActionPayload('play_road_building', {
        code: 'ABCDE',
        edges: ['e1', 'e2', 'e3']
      });
      assert.equal(r2.valid, false);
      assert.ok(r2.errors.some(e => e.includes('must contain at most 2 item(s)')));
    });

    it('rejects empty strings for edgeId and vertexId', () => {
      const r1 = validateActionPayload('build_road', { code: 'ABCDE', edgeId: '   ' });
      assert.equal(r1.valid, false);
      assert.ok(r1.errors.some(e => e.includes('cannot be empty')));

      const r2 = validateActionPayload('build_settlement', { code: 'ABCDE', vertexId: '' });
      assert.equal(r2.valid, false);
      assert.ok(r2.errors.some(e => e.includes('cannot be empty')));
    });

    it('rejects invalid category in buy_city_improvement', () => {
      const res = validateActionPayload('buy_city_improvement', {
        code: 'ABCDE',
        category: 'military'
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Invalid value "military"')));
    });
  });

  describe('5. Extra unexpected injected properties', () => {
    it('rejects injected properties in build_road', () => {
      const res = validateActionPayload('build_road', {
        code: 'ABCDE',
        edgeId: 'e1',
        injectedField: 'malicious',
        isAdmin: true
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Unrecognized property "injectedField"')));
      assert.ok(res.errors.some(e => e.includes('Unrecognized property "isAdmin"')));
    });

    it('rejects injected properties in roll_dice', () => {
      const res = validateActionPayload('roll_dice', {
        code: 'ABCDE',
        fixedRoll: 7
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Unrecognized property "fixedRoll"')));
    });

    it('rejects injected properties in end_turn', () => {
      const res = validateActionPayload('end_turn', {
        code: 'ABCDE',
        skipTurn: true
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Unrecognized property "skipTurn"')));
    });

    it('rejects injected properties in bank_trade', () => {
      const res = validateActionPayload('bank_trade', {
        code: 'ABCDE',
        give: 'wood',
        receive: 'brick',
        freeResource: true
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Unrecognized property "freeResource"')));
    });

    it('rejects injected properties in propose_trade', () => {
      const res = validateActionPayload('propose_trade', {
        code: 'ABCDE',
        give: { wood: 1 },
        want: { brick: 1 },
        extraPayload: 123
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Unrecognized property "extraPayload"')));
    });

    it('rejects injected properties in discard_cards', () => {
      const res = validateActionPayload('discard_cards', {
        code: 'ABCDE',
        cards: { wood: 1 },
        bypassDiscard: true
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Unrecognized property "bypassDiscard"')));
    });

    it('rejects injected properties in move_robber', () => {
      const res = validateActionPayload('move_robber', {
        code: 'ABCDE',
        hexId: 4,
        stealAll: true
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Unrecognized property "stealAll"')));
    });

    it('rejects injected properties in play_monopoly', () => {
      const res = validateActionPayload('play_monopoly', {
        code: 'ABCDE',
        resource: 'wood',
        stealCommodities: true
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Unrecognized property "stealCommodities"')));
    });

    it('rejects injected properties in buy_city_improvement', () => {
      const res = validateActionPayload('buy_city_improvement', {
        code: 'ABCDE',
        category: 'trade',
        bypassCost: true
      });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some(e => e.includes('Unrecognized property "bypassCost"')));
    });
  });

  describe('6. Socket gateway integration', () => {
    let serverPort = null;
    let serverUrl = null;
    let clientSocket = null;

    before(async () => {
      await new Promise((resolve) => {
        server.listen(0, () => {
          serverPort = server.address().port;
          serverUrl = `http://localhost:${serverPort}`;
          resolve();
        });
      });
      clientSocket = ioClient(serverUrl, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false
      });
      await new Promise(res => clientSocket.on('connect', res));
    });

    after(async () => {
      if (clientSocket?.connected) clientSocket.disconnect();
      serverIo.close();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    });

    it('rejects invalid payload with INVALID_PAYLOAD and details over socket callback', async () => {
      const res = await new Promise((resolve) => {
        clientSocket.emit('build_road', { code: 'ABCDE' }, resolve);
      });
      assert.equal(res.success, false);
      assert.equal(res.error, 'INVALID_PAYLOAD');
      assert.ok(Array.isArray(res.details));
      assert.ok(res.details.some(e => e.includes('Missing required field "edgeId"')));
    });

    it('rejects injected malicious properties with INVALID_PAYLOAD over socket callback', async () => {
      const res = await new Promise((resolve) => {
        clientSocket.emit('roll_dice', { code: 'ABCDE', cheatRoll: 12 }, resolve);
      });
      assert.equal(res.success, false);
      assert.equal(res.error, 'INVALID_PAYLOAD');
      assert.ok(Array.isArray(res.details));
      assert.ok(res.details.some(e => e.includes('Unrecognized property "cheatRoll"')));
    });

    it('emits action_error event when callback is not provided for invalid payload', async () => {
      const errorPromise = new Promise((resolve) => {
        clientSocket.once('action_error', resolve);
      });
      clientSocket.emit('build_settlement', { code: 'ABCDE' }); // no callback
      const errEvent = await errorPromise;
      assert.equal(errEvent.error, 'INVALID_PAYLOAD');
      assert.ok(Array.isArray(errEvent.details));
      assert.ok(errEvent.details.some(e => e.includes('Missing required field "vertexId"')));
    });
  });
});
