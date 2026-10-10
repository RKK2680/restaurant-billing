import { api } from '../api.js';
import { html, state, toast } from '../util.js';

export function mount(app) {
  app.innerHTML = html`
    <div class="login-wrap"><form class="card login" id="f">
      <h1>Restaurant Billing</h1>
      <label>Username<input name="username" autocomplete="username" required autofocus></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn primary big">Sign in</button>
      <p class="muted small">Demo: admin / admin123 &nbsp;·&nbsp; waiter / waiter123</p>
    </form></div>`.toString();
  app.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      state.user = (await api.post('/api/auth/login', { username: f.username.value, password: f.password.value })).user;
      location.hash = '#/tables';
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  };
}
