import { api, attempt } from '../api.js';
import { html, state, money, toCents, fromCents, toast, openModal, closeModal, confirmDialog, promptDialog, fmtDateTime } from '../util.js';
import { receiptHtml, printReceipt } from '../receipt.js';

const STATUS_LABEL = { new: 'New', sent: 'In kitchen', ready: 'Ready', served: 'Served', cancelled: 'Cancelled' };

export async function mount(app, orderId) {
  let order = await api.get(`/api/orders/${orderId}`);
  const menu = (await api.get('/api/menu')).filter((c) => c.items.length);
  let activeCat = 'all';
  let search = '';
  let stockMode = false;
  let renderedStatus = null;

  app.innerHTML = html`<div class="order-layout"><section class="menu-panel" id="left"></section><aside class="cart-panel card" id="cart"></aside></div>`.toString();
  const left = app.querySelector('#left');
  const cart = app.querySelector('#cart');

  const editable = () => order.status === 'open';

  async function act(fn) {
    const o = await attempt(fn);
    if (o) { order = o; renderAll(); }
    else { // state may have changed under us (e.g. another device); resync quietly
      const fresh = await attempt(() => api.get(`/api/orders/${orderId}`));
      if (fresh) { order = fresh; renderAll(); }
    }
    return o;
  }

  // ---------------- left: menu or receipt ----------------
  function renderLeft() {
    if (editable()) {
      left.innerHTML = html`
        <div class="menu-tools">
          <div class="row"><input id="search" type="search" placeholder="Search menu — Enter adds the first match" value="${search}" autocomplete="off">
            <button class="btn small ${stockMode ? 'primary' : ''}" id="stock" title="Tap items to mark them out of stock / back in stock">${stockMode ? 'Done' : 'Stock'}</button></div>
          <div class="cats" id="cats"></div>
          ${stockMode ? html`<div class="banner">Stock mode: tap an item to mark it unavailable / available.</div>` : ''}
        </div>
        <div id="menu" class="menu-grid"></div>`.toString();
      const s = left.querySelector('#search');
      s.oninput = () => { search = s.value; renderMenu(); };
      left.querySelector('#stock').onclick = () => { stockMode = !stockMode; renderLeft(); };
      s.onkeydown = (e) => {
        if (e.key === 'Enter' && !stockMode) { const first = visibleItems().find((i) => i.available); if (first) { addItem(first.id); s.select(); } }
      };
      renderCats();
      renderMenu();
    } else if (order.status === 'cancelled') {
      left.innerHTML = html`<div class="card empty">This order was cancelled.<br><b>Reason:</b> ${order.cancel_reason || '—'}</div>`.toString();
    } else {
      left.innerHTML = `<div class="card receipt-card">${receiptHtml(order)}</div>`;
    }
  }

  function renderCats() {
    const el = left.querySelector('#cats');
    el.innerHTML = [html`<button class="chip ${activeCat === 'all' ? 'on' : ''}" data-cat="all">All</button>`,
      ...menu.map((c) => html`<button class="chip ${activeCat === c.id ? 'on' : ''}" data-cat="${c.id}">${c.name}</button>`)].map(String).join('');
    el.onclick = (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      activeCat = b.dataset.cat === 'all' ? 'all' : Number(b.dataset.cat);
      renderCats(); renderMenu();
    };
  }

  function visibleItems() {
    const q = search.trim().toLowerCase();
    return menu.filter((c) => activeCat === 'all' || c.id === activeCat).flatMap((c) => c.items)
      .filter((i) => !q || i.name.toLowerCase().includes(q));
  }

  function renderMenu() {
    const el = left.querySelector('#menu');
    const items = visibleItems();
    el.innerHTML = items.length ? items.map((i) => html`
      <button class="menu-item ${i.available ? '' : 'off'}" data-id="${i.id}">
        <span class="veg ${i.is_veg ? 'v' : 'nv'}" title="${i.is_veg ? 'Veg' : 'Non-veg'}"></span>
        <span class="mi-name">${i.name}</span>
        <span class="mi-price">${money(i.price)}</span>
        ${i.available ? '' : html`<span class="mi-off">Unavailable</span>`}
      </button>`).toString() : '<div class="empty">No matching items.</div>';
    el.onclick = async (e) => {
      const b = e.target.closest('.menu-item');
      if (!b) return;
      const item = items.find((i) => i.id === Number(b.dataset.id));
      if (stockMode) {
        const r = await attempt(() => api.patch(`/api/menu-items/${item.id}/availability`, { available: !item.available }));
        if (r) { item.available = item.available ? 0 : 1; renderMenu(); }
        return;
      }
      if (!item.available) { toast(`${item.name} is unavailable`, 'error'); return; }
      addItem(item.id);
    };
  }

  function addItem(menuItemId) {
    return act(() => api.post(`/api/orders/${orderId}/items`, { menu_item_id: menuItemId, qty: 1 }));
  }

  // ---------------- right: cart ----------------
  function renderCart() {
    const o = order;
    const where = o.type === 'dine_in' ? `Table ${o.table_name}` : `Takeaway${o.customer_name ? ' · ' + o.customer_name : ''}`;
    const newCount = o.items.filter((i) => i.status === 'new').reduce((a, i) => a + i.qty, 0);
    const live = o.items.filter((i) => i.status !== 'cancelled');

    cart.innerHTML = html`
      <div class="cart-head">
        <div><h3>${where} <span class="pill ${o.status}">${o.status}</span></h3>
          <div class="muted small">Order #${o.id}${o.guests ? ` · ${o.guests} guests` : ''}${o.type === 'dine_in' && o.customer_name ? ` · ${o.customer_name}` : ''} · ${fmtDateTime(o.created_at)}</div></div>
        ${editable() ? html`<div class="menu-dots">
          ${o.type === 'dine_in' ? html`<button class="btn small" data-act="move">Move table</button>` : ''}
          <button class="btn small" data-act="info">Edit info</button>
          <button class="btn small danger-outline" data-act="cancel">Cancel order</button></div>` : ''}
      </div>
      <div class="cart-items">
        ${o.items.length ? o.items.map((i) => html`
          <div class="line ${i.status}" data-item="${i.id}">
            <div class="l-main">
              <div class="l-name">${i.name} <span class="st ${i.status}">${STATUS_LABEL[i.status]}</span></div>
              ${i.note ? html`<div class="note">“${i.note}”</div>` : ''}
              <div class="muted small">${money(i.unit_price)} each</div>
            </div>
            ${editable() && i.status === 'new' ? html`
              <div class="stepper"><button data-act="dec" aria-label="Decrease">−</button><span>${i.qty}</span><button data-act="inc" aria-label="Increase">+</button></div>`
              : html`<div class="qty-fixed">×${i.qty}</div>`}
            <div class="l-total">${i.status === 'cancelled' ? '—' : money(i.line_total)}</div>
            ${editable() && i.status !== 'cancelled' ? html`<div class="l-actions">
              ${i.status === 'new' ? html`<button class="icon-btn" data-act="note" title="Add note">✎</button>` : ''}
              <button class="icon-btn" data-act="del" title="Remove">🗑</button></div>` : html`<div></div>`}
          </div>`) : html`<div class="empty small">No items yet — tap a menu item to add it.</div>`}
      </div>
      <div class="cart-foot">${renderFoot(live, newCount)}</div>`.toString();
  }

  function renderFoot(live, newCount) {
    const o = order;
    if (o.status === 'open') {
      const p = o.preview;
      return html`
        <div class="totals">
          <div><span>Subtotal</span><span>${money(p.subtotal)}</span></div>
          ${p.service_charge ? html`<div><span>Service charge (${p.service_charge_rate}%)</span><span>${money(p.service_charge)}</span></div>` : ''}
          ${p.tax_rate > 0 ? html`<div><span>GST (${p.tax_rate}%)</span><span>${money(p.tax)}</span></div>` : ''}
          <div class="grand"><span>Estimated total</span><span>${money(p.total)}</span></div>
        </div>
        <div class="actions col">
          <button class="btn big" data-act="send" ${newCount ? '' : 'disabled'}>Send to kitchen${newCount ? ` (${newCount})` : ''}</button>
          <button class="btn primary big" data-act="bill" ${live.length ? '' : 'disabled'}>Generate bill</button>
        </div>`;
    }
    if (o.status === 'billed') {
      const b = o.bill;
      return html`
        <div class="totals">
          <div><span>Bill ${b.bill_number}</span><span>${money(b.total)}</span></div>
          ${o.paid_amount ? html`<div><span>Paid so far</span><span>${money(o.paid_amount)}</span></div>` : ''}
          <div class="grand"><span>Amount due</span><span>${money(o.due_amount)}</span></div>
        </div>
        <div class="actions col">
          <button class="btn primary big" data-act="pay">Take payment</button>
          <div class="row"><button class="btn" data-act="print">🖨 Print bill</button>
          ${o.paid_amount === 0 ? html`<button class="btn" data-act="void">Reopen order</button>` : ''}</div>
        </div>`;
    }
    if (o.status === 'paid') {
      return html`<div class="totals"><div class="grand"><span>Paid</span><span>${money(o.bill.total)}</span></div></div>
        <div class="actions col"><button class="btn primary big" data-act="print">🖨 Print bill</button>
        <a class="btn" href="#/tables">Back to tables</a></div>`;
    }
    return html`<div class="actions col"><a class="btn" href="#/tables">Back to tables</a></div>`;
  }

  cart.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const a = btn.dataset.act;
    const lineEl = btn.closest('[data-item]');
    const item = lineEl ? order.items.find((i) => i.id === Number(lineEl.dataset.item)) : null;
    const base = `/api/orders/${orderId}`;

    if (a === 'inc') return act(() => api.patch(`${base}/items/${item.id}`, { qty: Math.min(99, item.qty + 1) }));
    if (a === 'dec') {
      if (item.qty <= 1) return act(() => api.del(`${base}/items/${item.id}`));
      return act(() => api.patch(`${base}/items/${item.id}`, { qty: item.qty - 1 }));
    }
    if (a === 'del') {
      const sent = item.status !== 'new';
      if (sent && !(await confirmDialog(`"${item.name}" was already sent to the kitchen. Cancel it?`, { confirmText: 'Cancel item', danger: true }))) return;
      return act(() => api.del(`${base}/items/${item.id}`));
    }
    if (a === 'note') {
      const note = await promptDialog('Note for kitchen (e.g. no onion, extra spicy)', { value: item.note || '', title: item.name });
      if (note === null) return;
      return act(() => api.patch(`${base}/items/${item.id}`, { note }));
    }
    if (a === 'send') {
      const r = await act(() => api.post(`${base}/send`));
      if (r) toast('Sent to kitchen', 'success');
      return;
    }
    if (a === 'bill') return billDialog();
    if (a === 'pay') return payDialog();
    if (a === 'print') return printReceipt(order);
    if (a === 'void') {
      if (await confirmDialog('Reopen this order? The bill will be deleted so items can be changed.', { confirmText: 'Reopen' })) {
        return act(() => api.del(`${base}/bill`));
      }
      return;
    }
    if (a === 'cancel') return cancelDialog();
    if (a === 'move') return moveDialog();
    if (a === 'info') return infoDialog();
  };

  // ---------------- dialogs ----------------
  function billDialog() {
    const s = state.settings;
    const el = openModal(html`
      <form id="bf">
        <fieldset><legend>Discount</legend>
          <div class="seg">
            <label><input type="radio" name="dt" value="none" checked> None</label>
            <label><input type="radio" name="dt" value="percent"> Percent %</label>
            <label><input type="radio" name="dt" value="flat"> Flat ${s.currency_symbol}</label>
          </div>
          <input name="dv" inputmode="decimal" placeholder="Value" hidden>
        </fieldset>
        ${s.service_charge_rate > 0 ? html`<label class="inline"><input type="checkbox" name="sc" checked> Apply service charge (${s.service_charge_rate}%)</label>` : ''}
        <div class="totals" id="bp"></div>
        <div class="actions"><button type="button" class="btn" data-close>Back</button><button class="btn primary" id="ok">Generate bill</button></div>
      </form>`.toString(), { title: 'Generate bill' });
    const f = el.querySelector('#bf');
    const bp = el.querySelector('#bp');
    const ok = el.querySelector('#ok');
    let seq = 0;

    function opts() {
      const dt = f.dt.value;
      let dv = 0;
      if (dt === 'percent') { const n = Number(f.dv.value || 0); if (!Number.isFinite(n) || n < 0 || n > 100) return { error: 'Percent must be 0–100' }; dv = n; }
      if (dt === 'flat') { const c = f.dv.value ? toCents(f.dv.value) : 0; if (c === null) return { error: 'Enter a valid amount' }; dv = c; }
      return { body: { discount_type: dt, discount_value: dv, service_charge: f.sc ? f.sc.checked : undefined } };
    }
    async function preview() {
      const my = ++seq;
      const o = opts();
      f.dv.hidden = f.dt.value === 'none';
      if (o.error) { bp.innerHTML = `<div class="err">${o.error}</div>`; ok.disabled = true; return; }
      try {
        const p = await api.post(`/api/orders/${orderId}/bill-preview`, o.body);
        if (my !== seq) return;
        bp.innerHTML = html`
          <div><span>Subtotal</span><span>${money(p.subtotal)}</span></div>
          ${p.discount_amount ? html`<div><span>Discount</span><span>− ${money(p.discount_amount)}</span></div>` : ''}
          ${p.service_charge ? html`<div><span>Service charge</span><span>${money(p.service_charge)}</span></div>` : ''}
          ${p.tax ? html`<div><span>GST (${p.tax_rate}%)</span><span>${money(p.tax)}</span></div>` : ''}
          ${p.round_off ? html`<div><span>Round off</span><span>${p.round_off < 0 ? '− ' : ''}${money(Math.abs(p.round_off))}</span></div>` : ''}
          <div class="grand"><span>Total</span><span>${money(p.total)}</span></div>`.toString();
        ok.disabled = false;
      } catch (err) {
        if (my !== seq) return;
        bp.innerHTML = html`<div class="err">${err.message}</div>`.toString();
        ok.disabled = true;
      }
    }
    f.oninput = preview;
    f.onsubmit = async (e) => {
      e.preventDefault();
      const o = opts();
      if (o.error) return;
      ok.disabled = true;
      const r = await act(() => api.post(`/api/orders/${orderId}/bill`, o.body));
      if (r) { closeModal(); toast('Bill generated', 'success'); } else ok.disabled = false;
    };
    preview();
  }

  function payDialog() {
    const due = order.due_amount;
    let rows = [{ method: 'cash', amount: fromCents(due) }];
    const el = openModal('<div id="pd"></div>', { title: `Payment · due ${money(due)}` });
    const root = el.querySelector('#pd');
    let tendered = '';

    function draw() {
      const cents = rows.map((r) => toCents(r.amount));
      const valid = cents.every((c) => c !== null && c > 0);
      const sum = valid ? cents.reduce((a, c) => a + c, 0) : null;
      const cashSum = valid ? rows.reduce((a, r, i) => a + (r.method === 'cash' ? cents[i] : 0), 0) : 0;
      const hasCash = rows.some((r) => r.method === 'cash');
      const tc = toCents(tendered);
      root.innerHTML = html`
        <form id="pf">
          ${rows.map((r, i) => html`<div class="pay-row">
            <select data-i="${i}" data-k="method">${['cash', 'card', 'upi'].map((m) => html`<option value="${m}" ${r.method === m ? 'selected' : ''}>${m.toUpperCase()}</option>`)}</select>
            <input data-i="${i}" data-k="amount" inputmode="decimal" value="${r.amount}" aria-label="Amount">
            ${rows.length > 1 ? html`<button type="button" class="icon-btn" data-rm="${i}">✕</button>` : html`<span></span>`}
          </div>`)}
          <button type="button" class="btn small" id="split">+ Split payment</button>
          ${hasCash ? html`<label>Cash received (optional)<input id="tend" inputmode="decimal" value="${tendered}" placeholder="to calculate change"></label>
            ${tc !== null && valid && tc >= cashSum ? html`<div class="change">Change to return: <b>${money(tc - cashSum)}</b></div>` : ''}` : ''}
          <div class="totals">
            <div><span>Entering</span><span>${valid ? money(sum) : '—'}</span></div>
            <div class="grand"><span>Remaining after this</span><span>${valid ? money(due - sum) : '—'}</span></div>
          </div>
          ${valid && sum > due ? html`<div class="err">Amount is more than the due ${money(due)}</div>` : ''}
          ${valid && sum < due ? html`<div class="muted small">Partial payment: order stays open for the balance.</div>` : ''}
          <div class="actions"><button type="button" class="btn" data-close>Cancel</button>
            <button class="btn primary" ${valid && sum <= due ? '' : 'disabled'}>Confirm payment</button></div>
        </form>`.toString();
    }
    draw();

    // Edits update state without a full redraw to keep input focus; redraw on structural changes.
    root.oninput = (e) => {
      const t = e.target;
      if (t.id === 'tend') { tendered = t.value; softUpdate(); return; }
      if (t.dataset.k) {
        const i = Number(t.dataset.i);
        rows[i][t.dataset.k] = t.value;
        if (t.dataset.k === 'amount' && rows.length === 2) {
          // two-way split: keep the other row balanced to the remainder
          const mine = toCents(t.value);
          if (mine !== null) rows[1 - i].amount = fromCents(Math.max(0, due - mine));
        }
        if (t.dataset.k === 'method') draw(); else softUpdate();
      }
    };
    function softUpdate() {
      const pos = document.activeElement;
      const id = pos?.id, i = pos?.dataset?.i, k = pos?.dataset?.k, start = pos?.selectionStart;
      draw();
      const sel = id ? root.querySelector('#' + id) : root.querySelector(`[data-i="${i}"][data-k="${k}"]`);
      if (sel) { sel.focus(); try { sel.setSelectionRange(start, start); } catch { /* not text */ } }
    }
    root.onclick = (e) => {
      if (e.target.id === 'split') {
        const cents = rows.map((r) => toCents(r.amount) || 0);
        const rest = Math.max(0, due - cents.reduce((a, c) => a + c, 0));
        rows.push({ method: 'upi', amount: fromCents(rest) });
        draw();
      }
      const rm = e.target.closest('[data-rm]');
      if (rm) { rows.splice(Number(rm.dataset.rm), 1); draw(); }
    };
    root.onsubmit = async (e) => {
      e.preventDefault();
      const payments = rows.map((r) => ({ method: r.method, amount: toCents(r.amount) }));
      const r = await act(() => api.post(`/api/orders/${orderId}/pay`, { payments }));
      if (r) { closeModal(); toast(r.status === 'paid' ? 'Payment complete' : 'Partial payment recorded', 'success'); }
    };
  }

  async function cancelDialog() {
    const reason = await promptDialog('Why is this order being cancelled?', { title: 'Cancel order', required: true });
    if (!reason) return;
    const r = await act(() => api.post(`/api/orders/${orderId}/cancel`, { reason }));
    if (r) { toast('Order cancelled'); location.hash = '#/tables'; }
  }

  async function moveDialog() {
    const tables = (await attempt(() => api.get('/api/tables')))?.filter((t) => t.active && !t.order_id);
    if (!tables) return;
    if (!tables.length) { toast('No free tables available', 'error'); return; }
    const el = openModal(html`<form><label>Move to<select name="t">${tables.map((t) => html`<option value="${t.id}">${t.name} (${t.seats} seats)</option>`)}</select></label>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Move</button></div></form>`.toString(), { title: 'Move table' });
    el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const r = await act(() => api.post(`/api/orders/${orderId}/move`, { table_id: Number(e.target.t.value) }));
      if (r) { closeModal(); toast('Table changed', 'success'); }
    };
  }

  function infoDialog() {
    const el = openModal(html`<form>
      <label>Customer name<input name="n" maxlength="80" value="${order.customer_name || ''}" autofocus></label>
      ${order.type === 'dine_in' ? html`<label>Guests<input name="g" type="number" min="1" max="100" value="${order.guests || ''}"></label>` : ''}
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`.toString(), { title: 'Order info' });
    el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { customer_name: f.n.value.trim() || null };
      if (f.g) body.guests = f.g.value ? Number(f.g.value) : null;
      const r = await act(() => api.put(`/api/orders/${orderId}`, body));
      if (r) closeModal();
    };
  }

  function renderAll() {
    // Only rebuild the left panel when the order's phase changes, so search text and focus survive adding items.
    if (renderedStatus !== order.status || !editable()) { renderedStatus = order.status; stockMode = false; renderLeft(); }
    renderCart();
  }
  renderAll();
  if (editable()) left.querySelector('#search')?.focus();
}
