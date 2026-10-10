// Users, settings, categories, menu items, dining tables.
const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware');
const { notFound, conflict, badRequest } = require('../errors');
const { str, int, num, bool } = require('../validate');
const { hashPassword } = require('../auth-utils');
const { getSettings } = require('../services/settings');

const isUnique = (e) => /UNIQUE constraint failed/i.test(e.message);

module.exports = (db) => {
  const r = express.Router();

  // ---------- settings ----------
  r.get('/settings', requireAuth, (_req, res) => res.json(getSettings(db)));
  r.put('/settings', requireAdmin, (req, res) => {
    const b = req.body;
    const next = {
      restaurant_name: str(b.restaurant_name, 'Restaurant name', { max: 100 }),
      address: str(b.address, 'Address', { required: false, max: 200 }) ?? '',
      phone: str(b.phone, 'Phone', { required: false, max: 30 }) ?? '',
      gstin: str(b.gstin, 'GSTIN', { required: false, max: 30 }) ?? '',
      currency_symbol: str(b.currency_symbol, 'Currency symbol', { max: 4 }),
      tax_rate: String(num(b.tax_rate, 'Tax rate', { min: 0, max: 100 })),
      service_charge_rate: String(num(b.service_charge_rate, 'Service charge', { min: 0, max: 100 })),
      round_off: bool(b.round_off) ? '1' : '0',
      bill_footer: str(b.bill_footer, 'Bill footer', { required: false, max: 200 }) ?? '',
    };
    const up = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(next)) up.run(k, v);
    res.json(getSettings(db));
  });

  // ---------- users ----------
  r.get('/users', requireAdmin, (_req, res) => {
    res.json(db.prepare('SELECT id, username, name, role, active FROM users ORDER BY id').all());
  });
  r.post('/users', requireAdmin, (req, res) => {
    const username = str(req.body.username, 'Username', { max: 50 });
    const name = str(req.body.name, 'Name', { max: 100 });
    const password = str(req.body.password, 'Password', { max: 200 });
    if (password.length < 6) throw badRequest('Password must be at least 6 characters');
    const role = req.body.role === 'admin' ? 'admin' : 'staff';
    try {
      const x = db.prepare('INSERT INTO users(username, name, password_hash, role) VALUES (?,?,?,?)')
        .run(username, name, hashPassword(password), role);
      res.status(201).json({ id: Number(x.lastInsertRowid) });
    } catch (e) {
      if (isUnique(e)) throw conflict('That username is already taken');
      throw e;
    }
  });
  r.put('/users/:id', requireAdmin, (req, res) => {
    const id = int(req.params.id, 'id');
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw notFound('User not found');
    const name = req.body.name === undefined ? u.name : str(req.body.name, 'Name', { max: 100 });
    const role = req.body.role === undefined ? u.role : req.body.role === 'admin' ? 'admin' : 'staff';
    const active = req.body.active === undefined ? u.active : bool(req.body.active) ? 1 : 0;
    if (id === req.user.id && (role !== 'admin' || !active)) throw conflict('You cannot demote or deactivate your own account');
    let hash = u.password_hash;
    if (req.body.password) {
      const p = str(req.body.password, 'Password', { max: 200 });
      if (p.length < 6) throw badRequest('Password must be at least 6 characters');
      hash = hashPassword(p);
    }
    db.prepare('UPDATE users SET name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?').run(name, role, active, hash, id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    res.json({ ok: true });
  });

  // ---------- menu ----------
  r.get('/menu', requireAuth, (req, res) => {
    const all = req.query.all === '1' && req.user.role === 'admin';
    const cats = db.prepare(`SELECT * FROM categories ${all ? '' : 'WHERE active = 1'} ORDER BY sort_order, name`).all();
    const items = db.prepare(`SELECT * FROM menu_items ${all ? '' : 'WHERE active = 1'} ORDER BY name`).all();
    res.json(cats.map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id) })));
  });

  r.post('/categories', requireAdmin, (req, res) => {
    const name = str(req.body.name, 'Category name', { max: 60 });
    const sort = int(req.body.sort_order ?? 0, 'Sort order', { min: 0, max: 9999 });
    try {
      const x = db.prepare('INSERT INTO categories(name, sort_order) VALUES (?, ?)').run(name, sort);
      res.status(201).json({ id: Number(x.lastInsertRowid) });
    } catch (e) {
      if (isUnique(e)) throw conflict('A category with that name already exists');
      throw e;
    }
  });
  r.put('/categories/:id', requireAdmin, (req, res) => {
    const id = int(req.params.id, 'id');
    const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!c) throw notFound('Category not found');
    const name = req.body.name === undefined ? c.name : str(req.body.name, 'Category name', { max: 60 });
    const sort = req.body.sort_order === undefined ? c.sort_order : int(req.body.sort_order, 'Sort order', { min: 0, max: 9999 });
    const active = req.body.active === undefined ? c.active : bool(req.body.active) ? 1 : 0;
    try {
      db.prepare('UPDATE categories SET name = ?, sort_order = ?, active = ? WHERE id = ?').run(name, sort, active, id);
    } catch (e) {
      if (isUnique(e)) throw conflict('A category with that name already exists');
      throw e;
    }
    res.json({ ok: true });
  });

  function itemFields(b, existing) {
    const category_id = b.category_id === undefined && existing ? existing.category_id : int(b.category_id, 'Category');
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ? AND active = 1').get(category_id)) throw badRequest('Choose a valid category');
    return {
      category_id,
      name: b.name === undefined && existing ? existing.name : str(b.name, 'Item name', { max: 100 }),
      price: b.price === undefined && existing ? existing.price : int(b.price, 'Price', { min: 0, max: 100000000 }),
      is_veg: b.is_veg === undefined && existing ? existing.is_veg : bool(b.is_veg) ? 1 : 0,
      available: b.available === undefined && existing ? existing.available : bool(b.available) ? 1 : 0,
    };
  }
  r.post('/menu-items', requireAdmin, (req, res) => {
    const f = itemFields({ available: true, ...req.body });
    const x = db.prepare('INSERT INTO menu_items(category_id, name, price, is_veg, available) VALUES (?,?,?,?,?)')
      .run(f.category_id, f.name, f.price, f.is_veg, f.available);
    res.status(201).json({ id: Number(x.lastInsertRowid) });
  });
  r.put('/menu-items/:id', requireAdmin, (req, res) => {
    const id = int(req.params.id, 'id');
    const it = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
    if (!it) throw notFound('Menu item not found');
    const f = itemFields(req.body, it);
    const active = req.body.active === undefined ? it.active : bool(req.body.active) ? 1 : 0;
    db.prepare('UPDATE menu_items SET category_id=?, name=?, price=?, is_veg=?, available=?, active=? WHERE id=?')
      .run(f.category_id, f.name, f.price, f.is_veg, f.available, active, id);
    res.json({ ok: true });
  });
  // Any signed-in staff member can mark an item out of stock / back in stock.
  r.patch('/menu-items/:id/availability', requireAuth, (req, res) => {
    const id = int(req.params.id, 'id');
    const x = db.prepare('UPDATE menu_items SET available = ? WHERE id = ? AND active = 1').run(bool(req.body.available) ? 1 : 0, id);
    if (!x.changes) throw notFound('Menu item not found');
    res.json({ ok: true });
  });
  r.delete('/menu-items/:id', requireAdmin, (req, res) => {
    // Soft delete so historical orders keep referencing the item.
    const x = db.prepare('UPDATE menu_items SET active = 0 WHERE id = ?').run(int(req.params.id, 'id'));
    if (!x.changes) throw notFound('Menu item not found');
    res.json({ ok: true });
  });

  // ---------- dining tables ----------
  r.post('/tables', requireAdmin, (req, res) => {
    const name = str(req.body.name, 'Table name', { max: 30 });
    const seats = int(req.body.seats ?? 4, 'Seats', { min: 1, max: 100 });
    try {
      const x = db.prepare('INSERT INTO dining_tables(name, seats) VALUES (?, ?)').run(name, seats);
      res.status(201).json({ id: Number(x.lastInsertRowid) });
    } catch (e) {
      if (isUnique(e)) throw conflict('A table with that name already exists');
      throw e;
    }
  });
  r.put('/tables/:id', requireAdmin, (req, res) => {
    const id = int(req.params.id, 'id');
    const t = db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(id);
    if (!t) throw notFound('Table not found');
    const name = req.body.name === undefined ? t.name : str(req.body.name, 'Table name', { max: 30 });
    const seats = req.body.seats === undefined ? t.seats : int(req.body.seats, 'Seats', { min: 1, max: 100 });
    const active = req.body.active === undefined ? t.active : bool(req.body.active) ? 1 : 0;
    if (!active && db.prepare("SELECT 1 FROM orders WHERE table_id = ? AND status IN ('open','billed')").get(id)) {
      throw conflict('This table has a running order and cannot be disabled');
    }
    try {
      db.prepare('UPDATE dining_tables SET name = ?, seats = ?, active = ? WHERE id = ?').run(name, seats, active, id);
    } catch (e) {
      if (isUnique(e)) throw conflict('A table with that name already exists');
      throw e;
    }
    res.json({ ok: true });
  });

  return r;
};
