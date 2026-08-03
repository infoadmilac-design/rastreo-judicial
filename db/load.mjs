// =====================================================================
//  load.mjs  ·  Carga el esquema + la semilla en tu Postgres/Supabase
//  Requiere DATABASE_URL en db/.env  (Supabase → Settings → Database →
//  Connection string → URI). Ej: postgresql://postgres:[PASS]@db.xxx.supabase.co:5432/postgres
//
//  Uso:  cd db && npm install && node load.mjs
// =====================================================================
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Falta DATABASE_URL en db/.env'); process.exit(1); }

  const schema = await readFile(join(__dirname, 'schema.sql'), 'utf8');
  const seed = await readFile(join(__dirname, '..', 'migration', 'output', 'normalized', 'seed.sql'), 'utf8');

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Conectado. Creando esquema…');
  await client.query(schema);
  console.log('Esquema listo. Cargando datos…');
  await client.query(seed);

  const { rows } = await client.query(`
    select
      (select count(*) from procesos)   as procesos,
      (select count(*) from clientes)   as clientes,
      (select count(*) from audiencias) as audiencias,
      (select count(*) from procesos where api_trackable) as rastreables
  `);
  console.log('\n✅ Carga completa:', rows[0]);
  await client.end();
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
