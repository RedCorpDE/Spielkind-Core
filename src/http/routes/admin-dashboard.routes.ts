import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth, type AdminFastifyRequest } from '../admin.js';
import { HttpError, ValidationHttpError } from '../errors.js';
import { recordAdminWriteAudit } from '../admin-audit.js';
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  listTasksByBookingId,
  listDeletedTasks,
  restoreTask,
  updateTask
} from '../../dashboard/repository/tasks.js';
import {
  createTaskColumn,
  deleteTaskColumn,
  getTaskColumnById,
  listTaskColumns,
  reorderTaskColumns,
  updateTaskColumn
} from '../../dashboard/repository/task-columns.js';
import {
  createLocation,
  deleteLocation,
  getLocation,
  listLocations,
  updateLocation
} from '../../dashboard/repository/locations.js';
import { getDashboardSummary } from '../../dashboard/repository/summary.js';
import { listUsers } from '../../dashboard/repository/users.js';
import {
  DashboardNotFoundError,
  DashboardValidationError
} from '../../dashboard/repository/core.js';

const taskColumnIdSchema = z.union([z.string().uuid(), z.literal('none')]);

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  eventDateTime: z.string().min(1),
  reminderDate: z.string().nullable().optional(),
  reservedCapacityDate: z.string().nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  site: z.string().default(''),
  columnId: taskColumnIdSchema.nullable().optional(),
  connectedBookingId: z.string().uuid().nullable().optional()
});

const updateTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  eventDateTime: z.string().min(1),
  reminderDate: z.string().nullable().optional(),
  reservedCapacityDate: z.string().nullable().optional(),
  ownerId: z.string().uuid().nullable().optional(),
  site: z.string().default(''),
  columnId: taskColumnIdSchema.nullable(),
  connectedBookingId: z.string().uuid().nullable().optional()
});

const createTaskColumnSchema = z.object({
  title: z.string().trim().min(1),
  bookingRelated: z.boolean().default(false),
  position: z.number().int().min(0).optional()
});

const updateTaskColumnSchema = z.object({
  title: z.string().trim().min(1).optional(),
  bookingRelated: z.boolean().optional(),
  position: z.number().int().min(0).optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be provided.'
});

const reorderTaskColumnsSchema = z.object({
  orderedColumnIds: z.array(z.string().uuid()).min(1)
});

const createLocationSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().default(''),
  imageUrl: z.string().url().nullable().optional(),
  regiondoLocationId: z.string().nullable().optional()
});

const updateLocationSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  regiondoLocationId: z.string().nullable().optional()
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be provided.'
});

const listTasksQuerySchema = z.object({
  columnId: taskColumnIdSchema.optional(),
  ownerId: z.string().uuid().optional(),
  connectedBookingId: z.string().uuid().optional(),
  search: z.string().trim().optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
});

function sendError(error: unknown): never {
  if (error instanceof DashboardNotFoundError) {
    throw new HttpError(404, error.message);
  }
  if (error instanceof DashboardValidationError) {
    throw new ValidationHttpError(error.message);
  }
  throw error;
}

export async function registerAdminDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/dashboard/bootstrap', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const [users, locations, taskColumns, summary] = await Promise.all([
      listUsers(),
      listLocations(),
      listTaskColumns(),
      getDashboardSummary()
    ]);
    return {
      me: { id: auth.user.id, email: auth.user.email, name: auth.user.displayName, role: auth.user.role },
      users,
      locations,
      taskColumns,
      summary
    };
  });

  app.get('/api/admin/users', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    return { items: await listUsers() };
  });

  app.get('/api/admin/locations', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    return { items: await listLocations() };
  });

  app.get('/api/admin/locations/:locationId', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    try {
      const { locationId } = request.params as { locationId: string };
      return { item: await getLocation(locationId) };
    } catch (error) {
      sendError(error);
    }
  });

  app.post('/api/admin/locations', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = createLocationSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid location payload.');
    }

    try {
      const location = await createLocation(parsed.data);
      await recordAdminWriteAudit({
        request,
        auth,
        action: 'admin.location.created',
        entityType: 'location',
        entityId: location.id,
        details: parsed.data
      });
      return { item: location };
    } catch (error) {
      sendError(error);
    }
  });

  app.patch('/api/admin/locations/:locationId', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = updateLocationSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid location payload.');
    }

    try {
      const { locationId } = request.params as { locationId: string };
      const location = await updateLocation(locationId, {
        title: parsed.data.title,
        description: parsed.data.description ?? undefined,
        imageUrl: parsed.data.imageUrl ?? undefined,
        regiondoLocationId: parsed.data.regiondoLocationId ?? undefined
      });
      await recordAdminWriteAudit({
        request,
        auth,
        action: 'admin.location.updated',
        entityType: 'location',
        entityId: location.id,
        details: parsed.data
      });
      return { item: location };
    } catch (error) {
      sendError(error);
    }
  });

  app.delete('/api/admin/locations/:locationId', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const { locationId } = request.params as { locationId: string };

    try {
      await deleteLocation(locationId);
      await recordAdminWriteAudit({
        request,
        auth,
        action: 'admin.location.deleted',
        entityType: 'location',
        entityId: locationId
      });
      return { deleted: true };
    } catch (error) {
      sendError(error);
    }
  });

  app.get('/api/admin/task-columns', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    return { items: await listTaskColumns() };
  });

  app.get('/api/admin/task-columns/:columnId', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    try {
      const { columnId } = request.params as { columnId: string };
      return { item: await getTaskColumnById(columnId) };
    } catch (error) {
      sendError(error);
    }
  });

  app.post('/api/admin/task-columns', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = createTaskColumnSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid task column payload.');
    }

    const column = await createTaskColumn(parsed.data);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.task_column.created',
      entityType: 'task_column',
      entityId: column.id,
      details: parsed.data
    });
    return { item: column };
  });

  app.post('/api/admin/task-columns/reorder', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = reorderTaskColumnsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid task column reorder payload.');
    }

    const columns = await reorderTaskColumns(parsed.data);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.task_column.reordered',
      entityType: 'task_column',
      details: parsed.data
    });
    return { items: columns };
  });

  app.patch('/api/admin/task-columns/:columnId', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = updateTaskColumnSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid task column payload.');
    }

    const { columnId } = request.params as { columnId: string };
    const column = await updateTaskColumn(columnId, parsed.data);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.task_column.updated',
      entityType: 'task_column',
      entityId: column.id,
      details: parsed.data
    });
    return { item: column };
  });

  app.delete('/api/admin/task-columns/:columnId', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const { columnId } = request.params as { columnId: string };

    await deleteTaskColumn(columnId);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.task_column.deleted',
      entityType: 'task_column',
      entityId: columnId
    });
    return { deleted: true };
  });

  app.get('/api/admin/tasks', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    const query = listTasksQuerySchema.parse(request.query);
    return { items: await listTasks(query) };
  });

  app.get('/api/admin/tasks/:taskId', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    try {
      const { taskId } = request.params as { taskId: string };
      return { item: await getTask(taskId) };
    } catch (error) {
      sendError(error);
    }
  });

  app.post('/api/admin/tasks', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid task payload.');
    }

    const task = await createTask(parsed.data, {
      name: auth.user.displayName,
      role: auth.user.role,
      source: 'user'
    });
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.task.created',
      entityType: 'task',
      entityId: task.id,
      details: { title: task.title }
    });
    return { item: task };
  });

  app.patch('/api/admin/tasks/:taskId', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = updateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid task payload.');
    }

    const { taskId } = request.params as { taskId: string };
    const task = await updateTask(taskId, parsed.data, {
      name: auth.user.displayName,
      role: auth.user.role,
      source: 'user'
    });
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.task.updated',
      entityType: 'task',
      entityId: task.id,
      details: parsed.data
    });
    return { item: task };
  });

  app.delete('/api/admin/tasks/:taskId', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const { taskId } = request.params as { taskId: string };

    try {
      await deleteTask(taskId);
      await recordAdminWriteAudit({
        request,
        auth,
        action: 'admin.task.deleted',
        entityType: 'task',
        entityId: taskId
      });
      return { deleted: true };
    } catch (error) {
      sendError(error);
    }
  });

  app.get('/api/admin/bookings/:bookingId/tasks', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    const { bookingId } = request.params as { bookingId: string };
    return { items: await listTasksByBookingId(bookingId) };
  });

  app.get('/api/admin/deleted-tasks', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    const { limit } = z.object({
      limit: z.coerce.number().int().positive().max(200).optional()
    }).parse(request.query);
    return { items: await listDeletedTasks({ limit }) };
  });

  app.post('/api/admin/deleted-tasks/:taskId/restore', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const { taskId } = request.params as { taskId: string };

    try {
      const task = await restoreTask(taskId);
      await recordAdminWriteAudit({
        request,
        auth,
        action: 'admin.task.restored',
        entityType: 'task',
        entityId: task.id
      });
      return { item: task };
    } catch (error) {
      sendError(error);
    }
  });

  app.post('/api/admin/bookings/:bookingId/tasks', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = createTaskSchema
      .omit({ connectedBookingId: true })
      .safeParse(request.body);

    if (!parsed.success) {
      throw new ValidationHttpError('Invalid task payload.');
    }

    const { bookingId } = request.params as { bookingId: string };
    const task = await createTask(
      { ...parsed.data, connectedBookingId: bookingId },
      { name: auth.user.displayName, role: auth.user.role, source: 'user' }
    );
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.task.created',
      entityType: 'task',
      entityId: task.id,
      details: { title: task.title, bookingId }
    });
    return { item: task };
  });
}
