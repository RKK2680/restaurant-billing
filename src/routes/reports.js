const express = require('express');
const { requireAdmin } = require('../middleware');
const { dateStr } = require('../validate');
const { badRequest } = require('../errors');

module.exports = (db) => {
  const r = express.Router();
  r.use(requireAdmin);

  function range(req) {
    const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
    const from = dateStr(req.query.from, 'from') || today;
    const to = dateStr(req.query.to, 'to') || from;
    if (from > to) throw badRequest('"From" date must be on or before "To" date');
    return { from, to };
  }

  r.get('/summary', (req, res) => {
    const { from, to } = range(req);
    const totals = db.prepare(`
      SELECT COUNT(*) AS orders, COALESCE(SUM(b.subtotal),0) AS subtotal, COALESCE(SUM(b.discount_amount),0) AS discount,
             COALESCE(SUM(b.service_charge),0) AS service_charge, COALESCE(SUM(b.tax),0) AS tax,
             COALESCE(SUM(b.round_off),0) AS round_off, COALESCE(SUM(b.total),0) AS total
      FROM orders o JOIN bills b ON b.order_id = o.id
      WHERE o.status = 'paid' AND date(o.paid_at) BETWEEN ? AND ?`).get(from, to);
    const cancelled = db.prepare(
      "SELECT COUNT(*) AS n FROM orders WHERE status = 'cancelled' AND date(created_at) BETWEEN ? AND ?"
    ).get(from, to).n;
    const by_method = db.prepare(`
      SELECT p.method, COUNT(*) AS count, SUM(p.amount) AS amount
      FROM payments p JOIN bills b ON b.id = p.bill_id JOIN orders o ON o.id = b.order_id
      WHERE o.status = 'paid' AND date(o.paid_at) BETWEEN ? AND ? GROUP BY p.method ORDER BY amount DESC`).all(from, to);
    const top_items = db.prepare(`
      SELECT i.name, SUM(i.qty) AS qty, SUM(i.qty * i.unit_price) AS revenue
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.status = 'paid' AND i.status != 'cancelled' AND date(o.paid_at) BETWEEN ? AND ?
      GROUP BY i.menu_item_id, i.name ORDER BY qty DESC, revenue DESC LIMIT 10`).all(from, to);
    const by_category = db.prepare(`
      SELECT i.category_name AS name, SUM(i.qty) AS qty, SUM(i.qty * i.unit_price) AS revenue
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.status = 'paid' AND i.status != 'cancelled' AND date(o.paid_at) BETWEEN ? AND ?
      GROUP BY i.category_name ORDER BY revenue DESC`).all(from, to);
    const daily = db.prepare(`
      SELECT date(o.paid_at) AS date, COUNT(*) AS orders, SUM(b.total) AS total
      FROM orders o JOIN bills b ON b.order_id = o.id
      WHERE o.status = 'paid' AND date(o.paid_at) BETWEEN ? AND ? GROUP BY date(o.paid_at) ORDER BY date`).all(from, to);
    res.json({ from, to, totals, cancelled, avg_bill: totals.orders ? Math.round(totals.total / totals.orders) : 0, by_method, top_items, by_category, daily });
  });

  r.get('/export.csv', (req, res) => {
    const { from, to } = range(req);
    const rows = db.prepare(`
      SELECT b.bill_number, o.id AS order_id, o.type, COALESCE(t.name,'') AS tbl, o.paid_at,
             b.subtotal, b.discount_amount, b.service_charge, b.tax, b.round_off, b.total,
             (SELECT GROUP_CONCAT(method || ':' || amount, ' ') FROM payments WHERE bill_id = b.id) AS payments
      FROM orders o JOIN bills b ON b.order_id = o.id LEFT JOIN dining_tables t ON t.id = o.table_id
      WHERE o.status = 'paid' AND date(o.paid_at) BETWEEN ? AND ? ORDER BY o.paid_at`).all(from, to);
    const money = (n) => (n / 100).toFixed(2);
    const cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const lines = ['Bill No,Order,Type,Table,Paid At,Subtotal,Discount,Service Charge,Tax,Round Off,Total,Payments'];
    for (const x of rows) {
      lines.push([x.bill_number, x.order_id, x.type, x.tbl, x.paid_at, money(x.subtotal), money(x.discount_amount),
        money(x.service_charge), money(x.tax), money(x.round_off), money(x.total), x.payments].map(cell).join(','));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="sales_${from}_to_${to}.csv"`);
    res.send(lines.join('\n'));
  });

  return r;
};
