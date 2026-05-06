import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAvailability } from '../../modules/resources/availability.service.js';
import { getAdminResource, listAdminResources } from '../../modules/resources/resource-admin.repository.js';
import { type AdminFastifyRequest } from '../admin.js';
import { requireAdminPermission } from '../access-control.js';
import { HttpError, ValidationHttpError } from '../errors.js';

const availabilityQuerySchema = z.object({
  location_id: z.string().uuid().optional(),
  product_id: z.string().uuid().optional(),
  dt_from: z.string().datetime(),
  dt_to: z.string().datetime(),
  guest_count: z.coerce.number().int().positive().default(1)
});

export async function registerAdminResourceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/resources', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'resources', 'view');
    const query = request.query as { location_id?: string };
    return {
      ok: true,
      items: await listAdminResources(query.location_id)
    };
  });

  app.get('/api/admin/resources/:resourceId', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'resources', 'view');
    const { resourceId } = request.params as { resourceId: string };
    const resource = await getAdminResource(resourceId);
    if (!resource) {
      reply404();
    }

    return {
      ok: true,
      item: resource
    };
  });

  app.get('/api/admin/availability', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'resources', 'view');
    const parsed = availabilityQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid availability query.');
    }

    return {
      ok: true,
      items: await getAvailability(parsed.data)
    };
  });
}

function reply404(): never {
  throw new HttpError(404, 'Resource not found.');
}
