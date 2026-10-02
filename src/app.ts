import Fastify, { type FastifyRequest } from 'fastify';
import { appConfig } from './config/env.js';
import { applyAdminCors } from './http/admin.js';
import { applyClientCors } from './http/client.js';
import { registerErrorHandler } from './http/errors.js';
import { registerAdminAuthRoutes } from './http/routes/admin-auth.routes.js';
import { registerAdminBookingRoutes } from './http/routes/admin-bookings.routes.js';
import { registerAdminCancellationPolicyRoutes } from './http/routes/admin-cancellation-policies.routes.js';
import { registerAdminClientGroupRoutes } from './http/routes/admin-client-groups.routes.js';
import { registerAdminClientRoutes } from './http/routes/admin-clients.routes.js';
import { registerAdminProductRoutes } from './http/routes/admin-products.routes.js';
import { registerAdminRegiondoRoutes } from './http/routes/admin-regiondo.routes.js';
import { registerAdminReminderRoutes } from './http/routes/admin-reminders.routes.js';
import { registerAdminResourceRoutes } from './http/routes/admin-resources.routes.js';
import { registerAdminTaskBookingOptionRoutes } from './http/routes/admin-task-booking-options.routes.js';
import { registerAdminErrorEventRoutes } from './http/routes/admin-error-events.routes.js';
import { registerAdminDashboardRoutes } from './http/routes/admin-dashboard.routes.js';
import { registerExternalTaskIntakeRoutes } from './http/routes/external-task-intake.routes.js';
import { registerHealthRoutes } from './http/routes/health.routes.js';
import { registerInternalJobRoutes } from './http/routes/internal-jobs.routes.js';
import { registerRegiondoWebhookRoutes } from './http/routes/regiondo-webhook.routes.js';
import { registerClientAuthRoutes } from './http/routes/client-auth.routes.js';
import { registerClientApiRoutes } from './http/routes/client-api.routes.js';
import { registerClientFeedbackRoutes } from './http/routes/client-feedback.routes.js';
import { registerAdminFeedbackRoutes } from './http/routes/admin-feedback.routes.js';
import { registerClientCommerceRoutes } from './http/routes/client-commerce.routes.js';
import { registerStripeWebhookRoutes } from './http/routes/stripe-webhook.routes.js';
import { registerWebRoutes } from './http/routes/web.routes.js';
import { registerOpenApiRoutes } from './http/routes/openapi.routes.js';

export function createApp() {
  const app = Fastify({
    requestIdHeader: 'x-request-id',
    logger: {
      level: appConfig.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'headers.authorization',
          'headers.x-api-hash',
          'headers.x-core-signature',
          'headers.x-external-task-secret',
          'headers.x-client-authorization',
          'headers.x-checkout-token',
          'headers.x-management-token',
          'config.REGIONDO_SECRET_KEY',
          'config.STRIPE_SECRET_KEY',
          'config.STRIPE_WEBHOOK_SECRET',
          'config.REMINDER_PROVIDER_SECRET',
          'config.CRON_SECRET',
          'config.WORDPRESS_SERVICE_TOKEN'
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

    if (applyClientCors(request, reply)) {
      return reply;
    }

    return undefined;
  });

  app.setErrorHandler(registerErrorHandler());

  void registerHealthRoutes(app);
  void registerOpenApiRoutes(app);
  void registerClientAuthRoutes(app);
  void registerClientApiRoutes(app);
  void registerClientFeedbackRoutes(app);
  void registerClientCommerceRoutes(app);
  void registerWebRoutes(app);
  void registerAdminAuthRoutes(app);
  void registerAdminProductRoutes(app);
  void registerExternalTaskIntakeRoutes(app);
  void registerRegiondoWebhookRoutes(app);
  void registerStripeWebhookRoutes(app);
  void registerInternalJobRoutes(app);
  void registerAdminBookingRoutes(app);
  void registerAdminCancellationPolicyRoutes(app);
  void registerAdminClientRoutes(app);
  void registerAdminFeedbackRoutes(app);
  void registerAdminClientGroupRoutes(app);
  void registerAdminReminderRoutes(app);
  void registerAdminRegiondoRoutes(app);
  void registerAdminResourceRoutes(app);
  void registerAdminTaskBookingOptionRoutes(app);
  void registerAdminErrorEventRoutes(app);
  void registerAdminDashboardRoutes(app);

  return app;
}
