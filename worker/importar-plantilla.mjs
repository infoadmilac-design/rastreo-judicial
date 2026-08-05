// =====================================================================
//  importar-plantilla.mjs  ·  Aplica una plantilla de clasificación de
//  procesos (Excel) ya completada, a la base de datos.
//
//  Uso:  node --env-file=.env importar-plantilla.mjs datos.json
//
//  El JSON de entrada es un arreglo de objetos con las columnas de la
//  hoja "Procesos" de la plantilla (una fila por proceso):
//    { id, despacho, fuente, jurisdiccion, especialidad,
//      tipo_cliente, documento, telefono, email }
//  Solo se actualizan los campos no vacíos — no se sobreescribe con blancos.
// =====================================================================
import { readFile } from 'node:fs/promises';

const archivo = process.argv[2];
if (!archivo) { console.error('Uso: node importar-plantilla.mjs datos.json'); process.exit(1); }

const { createClient } = await import('@supabase/supabase-js');
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('Falta SUPABASE_URL / SUPABASE_SERVICE_KEY en .env'); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });

const filas = JSON.parse(await readFile(archivo, 'utf8'));
console.log(`Aplicando ${filas.length} fila(s)…\n`);

let procesosOk = 0, clientesOk = 0, errores = 0;
for (const f of filas) {
  if (!f.id) { console.log('  ⚠️  fila sin id, se omite'); continue; }

  const patchProceso = {};
  if (f.despacho) patchProceso.despacho = f.despacho;
  if (f.fuente) patchProceso.fuente = f.fuente;
  if (f.jurisdiccion) patchProceso.jurisdiccion = f.jurisdiccion;
  if (f.especialidad) patchProceso.tipo_proceso = f.especialidad;
  // Si se asigna una fuente sin API pública, el proceso pasa a seguimiento manual.
  if (f.fuente && f.fuente !== 'rama_judicial') patchProceso.api_trackable = false;

  if (Object.keys(patchProceso).length) {
    const { error } = await db.from('procesos').update(patchProceso).eq('id', f.id);
    if (error) { console.log(`  ❌ proceso ${f.id}: ${error.message}`); errores++; }
    else procesosOk++;
  }

  const patchCliente = {};
  if (f.tipo_cliente) patchCliente.tipo = f.tipo_cliente;
  if (f.documento) patchCliente.documento = f.documento;
  if (f.telefono) patchCliente.telefono = f.telefono;
  if (f.email) patchCliente.email = f.email;
  if (Object.keys(patchCliente).length) {
    const { data: proc } = await db.from('procesos').select('cliente_id').eq('id', f.id).maybeSingle();
    if (proc?.cliente_id) {
      const { error } = await db.from('clientes').update(patchCliente).eq('id', proc.cliente_id);
      if (error) { console.log(`  ❌ cliente de ${f.id}: ${error.message}`); errores++; }
      else clientesOk++;
    }
  }
}
console.log(`\n===== RESUMEN =====`);
console.log(`Procesos actualizados : ${procesosOk}`);
console.log(`Clientes actualizados : ${clientesOk}`);
console.log(`Errores               : ${errores}`);
