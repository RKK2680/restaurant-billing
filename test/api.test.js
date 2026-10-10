const test = require('node:test');
const assert = require('node:assert/strict');
const { start, asAdmin, asWaiter } = require('./helpers');

let ctx;
test.before(async () => { ctx = await start(); });
test.after(async () => { await ctx.close(); });

const itemId = async (c, name) => {
  const menu = (await c.get('/api/menu')).data;
  return menu.flatMap((x) => x.items).find((i) => i.name === name).id;
};

test('auth: requires login, rejects bad password, role checks', async () => {
  const anon = ctx.client();
  assert.equal((await anon.get('/api/menu')).status, 401);
  assert.equal((await anon.login('admin', 'nope')).status, 401);
  const w = await asWaiter(ctx);
  assert.equal((await w.get('/api/menu')).status, 200);
  assert.equal((await w.get('/api/reports/summary')).status, 403);
  assert.equal((await w.post('/api/categories', { name: 'X' })).status, 403);
  const out = await w.post('/api/auth/logout');
  assert.equal(out.status, 200);
});

test('login rate limiting kicks in', async () => {
  const c = ctx.client();
  let last;
  for (let i = 0; i < 11; i++) last = await c.login('ghost', 'wrong');
  assert.equal(last.status, 429);
});

test('full flow: order -> items -> kitchen -> bill -> split payment', async () => {
  const c = await asWaiter(ctx);
  const tables = (await c.get('/api/tables')).data;
  const t1 = tables[0];
  const o = await c.post('/api/orders', { type: 'dine_in', table_id: t1.id, guests: 2 });
  assert.equal(o.status, 201);
  const oid = o.data.id;

  const naan = await itemId(c, 'Butter Naan');       // 4500
  const paneer = await itemId(c, 'Paneer Tikka');    // 22000
  await c.post(`/api/orders/${oid}/items`, { menu_item_id: naan, qty: 2 });
  await c.post(`/api/orders/${oid}/items`, { menu_item_id: naan, qty: 1 }); // merges
  let r = await c.post(`/api/orders/${oid}/items`, { menu_item_id: paneer, qty: 1, note: 'less spicy' });
  assert.equal(r.data.items.length, 2);
  assert.equal(r.data.items.find((i) => i.name === 'Butter Naan').qty, 3);
  assert.equal(r.data.subtotal, 3 * 4500 + 22000);

  // table now occupied
  assert.equal((await c.post('/api/orders', { type: 'dine_in', table_id: t1.id })).status, 409);

  // send to kitchen, progress it
  assert.equal((await c.post(`/api/orders/${oid}/send`)).status, 200);
  assert.equal((await c.post(`/api/orders/${oid}/send`)).status, 400); // nothing new
  const kitchen = (await c.get('/api/kitchen')).data.filter((k) => k.order_id === oid);
  assert.equal(kitchen.length, 2);
  const it = r.data.items[0];
  assert.equal((await c.patch(`/api/orders/${oid}/items/${it.id}`, { qty: 5 })).status, 409); // sent: qty locked
  assert.equal((await c.patch(`/api/orders/${oid}/items/${it.id}`, { status: 'ready' })).status, 200);
  assert.equal((await c.patch(`/api/orders/${oid}/items/${it.id}`, { status: 'sent' })).status, 400); // no going back

  // bill with 10% discount
  const prev = await c.post(`/api/orders/${oid}/bill-preview`, { discount_type: 'percent', discount_value: 10 });
  assert.equal(prev.data.discount_amount, 3550);
  assert.equal((await c.post(`/api/orders/${oid}/bill`, { discount_type: 'percent', discount_value: 50 })).status, 400); // waiter cap
  const b = await c.post(`/api/orders/${oid}/bill`, { discount_type: 'percent', discount_value: 10 });
  assert.equal(b.status, 201);
  assert.match(b.data.bill.bill_number, /^INV-\d{8}-0001$/);
  assert.equal(b.data.status, 'billed');
  const total = b.data.bill.total;
  assert.equal(total, b.data.due_amount);

  // billed => locked
  assert.equal((await c.post(`/api/orders/${oid}/items`, { menu_item_id: naan })).status, 409);
  assert.equal((await c.post(`/api/orders/${oid}/bill`, {})).status, 409);

  // overpay rejected, split payment accepted
  assert.equal((await c.post(`/api/orders/${oid}/pay`, { method: 'cash', amount: total + 100 })).status, 400);
  let p = await c.post(`/api/orders/${oid}/pay`, { method: 'upi', amount: 10000 });
  assert.equal(p.data.status, 'billed');
  assert.equal(p.data.due_amount, total - 10000);
  assert.equal((await c.del(`/api/orders/${oid}/bill`)).status, 409); // has payments
  p = await c.post(`/api/orders/${oid}/pay`, { payments: [{ method: 'cash', amount: total - 10000 }] });
  assert.equal(p.data.status, 'paid');
  assert.equal(p.data.due_amount, 0);
  assert.equal((await c.post(`/api/orders/${oid}/pay`, { method: 'cash', amount: 100 })).status, 409);

  // table freed
  const again = (await c.get('/api/tables')).data.find((t) => t.id === t1.id);
  assert.equal(again.order_id, null);
  assert.equal((await c.post('/api/orders', { type: 'dine_in', table_id: t1.id })).status, 201);
});

test('void bill reopens order; cancel order frees table', async () => {
  const c = await asWaiter(ctx);
  const t = (await c.get('/api/tables')).data.find((x) => !x.order_id);
  const oid = (await c.post('/api/orders', { type: 'dine_in', table_id: t.id })).data.id;
  assert.equal((await c.post(`/api/orders/${oid}/bill`, {})).status, 400); // empty
  await c.post(`/api/orders/${oid}/items`, { menu_item_id: await itemId(c, 'Masala Chai') });
  assert.equal((await c.post(`/api/orders/${oid}/bill`, {})).status, 201);
  const v = await c.del(`/api/orders/${oid}/bill`);
  assert.equal(v.data.status, 'open');
  assert.equal(v.data.bill, null);
  assert.equal((await c.post(`/api/orders/${oid}/cancel`, {})).status, 400); // reason required
  const x = await c.post(`/api/orders/${oid}/cancel`, { reason: 'Guests left' });
  assert.equal(x.data.status, 'cancelled');
  assert.equal((await c.post(`/api/orders/${oid}/items`, { menu_item_id: await itemId(c, 'Masala Chai') })).status, 409);
  assert.equal((await c.get('/api/tables')).data.find((y) => y.id === t.id).order_id, null);
});

test('takeaway needs no table; cancelling a sent item keeps audit row and excludes it from totals', async () => {
  const c = await asWaiter(ctx);
  const o = await c.post('/api/orders', { type: 'takeaway', customer_name: 'Ravi' });
  assert.equal(o.status, 201);
  const oid = o.data.id;
  const chai = await itemId(c, 'Masala Chai');
  await c.post(`/api/orders/${oid}/items`, { menu_item_id: chai, qty: 2 });
  await c.post(`/api/orders/${oid}/send`);
  let r = await c.get(`/api/orders/${oid}`);
  const line = r.data.items[0];
  r = await c.del(`/api/orders/${oid}/items/${line.id}`);
  assert.equal(r.data.items[0].status, 'cancelled');
  assert.equal(r.data.subtotal, 0);
  // unsent line is deleted outright
  r = await c.post(`/api/orders/${oid}/items`, { menu_item_id: chai });
  const fresh = r.data.items.find((i) => i.status === 'new');
  r = await c.del(`/api/orders/${oid}/items/${fresh.id}`);
  assert.equal(r.data.items.length, 1);
});

test('validation: bad ids, quantities, unavailable items', async () => {
  const c = await asWaiter(ctx);
  const a = await asAdmin(ctx);
  const t = (await c.get('/api/tables')).data.find((x) => !x.order_id);
  const oid = (await c.post('/api/orders', { type: 'dine_in', table_id: t.id })).data.id;
  const chai = await itemId(c, 'Masala Chai');
  assert.equal((await c.post(`/api/orders/${oid}/items`, { menu_item_id: chai, qty: 0 })).status, 400);
  assert.equal((await c.post(`/api/orders/${oid}/items`, { menu_item_id: chai, qty: 1.5 })).status, 400);
  assert.equal((await c.post(`/api/orders/${oid}/items`, { menu_item_id: 99999 })).status, 404);
  assert.equal((await c.get('/api/orders/abc')).status, 400);
  assert.equal((await c.get('/api/orders/99999')).status, 404);
  assert.equal((await c.post('/api/orders', { type: 'dine_in' })).status, 400);
  assert.equal((await c.post('/api/orders', { type: 'dine_in', table_id: 99999 })).status, 404);
  assert.equal((await c.patch(`/api/menu-items/${chai}/availability`, { available: false })).status, 200);
  assert.equal((await c.post(`/api/orders/${oid}/items`, { menu_item_id: chai })).status, 409);
  await a.patch(`/api/menu-items/${chai}/availability`, { available: true });
  assert.equal((await c.post(`/api/orders/${oid}/items`, { menu_item_id: chai })).status, 201);
});

test('price changes do not alter existing order lines', async () => {
  const a = await asAdmin(ctx);
  const t = (await a.get('/api/tables')).data.find((x) => !x.order_id);
  const oid = (await a.post('/api/orders', { type: 'dine_in', table_id: t.id })).data.id;
  const id = await itemId(a, 'Dal Makhani');
  await a.post(`/api/orders/${oid}/items`, { menu_item_id: id });
  await a.put(`/api/menu-items/${id}`, { price: 99900 });
  assert.equal((await a.get(`/api/orders/${oid}`)).data.subtotal, 21000);
  await a.put(`/api/menu-items/${id}`, { price: 21000 });
});

test('admin CRUD: menu, tables, users, settings', async () => {
  const a = await asAdmin(ctx);
  const cat = await a.post('/api/categories', { name: 'Specials' });
  assert.equal(cat.status, 201);
  assert.equal((await a.post('/api/categories', { name: 'specials' })).status, 409); // case-insensitive unique
  const item = await a.post('/api/menu-items', { category_id: cat.data.id, name: 'Thali', price: 25000, is_veg: true });
  assert.equal(item.status, 201);
  assert.equal((await a.post('/api/menu-items', { category_id: cat.data.id, name: 'Bad', price: -5 })).status, 400);
  assert.equal((await a.del(`/api/menu-items/${item.data.id}`)).status, 200);
  const menu = (await a.get('/api/menu')).data;
  assert.ok(!menu.flatMap((c) => c.items).some((i) => i.name === 'Thali'));

  assert.equal((await a.post('/api/tables', { name: 'T1' })).status, 409);
  assert.equal((await a.post('/api/tables', { name: 'Patio 1', seats: 6 })).status, 201);

  const u = await a.post('/api/users', { username: 'sam', name: 'Sam', password: 'secret1' });
  assert.equal(u.status, 201);
  assert.equal((await a.post('/api/users', { username: 'SAM', name: 'x', password: 'secret1' })).status, 409);
  const sam = ctx.client();
  assert.equal((await sam.login('sam', 'secret1')).status, 200);
  assert.equal((await a.put(`/api/users/${u.data.id}`, { active: false })).status, 200);
  assert.equal((await sam.get('/api/menu')).status, 401); // session killed
  const me = (await a.get('/api/auth/me')).data.user;
  assert.equal((await a.put(`/api/users/${me.id}`, { role: 'staff' })).status, 409);

  const s = await a.put('/api/settings', { restaurant_name: 'Spice Hub', currency_symbol: '₹', tax_rate: 18, service_charge_rate: 0, round_off: true });
  assert.equal(s.data.tax_rate, 18);
  assert.equal((await a.put('/api/settings', { restaurant_name: 'x', currency_symbol: '₹', tax_rate: 400 })).status, 400);
  await a.put('/api/settings', { restaurant_name: 'My Restaurant', currency_symbol: '₹', tax_rate: 5, service_charge_rate: 0, round_off: true });
});

test('reports aggregate paid orders only', async () => {
  const a = await asAdmin(ctx);
  const o = await a.post('/api/orders', { type: 'takeaway' });
  await a.post(`/api/orders/${o.data.id}/items`, { menu_item_id: await itemId(a, 'Gulab Jamun'), qty: 2 });
  const billed = await a.post(`/api/orders/${o.data.id}/bill`, {});
  await a.post(`/api/orders/${o.data.id}/pay`, { method: 'card', amount: billed.data.bill.total });
  const rep = (await a.get('/api/reports/summary')).data;
  assert.ok(rep.totals.orders >= 2);
  assert.ok(rep.by_method.some((m) => m.method === 'card'));
  assert.ok(rep.top_items.some((i) => i.name === 'Gulab Jamun' && i.qty >= 2));
  assert.equal((await a.get('/api/reports/summary?from=2026-02-30')).status, 400);
  assert.equal((await a.get('/api/reports/summary?from=2026-05-02&to=2026-05-01')).status, 400);
  const csv = await a.get('/api/reports/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.data, /^Bill No,/);
});

test('unknown API route gives 404', async () => {
  const c = await asWaiter(ctx);
  assert.equal((await c.get('/api/nothing')).status, 404);
});
