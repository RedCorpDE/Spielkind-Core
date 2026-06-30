import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasRoutePermission } from '../../access-control/model.js';
import { recordAdminWriteAudit } from '../admin-audit.js';
import { type AdminFastifyRequest } from '../admin.js';
import { getAdminAccessContext, requireAdminPermission } from '../access-control.js';
import { ForbiddenHttpError, ValidationHttpError } from '../errors.js';
import {
  createTaskBookingOption,
  deleteTaskBookingOption,
  listTaskBookingOptions,
  reorderTaskBookingOptions,
  updateTaskBookingOption
} from '../../dashboard/repository/task-booking-options.js';

const taskBookingOptionGroupSchema = z.enum(['catering_size', 'beverage_package', 'choice_block']);

const createTaskBookingOptionSchema = z.object({
  groupKey: taskBookingOptionGroupSchema,
  labelEn: z.string().trim().min(1),
  labelDe: z.string().trim().min(1),
  isActive: z.boolean().optional()
});

const updateTaskBookingOptionSchema = z
  .object({
    labelEn: z.string().trim().min(1).optional(),
    labelDe: z.string().trim().min(1).optional(),
    isActive: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one task booking option field must be provided.'
  });

const reorderTaskBookingOptionsSchema = z.object({
  groupKey: taskBookingOptionGroupSchema,
  orderedOptionIds: z.array(z.string().uuid()).min(1)
});

function canReadTaskBookingOptions(permissions: Awaited<ReturnType<typeof getAdminAccessContext>>['permissions']): boolean {
  return (
    hasRoutePermission(permissions, 'task_booking_options', 'view') ||
    hasRoutePermission(permissions, 'tasks', 'view') ||
    hasRoutePermission(permissions, 'tasks', 'create') ||
    hasRoutePermission(permissions, 'tasks', 'update')
  );
}

async function requireTaskBookingOptionsRead(request: AdminFastifyRequest): Promise<void> {
  const accessContext = await getAdminAccessContext(request);

  if (!canReadTaskBookingOptions(accessContext.permissions)) {
    throw new ForbiddenHttpError('You do not have permission to view task booking options.');
  }
}

export async function registerAdminTaskBookingOptionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/task-booking-options', async (request) => {
    await requireTaskBookingOptionsRead(request as AdminFastifyRequest);
    const parsed = z
      .object({
        groupKey: taskBookingOptionGroupSchema.optional()
      })
      .safeParse(request.query);

    if (!parsed.success) {
      throw new ValidationHttpError('Invalid task booking options query.');
    }

    return { ok: true, items: await listTaskBookingOptions(parsed.data.groupKey) };
  });

  app.post('/api/admin/task-booking-options', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'task_booking_options', 'create');
    const parsed = createTaskBookingOptionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid task booking option payload.');
    }

    const option = await createTaskBookingOption(parsed.data);

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.task_booking_option.created',
      entityType: 'task_booking_option',
      entityId: option.id,
      details: {
        groupKey: option.groupKey,
        labelEn: option.labelEn,
        labelDe: option.labelDe,
        value: option.value
      }
    });

    return { ok: true, item: option };
  });

  app.patch('/api/admin/task-booking-options/:optionId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'task_booking_options', 'update');
    const { optionId } = request.params as { optionId: string };
    const parsed = updateTaskBookingOptionSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid task booking option payload.');
    }

    const option = await updateTaskBookingOption(optionId, parsed.data);

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.task_booking_option.updated',
      entityType: 'task_booking_option',
      entityId: option.id,
      details: parsed.data as Record<string, unknown>
    });

    return { ok: true, item: option };
  });

  app.delete('/api/admin/task-booking-options/:optionId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'task_booking_options', 'delete');
    const { optionId } = request.params as { optionId: string };

    await deleteTaskBookingOption(optionId);

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.task_booking_option.deleted',
      entityType: 'task_booking_option',
      entityId: optionId
    });

    return { ok: true };
  });

  app.post('/api/admin/task-booking-options/reorder', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'task_booking_options', 'manage');
    const parsed = reorderTaskBookingOptionsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid task booking option reorder payload.');
    }

    const options = await reorderTaskBookingOptions(parsed.data);

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.task_booking_option.reordered',
      entityType: 'task_booking_option',
      details: {
        groupKey: parsed.data.groupKey,
        orderedOptionIds: parsed.data.orderedOptionIds
      }
    });

    return { ok: true, items: options };
  });
}
