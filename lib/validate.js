// ---------------------------------------------------------------------------
// Minimal JSON Schema validator (draft-07 subset).
// Deliberately dependency-free: it runs unchanged inside an n8n Code node,
// where npm packages are not available by default. Supports the keywords the
// AI output schemas in schemas/ actually use.
// ---------------------------------------------------------------------------

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null
};

function typeMatches(value, type) {
  if (Array.isArray(type)) return type.some((t) => typeMatches(value, t));
  const check = TYPE_CHECKS[type];
  return check ? check(value) : true;
}

/**
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validate(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return { valid: true, errors };

  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${path}: expected ${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}, got ${describe(value)}`);
    return { valid: false, errors };
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength} (${value.length})`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match /${schema.pattern}/`);
  }

  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: at most ${schema.maxItems} items`);
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validate(item, schema.items, `${path}[${i}]`).errors);
      });
    }
    if (schema.uniqueItems) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) errors.push(`${path}: items must be unique`);
    }
  }

  if (TYPE_CHECKS.object(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value) || value[key] === undefined) errors.push(`${path}.${key}: required property missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value && value[key] !== undefined) {
        errors.push(...validate(value[key], sub, `${path}.${key}`).errors);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(`${path}.${key}: unexpected property`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function assertValid(value, schema, label = 'payload') {
  const { valid, errors } = validate(value, schema);
  if (!valid) {
    const error = new Error(`${label} failed schema validation: ${errors.slice(0, 8).join('; ')}`);
    error.name = 'SchemaValidationError';
    error.errors = errors;
    throw error;
  }
  return value;
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
