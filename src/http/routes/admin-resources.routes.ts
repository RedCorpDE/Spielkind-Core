import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAvailability } from '../../modules/resources/availability.service.js';
import {
  archiveAdminResource, createAdminResource, getAdminResource, listAdminResources, updateAdminResource
} from '../../modules/resources/resource-admin.repository.js';
import {
  createAvailabilityRule, deleteAvailabilityRule, listAvailabilityRules, updateAvailabilityRule
} from '../../modules/resources/availability-rule.repository.js';
import { type AdminFastifyRequest } from '../admin.js';
import { requireAdminPermission } from '../access-control.js';
import { ConflictHttpError, HttpError, ValidationHttpError } from '../errors.js';
import { recordAdminWriteAudit } from '../admin-audit.js';

const uuid = z.string().uuid();
const resourceType = z.enum([
  'pc',
  'room',
  'sleeping_room',
  'console_station',
  'vr_headset',
  'projector',
  'area',
  'equipment',
  'custom'
]);
const resourceInputSchema = z.object({
  locationId: uuid,
  type: resourceType,
  capacityAvailable: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(200),
  description: z.string().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  independentlyBookable: z.boolean().optional(),
  baseAmount: z.number().nonnegative().optional(),
  operationalStatus: z.enum(['active', 'out_of_service']).optional()
}).strict();
const resourceUpdateSchema = resourceInputSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one Resource field is required.'
});
const availabilityQuerySchema = z.object({
  location_id: uuid.optional(), product_id: uuid.optional(), product_variant_id: uuid.optional(), dt_from: z.string().datetime(),
  dt_to: z.string().datetime(), guest_count: z.coerce.number().int().positive().default(1)
});
const ruleInputSchema = z.object({
  locationId: uuid.nullable().default(null),
  productId: uuid.nullable().default(null),
  productVariantId: uuid.nullable().default(null),
  resourceId: uuid.nullable().default(null),
  ruleType: z.enum(['recurring', 'date_range', 'manual_block']),
  startsAt: z.string().datetime().nullable().default(null),
  endsAt: z.string().datetime().nullable().default(null),
  weekdays: z.array(z.number().int().min(1).max(7)).nullable().default(null),
  localStartTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/).nullable().default(null),
  localEndTime: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/).nullable().default(null),
  timezone: z.string().trim().min(1).default('Europe/Berlin'),
  capacityOverride: z.number().int().nonnegative().nullable().default(null),
  isActive: z.boolean().default(true),
  metadata: z.record(z.unknown()).default({})
}).strict().superRefine((value, context) => {
  if (!value.locationId && !value.productId && !value.resourceId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one Location, Product, or Resource scope is required.' });
  }
  if (value.ruleType === 'recurring' && (!value.weekdays?.length || !value.localStartTime || !value.localEndTime)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Recurring rules require weekdays and local start/end times.' });
  }
  if (value.ruleType !== 'recurring' && (!value.startsAt || !value.endsAt || new Date(value.endsAt) <= new Date(value.startsAt))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Date and block rules require a valid start/end range.' });
  }
});

export async function registerAdminResourceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/resources', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'resources', 'view');
    const query = z.object({ location_id: uuid.optional() }).safeParse(request.query);
    if (!query.success) throw new ValidationHttpError('Invalid Resource query.');
    return { ok: true, items: await listAdminResources(query.data.location_id) };
  });

  app.post('/api/admin/resources', async (request, reply) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'resources', 'manage');
    const body = resourceInputSchema.safeParse(request.body);
    if (!body.success) throw new ValidationHttpError('Invalid Resource payload.');
    const resource = await createAdminResource(body.data);
    if (!resource) throw new ValidationHttpError('Resource Location does not exist.');
    await recordAdminWriteAudit({
      request, auth, action: 'admin.resource.created', entityType: 'resource', entityId: resource.resourceId,
      details: { locationId: resource.locationId, capacityAvailable: resource.capacityAvailable }
    });
    reply.code(201);
    return { ok: true, item: resource };
  });

  app.get('/api/admin/resources/:resourceId', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'resources', 'view');
    const params = z.object({ resourceId: uuid }).safeParse(request.params);
    if (!params.success) throw new ValidationHttpError('Invalid Resource id.');
    const resource = await getAdminResource(params.data.resourceId);
    if (!resource) throw new HttpError(404, 'Resource not found.');
    return { ok: true, item: resource };
  });

  app.patch('/api/admin/resources/:resourceId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'resources', 'manage');
    const params = z.object({ resourceId: uuid }).safeParse(request.params);
    const body = resourceUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new ValidationHttpError('Invalid Resource update.');
    const result = await updateAdminResource(params.data.resourceId, body.data);
    if (result === 'not_found' || result === 'location_not_found') {
      throw new HttpError(404, result === 'not_found' ? 'Resource not found.' : 'Location not found.');
    }
    if (result === 'location_in_use') {
      throw new ConflictHttpError('A Resource used by Product Offerings cannot be moved to another Location.', 'RESOURCE_LOCATION_IN_USE');
    }
    await recordAdminWriteAudit({ request, auth, action: 'admin.resource.updated', entityType: 'resource', entityId: result.resourceId, details: body.data });
    return { ok: true, item: result };
  });

  app.delete('/api/admin/resources/:resourceId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'resources', 'manage');
    const params = z.object({ resourceId: uuid }).safeParse(request.params);
    if (!params.success) throw new ValidationHttpError('Invalid Resource id.');
    const resource = await archiveAdminResource(params.data.resourceId);
    if (!resource) throw new HttpError(404, 'Resource not found.');
    await recordAdminWriteAudit({
      request, auth, action: 'admin.resource.disabled', entityType: 'resource', entityId: resource.resourceId,
      details: { operationalStatus: resource.operationalStatus }
    });
    return { ok: true, item: resource };
  });

  app.get('/api/admin/availability', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'resources', 'view');
    const parsed = availabilityQuerySchema.safeParse(request.query);
    if (!parsed.success) throw new ValidationHttpError('Invalid availability query.');
    return { ok: true, items: await getAvailability(parsed.data) };
  });

  app.get('/api/admin/availability-rules', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'resources', 'view');
    const query = z.object({ locationId: uuid.optional(), productId: uuid.optional(), resourceId: uuid.optional() }).safeParse(request.query);
    if (!query.success) throw new ValidationHttpError('Invalid Availability Rule query.');
    return { ok: true, items: await listAvailabilityRules(query.data) };
  });

  app.post('/api/admin/availability-rules', async (request, reply) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'resources', 'manage');
    const body = ruleInputSchema.safeParse(request.body);
    if (!body.success) throw new ValidationHttpError('Invalid Availability Rule payload.');
    const rule = await createAvailabilityRule(body.data);
    if (!rule) throw new ValidationHttpError('Availability Rule scope is invalid or crosses Resource locations.');
    await recordAdminWriteAudit({ request, auth, action: 'admin.availability_rule.created', entityType: 'availability_rule', entityId: rule.ruleId });
    reply.code(201);
    return { ok: true, item: rule };
  });

  app.patch('/api/admin/availability-rules/:ruleId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'resources', 'manage');
    const params = z.object({ ruleId: uuid }).safeParse(request.params);
    const body = ruleInputSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new ValidationHttpError('Invalid Availability Rule update.');
    const rule = await updateAvailabilityRule(params.data.ruleId, body.data);
    if (!rule) throw new HttpError(404, 'Availability Rule not found or scope is invalid.');
    await recordAdminWriteAudit({ request, auth, action: 'admin.availability_rule.updated', entityType: 'availability_rule', entityId: rule.ruleId });
    return { ok: true, item: rule };
  });

  app.delete('/api/admin/availability-rules/:ruleId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'resources', 'manage');
    const params = z.object({ ruleId: uuid }).safeParse(request.params);
    if (!params.success) throw new ValidationHttpError('Invalid Availability Rule id.');
    if (!(await deleteAvailabilityRule(params.data.ruleId))) throw new HttpError(404, 'Availability Rule not found.');
    await recordAdminWriteAudit({ request, auth, action: 'admin.availability_rule.deleted', entityType: 'availability_rule', entityId: params.data.ruleId });
    return { ok: true };
  });
}
