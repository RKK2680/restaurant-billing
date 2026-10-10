import { api, attempt } from '../api.js';
import { html, money, timeAgo, openModal, closeModal, toast } from '../util.js';

let timer = null;

export async function mount(app) {
  app.innerHTML = html`
    <div class="page-head"><h2>Tables</h2>
      <div><button class="btn" id="takeaway">+ Takeaway order</button></div></div>
    <div class="legend"><span class="dot free"></span>Free <span class="dot open"></span>Running <span class="dot billed"></span>Billed – awaiting payment</div>
    <div id="grid" class="table-grid"></div>`.toString();

  const grid = app.querySelector('#grid');

  async function refresh() {
    const tables = await attempt(() => api.get('/api/tables'));
    if (!tables) return;
    const active = tables.filter((t) => t.active);
    grid.innerHTML = active.length ? active.map((t) => {
      const st = t.order_id ? t.order_status : 'free';
      return html`<button class="table-card ${st}" data-id="${t.id}" data-order="${t.order_id ?? ''}">
        <div class="t-name">${t.name}</div>
        <div class="t-seats">${t.seats} seats</div>
        ${t.order_id ? html`<div class="t-info"><b>${money(t.running_total)}</b><br>${t.item_count} items · ${timeAgo(t.opened_at)}
          <br><span class="pill ${st}">${st === 'billed' ? 'Billed' : 'Running'}</span></div>` : html`<div class="t-info muted">Tap to start order</div>`}
      </button>`;
    }).toString() : '<div class="empty">No tables yet. Ask an admin to add tables under Manage → Tables.</div>';
  }

  grid.onclick = (e) => {
    const card = e.target.closest('.table-card');
    if (!card) return;
    if (card.dataset.order) { location.hash = `#/order/${card.dataset.order}`; return; }
    const tableId = Number(card.dataset.id);
    const name = card.querySelector('.t-name').textContent;
    const el = openModal(html`<form><label>Guests (optional)<input name="guests" type="number" min="1" max="100" inputmode="numeric" autofocus></label>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Start order</button></div></form>`.toString(), { title: `Table ${name}` });
    el.querySelector('form').onsubmit = async (ev) => {
      ev.preventDefault();
      const g = ev.target.guests.value;
      const o = await attempt(() => api.post('/api/orders', { type: 'dine_in', table_id: tableId, guests: g ? Number(g) : null }));
      if (o) { closeModal(); location.hash = `#/order/${o.id}`; }
      else refresh(); // table may have just been taken by someone else
    };
  };

  app.querySelector('#takeaway').onclick = () => {
    const el = openModal(html`<form><label>Customer name (optional)<input name="name" maxlength="80" autofocus></label>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Start order</button></div></form>`.toString(), { title: 'Takeaway order' });
    el.querySelector('form').onsubmit = async (ev) => {
      ev.preventDefault();
      const o = await attempt(() => api.post('/api/orders', { type: 'takeaway', customer_name: ev.target.name.value || null }));
      if (o) { closeModal(); toast(`Order #${o.id} started`); location.hash = `#/order/${o.id}`; }
    };
  };

  await refresh();
  timer = setInterval(refresh, 8000);
}

export function unmount() { clearInterval(timer); timer = null; }
