'use strict';
/** Applies db/migrations/*.sql in order. Password from PGPASSWORD only. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, close } = require('./ofsAdapter');

async function main() {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  await query(`CREATE SCHEMA IF NOT EXISTS ${process.env.OFS_SCHEMA || 'ofs'}`);
  await query(`CREATE TABLE IF NOT EXISTS ${process.env.OFS_SCHEMA || 'ofs'}._migration (
    file text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const f of files) {
    const done = await query(`SELECT 1 FROM ${process.env.OFS_SCHEMA || 'ofs'}._migration WHERE file = $1`, [f]);
    if (done.rowCount) { console.log('skip  ' + f); continue; }
    console.log('apply ' + f);
    await query(fs.readFileSync(path.join(dir, f), 'utf8'));
    await query(`INSERT INTO ${process.env.OFS_SCHEMA || 'ofs'}._migration (file) VALUES ($1)`, [f]);
  }
  console.log('migrations complete');
}

main().then(() => close()).catch(async (e) => { console.error(e.message); await close(); process.exit(1); });
