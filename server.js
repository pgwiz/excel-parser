'use strict';

require('dotenv').config();

const crypto       = require('crypto');
const express      = require('express');
const multer       = require('multer');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const bcrypt       = require('bcryptjs');
const path         = require('path');
const fs           = require('fs');

const { signToken, requireAdmin } = require('./auth');
const db    = require('./db');
const cache = require('./cache');
const { readSheetData, previewColumns } = require('./google');

const app  = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const UPLOADS_DIR = process.env.VERCEL
  ? '/tmp/uploads'
  : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Legacy in-memory state (for /upload /status /select /files backward-compat routes)
const LEGACY_ID = '__legacy__';
let legacyFile  = null;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiters ─────────────────────────────────────────────────────────────

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 20,  standardHeaders: true, legacyHeaders: false });
const lookupLimiter = rateLimit({ windowMs: 60_000, max: 60,  standardHeaders: true, legacyHeaders: false });
const fileLimiter   = rateLimit({ windowMs: 60_000, max: 60,  standardHeaders: true, legacyHeaders: false });
const authLimiter   = rateLimit({
  windowMs: 15 * 60_000,
  max: parseInt(process.env.AUTH_RATE_LIMIT || '20', 10),
  standardHeaders: true,
  legacyHeaders: false,
});
const adminLimiter  = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });

// ── CSRF protection ───────────────────────────────────────────────────────────
// State-changing requests authenticated via httpOnly cookie must pass an origin
// check.  Requests carrying an Authorization header (Bearer token) are exempt
// because browsers cannot set custom headers in cross-origin requests without
// a CORS preflight — making them inherently CSRF-safe.
function csrfProtect(req, res, next) {
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.headers.authorization) return next(); // Bearer token — CSRF-safe
  const origin = req.headers.origin;
  if (!origin) return next(); // same-origin or non-browser client
  try {
    const originHost = new URL(origin).host;
    if (originHost === req.headers.host) return next();
  } catch (_) {}
  return res.status(403).json({ error: 'CSRF check failed' });
}

// Apply admin rate limiter + CSRF protection to all /admin/* and auth sub-routes
app.use('/admin', adminLimiter, csrfProtect);
app.use('/auth/logout', adminLimiter, csrfProtect);
app.use('/auth/change-password', authLimiter, csrfProtect);



const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, path.basename(file.originalname)),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') return cb(null, true);
    cb(new Error('Only .xlsx/.xls files are allowed'));
  },
});

// Memory-storage uploader used only for the column-preview endpoint
// (keeps the preview ephemeral — no file is written to disk).
const previewUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') return cb(null, true);
    cb(new Error('Only .xlsx/.xls files are allowed'));
  },
});

async function getEmailMap(file) {
  let map = cache.get(file.id);
  if (!map) {
    map = await readSheetData(file);
    cache.set(file.id, map, file.cache_ttl_secs || 300);
    if (file.id !== LEGACY_ID) {
      db.updateFile(file.id, { total_rows: map.size, last_refreshed: new Date().toISOString() })
        .catch(err => console.error('Failed to update file metadata:', err));
    }
  }
  return map;
}

function classifyResult(result) {
  if (!result) return 'partial';
  if (/done|ok|success|通过|有效/i.test(result)) return 'done';
  return 'fail';
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress)
    || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /files/public — active file list for user dropdown
app.get('/files/public', fileLimiter, async (req, res) => {
  const files = await db.getActiveFiles();
  res.json(files);
});

// POST /lookup — run email lookup
// Body: { fileId, text }
// fileId may be a Supabase UUID or the special value '__legacy__'
app.post('/lookup', lookupLimiter, async (req, res) => {
  const { fileId, text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text is required' });

  let file;
  if (!fileId || fileId === LEGACY_ID) {
    if (!legacyFile) return res.status(400).json({ error: 'No data source loaded. Upload an Excel file or select a registered file.' });
    file = legacyFile;
  } else {
    file = await db.getFileById(fileId);
    if (!file || !file.is_active) return res.status(404).json({ error: 'File not found or inactive' });
  }

  let emailMap;
  try {
    emailMap = await getEmailMap(file);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load data source: ' + err.message });
  }

  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const found = text.match(emailRegex) || [];
  const seen  = new Map();
  found.forEach(e => { const lc = e.toLowerCase(); seen.set(lc, (seen.get(lc) || 0) + 1); });

  const results = [];
  seen.forEach((count, lc) => {
    const match  = emailMap.get(lc);
    const status = match ? classifyResult(match.result) : 'not found';
    results.push({
      email:     lc,
      rowNumber: match ? match.rowNumber : null,
      result:    match ? match.result : '',
      status,
      duplicate: count > 1,
    });
  });

  // Log session (best-effort; skip for legacy)
  if (file.id !== LEGACY_ID) {
    const ip = clientIp(req);
    db.logSession({
      file_id:         file.id,
      emails_checked:  results.length,
      done_count:      results.filter(r => r.status === 'done').length,
      fail_count:      results.filter(r => r.status === 'fail').length,
      not_found_count: results.filter(r => r.status === 'not found').length,
      result_snapshot: results,
      ran_by:          req.admin ? req.admin.username : 'anon',
      ip_address:      ip,
    }).catch(() => {});
  }

  app.locals.lastResults   = results;
  app.locals.lastFileLabel = file.label;

  res.json({ results, total: results.length });
});

// GET /export/csv
app.get('/export/csv', (req, res) => {
  const lastResults = app.locals.lastResults || [];
  if (!lastResults.length) return res.status(400).json({ error: 'No results to export' });

  function csvField(val) {
    const s = String(val ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  const header = 'email,rowNumber,result,status,duplicate\n';
  const body   = lastResults
    .map(r => [r.email, r.rowNumber ?? '', r.result, r.status, r.duplicate].map(csvField).join(','))
    .join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="results.csv"');
  res.send(header + body);
});

// GET /export/json
app.get('/export/json', (req, res) => {
  const lastResults = app.locals.lastResults || [];
  if (!lastResults.length) return res.status(400).json({ error: 'No results to export' });

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="results.json"');
  res.send(JSON.stringify(lastResults, null, 2));
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /auth/login
app.post('/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const ip = clientIp(req);

  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

  // Magic key — use timing-safe comparison to prevent timing attacks
  if (process.env.MAGIC_KEY) {
    const a = Buffer.from(password);
    const b = Buffer.from(process.env.MAGIC_KEY);
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (match) {
      const token = signToken({ isMagicKey: true, username });
      res.cookie('token', token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
      db.logAudit(null, 'magic_key_used', { username }, ip)
        .catch(err => console.error('Failed to log magic key usage:', err));
      return res.json({ success: true, isMagicKey: true, token });
    }
  }

  const admin = await db.getAdminByUsername(username);
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  if (admin.must_change_password) return res.json({ forceChange: true, adminId: admin.id });

  const token = signToken({ adminId: admin.id, username: admin.username, isMagicKey: false });
  res.cookie('token', token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
  db.updateAdminLastLogin(admin.id).catch(() => {});
  db.logAudit(admin.id, 'login', { username: admin.username }, ip).catch(() => {});

  res.json({ success: true, username: admin.username, token });
});

// POST /auth/logout
app.post('/auth/logout', adminLimiter, requireAdmin, async (req, res) => {
  db.logAudit(req.admin.adminId || null, 'logout', { username: req.admin.username }, clientIp(req)).catch(() => {});
  res.clearCookie('token');
  res.json({ success: true });
});

// POST /auth/change-password
app.post('/auth/change-password', async (req, res) => {
  const { adminId, currentPassword, newPassword } = req.body || {};
  if (!adminId || !newPassword) return res.status(400).json({ error: 'adminId and newPassword are required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const adminRow = await db.getAdminById(adminId);
  if (!adminRow) return res.status(404).json({ error: 'Admin not found' });

  if (currentPassword) {
    const valid = await bcrypt.compare(currentPassword, adminRow.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  const ok   = await db.updateAdminPassword(adminRow.id, hash);
  if (!ok) return res.status(500).json({ error: 'Failed to update password' });

  db.logAudit(adminRow.id, 'password_change', {}, clientIp(req)).catch(() => {});

  const token = signToken({ adminId: adminRow.id, username: adminRow.username, isMagicKey: false });
  res.cookie('token', token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
  res.json({ success: true, token });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /admin/files
app.get('/admin/files', requireAdmin, async (req, res) => {
  res.json(await db.getAllFiles());
});

// POST /admin/files — register new file
app.post('/admin/files', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const body = req.body || {};
    const { source_type } = body;
    let source_ref = body.source_ref;

    if (!body.label || !source_type || !body.column_email || !body.column_result) {
      return res.status(400).json({ error: 'label, source_type, column_email, column_result are required' });
    }
    if (!['excel', 'sheets', 'drive'].includes(source_type)) {
      return res.status(400).json({ error: 'source_type must be excel, sheets, or drive' });
    }
    if (source_type === 'excel') {
      if (!req.file) return res.status(400).json({ error: 'Excel file upload required for source_type=excel' });
      source_ref = path.basename(req.file.originalname);
    }
    if (!source_ref) return res.status(400).json({ error: 'source_ref is required' });

    const fileRow = await db.insertFile({
      label:          body.label,
      source_type,
      source_ref,
      sheet_tab:      body.sheet_tab || null,
      column_email:   body.column_email,
      column_result:  body.column_result,
      cache_ttl_secs: parseInt(body.cache_ttl_secs, 10) || 300,
      is_active:      body.is_active !== 'false',
      added_by:       req.admin.adminId || null,
    });
    db.logAudit(req.admin.adminId || null, 'file_added', { label: body.label, source_type }, clientIp(req)).catch(() => {});
    res.status(201).json(fileRow);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/files/:id
app.patch('/admin/files/:id', requireAdmin, async (req, res) => {
  try {
    const allowed = ['label', 'sheet_tab', 'column_email', 'column_result', 'cache_ttl_secs', 'is_active'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.cache_ttl_secs !== undefined) updates.cache_ttl_secs = parseInt(updates.cache_ttl_secs, 10);
    const updated = await db.updateFile(req.params.id, updates);
    cache.invalidate(req.params.id);
    db.logAudit(req.admin.adminId || null, 'file_updated', { id: req.params.id }, clientIp(req)).catch(() => {});
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/files/:id
app.delete('/admin/files/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteFile(req.params.id);
    cache.invalidate(req.params.id);
    db.logAudit(req.admin.adminId || null, 'file_deleted', { id: req.params.id }, clientIp(req)).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/files/:id/refresh
app.post('/admin/files/:id/refresh', requireAdmin, async (req, res) => {
  try {
    const file = await db.getFileById(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    cache.invalidate(file.id);
    const map = await getEmailMap(file);
    res.json({ success: true, rowCount: map.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/drive/list
app.get('/admin/drive/list', requireAdmin, async (req, res) => {
  try {
    const { google: goog } = require('googleapis');
    const credsPath = process.env.GOOGLE_CREDS_PATH || path.join(__dirname, 'credentials.json');
    if (!fs.existsSync(credsPath)) return res.status(503).json({ error: 'Google credentials not configured' });
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    const auth  = new goog.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    const drive = goog.drive({ version: 'v3', auth });
    const resp  = await drive.files.list({
      pageSize: 50,
      fields: 'files(id, name, mimeType, modifiedTime)',
      q: "mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' or mimeType='application/vnd.google-apps.spreadsheet'",
    });
    res.json(resp.data.files || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/sessions
app.get('/admin/sessions', requireAdmin, async (req, res) => {
  const { fileId, limit, offset } = req.query;
  res.json(await db.getSessions({ fileId: fileId || null, limit: parseInt(limit, 10) || 50, offset: parseInt(offset, 10) || 0 }));
});

// GET /admin/audit
app.get('/admin/audit', requireAdmin, async (req, res) => {
  const { limit, offset } = req.query;
  res.json(await db.getAuditLog({ limit: parseInt(limit, 10) || 50, offset: parseInt(offset, 10) || 0 }));
});

// GET /admin/settings
app.get('/admin/settings', requireAdmin, async (req, res) => {
  res.json(await db.getAllSettings());
});

// PATCH /admin/settings
app.patch('/admin/settings', requireAdmin, async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body || {})) {
      await db.setSetting(key, String(value), req.admin.adminId || null);
    }
    db.logAudit(req.admin.adminId || null, 'settings_updated', { keys: Object.keys(req.body || {}) }, clientIp(req)).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/cache/stats
app.get('/admin/cache/stats', requireAdmin, (req, res) => {
  res.json(cache.stats());
});

// POST /admin/cache/flush
app.post('/admin/cache/flush', requireAdmin, (req, res) => {
  cache.invalidateAll();
  res.json({ success: true });
});

// POST /admin/files/preview-columns — read header row for column-picker UI
// Accepts: source_type, optional `file` (excel in-memory), source_ref, sheet_tab
app.post('/admin/files/preview-columns', requireAdmin, previewUpload.single('file'), async (req, res) => {
  try {
    const { source_type, source_ref, sheet_tab } = req.body || {};
    if (!source_type) return res.status(400).json({ error: 'source_type is required' });
    if (source_type === 'excel' && !req.file && !source_ref) {
      return res.status(400).json({ error: 'Excel file or source_ref is required' });
    }
    if (source_type !== 'excel' && !source_ref) {
      return res.status(400).json({ error: 'source_ref is required' });
    }
    const columns = await previewColumns({
      source_type,
      source_ref: source_ref || null,
      sheet_tab: sheet_tab || null,
      buffer: req.file ? req.file.buffer : null,
    });
    res.json({ columns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/upload — upload Excel file for excel-type file registrations
app.post('/admin/upload', requireAdmin, uploadLimiter, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ success: true, fileName: path.basename(req.file.originalname) });
});

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY ROUTES  (backward-compatible)
// ─────────────────────────────────────────────────────────────────────────────

app.post('/upload', uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    legacyFile = {
      id:            LEGACY_ID,
      label:         path.basename(req.file.originalname),
      source_type:   'excel',
      source_ref:    path.basename(req.file.originalname),
      column_email:  '邮箱',
      column_result: '检查结果',
      cache_ttl_secs: 300,
    };
    cache.invalidate(LEGACY_ID);
    const map = await getEmailMap(legacyFile);
    res.json({ success: true, fileName: legacyFile.label, totalRows: map.size, emailCount: map.size });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/status', fileLimiter, async (req, res) => {
  const defaultFile = path.join(UPLOADS_DIR, 'file1.xlsx');
  if (!legacyFile && fs.existsSync(defaultFile)) {
    legacyFile = { id: LEGACY_ID, label: 'file1.xlsx', source_type: 'excel', source_ref: 'file1.xlsx', column_email: '邮箱', column_result: '检查结果', cache_ttl_secs: 300 };
  }
  if (!legacyFile) return res.json({ loaded: false, fileName: null, totalRows: 0, emailCount: 0 });
  try {
    const map = await getEmailMap(legacyFile);
    res.json({ loaded: true, fileName: legacyFile.label, totalRows: map.size, emailCount: map.size });
  } catch {
    res.json({ loaded: false, fileName: null, totalRows: 0, emailCount: 0 });
  }
});

app.get('/files', fileLimiter, (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR)
      .filter(f => /\.(xlsx|xls)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(UPLOADS_DIR, f));
        return { name: f, size: stat.size, modified: stat.mtime };
      });
    res.json(files);
  } catch {
    res.json([]);
  }
});

app.post('/select', fileLimiter, async (req, res) => {
  const { fileName } = req.body || {};
  if (!fileName) return res.status(400).json({ error: 'fileName is required' });
  const safeName = path.basename(fileName);
  const filePath = path.join(UPLOADS_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: `File "${safeName}" not found in uploads/` });
  try {
    legacyFile = { id: LEGACY_ID, label: safeName, source_type: 'excel', source_ref: safeName, column_email: '邮箱', column_result: '检查结果', cache_ttl_secs: 300 };
    cache.invalidate(LEGACY_ID);
    const map = await getEmailMap(legacyFile);
    res.json({ success: true, fileName: safeName, totalRows: map.size, emailCount: map.size });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`EmailVault Pro server running at http://localhost:${PORT}`);
});

module.exports = app;
