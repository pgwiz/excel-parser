'use strict';

const jwt = require('jsonwebtoken');

const SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  // In production this is a hard error; in development we warn loudly.
  const msg = 'SESSION_SECRET environment variable is not set — JWT tokens will be insecure!';
  if (process.env.NODE_ENV === 'production') throw new Error(msg);
  else console.warn('[auth] WARNING:', msg);
}
const SIGNING_SECRET = SECRET || 'dev-insecure-secret';
const EXPIRY  = process.env.JWT_EXPIRY    || '4h';

function signToken(payload) {
  return jwt.sign(payload, SIGNING_SECRET, { expiresIn: EXPIRY });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SIGNING_SECRET);
  } catch {
    return null;
  }
}

// Express middleware — requires a valid JWT in the Authorization: Bearer header.
// The httpOnly cookie is set on login for convenience (e.g. server-side rendered
// pages) but is not used to authenticate state-changing API requests here,
// which prevents CSRF attacks (browsers cannot send the Authorization header
// cross-origin without a CORS preflight).
function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  req.admin = payload;
  next();
}

module.exports = { signToken, verifyToken, requireAdmin };
