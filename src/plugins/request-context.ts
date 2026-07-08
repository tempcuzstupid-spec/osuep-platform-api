import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    ctx: {
      requestId: string;
      ip: string;
      userAgent: string | undefined;
      userId?: string;
      membershipId?: string;
      orgId?: string;
    };
  }
}

const requestContextImpl = async (app: FastifyInstance) => {
  app.decorateRequest('ctx', null);

  app.addHook('onRequest', async (req) => {
    req.ctx = {
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    };
  });
};

export const requestContext = fp(requestContextImpl, { name: 'requestContext' });

export function getCtx(req: FastifyRequest) {
  if (!req.ctx) {
    // Defensive fallback — should never happen after the onRequest hook
    req.ctx = {
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    };
  }
  return req.ctx;
}
