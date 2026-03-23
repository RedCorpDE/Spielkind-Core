import express, { type Request } from 'express';
import { appConfig } from './config.js';
import { verifyWebhookSignature } from './regiondo/auth.js';
import { processBookingWebhook } from './sync/sync-service.js';
import type { RegiondoBooking } from './sync/types.js';

function getRawBody(req: Request): string {
  return (req as Request & { rawBody?: string }).rawBody ?? '';
}

export function createServer() {
  const app = express();

  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as Request & { rawBody?: string }).rawBody = buffer.toString();
      }
    })
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post(appConfig.WEBHOOK_BOOKINGS_PATH, async (req, res) => {
    try {
      const headerAuthConfigured = Boolean(appConfig.WEBHOOK_AUTH_HEADER_NAME && appConfig.WEBHOOK_AUTH_HEADER_VALUE);

      if (headerAuthConfigured) {
        const headerMatches =
          headerAuthConfigured &&
          req.header(appConfig.WEBHOOK_AUTH_HEADER_NAME as string) === appConfig.WEBHOOK_AUTH_HEADER_VALUE;

        if (!headerMatches) {
          res.status(401).json({ error: 'Invalid webhook authentication' });
          return;
        }
      }

      if (appConfig.REGIONDO_WEBHOOK_SECRET) {
        const signature = req.header('x-regiondo-signature');
        const valid = verifyWebhookSignature(getRawBody(req), signature, appConfig.REGIONDO_WEBHOOK_SECRET);
        if (!valid) {
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }
      }

      await processBookingWebhook(req.body as RegiondoBooking);
      res.status(202).json({ accepted: true });
    } catch (error) {
      console.error('Failed to process webhook:', error);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return app;
}
