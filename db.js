'use strict';

const { createClient } = require('@supabase/supabase-js');

// ── Lazy Supabase client ──────────────────────────────────────────────────────
// The client is created on first use so that:
//  1. `dotenv.config()` in server.js has already run before any DB call.
//  2. When SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured
//     (e.g. legacy-only deployments) the module loads without throwing and all
//     helpers return safe empty-result fallbacks.

let _supabase = null;

function getClient() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // Supabase not configured — callers handle null
  _supabase = createClient(url, key, { db: { schema: 'pars' } });
  return _supabase;
}

// Expose the live client for callers that need it directly (e.g. server.js).
// Returns null when Supabase is not configured.
Object.defineProperty(module.exports, 'supabase', {
  get() { return getClient(); },
  enumerable: true,
});

// ── Admin helpers ─────────────────────────────────────────────────────────────

async function getAdminByUsername(username) {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('admins')
    .select('*')
    .eq('username', username)
    .eq('is_active', true)
    .single();
  if (error) return null;
  return data;
}

async function getAdminById(id) {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('admins')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
}

async function updateAdminLastLogin(id) {
  const sb = getClient();
  if (!sb) return;
  await sb
    .from('admins')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', id);
}

async function updateAdminPassword(id, passwordHash) {
  const sb = getClient();
  if (!sb) return false;
  const { error } = await sb
    .from('admins')
    .update({ password_hash: passwordHash, must_change_password: false })
    .eq('id', id);
  return !error;
}

// ── File helpers ──────────────────────────────────────────────────────────────

async function getActiveFiles() {
  const sb = getClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('files')
    .select('id, label, source_type, cache_ttl_secs, total_rows, last_refreshed')
    .eq('is_active', true)
    .order('added_at', { ascending: true });
  if (error) return [];
  return data;
}

async function getAllFiles() {
  const sb = getClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('files')
    .select('*, admins!added_by(username)')
    .order('added_at', { ascending: true });
  if (error) return [];
  return data;
}

async function getFileById(id) {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('files')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
}

async function insertFile(data) {
  const sb = getClient();
  if (!sb) throw new Error('Supabase is not configured');
  const { data: row, error } = await sb
    .from('files')
    .insert(data)
    .select()
    .single();
  if (error) throw error;
  return row;
}

async function updateFile(id, data) {
  const sb = getClient();
  if (!sb) throw new Error('Supabase is not configured');
  const { data: row, error } = await sb
    .from('files')
    .update(data)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return row;
}

async function deleteFile(id) {
  const sb = getClient();
  if (!sb) throw new Error('Supabase is not configured');
  const { error } = await sb
    .from('files')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ── Session helpers ───────────────────────────────────────────────────────────

async function logSession(data) {
  const sb = getClient();
  if (!sb) return null;
  const { data: row, error } = await sb
    .from('lookup_sessions')
    .insert(data)
    .select()
    .single();
  if (error) throw error;
  return row;
}

async function getSessions({ fileId, limit = 50, offset = 0 } = {}) {
  const sb = getClient();
  if (!sb) return [];
  let query = sb
    .from('lookup_sessions')
    .select('*')
    .order('ran_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (fileId) query = query.eq('file_id', fileId);
  const { data, error } = await query;
  if (error) return [];
  return data;
}

// ── Audit helpers ─────────────────────────────────────────────────────────────

async function logAudit(adminId, action, detail, ip) {
  const sb = getClient();
  if (!sb) return;
  await sb.from('audit_log').insert({
    admin_id:   adminId || null,
    action,
    detail:     detail || null,
    ip_address: ip || null,
  });
}

async function getAuditLog({ limit = 50, offset = 0 } = {}) {
  const sb = getClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return [];
  return data;
}

// ── Settings helpers ──────────────────────────────────────────────────────────

async function getSetting(key) {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('settings')
    .select('value')
    .eq('key', key)
    .single();
  if (error) return null;
  return data ? data.value : null;
}

async function getAllSettings() {
  const sb = getClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('settings')
    .select('*')
    .order('key');
  if (error) return [];
  return data;
}

async function setSetting(key, value, adminId) {
  const sb = getClient();
  if (!sb) throw new Error('Supabase is not configured');
  const { error } = await sb
    .from('settings')
    .upsert({
      key,
      value,
      updated_by: adminId || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  if (error) throw error;
}

module.exports = Object.assign(module.exports, {
  getAdminByUsername,
  getAdminById,
  updateAdminLastLogin,
  updateAdminPassword,
  getActiveFiles,
  getAllFiles,
  getFileById,
  insertFile,
  updateFile,
  deleteFile,
  logSession,
  getSessions,
  logAudit,
  getAuditLog,
  getSetting,
  getAllSettings,
  setSetting,
});
