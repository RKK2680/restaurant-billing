function getSettings(db) {
  const out = {};
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) out[key] = value;
  return {
    ...out,
    tax_rate: Number(out.tax_rate),
    service_charge_rate: Number(out.service_charge_rate),
    round_off: out.round_off === '1',
  };
}

module.exports = { getSettings };
