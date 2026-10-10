import { api, attempt } from '../api.js';
import { html, money, fmtDateTime } from '../util.js';

export async function mount(app) {
  app.innerHTML = html`
    <div class="page-head"><h2>Orders</h2></div>
    <form class="filters" id="f">
      <label>Status<select name="status"><option value="">All</option><option value="active">Active (open + billed)</option>
        <option value="open">Open</option><option value="billed">Billed</option><option value="paid">Paid</option><option value="cancelled">Cancelled</option></select></label>
      <label>Date<input type="date" name="date"></label>
      <label>Search<input name="q" placeholder="Order #, bill no, table, customer"></label>
      <button class="btn" type="button" id="clear">Clear</button>
    </form>
    <div class="card flush"><table class="grid"><thead><tr><th>Order</th><th>Type</th><th>Status</th><th>Bill no</th><th>Items</th><th class="n">Amount</th><th>Created</th></tr></thead>
    <tbody id="rows"></tbody></table></div>`.toString();

  const f = app.querySelector('#f');
  async function load() {
    const p = new URLSearchParams();
    for (const k of ['status', 'date', 'q']) if (f[k].value.trim()) p.set(k, f[k].value.trim());
    const rows = await attempt(() => api.get('/api/orders?' + p));
    if (!rows) return;
    app.querySelector('#rows').innerHTML = rows.length ? rows.map((o) => html`
      <tr class="clickable" data-id="${o.id}"><td><b>#${o.id}</b></td>
        <td>${o.type === 'dine_in' ? 'Table ' + o.table_name : 'Takeaway' + (o.customer_name ? ' · ' + o.customer_name : '')}</td>
        <td><span class="pill ${o.status}">${o.status}</span></td><td>${o.bill_number || '—'}</td>
        <td>${o.item_count}</td><td class="n">${money(o.amount)}</td><td>${fmtDateTime(o.created_at)}</td></tr>`).toString()
      : '<tr><td colspan="7" class="empty">No orders match.</td></tr>';
  }
  let t;
  f.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  f.onsubmit = (e) => e.preventDefault();
  app.querySelector('#clear').onclick = () => { f.reset(); load(); };
  app.querySelector('#rows').onclick = (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) location.hash = `#/order/${tr.dataset.id}`;
  };
  await load();
}
