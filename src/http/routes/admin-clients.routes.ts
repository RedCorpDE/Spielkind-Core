import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAdminWriteAudit } from '../admin-audit.js';
import { type AdminFastifyRequest, requireAdminAuth } from '../admin.js';
import { HttpError, ValidationHttpError } from '../errors.js';
import { getAdminClient, listAdminClients, updateAdminClient } from '../../modules/clients/client-admin.repository.js';

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
    await requireAdminAuth(request as AdminFastifyRequest);
    const query = request.query as { search?: string };
    return { ok: true, items: await listAdminClients(query.search) };
  });

  app.get('/api/admin/clients/:clientId', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    const { clientId } = request.params as { clientId: string };
    const client = await getAdminClient(clientId);
    if (!client) {
      throw new HttpError(404, 'Client not found.');
    }

    return { ok: true, item: client };
  });

  app.patch('/api/admin/clients/:clientId', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = updateClientSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid client update payload.');
    }

    const { clientId } = request.params as { clientId: string };
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
