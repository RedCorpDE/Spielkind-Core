import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AdminFastifyRequest } from '../admin.js';
import { requireAdminPermission } from '../access-control.js';
import { recordAdminWriteAudit } from '../admin-audit.js';
import { ConflictHttpError, HttpError, ValidationHttpError } from '../errors.js';
import {
  archiveCancellationPolicy,
  createCancellationPolicy,
  duplicateCancellationPolicy,
  getCancellationPolicy,
  listCancellationPolicies,
  updateCancellationPolicy
} from '../../modules/cancellations/cancellation-policy.service.js';

const feeSchema = z.object({
  feeType: z.enum(['none', 'percentage', 'fixed_amount']),
  feeValue: z.number().int().nonnegative().safe().optional()
}).superRefine((value, context) => {
  if (value.feeType !== 'none' && value.feeValue === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['feeValue'], message: 'A fee value is required.' });
  }
  if (value.feeType === 'percentage' && (value.feeValue ?? 0) > 100) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['feeValue'], message: 'Percentage must not exceed 100.' });
  }
});
const policySchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  active: z.boolean().optional(),
  cancellationRules: z.array(z.object({
    minimumMinutesBeforeStart: z.number().int().nonnegative().safe(),
    feeType: z.enum(['none', 'percentage', 'fixed_amount']),
    feeValue: z.number().int().nonnegative().safe().optional(),
    description: z.string().trim().max(500).optional()
  })).min(1),
  noShow: feeSchema.and(z.object({ gracePeriodMinutes: z.number().int().nonnegative().safe() }))
});
const idSchema = z.object({ policyId: z.string().uuid() });

function validationMessage(error: unknown): never {
  throw new ValidationHttpError(error instanceof Error ? error.message : 'Invalid cancellation policy.');
}

export async function registerAdminCancellationPolicyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/cancellation-policies', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'cancellation_policies', 'view');
    const query = z.object({ search: z.string().optional(), includeArchived: z.coerce.boolean().optional() }).parse(request.query);
    return { ok: true, items: await listCancellationPolicies(query.search, query.includeArchived) };
  });

  app.get('/api/admin/cancellation-policies/:policyId', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'cancellation_policies', 'view');
    const { policyId } = idSchema.parse(request.params);
    const item = await getCancellationPolicy(policyId);
    if (!item) throw new HttpError(404, 'Cancellation policy was not found.');
    return { ok: true, item };
  });

  app.post('/api/admin/cancellation-policies', async (request, reply) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'cancellation_policies', 'create');
    const parsed = policySchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationHttpError('Invalid cancellation policy.');
    try {
      const item = await createCancellationPolicy(parsed.data);
      await recordAdminWriteAudit({ request, auth, action: 'admin.cancellation_policy.created', entityType: 'cancellation_policy', entityId: item.id });
      reply.status(201);
      return { ok: true, item };
    } catch (error) { validationMessage(error); }
  });

  app.put('/api/admin/cancellation-policies/:policyId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'cancellation_policies', 'update');
    const { policyId } = idSchema.parse(request.params);
    const parsed = policySchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationHttpError('Invalid cancellation policy.');
    try {
      const item = await updateCancellationPolicy(policyId, parsed.data);
      if (!item) throw new HttpError(404, 'Cancellation policy was not found.');
      await recordAdminWriteAudit({ request, auth, action: 'admin.cancellation_policy.updated', entityType: 'cancellation_policy', entityId: policyId });
      return { ok: true, item };
    } catch (error) { if (error instanceof HttpError) throw error; validationMessage(error); }
  });

  app.post('/api/admin/cancellation-policies/:policyId/duplicate', async (request, reply) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'cancellation_policies', 'create');
    const { policyId } = idSchema.parse(request.params);
    const item = await duplicateCancellationPolicy(policyId);
    if (!item) throw new HttpError(404, 'Cancellation policy was not found.');
    await recordAdminWriteAudit({ request, auth, action: 'admin.cancellation_policy.duplicated', entityType: 'cancellation_policy', entityId: item.id, details: { sourcePolicyId: policyId } });
    reply.status(201);
    return { ok: true, item };
  });

  app.post('/api/admin/cancellation-policies/:policyId/archive', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'cancellation_policies', 'delete');
    const { policyId } = idSchema.parse(request.params);
    try {
      const item = await archiveCancellationPolicy(policyId);
      if (!item) throw new HttpError(404, 'Cancellation policy was not found.');
      await recordAdminWriteAudit({ request, auth, action: 'admin.cancellation_policy.archived', entityType: 'cancellation_policy', entityId: policyId });
      return { ok: true, item };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new ConflictHttpError(error instanceof Error ? error.message : 'Policy cannot be archived.');
    }
  });
}
