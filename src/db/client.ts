import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

// Always require SSL unless explicitly local.
const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
const queryClient = postgres(connectionString, {
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  ssl: isLocal ? false : 'require',
  prepare: false,
});

export const db = drizzle(queryClient, { schema });
export type DB = typeof db;
export { schema };
