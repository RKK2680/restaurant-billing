const { badRequest, notFound, conflict } = require('../errors');
const { tx } = require('../db');
const { computeBill } = require('./billing');
const { getSettings } = require('./settings');

const ITEM_FLOW = ['new', 'sent', 'ready', 'served'];

function getOrderRow(db, id) {
  const row = db.prepare(`
    SELECT o.*, t.name AS table_name, u.name AS created_by_name
    FROM orders o
    LEFT JOIN dining_tables t ON t.id = o.table_id
    LEFT JOIN users u ON u.id = o.created_by
    WHERE o.id = ?`).get(id);
  if (!row) throw notFound('Order not found');
  return row;
}

function requireOpen(order) {
  if (order.status === 'billed') throw conflict('This order has been billed. Void the bill to edit it.');
  if (order.status !== 'open') throw conflict(`This order is ${order.status} and can no longer be changed`);
}

function activeSubtotal(db, orderId) {
  const { s } = db.prepare(
    "SELECT COALESCE(SUM(unit_price * qty), 0) AS s FROM order_items WHERE order_id = ? AND status != 'cancelled'"
  ).get(orderId);
  return s;
}

function settingsForBill(db, { discount_type = 'none', discount_value = 0, service_charge } = {}) {
  const s = getSettings(db);
  return {
    discountType: discount_type,
    discountValue: discount_value,
    serviceChargeRate: service_charge === undefined ? s.service_charge_rate : service_charge ? s.service_charge_rate : 0,
    taxRate: s.tax_rate,
    roundOff: s.round_off,
  };
}

function getOrderFull(db, id) {
  const order = getOrderRow(db, id);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
  const bill = db.prepare('SELECT * FROM bills WHERE order_id = ?').get(id) || null;
  const payments = bill ? db.prepare('SELECT * FROM payments WHERE bill_id = ? ORDER BY id').all(bill.id) : [];
  const paid = payments.reduce((a, p) => a + p.amount, 0);
  const subtotal = items.filter((i) => i.status !== 'cancelled').reduce((a, i) => a + i.unit_price * i.qty, 0);
  if (bill) {
    const tax = bill.tax;
    bill.taxable = bill.subtotal - bill.discount_amount;
    bill.cgst = Math.floor(tax / 2);
    bill.sgst = tax - Math.floor(tax / 2);
  }
  return {
    ...order,
    items: items.map((i) => ({ ...i, line_total: i.status === 'cancelled' ? 0 : i.unit_price * i.qty })),
    subtotal,
    bill,
    payments,
    paid_amount: paid,
    due_amount: bill ? bill.total - paid : null,
    preview: bill ? null : computeBill({ subtotal, ...settingsForBill(db) }),
  };
}

function createOrder(db, user, { type, table_id, customer_name, guests }) {
  return tx(db, () => {
    let tableId = null;
    if (type === 'dine_in') {
      if (!table_id) throw badRequest('Choose a table for a dine-in order');
      const t = db.prepare('SELECT * FROM dining_tables WHERE id = ? AND active = 1').get(table_id);
      if (!t) throw notFound('Table not found');
      const running = db.prepare("SELECT id FROM orders WHERE table_id = ? AND status IN ('open','billed')").get(table_id);
      if (running) throw conflict(`Table ${t.name} already has a running order (#${running.id})`);
      tableId = t.id;
    }
    const r = db.prepare(
      'INSERT INTO orders(type, table_id, customer_name, guests, created_by) VALUES (?,?,?,?,?)'
    ).run(type, tableId, customer_name, guests, user.id);
    return Number(r.lastInsertRowid);
  });
}

function addItem(db, orderId, { menu_item_id, qty, note }) {
  return tx(db, () => {
    const order = getOrderRow(db, orderId);
    requireOpen(order);
    const mi = db.prepare(`
      SELECT m.*, c.name AS category_name FROM menu_items m JOIN categories c ON c.id = m.category_id
      WHERE m.id = ? AND m.active = 1`).get(menu_item_id);
    if (!mi) throw notFound('Menu item not found');
    if (!mi.available) throw conflict(`${mi.name} is currently unavailable`);
    // Merge into an existing not-yet-sent line with the same note, otherwise add a new line.
    const existing = db.prepare(
      "SELECT id FROM order_items WHERE order_id = ? AND menu_item_id = ? AND status = 'new' AND COALESCE(note,'') = COALESCE(?, '')"
    ).get(orderId, menu_item_id, note);
    if (existing) {
      db.prepare('UPDATE order_items SET qty = qty + ? WHERE id = ?').run(qty, existing.id);
    } else {
      db.prepare(
        'INSERT INTO order_items(order_id, menu_item_id, name, category_name, unit_price, qty, note) VALUES (?,?,?,?,?,?,?)'
      ).run(orderId, mi.id, mi.name, mi.category_name, mi.price, qty, note);
    }
  });
}

function getItem(db, orderId, itemId) {
  const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId);
  if (!item) throw notFound('Order item not found');
  return item;
}

function updateItem(db, orderId, itemId, { qty, note, status }) {
  return tx(db, () => {
    const order = getOrderRow(db, orderId);
    const item = getItem(db, orderId, itemId);
    if (item.status === 'cancelled') throw conflict('This item was cancelled');

    if (status !== undefined) {
      // Kitchen progress. Allowed while the order is open or billed (food may still be going out).
      if (!['open', 'billed'].includes(order.status)) throw conflict(`Order is ${order.status}`);
      const from = ITEM_FLOW.indexOf(item.status);
      const to = ITEM_FLOW.indexOf(status);
      if (to === -1) throw badRequest('Invalid status');
      if (to <= from) throw badRequest(`Cannot move an item from ${item.status} back to ${status}`);
      db.prepare('UPDATE order_items SET status = ?, sent_at = COALESCE(sent_at, CASE WHEN ? = \'sent\' THEN datetime(\'now\',\'localtime\') END) WHERE id = ?').run(status, status, itemId);
      return;
    }

    requireOpen(order);
    if (qty !== undefined) {
      if (item.status !== 'new') throw conflict('This item was already sent to the kitchen. Cancel it and add it again instead.');
      db.prepare('UPDATE order_items SET qty = ? WHERE id = ?').run(qty, itemId);
    }
    if (note !== undefined) {
      if (item.status !== 'new') throw conflict('Notes can only be changed before the item is sent to the kitchen');
      db.prepare('UPDATE order_items SET note = ? WHERE id = ?').run(note, itemId);
    }
  });
}

function cancelItem(db, orderId, itemId) {
  return tx(db, () => {
    const order = getOrderRow(db, orderId);
    requireOpen(order);
    const item = getItem(db, orderId, itemId);
    if (item.status === 'new') {
      db.prepare('DELETE FROM order_items WHERE id = ?').run(itemId); // never reached the kitchen
    } else if (item.status !== 'cancelled') {
      db.prepare("UPDATE order_items SET status = 'cancelled' WHERE id = ?").run(itemId); // keep for audit
    }
  });
}

function sendToKitchen(db, orderId) {
  return tx(db, () => {
    const order = getOrderRow(db, orderId);
    requireOpen(order);
    const r = db.prepare(
      "UPDATE order_items SET status = 'sent', sent_at = datetime('now','localtime') WHERE order_id = ? AND status = 'new'"
    ).run(orderId);
    if (r.changes === 0) throw badRequest('There are no new items to send');
    return Number(r.changes);
  });
}

function previewBill(db, orderId, opts) {
  const order = getOrderRow(db, orderId);
  requireOpen(order);
  return computeBill({ subtotal: activeSubtotal(db, orderId), ...settingsForBill(db, opts) });
}

function generateBill(db, user, orderId, opts) {
  return tx(db, () => {
    const order = getOrderRow(db, orderId);
    requireOpen(order);
    const subtotal = activeSubtotal(db, orderId);
    if (subtotal <= 0) throw badRequest('Add at least one item before generating a bill');
    const c = computeBill({ subtotal, ...settingsForBill(db, opts) });
    const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
    const { next } = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM bills WHERE bill_date = ?').get(today);
    const number = `INV-${today.replaceAll('-', '')}-${String(next).padStart(4, '0')}`;
    db.prepare(`
      INSERT INTO bills(order_id, bill_date, seq, bill_number, subtotal, discount_type, discount_value, discount_amount,
        service_charge_rate, service_charge, tax_rate, tax, round_off, total, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      orderId, today, next, number, c.subtotal, c.discount_type, c.discount_value, c.discount_amount,
      c.service_charge_rate, c.service_charge, c.tax_rate, c.tax, c.round_off, c.total, user.id
    );
    db.prepare("UPDATE orders SET status = 'billed' WHERE id = ?").run(orderId);
  });
}

function voidBill(db, orderId) {
  return tx(db, () => {
    const order = getOrderRow(db, orderId);
    if (order.status !== 'billed') throw conflict('Only a billed, unpaid order can be reopened');
    const bill = db.prepare('SELECT id FROM bills WHERE order_id = ?').get(orderId);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE bill_id = ?').get(bill.id);
    if (n > 0) throw conflict('Payments have already been recorded against this bill');
    db.prepare('DELETE FROM bills WHERE id = ?').run(bill.id);
    db.prepare("UPDATE orders SET status = 'open' WHERE id = ?").run(orderId);
  });
}

function recordPayments(db, user, orderId, payments) {
  return tx(db, () => {
    const order = getOrderRow(db, orderId);
    if (order.status === 'paid') throw conflict('This order is already paid');
    if (order.status !== 'billed') throw conflict('Generate the bill before taking payment');
    const bill = db.prepare('SELECT * FROM bills WHERE order_id = ?').get(orderId);
    const { p } = db.prepare('SELECT COALESCE(SUM(amount),0) AS p FROM payments WHERE bill_id = ?').get(bill.id);
    const incoming = payments.reduce((a, x) => a + x.amount, 0);
    const due = bill.total - p;
    if (incoming > due) throw badRequest('Payment exceeds the amount due');
    const ins = db.prepare('INSERT INTO payments(bill_id, method, amount, created_by) VALUES (?,?,?,?)');
    for (const x of payments) ins.run(bill.id, x.method, x.amount, user.id);
    if (incoming === due) {
      db.prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now','localtime') WHERE id = ?").run(orderId);
    }
    return { due_after: due - incoming };
  });
}

function cancelOrder(db, orderId, reason) {
  return tx(db, () => {
    const order = getOrderRow(db, orderId);
    requireOpen(order);
    db.prepare("UPDATE order_items SET status = 'cancelled' WHERE order_id = ? AND status != 'cancelled'").run(orderId);
    db.prepare("UPDATE orders SET status = 'cancelled', cancel_reason = ? WHERE id = ?").run(reason, orderId);
  });
}

function moveTable(db, orderId, tableId) {
  return tx(db, () => {
    const order = getOrderRow(db, orderId);
    requireOpen(order);
    if (order.type !== 'dine_in') throw badRequest('Only dine-in orders have a table');
    const t = db.prepare('SELECT * FROM dining_tables WHERE id = ? AND active = 1').get(tableId);
    if (!t) throw notFound('Table not found');
    const running = db.prepare("SELECT id FROM orders WHERE table_id = ? AND status IN ('open','billed') AND id != ?").get(tableId, orderId);
    if (running) throw conflict(`Table ${t.name} is occupied`);
    db.prepare('UPDATE orders SET table_id = ? WHERE id = ?').run(tableId, orderId);
  });
}

function updateOrderInfo(db, orderId, { customer_name, guests }) {
  const order = getOrderRow(db, orderId);
  requireOpen(order);
  db.prepare('UPDATE orders SET customer_name = ?, guests = ? WHERE id = ?').run(
    customer_name === undefined ? order.customer_name : customer_name,
    guests === undefined ? order.guests : guests,
    orderId
  );
}

module.exports = {
  getOrderFull, createOrder, addItem, updateItem, cancelItem, sendToKitchen, previewBill,
  generateBill, voidBill, recordPayments, cancelOrder, moveTable, updateOrderInfo,
};
