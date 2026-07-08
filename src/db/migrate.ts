import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
const sql = postgres(connectionString, { max: 1, ssl: isLocal ? false : 'require' });
const db = drizzle(sql);

console.log('Running migrations…');
await migrate(db, { migrationsFolder: './migrations' });
console.log('Migrations complete.');
await sql.end();
