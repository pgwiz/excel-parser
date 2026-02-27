-- EmailVault Pro — Supabase migration
-- Creates all tables under the `pars` schema with RLS enabled.
-- Run this once against your Supabase project via the SQL editor.

-- ── Schema ───────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS pars;

-- ── pars.admins ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pars.admins (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username             TEXT UNIQUE NOT NULL,
  password_hash        TEXT NOT NULL,
  must_change_password BOOLEAN DEFAULT true,
  is_active            BOOLEAN DEFAULT true,
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT now()
);

-- ── pars.files ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pars.files (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label          TEXT NOT NULL,
  source_type    TEXT CHECK (source_type IN ('excel', 'sheets', 'drive')) NOT NULL,
  source_ref     TEXT NOT NULL,
  sheet_tab      TEXT,
  column_email   TEXT NOT NULL,
  column_result  TEXT NOT NULL,
  total_rows     INTEGER DEFAULT 0,
  is_active      BOOLEAN DEFAULT true,
  cache_ttl_secs INTEGER DEFAULT 300,
  added_by       UUID REFERENCES pars.admins(id),
  added_at       TIMESTAMPTZ DEFAULT now(),
  last_refreshed TIMESTAMPTZ
);

-- ── pars.lookup_sessions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pars.lookup_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id         UUID REFERENCES pars.files(id),
  emails_checked  INTEGER NOT NULL,
  done_count      INTEGER DEFAULT 0,
  fail_count      INTEGER DEFAULT 0,
  not_found_count INTEGER DEFAULT 0,
  result_snapshot JSONB,
  ran_by          TEXT DEFAULT 'anon',
  ip_address      TEXT,
  ran_at          TIMESTAMPTZ DEFAULT now()
);

-- ── pars.audit_log ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pars.audit_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   UUID REFERENCES pars.admins(id),
  action     TEXT NOT NULL,
  detail     JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── pars.settings ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pars.settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_by UUID REFERENCES pars.admins(id),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed default settings
INSERT INTO pars.settings (key, value) VALUES
  ('cache_ttl_seconds',      '300'),
  ('rate_limit_attempts',    '5'),
  ('rate_limit_window_mins', '15'),
  ('app_title',              'EmailVault Pro')
ON CONFLICT (key) DO NOTHING;

-- ── Row Level Security ───────────────────────────────────────────────────────
-- All access goes through the Express backend using the service_role key,
-- so we simply deny all direct client access.

ALTER TABLE pars.admins          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pars.files           ENABLE ROW LEVEL SECURITY;
ALTER TABLE pars.lookup_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pars.audit_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE pars.settings        ENABLE ROW LEVEL SECURITY;
