-- EmailVault Pro — Supabase migration 002
-- Schema-level grants, default privileges, example tables and RLS policies.
-- Run this once against your Supabase project via the SQL editor,
-- after 001_pars_schema.sql has been applied.

-- ── Schema-level grants ───────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA pars TO anon, authenticated, service_role;

-- anon: SELECT only on existing tables in pars
GRANT SELECT ON ALL TABLES IN SCHEMA pars TO anon;

-- authenticated: full CRUD on existing tables in pars
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pars TO authenticated;

-- service_role: full access on existing tables (BYPASSRLS covers RLS but not object-level grants)
GRANT ALL ON ALL TABLES IN SCHEMA pars TO service_role;

GRANT ALL ON ALL ROUTINES  IN SCHEMA pars TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pars TO anon, authenticated, service_role;

-- ── Default privileges for objects created by postgres ───────────────────────
-- These apply to tables/routines/sequences added after this migration runs.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA pars
  GRANT SELECT ON TABLES TO anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA pars
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA pars
  GRANT ALL ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA pars
  GRANT ALL ON ROUTINES TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA pars
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

-- ── Example tables ────────────────────────────────────────────────────────────
-- Create only if they don't exist; minimal definitions so RLS policies can attach.

CREATE TABLE IF NOT EXISTS pars.public_items (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text,
  inserted_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pars.user_documents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL,
  title       text,
  content     text,
  inserted_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pars.tenants_data (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL,
  data        jsonb,
  inserted_at timestamptz DEFAULT now()
);

-- ── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE pars.user_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE pars.tenants_data   ENABLE ROW LEVEL SECURITY;

-- pars.user_documents — owner-based policies (users see only their own rows)

CREATE POLICY user_documents_select_owner ON pars.user_documents
  FOR SELECT TO authenticated
  USING ( (SELECT auth.uid()) = user_id );

CREATE POLICY user_documents_insert_owner ON pars.user_documents
  FOR INSERT TO authenticated
  WITH CHECK ( (SELECT auth.uid()) = user_id );

CREATE POLICY user_documents_update_owner ON pars.user_documents
  FOR UPDATE TO authenticated
  USING     ( (SELECT auth.uid()) = user_id )
  WITH CHECK ( (SELECT auth.uid()) = user_id );

CREATE POLICY user_documents_delete_owner ON pars.user_documents
  FOR DELETE TO authenticated
  USING ( (SELECT auth.uid()) = user_id );

-- pars.tenants_data — tenant-based policies
-- Requires a `tenant_id` UUID claim in the JWT (configure in Supabase Auth hooks).

CREATE POLICY tenants_data_select_tenant ON pars.tenants_data
  FOR SELECT TO authenticated
  USING ( tenant_id = (auth.jwt() ->> 'tenant_id')::uuid );

CREATE POLICY tenants_data_insert_tenant ON pars.tenants_data
  FOR INSERT TO authenticated
  WITH CHECK ( tenant_id = (auth.jwt() ->> 'tenant_id')::uuid );

CREATE POLICY tenants_data_update_tenant ON pars.tenants_data
  FOR UPDATE TO authenticated
  USING     ( tenant_id = (auth.jwt() ->> 'tenant_id')::uuid )
  WITH CHECK ( tenant_id = (auth.jwt() ->> 'tenant_id')::uuid );

CREATE POLICY tenants_data_delete_tenant ON pars.tenants_data
  FOR DELETE TO authenticated
  USING ( tenant_id = (auth.jwt() ->> 'tenant_id')::uuid );

-- ── Table-level grants for example tables ────────────────────────────────────

-- public_items: readable by everyone, no write from outside the backend
GRANT SELECT ON TABLE pars.public_items TO anon, authenticated;

-- user_documents: authenticated full CRUD (RLS restricts to own rows), no anon access
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pars.user_documents TO authenticated;
REVOKE ALL ON TABLE pars.user_documents FROM anon;

-- tenants_data: authenticated full CRUD (RLS restricts to matching tenant), no anon access
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pars.tenants_data TO authenticated;
REVOKE ALL ON TABLE pars.tenants_data FROM anon;
