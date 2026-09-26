import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createClientGroup,
  createClientGroupInvite,
  deleteClientGroup,
  getClientAccessCredential,
  getClientBooking,
  getClientGroup,
  getClientLocation,
  getClientPreferences,
  getClientProfile,
  joinClientGroup,
  listClientBookings,
  listClientConnectedAccounts,
  listClientGroupMembers,
  listClientGroups,
  listClientLocations,
  listClientNotifications,
  listClientPayments,
  markClientNotificationRead,
  updateClientGroup,
  updateClientPreferences,
  updateClientProfile
} from '../../client-api/repository.js';
import { pool } from '../../db/pool.js';
import { createExternalClientEmailTask } from '../../modules/external-task-intake/external-task-intake.service.js';
import { requireClientAuth, type ClientFastifyRequest } from '../client.js';
import { ForbiddenHttpError, HttpError, ValidationHttpError } from '../errors.js';

const idParamsSchema = z.object({ id: z.string().uuid() });
const bookingParamsSchema = z.object({ bookingId: z.string().uuid() });
const groupParamsSchema = z.object({ groupId: z.string().uuid() });
const notificationParamsSchema = z.object({ notificationId: z.string().uuid() });
const joinParamsSchema = z.object({ token: z.string().min(1).max(512) });

function parseOrValidation<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationHttpError(message);
  return parsed.data;
}

function notFound(message: string): never {
  throw new HttpError(404, message);
}

export async function registerClientApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/client/me', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    return (await getClientProfile(auth.client.id)) ?? notFound('Client account was not found.');
  });

  app.patch('/api/client/me', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const input = parseOrValidation(
      z.object({
        firstName: z.string().trim().min(1).max(100).optional(),
        lastName: z.string().trim().min(1).max(100).optional(),
        displayName: z.string().trim().min(2).max(100).optional(),
        phone: z.string().trim().max(50).nullable().optional()
      }).refine((value) => Object.keys(value).length > 0),
      request.body,
      'Invalid profile update.'
    );
    return (await updateClientProfile(auth.client.id, input)) ?? notFound('Client account was not found.');
  });

  app.get('/api/client/preferences', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    return getClientPreferences(auth.client.id);
  });

  app.patch('/api/client/preferences', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const input = parseOrValidation(
      z.object({
        language: z.enum(['de', 'en']).optional(),
        appearance: z.enum(['system', 'light', 'dark']).optional(),
        onboardingCompleted: z.boolean().optional(),
        bookingReminders: z.boolean().optional(),
        accessNotifications: z.boolean().optional(),
        groupNotifications: z.boolean().optional(),
        marketing: z.boolean().optional()
      }).refine((value) => Object.keys(value).length > 0),
      request.body,
      'Invalid preference update.'
    );
    return updateClientPreferences(auth.client.id, input);
  });

  app.get('/api/client/bookings', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    return listClientBookings(auth.client.id);
  });

  app.get('/api/client/bookings/:bookingId', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { bookingId } = parseOrValidation(bookingParamsSchema, request.params, 'Invalid booking id.');
    return (await getClientBooking(auth.client.id, bookingId)) ?? notFound('Booking was not found.');
  });

  app.get('/api/client/bookings/:bookingId/access', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { bookingId } = parseOrValidation(bookingParamsSchema, request.params, 'Invalid booking id.');
    if (!(await getClientBooking(auth.client.id, bookingId))) notFound('Booking was not found.');
    return (await getClientAccessCredential(auth.client.id, bookingId)) ?? notFound('No access credential is available.');
  });

  app.get('/api/client/access', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    return (await getClientAccessCredential(auth.client.id)) ?? notFound('No access credential is available.');
  });

  app.get('/api/client/locations', async (request) => {
    await requireClientAuth(request as ClientFastifyRequest);
    return listClientLocations();
  });

  app.get('/api/client/locations/:id', async (request) => {
    await requireClientAuth(request as ClientFastifyRequest);
    const { id } = parseOrValidation(idParamsSchema, request.params, 'Invalid location id.');
    return (await getClientLocation(id)) ?? notFound('Location was not found.');
  });

  app.get('/api/client/groups', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    return listClientGroups(auth.client.id);
  });

  app.get('/api/client/groups/:groupId', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { groupId } = parseOrValidation(groupParamsSchema, request.params, 'Invalid group id.');
    return (await getClientGroup(auth.client.id, groupId)) ?? notFound('Group was not found.');
  });

  app.post('/api/client/groups', async (request, reply) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const input = parseOrValidation(
      z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(2000) }),
      request.body,
      'Invalid group payload.'
    );
    reply.code(201);
    return createClientGroup(auth.client.id, input.name, input.description);
  });

  app.patch('/api/client/groups/:groupId', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { groupId } = parseOrValidation(groupParamsSchema, request.params, 'Invalid group id.');
    const input = parseOrValidation(
      z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(2000).optional() })
        .refine((value) => Object.keys(value).length > 0),
      request.body,
      'Invalid group update.'
    );
    const result = await updateClientGroup(auth.client.id, groupId, input);
    if (result === 'forbidden') throw new ForbiddenHttpError('Only group owners and admins can update this group.');
    return result ?? notFound('Group was not found.');
  });

  app.delete('/api/client/groups/:groupId', async (request, reply) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { groupId } = parseOrValidation(groupParamsSchema, request.params, 'Invalid group id.');
    const result = await deleteClientGroup(auth.client.id, groupId);
    if (result === 'forbidden') throw new ForbiddenHttpError('Only the group owner can delete this group.');
    if (!result) notFound('Group was not found.');
    reply.code(204);
    return reply.send();
  });

  app.get('/api/client/groups/:groupId/members', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { groupId } = parseOrValidation(groupParamsSchema, request.params, 'Invalid group id.');
    if (!(await getClientGroup(auth.client.id, groupId))) notFound('Group was not found.');
    return listClientGroupMembers(groupId);
  });

  app.post('/api/client/groups/:groupId/invites', async (request, reply) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { groupId } = parseOrValidation(groupParamsSchema, request.params, 'Invalid group id.');
    const input = parseOrValidation(
      z.object({ email: z.string().trim().email().optional() }),
      request.body ?? {},
      'Invalid group invitation.'
    );
    const invite = await createClientGroupInvite(auth.client.id, groupId, input.email);
    if (!invite) throw new ForbiddenHttpError('Only group owners and admins can invite members.');
    reply.code(201);
    return invite;
  });

  app.post('/api/client/groups/join/:token', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { token } = parseOrValidation(joinParamsSchema, request.params, 'Invalid invitation token.');
    const groupId = await joinClientGroup(auth.client.id, token);
    if (!groupId) throw new ValidationHttpError('This invitation is invalid, expired, or belongs to another account.');
    return (await getClientGroup(auth.client.id, groupId)) ?? notFound('Group was not found.');
  });

  app.get('/api/client/notifications', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const query = parseOrValidation(z.object({ cursor: z.string().uuid().optional() }), request.query, 'Invalid notification cursor.');
    return listClientNotifications(auth.client.id, query.cursor);
  });

  app.patch('/api/client/notifications/:notificationId/read', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const { notificationId } = parseOrValidation(notificationParamsSchema, request.params, 'Invalid notification id.');
    if (!(await markClientNotificationRead(auth.client.id, notificationId))) notFound('Notification was not found.');
    return { accepted: true };
  });

  app.get('/api/client/payments', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    return listClientPayments(auth.client.id);
  });

  app.get('/api/client/connected-accounts', async (request) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    return listClientConnectedAccounts(auth.client.id);
  });

  app.post('/api/client/support', async (request, reply) => {
    const auth = await requireClientAuth(request as ClientFastifyRequest);
    const input = parseOrValidation(
      z.object({
        category: z.enum(['Access', 'PC', 'Equipment', 'Room', 'Network', 'Booking', 'Payment', 'Other']),
        description: z.string().trim().min(10).max(10_000),
        bookingId: z.string().uuid().optional(),
        locationId: z.string().uuid().optional(),
        resourceId: z.string().uuid().optional(),
        attachmentUri: z.string().max(2048).optional()
      }),
      request.body,
      'Invalid support request.'
    );

    const booking = input.bookingId ? await getClientBooking(auth.client.id, input.bookingId) : null;
    if (input.bookingId && !booking) notFound('Booking was not found.');
    let location = input.locationId ? await getClientLocation(input.locationId) : booking?.location ?? null;
    if (input.locationId && !location) notFound('Location was not found.');
    if (input.resourceId) {
      const resource = await pool.query<{ location_id: string }>(
        `SELECT location_id FROM resources WHERE resource_id = $1 LIMIT 1`,
        [input.resourceId]
      );
      if (!resource.rowCount) notFound('Resource was not found.');
      if (location && resource.rows[0].location_id !== location.id) {
        throw new ValidationHttpError('The selected resource does not belong to the selected location.');
      }
      location ??= await getClientLocation(resource.rows[0].location_id);
    }
    const externalMessageId = randomUUID();
    const context = [
      input.bookingId ? `Booking: ${input.bookingId}` : null,
      input.locationId ? `Location: ${input.locationId}` : null,
      input.resourceId ? `Resource: ${input.resourceId}` : null,
      input.attachmentUri ? `Attachment (client URI only): ${input.attachmentUri}` : null
    ].filter(Boolean).join('\n');
    const result = await createExternalClientEmailTask({
      externalMessageId,
      source: 'client_app',
      title: `[${input.category}] ${input.description.slice(0, 80)}`,
      description: `${input.description}${context ? `\n\n${context}` : ''}`,
      email: auth.client.email,
      firstName: auth.client.firstName,
      lastName: auth.client.lastName,
      originalClientEmail: auth.client.email,
      site: location?.name ?? 'Customer app'
    });
    await pool.query(
      `UPDATE external_task_intake_events
       SET client_id = $1, booking_id = $2, resource_id = $3, location_id = $4
       WHERE source = 'client_app' AND external_message_id = $5`,
      [auth.client.id, input.bookingId ?? null, input.resourceId ?? null, location?.id ?? null, externalMessageId]
    );
    reply.code(201);
    return { id: result.item.id, status: 'received', createdAt: new Date().toISOString() };
  });
}
