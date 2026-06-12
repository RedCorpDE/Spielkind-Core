import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { appConfig } from '../../config/env.js';
import {
  createExternalClientEmailTask,
  ExternalTaskIntakeConflictError
} from '../../modules/external-task-intake/external-task-intake.service.js';
import { ConflictHttpError, UnauthorizedHttpError, ValidationHttpError } from '../errors.js';

const externalTaskOptionSchema = z.object({
  optionId: z.string().trim().nullable().optional(),
  productId: z.string().trim().min(1),
  variationId: z.string().trim().nullable().optional()
});

const externalClientEmailTaskSchema = z.object({
  attendees: z.union([z.string(), z.number()]).nullable().optional(),
  beveragePackage: z.string().nullable().optional(),
  cateringSize: z.string().nullable().optional(),
  choiceBlock: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  columnId: z.union([z.string().uuid(), z.literal('none')]).nullable().optional(),
  description: z.string().trim().min(1),
  email: z.string().nullable().optional(),
  eventDateTime: z.string().trim().min(1),
  externalMessageId: z.string().trim().min(1),
  firstName: z.string().nullable().optional(),
  fixedPrice: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  options: z.array(externalTaskOptionSchema).optional(),
  ownerId: z.string().uuid().nullable().optional(),
  originalClientEmail: z.string().trim().min(1),
  paymentMethod: z.string().nullable().optional(),
  phoneNumber: z.string().nullable().optional(),
  price: z.union([z.string(), z.number()]).nullable().optional(),
  priceCalculation: z.string().nullable().optional(),
  reminderDate: z.string().nullable().optional(),
  reservedCapacityDate: z.string().nullable().optional(),
  secondaryEventTime: z.string().nullable().optional(),
  site: z.string().trim().min(1),
  source: z.string().trim().min(1).nullable().optional(),
  taxation: z.string().nullable().optional(),
  title: z.string().trim().min(1)
});

function assertExternalTaskWebhookAuthorization(request: FastifyRequest): void {
  const expectedHeaderValue = appConfig.EXTERNAL_TASK_WEBHOOK_AUTH_HEADER_VALUE;
  if (!expectedHeaderValue) {
    throw new UnauthorizedHttpError('External task webhook is not configured.');
  }

  const headerName = appConfig.EXTERNAL_TASK_WEBHOOK_AUTH_HEADER_NAME.toLowerCase();
  const headerValue = request.headers[headerName];
  if (headerValue !== expectedHeaderValue) {
    throw new UnauthorizedHttpError('Invalid external task webhook authentication header.');
  }
}

export async function registerExternalTaskIntakeRoutes(app: FastifyInstance): Promise<void> {
  app.post(appConfig.EXTERNAL_TASK_WEBHOOK_PATH, async (request, reply) => {
    assertExternalTaskWebhookAuthorization(request);

    const parsed = externalClientEmailTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid external task payload.');
    }

    try {
      const result = await createExternalClientEmailTask(parsed.data);
      return reply.status(result.created ? 201 : 200).send({
        ok: true,
        created: result.created,
        ...(result.duplicate ? { duplicate: true } : {}),
        item: result.item
      });
    } catch (error) {
      if (error instanceof ExternalTaskIntakeConflictError) {
        throw new ConflictHttpError(error.message);
      }

      throw error;
    }
  });
}
