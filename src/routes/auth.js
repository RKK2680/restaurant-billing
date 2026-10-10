const express = require('express');
const { verifyPassword, hashPassword } = require('../auth-utils');
const { createSession, destroySession, requireAuth } = require('../middleware');
const { badRequest, HttpError, unauthorized } = require('../errors');
const { str } = require('../validate');

module.exports = (db) => {
  const r = express.Router();
  const attempts = new Map(); // key -> {count, first}
  const WINDOW = 15 * 60 * 1000;
  const MAX = 10;

  r.post('/login', (req, res) => {
    const username = str(req.body.username, 'Username', { max: 50 });
    const password = str(req.body.password, 'Password', { max: 200 });
    const key = `${req.ip}|${username.toLowerCase()}`;
    const a = attempts.get(key);
    if (a && Date.now() - a.first < WINDOW && a.count >= MAX) {
      throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      const fresh = a && Date.now() - a.first < WINDOW ? a : { count: 0, first: Date.now() };
      fresh.count++;
      attempts.set(key, fresh);
      throw unauthorized('Invalid username or password');
    }
    attempts.delete(key);
    createSession(db, res, user.id);
    res.json({ user: { id: user.id, username: user.username, name: user.name, role: user.role } });
  });

  r.post('/logout', (req, res) => {
    destroySession(db, req, res);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    res.json({ user: req.user || null });
  });

  r.post('/change-password', requireAuth, (req, res) => {
    const current = str(req.body.current_password, 'Current password');
    const next = str(req.body.new_password, 'New password', { max: 200 });
    if (next.length < 6) throw badRequest('New password must be at least 6 characters');
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current, u.password_hash)) throw badRequest('Current password is incorrect');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), u.id);
    res.json({ ok: true });
  });

  return r;
};
