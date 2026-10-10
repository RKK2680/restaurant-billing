const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth-utils');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL COLLATE NOCASE,
  price INTEGER NOT NULL CHECK (price >= 0),          -- minor units (paise/cents)
  is_veg INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL DEFAULT 1,               -- toggled by staff when out of stock
  active INTEGER NOT NULL DEFAULT 1                   -- soft delete
);

CREATE TABLE IF NOT EXISTS dining_tables (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  seats INTEGER NOT NULL DEFAULT 4 CHECK (seats > 0),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('dine_in','takeaway')),
  table_id INTEGER REFERENCES dining_tables(id),
  customer_name TEXT,
  guests INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','billed','paid','cancelled')),
  cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  paid_at TEXT
);
-- A table can only have one running order at a time.
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_one_active_per_table
  ON orders(table_id) WHERE table_id IS NOT NULL AND status IN ('open','billed');

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  name TEXT NOT NULL,                                  -- snapshot at time of order
  category_name TEXT NOT NULL,
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0), -- snapshot at time of order
  qty INTEGER NOT NULL CHECK (qty > 0),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','sent','ready','served','cancelled')),
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS ix_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  bill_date TEXT NOT NULL,
  seq INTEGER NOT NULL,
  bill_number TEXT NOT NULL UNIQUE,
  subtotal INTEGER NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none','percent','flat')),
  discount_value REAL NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  service_charge_rate REAL NOT NULL DEFAULT 0,
  service_charge INTEGER NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  round_off INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (bill_date, seq)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('cash','card','upi')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

const DEFAULT_SETTINGS = {
  restaurant_name: 'My Restaurant',
  address: '12 Main Street, Your City',
  phone: '',
  gstin: '',
  currency_symbol: '₹',
  tax_rate: '5',
  service_charge_rate: '0',
  round_off: '1',
  bill_footer: 'Thank you! Visit again.',
};

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

function seedIfEmpty(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return false;
  tx(db, () => {
    const addUser = db.prepare('INSERT INTO users(username, name, password_hash, role) VALUES (?,?,?,?)');
    addUser.run('admin', 'Admin', hashPassword('admin123'), 'admin');
    addUser.run('waiter', 'Waiter', hashPassword('waiter123'), 'staff');

    const addCat = db.prepare('INSERT INTO categories(name, sort_order) VALUES (?, ?)');
    const addItem = db.prepare('INSERT INTO menu_items(category_id, name, price, is_veg) VALUES (?,?,?,?)');
    const menu = {
      Starters: [['Paneer Tikka', 220, 1], ['Veg Spring Roll', 150, 1], ['Chicken 65', 240, 0], ['Crispy Corn', 170, 1]],
      'Main Course': [['Butter Chicken', 320, 0], ['Paneer Butter Masala', 260, 1], ['Dal Makhani', 210, 1], ['Veg Biryani', 230, 1], ['Chicken Biryani', 290, 0]],
      Breads: [['Butter Naan', 45, 1], ['Tandoori Roti', 25, 1], ['Garlic Naan', 60, 1]],
      Beverages: [['Masala Chai', 40, 1], ['Cold Coffee', 110, 1], ['Fresh Lime Soda', 70, 1], ['Mineral Water', 20, 1]],
      Desserts: [['Gulab Jamun', 80, 1], ['Brownie with Ice Cream', 140, 1]],
    };
    let order = 0;
    for (const [cat, items] of Object.entries(menu)) {
      const { lastInsertRowid } = addCat.run(cat, order++);
      for (const [name, rupees, veg] of items) addItem.run(Number(lastInsertRowid), name, rupees * 100, veg);
    }

    const addTable = db.prepare('INSERT INTO dining_tables(name, seats) VALUES (?, ?)');
    for (let i = 1; i <= 8; i++) addTable.run(`T${i}`, i <= 4 ? 2 : i <= 7 ? 4 : 6);
  });
  return true;
}

module.exports = { openDb, seedIfEmpty, tx, DEFAULT_SETTINGS };
