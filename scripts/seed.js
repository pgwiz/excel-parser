'use strict';

/**
 * Seed script — inserts the initial admin into pars.admins.
 * Run once: node scripts/seed.js
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env
 */

require('dotenv').config();
const bcrypt    = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { db: { schema: 'pars' } }
);

async function seed() {
  const username = process.env.INITIAL_ADMIN_USER || 'admin';
  const password = process.env.INITIAL_ADMIN_PASS || 'password123';

  const hash = await bcrypt.hash(password, 12);

  const { data, error } = await supabase
    .from('admins')
    .upsert(
      { username, password_hash: hash, must_change_password: true },
      { onConflict: 'username' }
    )
    .select()
    .single();

  if (error) {
    console.error('Seed failed:', error.message);
    process.exit(1);
  }
  console.log(`Admin "${data.username}" seeded. Force-change password on first login.`);
}

seed();
