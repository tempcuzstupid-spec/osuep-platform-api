import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/', async () => ({
    name: 'osuep-api',
    version: '0.1.0',
    status: 'ok',
    time: new Date().toISOString(),
  }));

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: 'ready' };
    } catch (err) {
      reply.status(503);
      return { status: 'not_ready', error: err instanceof Error ? err.message : 'unknown' };
    }
  });
}
