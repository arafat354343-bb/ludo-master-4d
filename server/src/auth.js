'use strict';

/**
 * JWT auth helpers. Tokens live 7 days and travel as
 * `Authorization: Bearer <token>`.
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env var is required (see .env.example).');
  process.exit(1);
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'missing token' });
  try {
    req.userId = verifyToken(m[1]).sub;
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

module.exports = { signToken, verifyToken, requireAuth };
