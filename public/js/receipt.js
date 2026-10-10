import { html, money, state, fmtDateTime } from './util.js';

const METHOD = { cash: 'Cash', card: 'Card', upi: 'UPI' };

export function receiptHtml(order) {
  const s = state.settings;
  const b = order.bill;
  const items = order.items.filter((i) => i.status !== 'cancelled');
  const half = (r) => String(r / 2).replace(/\.0+$/, '');
  return html`
  <div class="receipt">
    <div class="r-head">
      <strong class="r-name">${s.restaurant_name}</strong>
      ${s.address ? html`<div>${s.address}</div>` : ''}
      ${s.phone ? html`<div>Tel: ${s.phone}</div>` : ''}
      ${s.gstin ? html`<div>GSTIN: ${s.gstin}</div>` : ''}
    </div>
    <hr>
    <div class="r-meta">
      <div><span>Bill No</span><span>${b ? b.bill_number : '(not billed)'}</span></div>
      <div><span>Date</span><span>${fmtDateTime(b ? b.created_at : order.created_at)}</span></div>
      <div><span>Order</span><span>#${order.id} · ${order.type === 'dine_in' ? 'Table ' + order.table_name : 'Takeaway'}</span></div>
      ${order.customer_name ? html`<div><span>Customer</span><span>${order.customer_name}</span></div>` : ''}
    </div>
    <hr>
    <table class="r-items">
      <thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead>
      <tbody>${items.map((i) => html`<tr><td>${i.name}${i.note ? html`<br><small>${i.note}</small>` : ''}</td>
        <td class="n">${i.qty}</td><td class="n">${money(i.unit_price)}</td><td class="n">${money(i.line_total)}</td></tr>`)}</tbody>
    </table>
    <hr>
    ${b ? html`
    <div class="r-totals">
      <div><span>Subtotal</span><span>${money(b.subtotal)}</span></div>
      ${b.discount_amount ? html`<div><span>Discount${b.discount_type === 'percent' ? ` (${b.discount_value}%)` : ''}</span><span>− ${money(b.discount_amount)}</span></div>` : ''}
      ${b.service_charge ? html`<div><span>Service charge (${b.service_charge_rate}%)</span><span>${money(b.service_charge)}</span></div>` : ''}
      ${b.tax_rate > 0 ? html`<div><span>CGST (${half(b.tax_rate)}%)</span><span>${money(b.cgst)}</span></div>
        <div><span>SGST (${half(b.tax_rate)}%)</span><span>${money(b.sgst)}</span></div>` : ''}
      ${b.round_off ? html`<div><span>Round off</span><span>${b.round_off < 0 ? '− ' : ''}${money(Math.abs(b.round_off))}</span></div>` : ''}
      <div class="grand"><span>TOTAL</span><span>${money(b.total)}</span></div>
    </div>
    ${order.payments.length ? html`<hr><div class="r-totals">
      ${order.payments.map((p) => html`<div><span>Paid by ${METHOD[p.method]}</span><span>${money(p.amount)}</span></div>`)}
      ${order.due_amount > 0 ? html`<div><span>Balance due</span><span>${money(order.due_amount)}</span></div>` : ''}
    </div>` : ''}` : html`<div class="r-totals"><div class="grand"><span>Running total</span><span>${money(order.subtotal)}</span></div></div>`}
    <hr>
    <div class="r-foot">${s.bill_footer || ''}</div>
  </div>`.toString();
}

export function printReceipt(order) {
  const area = document.getElementById('print-area');
  area.innerHTML = receiptHtml(order);
  window.print();
}
