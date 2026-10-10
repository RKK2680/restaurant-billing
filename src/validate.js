const { badRequest } = require('./errors');

function str(v, name, { required = true, max = 200 } = {}) {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  if (typeof v !== 'string') throw badRequest(`${name} must be text`);
  const t = v.trim();
  if (t.length > max) throw badRequest(`${name} must be at most ${max} characters`);
  return t;
}

function int(v, name, { min = -Infinity, max = Infinity, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isInteger(n)) throw badRequest(`${name} must be a whole number`);
  if (n < min) throw badRequest(`${name} must be at least ${min}`);
  if (n > max) throw badRequest(`${name} must be at most ${max}`);
  return n;
}

function num(v, name, { min = -Infinity, max = Infinity, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw badRequest(`${name} must be a number`);
  if (n < min) throw badRequest(`${name} must be at least ${min}`);
  if (n > max) throw badRequest(`${name} must be at most ${max}`);
  return n;
}

function oneOf(v, name, options, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  if (!options.includes(v)) throw badRequest(`${name} must be one of: ${options.join(', ')}`);
  return v;
}

function bool(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function dateStr(v, name, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const valid = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(v)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!valid) {
    throw badRequest(`${name} must be a date in YYYY-MM-DD format`);
  }
  return v;
}

module.exports = { str, int, num, oneOf, bool, dateStr };
