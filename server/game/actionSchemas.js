/**
 * actionSchemas.js
 * Declarative zero-dependency JSON schema validator for Catan game actions.
 * Enforces strict structure, required fields, data types, value ranges,
 * and rejects any unrecognized / unexpected properties.
 */

export const BASE_RESOURCES = Object.freeze([
  'wood',
  'brick',
  'wool',
  'wheat',
  'ore'
]);

export const COMMODITY_RESOURCES = Object.freeze([
  'cloth',
  'coin',
  'paper'
]);

export const VALID_RESOURCES = Object.freeze([
  ...BASE_RESOURCES,
  ...COMMODITY_RESOURCES
]);

export const VALID_CATEGORIES = Object.freeze([
  'politics',
  'science',
  'trade',
  'POLITICS',
  'SCIENCE',
  'TRADE'
]);

const ROOM_CODE_REGEX = /^[A-Za-z0-9]{5}$/;

/**
 * Registry of declarative action schemas.
 */
export const ACTION_SCHEMAS = {
  // Required core actions from Issue #214
  build_road: {
    code: { type: 'roomCode', required: true },
    edgeId: { type: 'string', required: true, nonEmpty: true }
  },
  build_settlement: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  build_city: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  build_city_wall: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  roll_dice: {
    code: { type: 'roomCode', required: true }
  },
  end_turn: {
    code: { type: 'roomCode', required: true }
  },
  bank_trade: {
    code: { type: 'roomCode', required: true },
    give: { type: 'string', required: true, enum: VALID_RESOURCES, caseInsensitiveEnum: true },
    receive: { type: 'string', required: true, enum: VALID_RESOURCES, caseInsensitiveEnum: true },
    ratio: { type: 'integer', required: false, min: 2, max: 4 }
  },
  propose_trade: {
    code: { type: 'roomCode', required: true },
    give: { type: 'resourceRecord', required: true },
    want: { type: 'resourceRecord', required: true },
    targetPlayerId: { type: 'string', required: false, nonEmpty: true }
  },
  accept_trade: {
    code: { type: 'roomCode', required: true },
    tradeId: { type: 'string', required: false }
  },
  reject_trade: {
    code: { type: 'roomCode', required: true },
    tradeId: { type: 'string', required: false }
  },
  cancel_trade: {
    code: { type: 'roomCode', required: true }
  },
  discard_cards: {
    code: { type: 'roomCode', required: true },
    cards: { type: 'resourceRecord', required: true }
  },
  move_robber: {
    code: { type: 'roomCode', required: true },
    hexId: { type: 'hexId', required: true },
    victimPlayerId: { type: 'stringOrNull', required: false },
    targetPlayerId: { type: 'stringOrNull', required: false }
  },
  move_pirate: {
    code: { type: 'roomCode', required: true },
    hexId: { type: 'hexId', required: true },
    victimPlayerId: { type: 'stringOrNull', required: false }
  },
  buy_dev_card: {
    code: { type: 'roomCode', required: true }
  },
  play_knight: {
    code: { type: 'roomCode', required: true },
    hexId: { type: 'hexId', required: false },
    victimPlayerId: { type: 'stringOrNull', required: false }
  },
  play_year_of_plenty: {
    code: { type: 'roomCode', required: true },
    resources: { type: 'yearOfPlentyResources', required: true }
  },
  play_monopoly: {
    code: { type: 'roomCode', required: true },
    resource: { type: 'string', required: true, enum: BASE_RESOURCES, caseInsensitiveEnum: true }
  },
  play_road_building: {
    code: { type: 'roomCode', required: true },
    edges: { type: 'stringArray', required: true, minItems: 1, maxItems: 2 }
  },
  buy_city_improvement: {
    code: { type: 'roomCode', required: true },
    category: { type: 'string', required: true, enum: VALID_CATEGORIES, caseInsensitiveEnum: true }
  },

  // Additional gameplay actions in Catan codebase
  place_setup_settlement: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  place_setup_city: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  place_setup_road: {
    code: { type: 'roomCode', required: true },
    edgeId: { type: 'string', required: true, nonEmpty: true }
  },
  upgrade_city: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  improve_city: {
    code: { type: 'roomCode', required: true },
    track: { type: 'string', required: true, enum: VALID_CATEGORIES, caseInsensitiveEnum: true }
  },
  claim_aqueduct_resource: {
    code: { type: 'roomCode', required: true },
    resource: { type: 'string', required: true, enum: VALID_RESOURCES, caseInsensitiveEnum: true }
  },
  choose_metropolis: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  place_knight: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  activate_knight: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  promote_knight: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  move_knight: {
    code: { type: 'roomCode', required: true },
    fromVertexId: { type: 'string', required: true, nonEmpty: true },
    toVertexId: { type: 'string', required: true, nonEmpty: true }
  },
  relocate_displaced_knight: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  relocate_knight: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  chase_robber: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true },
    hexId: { type: 'hexId', required: true },
    victimPlayerId: { type: 'stringOrNull', required: false },
    targetPlayerId: { type: 'stringOrNull', required: false }
  },
  downgrade_city: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  choose_barbarian_reward: {
    code: { type: 'roomCode', required: true },
    deck: { type: 'string', required: true, enum: VALID_CATEGORIES, caseInsensitiveEnum: true }
  },
  claim_barbarian_progress_card: {
    code: { type: 'roomCode', required: true },
    deck: { type: 'string', required: true, enum: VALID_CATEGORIES, caseInsensitiveEnum: true }
  },
  play_dev_card: {
    code: { type: 'roomCode', required: true },
    cardId: { type: 'string', required: true, nonEmpty: true },
    options: { type: 'object', required: false }
  },
  play_progress_card: {
    code: { type: 'roomCode', required: true },
    cardId: { type: 'string', required: true, nonEmpty: true },
    options: { type: 'object', required: false }
  },
  respond_progress_choice: {
    code: { type: 'roomCode', required: true },
    cards: { type: 'progressChoiceCards', required: false },
    commodity: { type: 'string', required: false }
  },
  choose_deserter_knight: {
    code: { type: 'roomCode', required: true },
    vertexId: { type: 'string', required: true, nonEmpty: true }
  },
  place_deserter_knight: {
    code: { type: 'roomCode', required: true },
    placeVertexId: { type: 'string', required: false },
    vertexId: { type: 'string', required: false },
    placeRank: { type: 'string', required: false },
    skip: { type: 'boolean', required: false }
  },
  discard_progress_card: {
    code: { type: 'roomCode', required: true },
    cardId: { type: 'string', required: true, nonEmpty: true }
  },
  respond_trade: {
    code: { type: 'roomCode', required: true },
    accept: { type: 'boolean', required: true }
  },
  confirm_trade: {
    code: { type: 'roomCode', required: true },
    targetPlayerId: { type: 'string', required: false, nonEmpty: true }
  }
};

/**
 * Validates a single field according to its rule definition.
 * @param {string} fieldName 
 * @param {*} value 
 * @param {object} rule 
 * @returns {string|null} error message or null if valid
 */
function validateField(fieldName, value, rule) {
  switch (rule.type) {
    case 'roomCode': {
      if (typeof value !== 'string') {
        return `Field "${fieldName}" must be a string`;
      }
      if (value.length !== 5 || !ROOM_CODE_REGEX.test(value)) {
        return `Field "${fieldName}" must be a 5-character alphanumeric string`;
      }
      return null;
    }

    case 'string': {
      if (typeof value !== 'string') {
        return `Field "${fieldName}" must be a string`;
      }
      if (rule.nonEmpty && value.trim().length === 0) {
        return `Field "${fieldName}" cannot be empty`;
      }
      if (rule.length !== undefined && value.length !== rule.length) {
        return `Field "${fieldName}" must be of length ${rule.length}`;
      }
      if (rule.enum) {
        const match = rule.caseInsensitiveEnum
          ? rule.enum.some(item => item.toLowerCase() === value.toLowerCase())
          : rule.enum.includes(value);
        if (!match) {
          return `Invalid value "${value}" for field "${fieldName}" (must be one of: ${rule.enum.join(', ')})`;
        }
      }
      return null;
    }

    case 'integer': {
      if (!Number.isInteger(value)) {
        return `Field "${fieldName}" must be an integer`;
      }
      if (rule.min !== undefined && value < rule.min) {
        return `Field "${fieldName}" must be at least ${rule.min}`;
      }
      if (rule.max !== undefined && value > rule.max) {
        return `Field "${fieldName}" must be at most ${rule.max}`;
      }
      return null;
    }

    case 'boolean': {
      if (typeof value !== 'boolean') {
        return `Field "${fieldName}" must be a boolean`;
      }
      return null;
    }

    case 'hexId': {
      const isString = typeof value === 'string' && value.trim().length > 0;
      const isInt = Number.isInteger(value);
      if (!isString && !isInt) {
        return `Field "${fieldName}" must be a non-empty string or integer`;
      }
      return null;
    }

    case 'stringOrNull': {
      if (value !== null && (typeof value !== 'string' || value.trim().length === 0)) {
        return `Field "${fieldName}" must be a non-empty string or null`;
      }
      return null;
    }

    case 'resourceRecord': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return `Field "${fieldName}" must be an object`;
      }
      const allowed = rule.allowedResources || VALID_RESOURCES;
      for (const [resKey, count] of Object.entries(value)) {
        if (!allowed.some(item => item.toLowerCase() === resKey.toLowerCase())) {
          return `Invalid resource "${resKey}" in field "${fieldName}"`;
        }
        if (!Number.isInteger(count)) {
          return `Quantity for resource "${resKey}" in field "${fieldName}" must be an integer`;
        }
        if (count < 0) {
          return `Quantity for resource "${resKey}" in field "${fieldName}" must be a non-negative integer`;
        }
      }
      return null;
    }

    case 'stringArray': {
      if (!Array.isArray(value)) {
        return `Field "${fieldName}" must be an array`;
      }
      if (rule.minItems !== undefined && value.length < rule.minItems) {
        return `Field "${fieldName}" must contain at least ${rule.minItems} item(s)`;
      }
      if (rule.maxItems !== undefined && value.length > rule.maxItems) {
        return `Field "${fieldName}" must contain at most ${rule.maxItems} item(s)`;
      }
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item !== 'string' || item.trim().length === 0) {
          return `Item at index ${i} of "${fieldName}" must be a non-empty string`;
        }
        if (rule.allowedItems) {
          const match = rule.allowedItems.some(allowed => allowed.toLowerCase() === item.toLowerCase());
          if (!match) {
            return `Invalid item "${item}" in field "${fieldName}"`;
          }
        }
      }
      return null;
    }

    case 'yearOfPlentyResources': {
      if (Array.isArray(value)) {
        if (value.length !== 2) {
          return 'Field "resources" array must contain exactly 2 resources';
        }
        for (const r of value) {
          if (typeof r !== 'string' || !BASE_RESOURCES.some(item => item.toLowerCase() === r.toLowerCase())) {
            return `Invalid resource "${r}" in field "resources"`;
          }
        }
        return null;
      }

      if (value !== null && typeof value === 'object') {
        let sum = 0;
        for (const [resKey, count] of Object.entries(value)) {
          if (!BASE_RESOURCES.some(item => item.toLowerCase() === resKey.toLowerCase())) {
            return `Invalid resource "${resKey}" in field "resources"`;
          }
          if (!Number.isInteger(count)) {
            return `Quantity for resource "${resKey}" in field "resources" must be an integer`;
          }
          if (count < 0) {
            return `Quantity for resource "${resKey}" in field "resources" must be a non-negative integer`;
          }
          sum += count;
        }
        if (sum !== 2) {
          return `Total count of resources in field "resources" must equal 2 (got ${sum})`;
        }
        return null;
      }

      return 'Field "resources" must be an array of 2 resources or a record of resources summing to 2';
    }

    case 'progressChoiceCards': {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (typeof value[i] !== 'string') {
            return `Item at index ${i} of "cards" must be a string`;
          }
        }
        return null;
      }
      if (value !== null && typeof value === 'object') {
        for (const [resKey, count] of Object.entries(value)) {
          if (!VALID_RESOURCES.some(item => item.toLowerCase() === resKey.toLowerCase())) {
            return `Invalid resource "${resKey}" in field "cards"`;
          }
          if (!Number.isInteger(count) || count < 0) {
            return `Quantity for resource "${resKey}" in field "cards" must be a non-negative integer`;
          }
        }
        return null;
      }
      return 'Field "cards" must be an array or object';
    }

    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return `Field "${fieldName}" must be an object`;
      }
      return null;
    }

    default:
      return `Unknown rule type "${rule.type}" for field "${fieldName}"`;
  }
}

/**
 * Validates incoming action payload against declared schema.
 * Rejects missing required fields, wrong data types, out of range values,
 * invalid enum values, and any unrecognized / unexpected properties.
 *
 * @param {string} actionName
 * @param {object} payload
 * @returns {{ valid: boolean, errors?: string[] }}
 */
export function validateActionPayload(actionName, payload) {
  if (!actionName || typeof actionName !== 'string') {
    return { valid: false, errors: ['Action name must be a non-empty string'] };
  }

  const schema = ACTION_SCHEMAS[actionName];
  if (!schema) {
    return { valid: false, errors: [`Unknown action "${actionName}"`] };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['Payload must be a non-null object'] };
  }

  const errors = [];
  const allowedKeys = new Set(Object.keys(schema));

  // Reject unrecognized / injected properties
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      errors.push(`Unrecognized property "${key}" for action "${actionName}"`);
    }
  }

  // Validate declared fields
  for (const [fieldName, rule] of Object.entries(schema)) {
    const value = payload[fieldName];

    if (value === undefined) {
      if (rule.required) {
        errors.push(`Missing required field "${fieldName}" for action "${actionName}"`);
      }
      continue;
    }

    const fieldError = validateField(fieldName, value, rule);
    if (fieldError) {
      errors.push(fieldError);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true };
}
