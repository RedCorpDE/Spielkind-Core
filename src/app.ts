import Fastify, { type FastifyRequest } from 'fastify';
import { appConfig } from './config/env.js';
import { applyAdminCors } from './http/admin.js';
import { registerErrorHandler } from './http/errors.js';
import { registerAdminAuthRoutes } from './http/routes/admin-auth.routes.js';
import { registerAdminBookingRoutes } from './http/routes/admin-bookings.routes.js';
import { registerAdminClientGroupRoutes } from './http/routes/admin-client-groups.routes.js';
import { registerAdminClientRoutes } from './http/routes/admin-clients.routes.js';
import { registerAdminProductRoutes } from './http/routes/admin-products.routes.js';
import { registerAdminRegiondoRoutes } from './http/routes/admin-regiondo.routes.js';
import { registerAdminReminderRoutes } from './http/routes/admin-reminders.routes.js';
import { registerAdminResourceRoutes } from './http/routes/admin-resources.routes.js';
import { registerAdminDashboardRoutes } from './http/routes/admin-dashboard.routes.js';
import { registerExternalTaskIntakeRoutes } from './http/routes/external-task-intake.routes.js';
import { registerHealthRoutes } from './http/routes/health.routes.js';
import { registerInternalJobRoutes } from './http/routes/internal-jobs.routes.js';
import { registerRegiondoWebhookRoutes } from './http/routes/regiondo-webhook.routes.js';

export function createApp() {
  const app = Fastify({
    logger: {
      level: appConfig.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'headers.authorization',
          'headers.x-api-hash',
          'headers.x-core-signature',
          'headers.x-external-task-secret',
          'config.REGIONDO_SECRET_KEY',
          'config.REMINDER_PROVIDER_SECRET',
          'config.CRON_SECRET'
        ],
        remove: true
      }
    },
    bodyLimit: appConfig.WEBHOOK_BODY_LIMIT_BYTES,
    disableRequestLogging: false
  });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    try {
      const rawBody = typeof body === 'string' ? body : body.toString('utf8');
      (request as FastifyRequest & { rawBody?: string }).rawBody = rawBody;
      done(null, JSON.parse(rawBody));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    if (applyAdminCors(request, reply)) {
      return reply;
    }

    return undefined;
  });

  app.setErrorHandler(registerErrorHandler());

  void registerHealthRoutes(app);
  void registerAdminAuthRoutes(app);
  void registerAdminProductRoutes(app);
  void registerExternalTaskIntakeRoutes(app);
  void registerRegiondoWebhookRoutes(app);
  void registerInternalJobRoutes(app);
  void registerAdminBookingRoutes(app);
  void registerAdminClientRoutes(app);
  void registerAdminClientGroupRoutes(app);
  void registerAdminReminderRoutes(app);
  void registerAdminRegiondoRoutes(app);
  void registerAdminResourceRoutes(app);
  void registerAdminDashboardRoutes(app);

  return app;
}
