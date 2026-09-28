import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAdminWriteAudit } from '../admin-audit.js';
import { type AdminFastifyRequest } from '../admin.js';
import { requireAdminPermission } from '../access-control.js';
import { HttpError, ValidationHttpError } from '../errors.js';
import {
  getAdminClient,
  listAdminClientBookings,
  listAdminClients,
  updateAdminClient
} from '../../modules/clients/client-admin.repository.js';

const booleanQuerySchema = z.enum(['true', 'false']).transform((value) => value === 'true');
const listClientsQuerySchema = z
  .object({
    search: z.string().trim().optional(),
    hasBookings: booleanQuerySchema.optional(),
    hasUpcomingBookings: booleanQuerySchema.optional(),
    hasAppAccount: booleanQuerySchema.optional(),
    emailVerified: booleanQuerySchema.optional(),
    createdFrom: z.string().datetime({ offset: true }).optional(),
    createdTo: z.string().datetime({ offset: true }).optional(),
    sort: z.enum(['name', 'createdAt', 'updatedAt', 'lastActivityAt', 'bookingCount']).optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional()
  })
  .superRefine((value, context) => {
    if (value.createdFrom && value.createdTo && new Date(value.createdFrom).getTime() > new Date(value.createdTo).getTime()) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'createdFrom must be before createdTo.', path: ['createdTo'] });
    }
  });

const listClientBookingsQuerySchema = z.object({
  category: z.enum(['all', 'upcoming', 'past', 'cancelled']).optional(),
  cursor: z.string().optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional()
});

function parseClientId(params: unknown): string {
  const parsed = z.object({ clientId: z.string().uuid() }).safeParse(params);
  if (!parsed.success) throw new ValidationHttpError('Invalid client ID.');
  return parsed.data.clientId;
}

const contactMethodSchema = z.object({
  channel: z.enum(['email', 'telegram', 'sms', 'whatsapp']),
  destination: z.string().min(1),
  isEnabled: z.boolean().optional(),
  isVerified: z.boolean().optional(),
  providerRef: z.string().nullable().optional(),
  rawJson: z.unknown().optional()
});

const updateClientSchema = z
  .object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    birthday: z.string().nullable().optional(),
    email: z.string().email().nullable().optional(),
    phoneNumber: z.string().nullable().optional(),
    preferredContactType: z.string().nullable().optional(),
    subscribedToNewsletter: z.boolean().optional(),
    contactMethods: z.array(contactMethodSchema).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one client field must be provided.'
  });

export async function registerAdminClientRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/clients', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'customers', 'view');
    const parsed = listClientsQuerySchema.safeParse(request.query);
    if (!parsed.success) throw new ValidationHttpError('Invalid clients query.');
    return { ok: true, ...(await listAdminClients(parsed.data)) };
  });

  app.get('/api/admin/clients/:clientId/bookings', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'customers', 'view');
    const parsed = listClientBookingsQuerySchema.safeParse(request.query);
    if (!parsed.success) throw new ValidationHttpError('Invalid client bookings query.');
    const clientId = parseClientId(request.params);
    const bookings = await listAdminClientBookings(clientId, parsed.data);
    if (!bookings) throw new HttpError(404, 'Client not found.');
    return { ok: true, ...bookings };
  });

  app.get('/api/admin/clients/:clientId', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'customers', 'view');
    const clientId = parseClientId(request.params);
    const client = await getAdminClient(clientId);
    if (!client) {
      throw new HttpError(404, 'Client not found.');
    }

    return { ok: true, item: client };
  });

  app.patch('/api/admin/clients/:clientId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'customers', 'update');
    const parsed = updateClientSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid client update payload.');
    }

    const clientId = parseClientId(request.params);
    const client = await updateAdminClient(clientId, parsed.data);
    if (!client) {
      throw new HttpError(404, 'Client not found.');
    }

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.client.updated',
      entityType: 'client',
      entityId: client.clientId,
      details: parsed.data as Record<string, unknown>
    });

    return { ok: true, item: client };
  });
}
