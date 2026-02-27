'use strict';

/**
 * google.js — unified data reader for all three source types.
 *
 * Returns a Map<email_lowercase, { rowNumber, result, raw }>
 * where `raw` is the full row object for debugging.
 */

const path  = require('path');
const fs    = require('fs');
const ExcelJS = require('exceljs');
const { google } = require('googleapis');

const UPLOADS_DIR = process.env.VERCEL
  ? '/tmp/uploads'
  : path.join(__dirname, 'uploads');

// ── Google Auth singleton ─────────────────────────────────────────────────────

let _googleAuth = null;

function getGoogleAuth() {
  if (_googleAuth) return _googleAuth;
  const credsPath = process.env.GOOGLE_CREDS_PATH || path.join(__dirname, 'credentials.json');
  if (!fs.existsSync(credsPath)) {
    throw new Error('Google credentials file not found: ' + credsPath);
  }
  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  _googleAuth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  return _googleAuth;
}

// ── ExcelJS workbook → email Map ──────────────────────────────────────────────

async function workbookToMap(workbook, file) {
  const sheet = file.sheet_tab
    ? workbook.getWorksheet(file.sheet_tab) || workbook.worksheets[0]
    : workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 1) throw new Error('Worksheet is empty');

  // Read header row to resolve column names / letters to column numbers
  const headerRow = sheet.getRow(1);
  const headers   = {};
  headerRow.eachCell((cell, colNum) => {
    headers[colNum] = String(cell.value ?? '').trim();
  });

  const emailColNum  = resolveColumn(headers, file.column_email);
  const resultColNum = resolveColumn(headers, file.column_result);

  if (!emailColNum) {
    throw new Error(`Cannot find email column "${file.column_email}" in sheet`);
  }

  const map = new Map();
  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const rawEmail = String(row.getCell(emailColNum).value ?? '').trim();
    if (!rawEmail) return;
    const result = resultColNum
      ? String(row.getCell(resultColNum).value ?? '').trim()
      : '';
    map.set(rawEmail.toLowerCase(), { rowNumber: rowNum, result, raw: rawEmail });
  });
  return map;
}

/**
 * Resolve a column identifier to a 1-based column number.
 * Accepts: header text (e.g. '邮箱'), column letter (e.g. 'B'), or '1'-based number.
 */
function resolveColumn(headers, identifier) {
  if (!identifier) return null;

  // Try exact header match first
  const byName = Object.keys(headers).find(
    c => headers[c].toLowerCase() === identifier.toLowerCase()
  );
  if (byName) return Number(byName);

  // Try column letter (A=1, B=2, …)
  const letter = identifier.toUpperCase();
  if (/^[A-Z]+$/.test(letter)) {
    let col = 0;
    for (const ch of letter) col = col * 26 + (ch.charCodeAt(0) - 64);
    return col;
  }

  // Try numeric string
  const asNum = Number(identifier);
  if (Number.isInteger(asNum) && asNum > 0) return asNum;

  return null;
}

// ── Source readers ────────────────────────────────────────────────────────────

async function readExcel(file) {
  const filePath = path.join(UPLOADS_DIR, path.basename(file.source_ref));
  if (!fs.existsSync(filePath)) {
    throw new Error(`Excel file not found: ${file.source_ref}`);
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbookToMap(workbook, file);
}

async function readSheets(file) {
  const auth    = getGoogleAuth();
  const sheets  = google.sheets({ version: 'v4', auth });
  const range   = file.sheet_tab ? `${file.sheet_tab}!A1:ZZZ` : 'A1:ZZZ';
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: file.source_ref,
    range,
  });
  const rows = response.data.values || [];
  return rowsToMap(rows, file);
}

async function readDrive(file) {
  const auth  = getGoogleAuth();
  const drive = google.drive({ version: 'v3', auth });

  // Download to a temp buffer
  const resp = await drive.files.get(
    { fileId: file.source_ref, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  const buffer   = Buffer.from(resp.data);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbookToMap(workbook, file);
}

/** Convert a raw 2-D array (from Sheets API) into the same email Map format. */
function rowsToMap(rows, file) {
  if (!rows.length) return new Map();
  const headerRow = rows[0].map(h => String(h ?? '').trim());

  function resolveIndex(identifier) {
    if (!identifier) return -1;
    const byName = headerRow.findIndex(h => h.toLowerCase() === identifier.toLowerCase());
    if (byName !== -1) return byName;
    const letter = identifier.toUpperCase();
    if (/^[A-Z]+$/.test(letter)) {
      let col = 0;
      for (const ch of letter) col = col * 26 + (ch.charCodeAt(0) - 64);
      return col - 1;
    }
    const asNum = Number(identifier);
    if (Number.isInteger(asNum) && asNum > 0) return asNum - 1;
    return -1;
  }

  const emailIdx  = resolveIndex(file.column_email);
  const resultIdx = resolveIndex(file.column_result);

  const map = new Map();
  rows.slice(1).forEach((row, i) => {
    if (emailIdx === -1) return;
    const rawEmail = String(row[emailIdx] ?? '').trim();
    if (!rawEmail) return;
    const result = resultIdx !== -1 ? String(row[resultIdx] ?? '').trim() : '';
    map.set(rawEmail.toLowerCase(), { rowNumber: i + 2, result, raw: rawEmail });
  });
  return map;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load data for a file config object from pars.files.
 * @returns {Promise<Map<string, {rowNumber:number, result:string, raw:string}>>}
 */
async function readSheetData(file) {
  switch (file.source_type) {
    case 'excel':  return readExcel(file);
    case 'sheets': return readSheets(file);
    case 'drive':  return readDrive(file);
    default: throw new Error(`Unknown source_type: ${file.source_type}`);
  }
}

module.exports = { readSheetData };
