# Restaurant Billing & Management System

A small, working point-of-sale for a restaurant: **table / takeaway order → items → kitchen → bill → payment → sales report.**


## Run it

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there is nothing native to compile and no database server to install).

```bash
npm install
npm start            # http://localhost:3000
```

The SQLite file is created automatically at `data/restaurant.db` and seeded with a sample menu (5 categories, 18 items) and 8 tables on first start.
No migrations to run – the schema is applied idempotently on boot (`src/db.js`).

| Command | What it does |
|---|---|
| `npm start` | Start the server (`PORT` and `DB_PATH` env vars are optional) |
| `npm run seed:reset` | Delete the database and start fresh with the seed data |
| `npm test` | Run the automated tests (billing maths + API flow, 17 tests, in-memory DB) |

**Demo logins**

| Role | Username | Password |
|---|---|---|
| Admin | `admin` | `admin123` |
| Staff (waiter / cashier) | `waiter` | `waiter123` |

## Features

**Order taking (staff)**
- Table grid with live status (free / running / billed), running total, item count and time open; auto-refreshes.
- Dine-in orders (one running order per table, enforced in the DB) and takeaway orders with an optional customer name.
- Fast order screen: category chips, instant search, **Enter adds the first match**, tap to add, +/− quantity, per-item kitchen notes ("no onion").
- Same item added twice merges into one line; price/name are snapshotted so later menu edits never change an existing order.
- Move an order to another table, edit guests / customer, cancel an order (reason required).
- "Stock" mode: any staff member can mark an item out of stock; it is greyed out and cannot be ordered.

**Kitchen**
- "Send to kitchen" fires all new items; the Kitchen screen shows *To prepare → Ready → Served* per table with notes and ticket age.
- Cancelling an item that was already sent keeps an audit row (struck through, excluded from totals); unsent items are simply removed.

**Billing**
- Live bill preview from the server (single source of truth for the maths), then generate the bill.
- Discount: none / percent / flat. Optional service charge. Configurable GST (shown as CGST + SGST). Optional round-off to whole currency unit.
- Sequential bill numbers per day (`INV-20261010-0001`).
- Billed orders are locked; an unpaid bill can be voided to re-open the order.
- **Payments:** cash / card / UPI, split payments, partial payments (order stays open for the balance), cash-received → change calculator.
- Printable 80 mm receipt (browser print dialog) available any time after billing, including from order history.

**Admin**
- Menu: categories and items (add, edit, price, veg/non-veg, availability, soft-delete), category ordering and hiding.
- Tables, staff accounts (admin / staff roles, disable, reset password), restaurant details, tax %, service charge %, currency, bill footer.
- Sales report for any date range: net sales, order count, average bill, tax/discount breakdown, payment-method split, top items, category split, daily bars, **CSV export**.

**Orders history:** filter by status / date, search by order #, bill no., table or customer; reopen any order to view or reprint.

## Architecture

```
src/
  index.js            process entry (port, db path, --reset)
  server.js           createApp(): wires middleware, routes, error handler (used by tests too)
  db.js               schema, seed data, transaction helper
  middleware.js       cookie sessions, requireAuth / requireAdmin
  errors.js validate.js   HttpError helpers + input validation
  routes/             thin HTTP layer: auth, admin (menu/tables/users/settings), orders, reports
  services/
    billing.js        PURE bill calculation (integer money) – unit tested
    orders.js         order lifecycle rules, each operation in a DB transaction
    settings.js
public/               no-build vanilla-JS single page app (ES modules)
  js/pages/           one module per screen; js/receipt.js shared bill markup
test/                 node:test – billing.test.js (maths), api.test.js (flows, permissions, validation)
```

Design decisions worth knowing:
- **Money is stored as integers in minor units** (paise/cents) – no floating-point rounding bugs. Bill order of operations: subtotal → discount → + service charge → + GST on (taxable + service) → round-off.
- **Business rules live in the service layer and in the schema** (CHECK constraints, a partial unique index so a table can't have two running orders, even under concurrent requests). The UI never decides what's allowed; it just reflects server state.
- **Every mutating operation is a single SQLite transaction**, so partial failures can't leave half-updated orders or bills.
- **Auth:** scrypt password hashes, random session tokens in an httpOnly cookie, 12 h expiry, login throttling (10 failures / 15 min per IP+username), role checks on every admin endpoint. Staff can't apply discounts over 20%.
- All UI output is HTML-escaped; CSV export neutralises spreadsheet-formula injection.

## Database

SQLite (single file, WAL mode). Tables: `users, sessions, settings, categories, menu_items, dining_tables, orders, order_items, bills, payments`. See `src/db.js`.

## API (all JSON, cookie session)

`POST /api/auth/login|logout`, `GET /api/auth/me` · `GET /api/menu`, `/api/tables`, `/api/kitchen` · `POST /api/orders`, `GET /api/orders?status=&date=&q=` ·
`POST|PATCH|DELETE /api/orders/:id/items[/:itemId]`, `POST /api/orders/:id/send|bill-preview|bill|pay|cancel|move`, `DELETE /api/orders/:id/bill` ·
admin: `/api/categories`, `/api/menu-items`, `/api/tables`, `/api/users`, `/api/settings`, `/api/reports/summary`, `/api/reports/export.csv`.

## Known issues / limitations

- Dates/times use the **server's local time zone** (stored as local timestamps); fine for a single-location restaurant, not for multi-timezone use.
- Kitchen and table screens poll every 5–8 s rather than using websockets, so another device can be a few seconds behind.
- Printing uses the browser print dialog (sized for an 80 mm roll); there is no direct thermal-printer / ESC-POS integration.
- Item quantity can't be edited once an item is sent to the kitchen – cancel and re-add (deliberate, so the kitchen never misses a change).
- Single outlet, single currency, one tax rate for all items. Sessions and login throttling are in the app process (restarting clears the throttle).
- The UI was exercised end-to-end in headless Chromium (login → order → kitchen → bill → split payment → reports) but there is no automated browser test suite committed.


