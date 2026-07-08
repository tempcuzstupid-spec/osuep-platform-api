import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env } from './env.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { orgRoutes } from './routes/orgs.js';
import { userRoutes } from './routes/users.js';
import { auditRoutes } from './routes/audit.js';
import { catalogRoutes } from './routes/catalog.js';
import {
  cartRoutes,
  orderRoutes,
  invoiceRoutes,
  documentRoutes,
  artworkRoutes,
  messageRoutes,
  notificationRoutes,
  favoriteRoutes,
} from './routes/orders.js';
import { setActiveOrgRoutes } from './routes/session.js';
import { errorHandler } from './plugins/error-handler.js';
import { requestContext } from './plugins/request-context.js';
import { authPlugin } from './plugins/auth.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport: env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
        : undefined,
    },
    trustProxy: true,
    bodyLimit: 1_048_576, // 1 MB default; raise per-route for uploads
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
  });

  // Security & infra plugins
  await app.register(helmet, {
    contentSecurityPolicy: false, // API only, no HTML
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true, // allow cookies
  });

  await app.register(cookie, {
    secret: env.COOKIE_SECRET,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // App plugins
  await app.register(errorHandler);
  await app.register(requestContext);
  await app.register(authPlugin);

  // Routes
  await app.register(healthRoutes, { prefix: '/' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(orgRoutes, { prefix: '/api/orgs' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(auditRoutes, { prefix: '/api/audit' });
  await app.register(setActiveOrgRoutes, { prefix: '/api/session' });
  await app.register(catalogRoutes, { prefix: '/api/catalog' });
  await app.register(cartRoutes, { prefix: '/api' });
  await app.register(orderRoutes, { prefix: '/api' });
  await app.register(invoiceRoutes, { prefix: '/api' });
  await app.register(documentRoutes, { prefix: '/api' });
  await app.register(artworkRoutes, { prefix: '/api' });
  await app.register(messageRoutes, { prefix: '/api' });
  await app.register(notificationRoutes, { prefix: '/api' });
  await app.register(favoriteRoutes, { prefix: '/api' });

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    const address = await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`OSUEP API listening at ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down…`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
