'use strict';

const jwt = require('jsonwebtoken');

const SECRET = process.env.SESSION_SECRET || 'changeme';
const EXPIRY  = process.env.JWT_EXPIRY    || '4h';

function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRY });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

// Express middleware — requires a valid JWT in httpOnly cookie or Authorization header
function requireAdmin(req, res, next) {
  const cookieToken = req.cookies && req.cookies.token;
  const headerToken = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  const token = cookieToken || headerToken;

  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

  req.admin = payload;
  next();
}

module.exports = { signToken, verifyToken, requireAdmin };
