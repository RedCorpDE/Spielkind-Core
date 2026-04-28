import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAdminWriteAudit } from '../admin-audit.js';
import { type AdminFastifyRequest, requireAdminAuth } from '../admin.js';
import { HttpError, ValidationHttpError } from '../errors.js';
import {
  createReminderRule,
  deleteReminderRule,
  getReminderRule,
  listReminderDeliveries,
  listReminderRules,
  retryReminderDelivery,
  updateReminderRule
} from '../../modules/reminders/reminder-admin.repository.js';
import { runDispatchRemindersJob } from '../../modules/reminders/dispatch-reminders.job.js';

const reminderRuleSchema = z.object({
  title: z.string().min(1),
  isEnabled: z.boolean().default(true),
  triggerType: z.literal('before_booking_start').default('before_booking_start'),
  offsetMinutes: z.number().int().positive(),
  additionalChannels: z.array(z.enum(['email', 'telegram', 'sms', 'whatsapp'])).default([]),
  reminderType: z.string().min(1),
  messageTemplate: z.string().min(1).refine((value) => value.trim().length > 0),
  locationId: z.string().uuid().nullable().optional(),
  productId: z.string().uuid().nullable().optional(),
  bookingStatuses: z.array(z.string().min(1)).default(['confirmed'])
});

const reminderRulePatchSchema = reminderRuleSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one reminder rule field must be provided.'
});

export async function registerAdminReminderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/reminder-rules', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    return { ok: true, items: await listReminderRules() };
  });

  app.post('/api/admin/reminder-rules', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = reminderRuleSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid reminder rule payload.');
    }

    const rule = await createReminderRule({
      ...parsed.data,
      createdByUserId: auth.user.id
    });

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.reminder_rule.created',
      entityType: 'reminder_rule',
      entityId: rule.reminderRuleId,
      details: parsed.data as Record<string, unknown>
    });

    return { ok: true, item: rule };
  });

  app.get('/api/admin/reminder-rules/:ruleId', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    const { ruleId } = request.params as { ruleId: string };
    const rule = await getReminderRule(ruleId);
    if (!rule) {
      throw new HttpError(404, 'Reminder rule not found.');
    }

    return { ok: true, item: rule };
  });

  app.patch('/api/admin/reminder-rules/:ruleId', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = reminderRulePatchSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid reminder rule payload.');
    }

    const { ruleId } = request.params as { ruleId: string };
    const rule = await updateReminderRule(ruleId, parsed.data);
    if (!rule) {
      throw new HttpError(404, 'Reminder rule not found.');
    }

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.reminder_rule.updated',
      entityType: 'reminder_rule',
      entityId: rule.reminderRuleId,
      details: parsed.data as Record<string, unknown>
    });

    return { ok: true, item: rule };
  });

  app.delete('/api/admin/reminder-rules/:ruleId', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const { ruleId } = request.params as { ruleId: string };
    const deleted = await deleteReminderRule(ruleId);
    if (!deleted) {
      throw new HttpError(404, 'Reminder rule not found.');
    }

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.reminder_rule.deleted',
      entityType: 'reminder_rule',
      entityId: ruleId
    });

    return { ok: true };
  });

  app.get('/api/admin/reminder-deliveries', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    const query = request.query as { status?: 'pending' | 'processing' | 'sent' | 'failed' | 'skipped'; bookingId?: string; limit?: string };
    return {
      ok: true,
      items: await listReminderDeliveries({
        status: query.status,
        bookingId: query.bookingId,
        limit: query.limit ? Number(query.limit) : undefined
      })
    };
  });

  app.post('/api/admin/reminder-deliveries/:deliveryId/retry', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const { deliveryId } = request.params as { deliveryId: string };
    const retried = await retryReminderDelivery(deliveryId);
    if (!retried) {
      throw new HttpError(404, 'Reminder delivery not found or not retryable.');
    }

    const job = await runDispatchRemindersJob({ limit: 1 });
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.reminder_delivery.retried',
      entityType: 'reminder_delivery',
      entityId: deliveryId,
      details: { job }
    });

    return { ok: true, job };
  });
}
