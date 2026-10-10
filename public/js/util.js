// Tiny helpers: HTML escaping template tag, money formatting, toasts, modal.
export class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const part = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : esc(v));
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return new Raw(out);
}

export const state = { settings: { currency_symbol: '₹' }, user: null };

export function money(cents) {
  const n = (Number(cents) || 0) / 100;
  return `${state.settings.currency_symbol}${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// "123.5" -> 12350. Returns null if invalid.
export function toCents(str) {
  const s = String(str ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}
export const fromCents = (c) => (c / 100).toFixed(2);

export function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 5000 : 2500);
}

export function timeAgo(sqlTime) {
  if (!sqlTime) return '';
  const t = new Date(sqlTime.replace(' ', 'T'));
  const m = Math.max(0, Math.floor((Date.now() - t.getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const fmtDateTime = (s) => (s ? new Date(s.replace(' ', 'T')).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---- modal ----
let activeModal = null;
export function closeModal() {
  if (activeModal) { activeModal.remove(); activeModal = null; }
}
export function openModal(content, { title = '', wide = false } = {}) {
  closeModal();
  const root = document.getElementById('modal-root');
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="modal-body">${content}</div></div>`;
  el.addEventListener('mousedown', (e) => { if (e.target === el) closeModal(); });
  el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  root.append(el);
  activeModal = el;
  const first = el.querySelector('[autofocus], input, select, textarea');
  if (first) first.focus();
  return el;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

export function confirmDialog(message, { confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const el = openModal(html`<p>${message}</p>
      <div class="actions"><button class="btn" data-close>Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${confirmText}</button></div>`.toString(), { title: 'Please confirm' });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    el.querySelector('[data-ok]').addEventListener('click', () => { finish(true); closeModal(); });
    new MutationObserver(() => { if (!document.body.contains(el)) finish(false); }).observe(document.getElementById('modal-root'), { childList: true });
  });
}

export function promptDialog(label, { value = '', title = 'Enter details', maxlength = 120, required = false } = {}) {
  return new Promise((resolve) => {
    const el = openModal(html`<form><label>${label}<input name="v" maxlength="${maxlength}" value="${value}" ${required ? 'required' : ''} autofocus></label>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">OK</button></div></form>`.toString(), { title });
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    el.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); finish(e.target.v.value.trim()); closeModal(); });
    new MutationObserver(() => { if (!document.body.contains(el)) finish(null); }).observe(document.getElementById('modal-root'), { childList: true });
  });
}
