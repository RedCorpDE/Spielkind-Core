import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAdminWriteAudit } from '../admin-audit.js';
import { type AdminFastifyRequest, requireAdminAuth } from '../admin.js';
import { HttpError, ValidationHttpError } from '../errors.js';
import {
  attachClientGroupMember,
  createAdminClientGroup,
  deleteAdminClientGroup,
  detachClientGroupMember,
  getAdminClientGroup,
  listAdminClientGroups,
  updateAdminClientGroup
} from '../../modules/client-groups/client-group-admin.repository.js';

const groupSchema = z.object({
  title: z.string().min(1)
});

export async function registerAdminClientGroupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/client-groups', async (request) => {
    await requireAdminAuth(request as AdminFastifyRequest);
    return { ok: true, items: await listAdminClientGroups() };
  });

  app.post('/api/admin/client-groups', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = groupSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid client group payload.');
    }

    const group = await createAdminClientGroup(parsed.data.title);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.client_group.created',
      entityType: 'client_group',
      entityId: group.groupId,
      details: { title: group.title }
    });

    return { ok: true, item: group };
  });

  app.patch('/api/admin/client-groups/:groupId', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const parsed = groupSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid client group payload.');
    }

    const { groupId } = request.params as { groupId: string };
    const group = await updateAdminClientGroup(groupId, parsed.data.title);
    if (!group) {
      throw new HttpError(404, 'Client group not found.');
    }

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.client_group.updated',
      entityType: 'client_group',
      entityId: group.groupId,
      details: { title: group.title }
    });

    return { ok: true, item: group };
  });

  app.delete('/api/admin/client-groups/:groupId', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const { groupId } = request.params as { groupId: string };
    const existing = await getAdminClientGroup(groupId);
    if (!existing) {
      throw new HttpError(404, 'Client group not found.');
    }

    await deleteAdminClientGroup(groupId);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.client_group.deleted',
      entityType: 'client_group',
      entityId: groupId,
      details: { title: existing.title }
    });

    return { ok: true };
  });

  app.post('/api/admin/client-groups/:groupId/members/:clientId', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const { groupId, clientId } = request.params as { groupId: string; clientId: string };
    await attachClientGroupMember(groupId, clientId);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.client_group.member_attached',
      entityType: 'client_group',
      entityId: groupId,
      details: { clientId }
    });

    return { ok: true, item: await getAdminClientGroup(groupId) };
  });

  app.delete('/api/admin/client-groups/:groupId/members/:clientId', async (request) => {
    const auth = await requireAdminAuth(request as AdminFastifyRequest);
    const { groupId, clientId } = request.params as { groupId: string; clientId: string };
    const deleted = await detachClientGroupMember(groupId, clientId);
    if (!deleted) {
      throw new HttpError(404, 'Client group membership not found.');
    }

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.client_group.member_detached',
      entityType: 'client_group',
      entityId: groupId,
      details: { clientId }
    });

    return { ok: true, item: await getAdminClientGroup(groupId) };
  });
}
