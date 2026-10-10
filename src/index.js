const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./server');

const dbFile = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'restaurant.db');
const port = Number(process.env.PORT) || 3000;

if (process.argv.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  console.log('Database reset.');
}

const { app } = createApp({ dbFile });
app.listen(port, () => {
  console.log(`Restaurant billing running at http://localhost:${port}`);
  console.log('Demo logins: admin / admin123   |   waiter / waiter123');
});
