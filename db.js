'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  { db: { schema: 'pars' } }
);

// ── Admin helpers ─────────────────────────────────────────────────────────────

async function getAdminByUsername(username) {
  const { data, error } = await supabase
    .from('admins')
    .select('*')
    .eq('username', username)
    .eq('is_active', true)
    .single();
  if (error) return null;
  return data;
}

async function getAdminById(id) {
  const { data, error } = await supabase
    .from('admins')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
}

async function updateAdminLastLogin(id) {
  await supabase
    .from('admins')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', id);
}

async function updateAdminPassword(id, passwordHash) {
  const { error } = await supabase
    .from('admins')
    .update({ password_hash: passwordHash, must_change_password: false })
    .eq('id', id);
  return !error;
}

// ── File helpers ──────────────────────────────────────────────────────────────

async function getActiveFiles() {
  const { data, error } = await supabase
    .from('files')
    .select('id, label, source_type, cache_ttl_secs, total_rows, last_refreshed')
    .eq('is_active', true)
    .order('added_at', { ascending: true });
  if (error) return [];
  return data;
}

async function getAllFiles() {
  const { data, error } = await supabase
    .from('files')
    .select('*, admins!added_by(username)')
    .order('added_at', { ascending: true });
  if (error) return [];
  return data;
}

async function getFileById(id) {
  const { data, error } = await supabase
    .from('files')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
}

async function insertFile(data) {
  const { data: row, error } = await supabase
    .from('files')
    .insert(data)
    .select()
    .single();
  if (error) throw error;
  return row;
}

async function updateFile(id, data) {
  const { data: row, error } = await supabase
    .from('files')
    .update(data)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return row;
}

async function deleteFile(id) {
  const { error } = await supabase
    .from('files')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ── Session helpers ───────────────────────────────────────────────────────────

async function logSession(data) {
  const { data: row, error } = await supabase
    .from('lookup_sessions')
    .insert(data)
    .select()
    .single();
  if (error) throw error;
  return row;
}

async function getSessions({ fileId, limit = 50, offset = 0 } = {}) {
  let query = supabase
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
  await supabase.from('audit_log').insert({
    admin_id:   adminId || null,
    action,
    detail:     detail || null,
    ip_address: ip || null,
  });
}

async function getAuditLog({ limit = 50, offset = 0 } = {}) {
  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return [];
  return data;
}

// ── Settings helpers ──────────────────────────────────────────────────────────

async function getSetting(key) {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .single();
  if (error) return null;
  return data ? data.value : null;
}

async function getAllSettings() {
  const { data, error } = await supabase
    .from('settings')
    .select('*')
    .order('key');
  if (error) return [];
  return data;
}

async function setSetting(key, value, adminId) {
  const { error } = await supabase
    .from('settings')
    .upsert({
      key,
      value,
      updated_by: adminId || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  if (error) throw error;
}

module.exports = {
  supabase,
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
};
