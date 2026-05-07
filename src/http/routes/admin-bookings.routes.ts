import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getBooking, listBookings, updateBooking } from '../../dashboard/repository/bookings.js';
import { DashboardNotFoundError, DashboardValidationError } from '../../dashboard/repository/core.js';
import { recordAdminWriteAudit } from '../admin-audit.js';
import { type AdminFastifyRequest } from '../admin.js';
import { requireAdminPermission } from '../access-control.js';
import { HttpError, ValidationHttpError } from '../errors.js';
import {
  cancelBookingInRegiondo,
  cancelBookingLocally
} from '../../modules/bookings/admin-booking.repository.js';
import { rebuildConsumptionsForBooking } from '../../modules/resources/consumption.service.js';

const bookingExternalStatusSchema = z.enum(['Pending', 'Processing', 'Confirmed', 'Completed', 'Rejected', 'Canceled', 'Unknown']);
const bookingOpsStatusSchema = z.enum(['Normal', 'Escalated']);
const bookingStatusSchema = z.union([bookingExternalStatusSchema, z.literal('Escalated')]);
const bookingSortSchema = z.enum(['bookingDate', 'lastUpdated']);
const sortDirectionSchema = z.enum(['asc', 'desc']);

const listBookingsQuerySchema = z.object({
  status: bookingStatusSchema.optional(),
  externalStatus: bookingExternalStatusSchema.optional(),
  opsStatus: bookingOpsStatusSchema.optional(),
  locationId: z.string().uuid().optional(),
  search: z.string().trim().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  updatedSince: z.string().optional(),
  cursor: z.string().optional(),
  sort: bookingSortSchema.optional(),
  direction: sortDirectionSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
});

const updateBookingMetadataSchema = z
  .object({
    opsStatus: bookingOpsStatusSchema.optional(),
    opsNotes: z.string().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one booking metadata field must be provided.'
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

export async function registerAdminBookingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/bookings', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'bookings', 'view');
    const parsed = listBookingsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid bookings query.');
    }

    return { ok: true, ...(await listBookings(parsed.data)) };
  });

  app.get('/api/admin/bookings/:bookingId', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'bookings', 'view');
    const { bookingId } = request.params as { bookingId: string };
    return { ok: true, item: await getBooking(bookingId) };
  });

  app.patch('/api/admin/bookings/:bookingId/admin-metadata', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'bookings', 'update');
    const parsed = updateBookingMetadataSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid booking metadata payload.');
    }

    const { bookingId } = request.params as { bookingId: string };
    const booking = await updateBooking(bookingId, parsed.data);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.booking.metadata_updated',
      entityType: 'booking',
      entityId: booking.id,
      details: parsed.data as Record<string, unknown>
    });

    return { ok: true, item: booking };
  });

  app.post('/api/admin/bookings/:bookingId/rebuild-consumptions', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'bookings', 'manage');
    const { bookingId } = request.params as { bookingId: string };
    const booking = await getBooking(bookingId);
    const result = await rebuildConsumptionsForBooking(bookingId);

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.booking.consumptions_rebuilt',
      entityType: 'booking',
      entityId: bookingId,
      details: result as unknown as Record<string, unknown>
    });

    return { ok: true, item: await getBooking(booking.id), rebuild: result };
  });

  app.post('/api/admin/bookings/:bookingId/cancel-local', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'bookings', 'delete');
    const { bookingId } = request.params as { bookingId: string };
    const canceled = await cancelBookingLocally(bookingId);
    if (!canceled) {
      throw new HttpError(404, 'Booking not found.');
    }

    const rebuild = await rebuildConsumptionsForBooking(bookingId);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.booking.canceled_local',
      entityType: 'booking',
      entityId: bookingId,
      details: { rebuild }
    });

    return { ok: true, item: await getBooking(bookingId), rebuild };
  });

  app.post('/api/admin/bookings/:bookingId/cancel-regiondo', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'bookings', 'delete');
    const { bookingId } = request.params as { bookingId: string };

    try {
      const canceled = await cancelBookingInRegiondo(bookingId);
      if (!canceled) {
        throw new HttpError(404, 'Booking not found.');
      }

      const rebuild = await rebuildConsumptionsForBooking(bookingId);
      await recordAdminWriteAudit({
        request,
        auth,
        action: 'admin.booking.canceled_regiondo',
        entityType: 'booking',
        entityId: bookingId,
        details: {
          rebuild,
          synchronized: canceled.synchronized
        }
      });

      return { ok: true, item: await getBooking(bookingId), rebuild };
    } catch (error) {
      sendError(error);
    }
  });
}
