import { api, attempt, loadSettings } from '../api.js';
import { html, esc, state, money, toCents, fromCents, toast, openModal, closeModal, confirmDialog } from '../util.js';

const TABS = [['menu', 'Menu'], ['tables', 'Tables'], ['users', 'Staff'], ['settings', 'Settings']];

export async function mount(app, tab = 'menu') {
  if (!TABS.some(([k]) => k === tab)) tab = 'menu';
  app.innerHTML = html`<div class="page-head"><h2>Manage</h2></div>
    <div class="tabs">${TABS.map(([k, l]) => html`<a href="#/admin/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`)}</div>
    <div id="pane"></div>`.toString();
  const pane = app.querySelector('#pane');
  await ({ menu: menuTab, tables: tablesTab, users: usersTab, settings: settingsTab })[tab](pane);
}

const field = (label, input) => `<label>${label}${input}</label>`;
const actions = (ok = 'Save') => `<div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">${ok}</button></div>`;

// ---------------- Menu ----------------
async function menuTab(pane) {
  async function draw() {
    const cats = await attempt(() => api.get('/api/menu?all=1'));
    if (!cats) return;
    pane.innerHTML = html`
      <div class="row between"><h3>Categories & items</h3>
        <div><button class="btn" data-a="add-cat">+ Category</button> <button class="btn primary" data-a="add-item" ${cats.some((c) => c.active) ? '' : 'disabled'}>+ Menu item</button></div></div>
      ${cats.map((c) => html`
        <div class="card flush ${c.active ? '' : 'inactive'}">
          <div class="cat-head"><b>${c.name}</b> ${c.active ? '' : html`<span class="pill cancelled">hidden</span>`}
            <span class="muted small">order ${c.sort_order}</span>
            <span class="spacer"></span>
            <button class="btn small" data-a="edit-cat" data-id="${c.id}">Edit</button></div>
          <table class="grid"><tbody>${c.items.length ? c.items.map((i) => html`
            <tr class="${i.active ? '' : 'inactive'}"><td><span class="veg ${i.is_veg ? 'v' : 'nv'}"></span> ${i.name}
              ${i.active ? '' : html`<span class="pill cancelled">deleted</span>`}${i.active && !i.available ? html`<span class="pill billed">out of stock</span>` : ''}</td>
              <td class="n">${money(i.price)}</td>
              <td class="n"><button class="btn small" data-a="edit-item" data-id="${i.id}">Edit</button></td></tr>`)
            : html`<tr><td class="muted">No items</td></tr>`}</tbody></table>
        </div>`)}`.toString();

    const itemById = (id) => cats.flatMap((c) => c.items).find((i) => i.id === Number(id));
    pane.onclick = (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      if (b.dataset.a === 'add-cat') catForm();
      if (b.dataset.a === 'edit-cat') catForm(cats.find((c) => c.id === Number(b.dataset.id)));
      if (b.dataset.a === 'add-item') itemForm();
      if (b.dataset.a === 'edit-item') itemForm(itemById(b.dataset.id));
    };

    function catForm(c) {
      const el = openModal(`<form>${field('Name', `<input name="name" required maxlength="60" value="${esc(c?.name || '')}" autofocus>`)}
        ${field('Display order (lower first)', `<input name="sort" type="number" min="0" max="9999" value="${c?.sort_order ?? 0}">`)}
        ${c ? `<label class="inline"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Visible on order screen</label>` : ''}
        ${actions()}</form>`, { title: c ? 'Edit category' : 'New category' });
      el.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        const body = { name: f.name.value, sort_order: Number(f.sort.value || 0) };
        if (c) body.active = f.active.checked;
        const r = await attempt(() => (c ? api.put(`/api/categories/${c.id}`, body) : api.post('/api/categories', body)));
        if (r) { closeModal(); toast('Saved', 'success'); draw(); }
      };
    }

    function itemForm(i) {
      const active = cats.filter((c) => c.active || (i && c.id === i.category_id));
      const el = openModal(`<form>
        ${field('Name', `<input name="name" required maxlength="100" value="${esc(i?.name || '')}" autofocus>`)}
        ${field('Category', `<select name="cat">${active.map((c) => `<option value="${c.id}" ${i && i.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`)}
        ${field(`Price (${state.settings.currency_symbol})`, `<input name="price" required inputmode="decimal" value="${i ? fromCents(i.price) : ''}" placeholder="0.00">`)}
        <label class="inline"><input type="checkbox" name="veg" ${!i || i.is_veg ? 'checked' : ''}> Vegetarian</label>
        <label class="inline"><input type="checkbox" name="avail" ${!i || i.available ? 'checked' : ''}> Available</label>
        ${i ? `<label class="inline"><input type="checkbox" name="active" ${i.active ? 'checked' : ''}> Active (uncheck to delete)</label>` : ''}
        ${actions()}</form>`, { title: i ? 'Edit item' : 'New item' });
      el.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        const price = toCents(f.price.value);
        if (price === null) { toast('Enter a valid price, e.g. 120 or 120.50', 'error'); return; }
        const body = { name: f.name.value, category_id: Number(f.cat.value), price, is_veg: f.veg.checked, available: f.avail.checked };
        if (i) body.active = f.active.checked;
        const r = await attempt(() => (i ? api.put(`/api/menu-items/${i.id}`, body) : api.post('/api/menu-items', body)));
        if (r) { closeModal(); toast('Saved', 'success'); draw(); }
      };
    }
  }
  await draw();
}

// ---------------- Tables ----------------
async function tablesTab(pane) {
  async function draw() {
    const tables = await attempt(() => api.get('/api/tables'));
    if (!tables) return;
    pane.innerHTML = html`<div class="row between"><h3>Dining tables</h3><button class="btn primary" data-a="add">+ Table</button></div>
      <div class="card flush"><table class="grid"><thead><tr><th>Name</th><th>Seats</th><th>Status</th><th></th></tr></thead><tbody>
      ${tables.map((t) => html`<tr class="${t.active ? '' : 'inactive'}"><td><b>${t.name}</b></td><td>${t.seats}</td>
        <td>${!t.active ? html`<span class="pill cancelled">disabled</span>` : t.order_id ? html`<span class="pill ${t.order_status}">in use</span>` : 'Free'}</td>
        <td class="n"><button class="btn small" data-a="edit" data-id="${t.id}">Edit</button></td></tr>`)}</tbody></table></div>`.toString();
    pane.onclick = (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      form(b.dataset.a === 'edit' ? tables.find((t) => t.id === Number(b.dataset.id)) : null);
    };
    function form(t) {
      const el = openModal(`<form>${field('Name', `<input name="name" required maxlength="30" value="${esc(t?.name || '')}" autofocus>`)}
        ${field('Seats', `<input name="seats" type="number" min="1" max="100" required value="${t?.seats ?? 4}">`)}
        ${t ? `<label class="inline"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}> Enabled</label>` : ''}${actions()}</form>`, { title: t ? 'Edit table' : 'New table' });
      el.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        const body = { name: f.name.value, seats: Number(f.seats.value) };
        if (t) body.active = f.active.checked;
        const r = await attempt(() => (t ? api.put(`/api/tables/${t.id}`, body) : api.post('/api/tables', body)));
        if (r) { closeModal(); toast('Saved', 'success'); draw(); }
      };
    }
  }
  await draw();
}

// ---------------- Users ----------------
async function usersTab(pane) {
  async function draw() {
    const users = await attempt(() => api.get('/api/users'));
    if (!users) return;
    pane.innerHTML = html`<div class="row between"><h3>Staff accounts</h3><button class="btn primary" data-a="add">+ Staff</button></div>
      <div class="card flush"><table class="grid"><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map((u) => html`<tr class="${u.active ? '' : 'inactive'}"><td>${u.username}</td><td>${u.name}</td><td>${u.role}</td>
        <td>${u.active ? 'Active' : html`<span class="pill cancelled">disabled</span>`}</td>
        <td class="n"><button class="btn small" data-a="edit" data-id="${u.id}">Edit</button></td></tr>`)}</tbody></table></div>`.toString();
    pane.onclick = (e) => {
      const b = e.target.closest('[data-a]');
      if (b) form(b.dataset.a === 'edit' ? users.find((u) => u.id === Number(b.dataset.id)) : null);
    };
    function form(u) {
      const el = openModal(`<form>
        ${u ? '' : field('Username', '<input name="username" required maxlength="50" autofocus>')}
        ${field('Full name', `<input name="name" required maxlength="100" value="${esc(u?.name || '')}">`)}
        ${field(u ? 'New password (leave blank to keep)' : 'Password (min 6 chars)', '<input name="password" type="password" minlength="6" autocomplete="new-password" ' + (u ? '' : 'required') + '>')}
        ${field('Role', `<select name="role"><option value="staff" ${u?.role === 'staff' ? 'selected' : ''}>Staff (waiter / cashier)</option><option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>Admin</option></select>`)}
        ${u ? `<label class="inline"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Active</label>` : ''}${actions()}</form>`, { title: u ? `Edit ${u.username}` : 'New staff account' });
      el.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        const body = { name: f.name.value, role: f.role.value };
        if (f.password.value) body.password = f.password.value;
        if (u) body.active = f.active.checked; else body.username = f.username.value;
        const r = await attempt(() => (u ? api.put(`/api/users/${u.id}`, body) : api.post('/api/users', body)));
        if (r) { closeModal(); toast('Saved', 'success'); draw(); }
      };
    }
  }
  await draw();
}

// ---------------- Settings ----------------
async function settingsTab(pane) {
  const s = await attempt(() => api.get('/api/settings'));
  if (!s) return;
  const v = (x) => Stringesc(x ?? '');
  pane.innerHTML = `<form class="card settings" id="sf"><h3>Restaurant & billing</h3>
    ${field('Restaurant name', `<input name="restaurant_name" required maxlength="100" value="${v(s.restaurant_name)}">`)}
    ${field('Address', `<input name="address" maxlength="200" value="${v(s.address)}">`)}
    <div class="two">${field('Phone', `<input name="phone" maxlength="30" value="${v(s.phone)}">`)}${field('GSTIN', `<input name="gstin" maxlength="30" value="${v(s.gstin)}">`)}</div>
    <div class="two">${field('GST rate %', `<input name="tax_rate" inputmode="decimal" value="${v(s.tax_rate)}">`)}${field('Service charge %', `<input name="service_charge_rate" inputmode="decimal" value="${v(s.service_charge_rate)}">`)}</div>
    <div class="two">${field('Currency symbol', `<input name="currency_symbol" maxlength="4" required value="${v(s.currency_symbol)}">`)}
    <label class="inline"><input type="checkbox" name="round_off" ${s.round_off ? 'checked' : ''}> Round bill total to nearest whole unit</label></div>
    ${field('Bill footer', `<input name="bill_footer" maxlength="200" value="${v(s.bill_footer)}">`)}
    <div class="actions"><button class="btn primary">Save settings</button></div></form>
    <form class="card settings" id="pw"><h3>Change my password</h3>
    ${field('Current password', '<input name="cur" type="password" required autocomplete="current-password">')}
    ${field('New password (min 6 chars)', '<input name="new" type="password" minlength="6" required autocomplete="new-password">')}
    <div class="actions"><button class="btn">Change password</button></div></form>`;
  pane.querySelector('#sf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = Object.fromEntries(['restaurant_name', 'address', 'phone', 'gstin', 'tax_rate', 'service_charge_rate', 'currency_symbol', 'bill_footer'].map((k) => [k, f[k].value]));
    body.round_off = f.round_off.checked;
    const r = await attempt(() => api.put('/api/settings', body));
    if (r) { await loadSettings(); toast('Settings saved', 'success'); }
  };
  pane.querySelector('#pw').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const r = await attempt(() => api.post('/api/auth/change-password', { current_password: f.cur.value, new_password: f.new.value }));
    if (r) { toast('Password changed', 'success'); f.reset(); }
  };
}
