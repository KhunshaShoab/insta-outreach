// ---------------------------------------------------------------------------
// Datastore adapter: direct PostgreSQL.
// Same migrations, same functions, no Supabase. The `pg` driver is injected
// rather than imported so this repo stays dependency-free; pass a pool from
// your runtime:
//
//   import pg from 'pg';
//   const store = create({ DATABASE_URL }, { pool: new pg.Pool({ connectionString }) });
// ---------------------------------------------------------------------------

export function create(env = {}, spec = {}) {
  const pool = spec.pool ?? env.__pgPool;
  if (!pool) {
    throw new Error('datastore.postgres: pass a pg Pool as spec.pool (see the comment at the top of this file)');
  }

  async function query(text, params = []) {
    const result = await pool.query(text, params);
    return result.rows;
  }

  return {
    async rpc(fn, args = {}) {
      const keys = Object.keys(args);
      const placeholders = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      const rows = await query(`select * from ${fn}(${placeholders})`, keys.map((k) => args[k]));
      return rows.length === 1 && Object.keys(rows[0]).length === 1 ? Object.values(rows[0])[0] : rows;
    },
    select(table, where = '', params = []) {
      return query(`select * from ${table}${where ? ` where ${where}` : ''}`, params);
    },
    async insert(table, rows) {
      const list = Array.isArray(rows) ? rows : [rows];
      if (!list.length) return [];
      const cols = Object.keys(list[0]);
      const values = list.map((row, r) => `(${cols.map((_, c) => `$${r * cols.length + c + 1}`).join(',')})`).join(',');
      const flat = list.flatMap((row) => cols.map((c) => row[c]));
      return query(`insert into ${table} (${cols.join(',')}) values ${values} returning *`, flat);
    },
    update(table, where, patch, params = []) {
      const cols = Object.keys(patch);
      const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      return query(`update ${table} set ${sets} where ${where} returning *`, [...cols.map((c) => patch[c]), ...params]);
    }
  };
}
