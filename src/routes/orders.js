const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware');
const { badRequest } = require('../errors');
const { str, int, num, oneOf, dateStr } = require('../validate');
const svc = require('../services/orders');

module.exports = (db) => {
  const r = express.Router();
  r.use(requireAuth);

  const id = (req) => int(req.params.id, 'Order id', { min: 1 });

  // ---------- tables with their running order ----------
  r.get('/tables', (_req, res) => {
    res.json(db.prepare(`
      SELECT t.id, t.name, t.seats, t.active,
             o.id AS order_id, o.status AS order_status, o.created_at AS opened_at, o.guests,
             (SELECT COALESCE(SUM(unit_price*qty),0) FROM order_items WHERE order_id = o.id AND status != 'cancelled') AS running_total,
             (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id = o.id AND status != 'cancelled') AS item_count
      FROM dining_tables t
      LEFT JOIN orders o ON o.table_id = t.id AND o.status IN ('open','billed')
      ORDER BY t.active DESC, LENGTH(t.name), t.name`).all());
  });

  // ---------- list ----------
  r.get('/orders', (req, res) => {
    const status = oneOf(req.query.status, 'status', ['open', 'billed', 'paid', 'cancelled', 'active'], { required: false });
    const date = dateStr(req.query.date, 'date');
    const q = str(req.query.q, 'q', { required: false, max: 60 });
    const where = [];
    const args = [];
    if (status === 'active') where.push("o.status IN ('open','billed')");
    else if (status) { where.push('o.status = ?'); args.push(status); }
    if (date) { where.push('date(o.created_at) = ?'); args.push(date); }
    if (q) {
      where.push('(CAST(o.id AS TEXT) = ? OR o.customer_name LIKE ? OR t.name LIKE ? OR b.bill_number LIKE ?)');
      args.push(q.replace(/^#/, ''), `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const rows = db.prepare(`
      SELECT o.id, o.type, o.status, o.customer_name, o.created_at, o.paid_at, t.name AS table_name, b.bill_number,
             COALESCE(b.total, (SELECT COALESCE(SUM(unit_price*qty),0) FROM order_items WHERE order_id = o.id AND status != 'cancelled')) AS amount,
             (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id = o.id AND status != 'cancelled') AS item_count
      FROM orders o
      LEFT JOIN dining_tables t ON t.id = o.table_id
      LEFT JOIN bills b ON b.order_id = o.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.id DESC LIMIT 200`).all(...args);
    res.json(rows);
  });

  // ---------- kitchen ----------
  r.get('/kitchen', (_req, res) => {
    res.json(db.prepare(`
      SELECT i.id, i.order_id, i.name, i.qty, i.note, i.status, i.sent_at,
             o.type, t.name AS table_name, o.customer_name
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
      LEFT JOIN dining_tables t ON t.id = o.table_id
      WHERE i.status IN ('sent','ready') AND o.status IN ('open','billed')
      ORDER BY i.sent_at, i.id`).all());
  });

  // ---------- create ----------
  r.post('/orders', (req, res) => {
    const type = oneOf(req.body.type ?? 'dine_in', 'type', ['dine_in', 'takeaway']);
    const orderId = svc.createOrder(db, req.user, {
      type,
      table_id: type === 'dine_in' ? int(req.body.table_id, 'Table', { min: 1 }) : null,
      customer_name: str(req.body.customer_name, 'Customer name', { required: false, max: 80 }),
      guests: int(req.body.guests, 'Guests', { required: false, min: 1, max: 100 }),
    });
    res.status(201).json(svc.getOrderFull(db, orderId));
  });

  r.get('/orders/:id', (req, res) => res.json(svc.getOrderFull(db, id(req))));

  r.put('/orders/:id', (req, res) => {
    svc.updateOrderInfo(db, id(req), {
      customer_name: req.body.customer_name === undefined ? undefined : str(req.body.customer_name, 'Customer name', { required: false, max: 80 }),
      guests: req.body.guests === undefined ? undefined : int(req.body.guests, 'Guests', { required: false, min: 1, max: 100 }),
    });
    res.json(svc.getOrderFull(db, id(req)));
  });

  // ---------- items ----------
  r.post('/orders/:id/items', (req, res) => {
    svc.addItem(db, id(req), {
      menu_item_id: int(req.body.menu_item_id, 'Menu item', { min: 1 }),
      qty: int(req.body.qty ?? 1, 'Quantity', { min: 1, max: 99 }),
      note: str(req.body.note, 'Note', { required: false, max: 120 }),
    });
    res.status(201).json(svc.getOrderFull(db, id(req)));
  });

  r.patch('/orders/:id/items/:itemId', (req, res) => {
    const b = req.body;
    svc.updateItem(db, id(req), int(req.params.itemId, 'Item id', { min: 1 }), {
      qty: b.qty === undefined ? undefined : int(b.qty, 'Quantity', { min: 1, max: 99 }),
      note: b.note === undefined ? undefined : str(b.note, 'Note', { required: false, max: 120 }),
      status: b.status === undefined ? undefined : oneOf(b.status, 'status', ['sent', 'ready', 'served']),
    });
    res.json(svc.getOrderFull(db, id(req)));
  });

  r.delete('/orders/:id/items/:itemId', (req, res) => {
    svc.cancelItem(db, id(req), int(req.params.itemId, 'Item id', { min: 1 }));
    res.json(svc.getOrderFull(db, id(req)));
  });

  r.post('/orders/:id/send', (req, res) => {
    svc.sendToKitchen(db, id(req));
    res.json(svc.getOrderFull(db, id(req)));
  });

  // ---------- billing ----------
  function billOpts(b) {
    const discount_type = oneOf(b.discount_type ?? 'none', 'Discount type', ['none', 'percent', 'flat']);
    return {
      discount_type,
      discount_value: discount_type === 'none' ? 0
        : discount_type === 'percent' ? num(b.discount_value ?? 0, 'Discount', { min: 0, max: 100 })
        : int(b.discount_value ?? 0, 'Discount', { min: 0 }),
      service_charge: b.service_charge === undefined ? undefined : !!b.service_charge,
    };
  }
  r.post('/orders/:id/bill-preview', (req, res) => res.json(svc.previewBill(db, id(req), billOpts(req.body))));

  r.post('/orders/:id/bill', (req, res) => {
    const opts = billOpts(req.body);
    // Large discounts are a classic source of leakage; let only admins give more than 20%.
    if (req.user.role !== 'admin' && opts.discount_type === 'percent' && opts.discount_value > 20) {
      throw badRequest('Discounts above 20% need an admin account');
    }
    svc.generateBill(db, req.user, id(req), opts);
    res.status(201).json(svc.getOrderFull(db, id(req)));
  });

  r.delete('/orders/:id/bill', (req, res) => {
    svc.voidBill(db, id(req));
    res.json(svc.getOrderFull(db, id(req)));
  });

  r.post('/orders/:id/pay', (req, res) => {
    const list = Array.isArray(req.body.payments) ? req.body.payments : [req.body];
    if (!list.length || list.length > 10) throw badRequest('Provide between 1 and 10 payments');
    const payments = list.map((p) => ({
      method: oneOf(p.method, 'Payment method', ['cash', 'card', 'upi']),
      amount: int(p.amount, 'Payment amount', { min: 1 }),
    }));
    svc.recordPayments(db, req.user, id(req), payments);
    res.json(svc.getOrderFull(db, id(req)));
  });

  // ---------- lifecycle ----------
  r.post('/orders/:id/cancel', (req, res) => {
    const reason = str(req.body.reason, 'Cancellation reason', { max: 120 });
    svc.cancelOrder(db, id(req), reason);
    res.json(svc.getOrderFull(db, id(req)));
  });

  r.post('/orders/:id/move', (req, res) => {
    svc.moveTable(db, id(req), int(req.body.table_id, 'Table', { min: 1 }));
    res.json(svc.getOrderFull(db, id(req)));
  });

  return r;
};
