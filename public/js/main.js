import { api, attempt, loadSettings } from './api.js';
import { html, state, esc } from './util.js';
import * as login from './pages/login.js';
import * as tables from './pages/tables.js';
import * as order from './pages/order.js';
import * as kitchen from './pages/kitchen.js';
import * as orders from './pages/orders.js';
import * as admin from './pages/admin.js';
import * as reports from './pages/reports.js';

const routes = [
  { re: /^#\/login$/, page: login, public: true },
  { re: /^#\/tables$/, page: tables },
  { re: /^#\/order\/(\d+)$/, page: order },
  { re: /^#\/kitchen$/, page: kitchen },
  { re: /^#\/orders$/, page: orders },
  { re: /^#\/admin(?:\/(\w+))?$/, page: admin, admin: true },
  { re: /^#\/reports$/, page: reports, admin: true },
];

const app = document.getElementById('app');
let current = null;

function renderTopbar() {
  const bar = document.getElementById('topbar');
  if (!state.user) { bar.hidden = true; return; }
  bar.hidden = false;
  const hash = location.hash;
  const link = (href, label) => `<a href="${href}" class="${hash.startsWith(href) ? 'active' : ''}">${label}</a>`;
  const isAdmin = state.user.role === 'admin';
  bar.innerHTML = `
    <div class="brand">${esc(state.settings.restaurant_name || 'Restaurant')}</div>
    <nav>${link('#/tables', 'Tables')}${link('#/orders', 'Orders')}${link('#/kitchen', 'Kitchen')}
      ${isAdmin ? link('#/reports', 'Reports') + link('#/admin', 'Manage') : ''}</nav>
    <div class="who"><span>${esc(state.user.name)} <small>(${esc(state.user.role)})</small></span>
      <button class="btn small" id="logout">Sign out</button></div>`;
  bar.querySelector('#logout').onclick = async () => {
    await attempt(() => api.post('/api/auth/logout'));
    state.user = null;
    location.hash = '#/login';
  };
}

async function route() {
  if (current?.page.unmount) current.page.unmount();
  current = null;
  const hash = location.hash || '#/tables';
  const match = routes.map((r) => ({ r, m: hash.match(r.re) })).find((x) => x.m);

  if (!state.user) {
    try { state.user = (await api.get('/api/auth/me')).user; } catch { state.user = null; }
  }
  if (!match || (!state.user && !match.r.public)) {
    location.hash = state.user ? '#/tables' : '#/login';
    return;
  }
  if (state.user && match.r.public) { location.hash = '#/tables'; return; }
  if (match.r.admin && state.user.role !== 'admin') {
    app.innerHTML = '<div class="empty">Admin access required.</div>';
    renderTopbar();
    return;
  }
  if (state.user) { try { await loadSettings(); } catch { /* ignore */ } }
  renderTopbar();
  app.innerHTML = '';
  current = { page: match.r.page };
  try {
    await match.r.page.mount(app, ...match.m.slice(1));
  } catch (e) {
    app.innerHTML = html`<div class="empty">${e.message}<br><a href="#/tables">Back to tables</a></div>`.toString();
  }
}

window.addEventListener('hashchange', route);
route();
