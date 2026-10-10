import { api, attempt } from '../api.js';
import { html, money, todayStr } from '../util.js';

export async function mount(app) {
  const t = todayStr();
  app.innerHTML = html`
    <div class="page-head"><h2>Sales report</h2></div>
    <form class="filters" id="f">
      <label>From<input type="date" name="from" value="${t}" max="${t}"></label>
      <label>To<input type="date" name="to" value="${t}"></label>
      <button class="btn" type="button" data-range="today">Today</button>
      <button class="btn" type="button" data-range="7">Last 7 days</button>
      <button class="btn" type="button" data-range="30">Last 30 days</button>
      <a class="btn" id="csv">Download CSV</a>
    </form>
    <div id="out"></div>`.toString();
  const f = app.querySelector('#f');
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  async function load() {
    const q = new URLSearchParams({ from: f.from.value, to: f.to.value });
    app.querySelector('#csv').href = '/api/reports/export.csv?' + q;
    const r = await attempt(() => api.get('/api/reports/summary?' + q));
    const out = app.querySelector('#out');
    if (!r) { out.innerHTML = ''; return; }
    const max = Math.max(1, ...r.daily.map((d) => d.total));
    const T = r.totals;
    out.innerHTML = html`
      <div class="stats">
        <div class="stat"><span>Net sales</span><b>${money(T.total)}</b></div>
        <div class="stat"><span>Paid orders</span><b>${T.orders}</b></div>
        <div class="stat"><span>Average bill</span><b>${money(r.avg_bill)}</b></div>
        <div class="stat"><span>Cancelled orders</span><b>${r.cancelled}</b></div>
      </div>
      <div class="cols">
        <div class="card"><h3>Breakdown</h3><table class="kv">
          <tr><td>Gross (items)</td><td>${money(T.subtotal)}</td></tr><tr><td>Discounts</td><td>− ${money(T.discount)}</td></tr>
          <tr><td>Service charge</td><td>${money(T.service_charge)}</td></tr><tr><td>GST collected</td><td>${money(T.tax)}</td></tr>
          <tr><td>Round off</td><td>${T.round_off < 0 ? '− ' : ''}${money(Math.abs(T.round_off))}</td></tr><tr class="grand"><td>Total</td><td>${money(T.total)}</td></tr></table></div>
        <div class="card"><h3>Payments received</h3>${r.by_method.length ? html`<table class="kv">${r.by_method.map((m) => html`<tr><td>${m.method.toUpperCase()} <small class="muted">(${m.count})</small></td><td>${money(m.amount)}</td></tr>`)}</table>` : html`<div class="muted">No payments</div>`}</div>
      </div>
      ${r.daily.length > 1 ? html`<div class="card"><h3>Daily sales</h3><div class="bars">${r.daily.map((d) => html`
        <div class="bar-row"><span>${d.date}</span><div class="bar"><i style="width:${Math.round((d.total / max) * 100)}%"></i></div><span>${money(d.total)} <small class="muted">(${d.orders})</small></span></div>`)}</div></div>` : ''}
      <div class="cols">
        <div class="card"><h3>Top items</h3>${r.top_items.length ? html`<table class="kv">${r.top_items.map((i) => html`<tr><td>${i.name}</td><td>${i.qty} sold · ${money(i.revenue)}</td></tr>`)}</table>` : html`<div class="muted">No sales</div>`}</div>
        <div class="card"><h3>By category</h3>${r.by_category.length ? html`<table class="kv">${r.by_category.map((i) => html`<tr><td>${i.name}</td><td>${i.qty} · ${money(i.revenue)}</td></tr>`)}</table>` : html`<div class="muted">No sales</div>`}</div>
      </div>`.toString();
  }
  f.onchange = load;
  f.onsubmit = (e) => e.preventDefault();
  f.addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (!b) return;
    const to = new Date();
    const from = new Date();
    if (b.dataset.range !== 'today') from.setDate(from.getDate() - (Number(b.dataset.range) - 1));
    f.from.value = ymd(from); f.to.value = ymd(to);
    load();
  });
  await load();
}
