const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBill } = require('../src/services/billing');

test('plain tax, no discount, round off', () => {
  const b = computeBill({ subtotal: 10000, taxRate: 5 });
  assert.equal(b.tax, 500);
  assert.equal(b.total, 10500);
  assert.equal(b.round_off, 0);
});

test('percent discount reduces the taxable amount', () => {
  const b = computeBill({ subtotal: 20000, discountType: 'percent', discountValue: 10, taxRate: 5 });
  assert.equal(b.discount_amount, 2000);
  assert.equal(b.taxable, 18000);
  assert.equal(b.tax, 900);
  assert.equal(b.total, 18900);
});

test('flat discount cannot exceed subtotal', () => {
  assert.throws(() => computeBill({ subtotal: 5000, discountType: 'flat', discountValue: 5001 }), /exceed/);
  assert.equal(computeBill({ subtotal: 5000, discountType: 'flat', discountValue: 5000 }).total, 0);
});

test('service charge is taxed, total rounds to nearest whole unit', () => {
  const b = computeBill({ subtotal: 12345, serviceChargeRate: 10, taxRate: 5 });
  assert.equal(b.service_charge, 1235);          // 1234.5 -> 1235
  assert.equal(b.tax, 679);                      // (12345+1235)*5% = 679
  assert.equal(b.total % 100, 0);
  assert.equal(b.subtotal - b.discount_amount + b.service_charge + b.tax + b.round_off, b.total);
});

test('round off can be disabled', () => {
  const b = computeBill({ subtotal: 12345, taxRate: 5, roundOff: false });
  assert.equal(b.total, 12345 + 617); // 617.25 -> 617
  assert.equal(b.round_off, 0);
});

test('cgst + sgst always equals tax', () => {
  for (const s of [101, 999, 12345, 55555]) {
    const b = computeBill({ subtotal: s, taxRate: 5 });
    assert.equal(b.cgst + b.sgst, b.tax);
  }
});

test('rejects bad percent', () => {
  assert.throws(() => computeBill({ subtotal: 100, discountType: 'percent', discountValue: 101 }));
  assert.throws(() => computeBill({ subtotal: 100, discountType: 'percent', discountValue: -1 }));
});
