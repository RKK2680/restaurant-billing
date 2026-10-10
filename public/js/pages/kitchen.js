import { api, attempt } from '../api.js';
import { html, timeAgo } from '../util.js';

let timer = null;

export async function mount(app) {
  app.innerHTML = html`<div class="page-head"><h2>Kitchen</h2><span class="muted small">Auto-refreshes every 5 seconds</span></div>
    <div class="kitchen"><section><h3>To prepare</h3><div id="sent" class="k-col"></div></section>
    <section><h3>Ready to serve</h3><div id="ready" class="k-col"></div></section></div>`.toString();

  async function refresh() {
    const rows = await attempt(() => api.get('/api/kitchen'));
    if (!rows) return;
    for (const status of ['sent', 'ready']) {
      const byOrder = new Map();
      for (const r of rows.filter((x) => x.status === status)) {
        if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
        byOrder.get(r.order_id).push(r);
      }
      app.querySelector('#' + status).innerHTML = byOrder.size ? [...byOrder.entries()].map(([oid, items]) => html`
        <div class="k-card">
          <div class="k-head"><b>${items[0].type === 'dine_in' ? 'Table ' + items[0].table_name : 'Takeaway' + (items[0].customer_name ? ' – ' + items[0].customer_name : '')}</b>
            <span class="muted small">#${oid} · ${timeAgo(items[0].sent_at)}</span></div>
          ${items.map((i) => html`<div class="k-item"><span><b>${i.qty}×</b> ${i.name}${i.note ? html`<br><small class="note">${i.note}</small>` : ''}</span>
            <button class="btn small ${status === 'sent' ? 'primary' : ''}" data-order="${oid}" data-item="${i.id}" data-to="${status === 'sent' ? 'ready' : 'served'}">${status === 'sent' ? 'Ready' : 'Served'}</button></div>`)}
        </div>`).toString() : '<div class="empty small">Nothing here</div>';
    }
  }

  app.onclick = async (e) => {
    const b = e.target.closest('button[data-item]');
    if (!b) return;
    b.disabled = true;
    await attempt(() => api.patch(`/api/orders/${b.dataset.order}/items/${b.dataset.item}`, { status: b.dataset.to }));
    refresh();
  };
  await refresh();
  timer = setInterval(refresh, 5000);
}

export function unmount() { clearInterval(timer); timer = null; document.getElementById('app').onclick = null; }
