'use strict';

const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer config — store uploaded xlsx in uploads/
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, path.basename(file.originalname)),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') return cb(null, true);
    cb(new Error('Only .xlsx/.xls files are allowed'));
  },
});

// In-memory state
let emailMap = new Map();        // email (lowercase) → { rowNumber, 检查结果, 卖家 }
let loadedFileName = null;
let totalRows = 0;
let columnHeaders = [];
let lastResults = [];            // last lookup results (for export)
let sessions = [];               // session log

// ─── Helper: parse Excel file and build emailMap ────────────────────────────
function parseExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (!rows.length) throw new Error('Excel file is empty');

  columnHeaders = Object.keys(rows[0]);

  // Auto-detect column names (case-insensitive partial match)
  const headerKeys = columnHeaders;
  const emailCol = headerKeys.find(k => /邮箱|email/i.test(k));
  const resultCol = headerKeys.find(k => /检查结果|result/i.test(k));
  const sellerCol = headerKeys.find(k => /卖家|seller/i.test(k));

  if (!emailCol) throw new Error('Could not find email column (邮箱 or email)');

  emailMap = new Map();
  rows.forEach((row, idx) => {
    const rawEmail = String(row[emailCol] || '').trim();
    if (!rawEmail) return;
    emailMap.set(rawEmail.toLowerCase(), {
      rowNumber: idx + 2, // 1-indexed, +1 for header row
      检查结果: resultCol ? String(row[resultCol] || '').trim() : '',
      卖家: sellerCol ? String(row[sellerCol] || '').trim() : '',
    });
  });

  totalRows = rows.length;
}

// ─── POST /upload ─────────────────────────────────────────────────────────
app.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    parseExcel(req.file.path);
    loadedFileName = req.file.originalname;
    res.json({
      success: true,
      fileName: loadedFileName,
      totalRows,
      emailCount: emailMap.size,
      columns: columnHeaders,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── GET /status ──────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  // Also check if file1.xlsx exists on disk and auto-load if nothing is loaded
  const defaultFile = path.join(UPLOADS_DIR, 'file1.xlsx');
  if (!loadedFileName && fs.existsSync(defaultFile)) {
    try {
      parseExcel(defaultFile);
      loadedFileName = 'file1.xlsx';
    } catch (_) {
      // silently ignore if default file is unreadable
    }
  }

  res.json({
    loaded: !!loadedFileName,
    fileName: loadedFileName,
    totalRows,
    emailCount: emailMap.size,
    columns: columnHeaders,
  });
});

// ─── GET /files ───────────────────────────────────────────────────────────
// List .xlsx files already present in uploads/ so the UI can offer them
app.get('/files', (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR)
      .filter(f => /\.(xlsx|xls)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(UPLOADS_DIR, f));
        return { name: f, size: stat.size, modified: stat.mtime };
      });
    res.json(files);
  } catch (err) {
    res.json([]);
  }
});

// ─── POST /select ─────────────────────────────────────────────────────────
// Load an already-existing file from uploads/ by name
app.post('/select', express.json(), (req, res) => {
  const { fileName } = req.body || {};
  if (!fileName) return res.status(400).json({ error: 'fileName is required' });

  // Sanitise: only allow simple filenames, no path traversal
  const safeName = path.basename(fileName);
  const filePath = path.join(UPLOADS_DIR, safeName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File "${safeName}" not found in uploads/` });
  }
  try {
    parseExcel(filePath);
    loadedFileName = safeName;
    res.json({
      success: true,
      fileName: loadedFileName,
      totalRows,
      emailCount: emailMap.size,
      columns: columnHeaders,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── POST /lookup ─────────────────────────────────────────────────────────
app.post('/lookup', (req, res) => {
  if (!loadedFileName) {
    return res.status(400).json({ error: 'No Excel file loaded. Upload one first.' });
  }

  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text is required' });

  // Extract emails from pasted text
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const found = text.match(emailRegex) || [];

  // Deduplicate while preserving order; track duplicates
  const seen = new Map();
  found.forEach(e => {
    const lc = e.toLowerCase();
    seen.set(lc, (seen.get(lc) || 0) + 1);
  });

  const results = [];
  seen.forEach((count, lc) => {
    const match = emailMap.get(lc);
    let status;
    if (!match) {
      status = 'not found';
    } else if (!match['检查结果']) {
      status = 'partial';
    } else if (/done|ok|success|通过|有效/i.test(match['检查结果'])) {
      status = 'done';
    } else {
      status = 'fail';
    }
    results.push({
      email: lc,
      rowNumber: match ? match.rowNumber : null,
      检查结果: match ? match['检查结果'] : '',
      卖家: match ? match['卖家'] : '',
      status,
      duplicate: count > 1,
    });
  });

  lastResults = results;

  // Log session
  sessions.push({
    timestamp: new Date().toISOString(),
    fileName: loadedFileName,
    emailsChecked: results.length,
    summary: {
      done: results.filter(r => r.status === 'done').length,
      fail: results.filter(r => r.status === 'fail').length,
      notFound: results.filter(r => r.status === 'not found').length,
      partial: results.filter(r => r.status === 'partial').length,
    },
  });

  // Persist sessions log
  try {
    fs.writeFileSync(
      path.join(__dirname, 'sessions.json'),
      JSON.stringify(sessions, null, 2)
    );
  } catch (_) {}

  res.json({ results, total: results.length });
});

// ─── GET /export/csv ──────────────────────────────────────────────────────
app.get('/export/csv', (req, res) => {
  if (!lastResults.length) return res.status(400).json({ error: 'No results to export' });

  function csvField(val) {
    const s = String(val ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  const header = 'email,rowNumber,检查结果,卖家,status,duplicate\n';
  const body = lastResults
    .map(r =>
      [r.email, r.rowNumber ?? '', r['检查结果'], r['卖家'], r.status, r.duplicate]
        .map(csvField)
        .join(',')
    )
    .join('\n');
  const csv = header + body;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="results.csv"');
  res.send(csv);
});

// ─── GET /export/json ─────────────────────────────────────────────────────
app.get('/export/json', (req, res) => {
  if (!lastResults.length) return res.status(400).json({ error: 'No results to export' });

  const json = JSON.stringify(lastResults, null, 2);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="results.json"');
  res.send(json);
});

// ─── GET /admin ────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.status(401).json({ error: 'Admin dashboard not yet implemented' });
});

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`EmailVault server running at http://localhost:${PORT}`);
});

module.exports = app;
