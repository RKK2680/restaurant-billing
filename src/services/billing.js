// Pure billing calculation. All money values are integers in minor units (paise/cents).
const { badRequest } = require('../errors');

/**
 * Order of operations:
 *   subtotal -> discount -> (taxable) -> + service charge -> + tax on (taxable + service) -> round off
 */
function computeBill({ subtotal, discountType = 'none', discountValue = 0, serviceChargeRate = 0, taxRate = 0, roundOff = true }) {
  if (!Number.isInteger(subtotal) || subtotal < 0) throw badRequest('Invalid subtotal');

  let discount = 0;
  if (discountType === 'percent') {
    if (discountValue < 0 || discountValue > 100) throw badRequest('Percent discount must be between 0 and 100');
    discount = Math.round((subtotal * discountValue) / 100);
  } else if (discountType === 'flat') {
    if (!Number.isInteger(discountValue) || discountValue < 0) throw badRequest('Flat discount must be a non-negative whole amount');
    if (discountValue > subtotal) throw badRequest('Discount cannot exceed the bill subtotal');
    discount = discountValue;
  } else if (discountType !== 'none') {
    throw badRequest('Unknown discount type');
  }

  const taxable = subtotal - discount;
  const serviceCharge = Math.round((taxable * serviceChargeRate) / 100);
  const tax = Math.round(((taxable + serviceCharge) * taxRate) / 100);
  const raw = taxable + serviceCharge + tax;
  const total = roundOff ? Math.round(raw / 100) * 100 : raw;

  return {
    subtotal,
    discount_type: discountType,
    discount_value: discountType === 'none' ? 0 : discountValue,
    discount_amount: discount,
    taxable,
    service_charge_rate: serviceChargeRate,
    service_charge: serviceCharge,
    tax_rate: taxRate,
    tax,
    cgst: Math.floor(tax / 2),
    sgst: tax - Math.floor(tax / 2),
    round_off: total - raw,
    total,
  };
}

module.exports = { computeBill };
