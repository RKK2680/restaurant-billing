const { createApp } = require('../src/server');

async function start() {
  const { app, db } = createApp({ dbFile: ':memory:' });
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    const call = async (method, url, body) => {
      const r = await fetch(base + url, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: r.status, data, headers: r.headers };
    };
    return {
      get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), put: (u, b = {}) => call('PUT', u, b),
      patch: (u, b = {}) => call('PATCH', u, b), del: (u) => call('DELETE', u),
      login: (username, password) => call('POST', '/api/auth/login', { username, password }),
    };
  }
  return { client, db, close: () => new Promise((r) => server.close(r)) };
}

async function asAdmin(ctx) { const c = ctx.client(); await c.login('admin', 'admin123'); return c; }
async function asWaiter(ctx) { const c = ctx.client(); await c.login('waiter', 'waiter123'); return c; }

module.exports = { start, asAdmin, asWaiter };
