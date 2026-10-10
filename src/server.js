const path = require('node:path');
const express = require('express');
const { openDb, seedIfEmpty } = require('./db');
const { loadUser } = require('./middleware');
const { HttpError } = require('./errors');

function createApp({ dbFile = ':memory:', seed = true } = {}) {
  const db = openDb(dbFile);
  if (seed) seedIfEmpty(db);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(loadUser(db));

  app.use('/api/auth', require('./routes/auth')(db));
  app.use('/api', require('./routes/admin')(db));
  app.use('/api', require('./routes/orders')(db));
  app.use('/api/reports', require('./routes/reports')(db));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Unknown API endpoint')));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    if (/UNIQUE constraint failed: orders\.table_id|ux_orders_one_active_per_table/.test(err.message)) {
      return res.status(409).json({ error: 'That table already has a running order' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });

  return { app, db };
}

module.exports = { createApp };
