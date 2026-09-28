import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, ValidationHttpError } from '../errors.js';
import { type AdminFastifyRequest } from '../admin.js';
import { requireAdminPermission } from '../access-control.js';
import { recordAdminWriteAudit } from '../admin-audit.js';
import {
  deleteProductResourceMapping,
  addProductOffering,
  getAdminProduct,
  listLocationProducts,
  listAdminProducts,
  listRegiondoCatalogProducts,
  updateAdminProduct,
  removeProductOffering,
  upsertProductResourceMapping
} from '../../modules/products/product-admin.repository.js';
import { runRegiondoCatalogSyncJob } from '../../modules/regiondo/regiondo-catalog-sync.job.js';
import {
  RegiondoApiError,
  RegiondoAuthError,
  RegiondoRateLimitError,
  RegiondoTransientError
} from '../../modules/regiondo/regiondo.client.js';
import { RegiondoCatalogSyncError } from '../../modules/regiondo/regiondo-catalog.errors.js';
import { getAvailabilitySummary } from '../../modules/resources/availability.service.js';

const updateProductSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    imageUrl: z.string().nullable().optional(),
    baseAmount: z.number().nonnegative().optional(),
    bookingProvider: z.enum(['core', 'regiondo']).optional(),
    vatBasisPoints: z.number().int().min(0).max(10_000).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one product field must be provided.'
  });

const productResourceSchema = z.object({
  resourceId: z.string().uuid(),
  quantity: z.number().int().positive()
});
const offeringParamsSchema = z.object({
  locationId: z.string().uuid(),
  productId: z.string().uuid()
});
const availabilityQuerySchema = z.object({
  locationId: z.string().uuid(),
  start: z.string().datetime(),
  end: z.string().datetime(),
  quantity: z.coerce.number().int().positive().max(100).default(1)
}).refine((value) => new Date(value.end) > new Date(value.start), { message: 'End must be after start.' });

function getRegiondoSyncStatusCode(error: RegiondoApiError): number {
  if (error instanceof RegiondoRateLimitError) {
    return 429;
  }

  if (error instanceof RegiondoTransientError) {
    return 503;
  }

  if (error instanceof RegiondoAuthError) {
    return 502;
  }

  return 502;
}

export async function registerAdminProductRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/products', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'products', 'view');
    return { ok: true, items: await listAdminProducts() };
  });

  app.get('/api/admin/products/:productId', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'products', 'view');
    const { productId } = request.params as { productId: string };
    const product = await getAdminProduct(productId);
    if (!product) {
      throw new HttpError(404, 'Product not found.');
    }

    return { ok: true, item: product };
  });

  app.get('/api/admin/locations/:locationId/products', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'products', 'view');
    const parsed = z.object({ locationId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) throw new ValidationHttpError('Invalid location id.');
    return { ok: true, items: await listLocationProducts(parsed.data.locationId) };
  });

  app.post('/api/admin/locations/:locationId/products/:productId', async (request, reply) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const parsed = offeringParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new ValidationHttpError('Invalid product offering ids.');
    const product = await addProductOffering(parsed.data.locationId, parsed.data.productId);
    if (!product) throw new HttpError(404, 'Location or product not found.');
    await recordAdminWriteAudit({
      request, auth, action: 'admin.product_offering.created', entityType: 'product',
      entityId: parsed.data.productId, details: { locationId: parsed.data.locationId }
    });
    reply.code(201);
    return { ok: true, item: product };
  });

  app.delete('/api/admin/locations/:locationId/products/:productId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const parsed = offeringParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new ValidationHttpError('Invalid product offering ids.');
    const removal = await removeProductOffering(parsed.data.locationId, parsed.data.productId);
    if (removal === 'not_found') {
      throw new HttpError(404, 'Product offering not found.');
    }
    if (removal === 'in_use') {
      throw new ValidationHttpError(
        'Remove active bookings and location resource mappings before removing this product offering.'
      );
    }
    await recordAdminWriteAudit({
      request, auth, action: 'admin.product_offering.deleted', entityType: 'product',
      entityId: parsed.data.productId, details: { locationId: parsed.data.locationId }
    });
    return { ok: true };
  });

  app.get('/api/admin/products/:productId/availability', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'products', 'view');
    const { productId } = request.params as { productId: string };
    const parsed = availabilityQuerySchema.safeParse(request.query);
    if (!parsed.success) throw new ValidationHttpError('Invalid availability query.');
    const product = await getAdminProduct(productId);
    if (!product) throw new HttpError(404, 'Product not found.');
    if (product.bookingProvider !== 'core') {
      throw new ValidationHttpError('Admin availability diagnostics currently support Core products only.');
    }
    return getAvailabilitySummary({
      product_id: productId,
      location_id: parsed.data.locationId,
      dt_from: parsed.data.start,
      dt_to: parsed.data.end,
      guest_count: parsed.data.quantity
    });
  });

  app.patch('/api/admin/products/:productId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'update');
    const parsed = updateProductSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid product update payload.');
    }

    const { productId } = request.params as { productId: string };
    const currentProduct = await getAdminProduct(productId);
    if (parsed.data.bookingProvider === 'regiondo' && !currentProduct?.regiondoProductId) {
      throw new ValidationHttpError('A product must have a Regiondo reference before it can use the Regiondo provider.');
    }
    const product = await updateAdminProduct(productId, parsed.data);
    if (!product) {
      throw new HttpError(404, 'Product not found.');
    }

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product.updated',
      entityType: 'product',
      entityId: product.productId,
      details: parsed.data as Record<string, unknown>
    });

    return { ok: true, item: product };
  });

  app.post('/api/admin/products/:productId/resources', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const parsed = productResourceSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid product resource mapping payload.');
    }

    const { productId } = request.params as { productId: string };
    const product = await getAdminProduct(productId);
    if (!product) {
      throw new HttpError(404, 'Product not found.');
    }

    const mapped = await upsertProductResourceMapping({
      productId,
      resourceId: parsed.data.resourceId,
      quantity: parsed.data.quantity
    });
    if (!mapped) {
      throw new ValidationHttpError('The resource must belong to a location where this product is offered.');
    }

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product_resource.upserted',
      entityType: 'product',
      entityId: productId,
      details: parsed.data as Record<string, unknown>
    });

    return { ok: true, item: await getAdminProduct(productId) };
  });

  app.delete('/api/admin/products/:productId/resources/:resourceId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const { productId, resourceId } = request.params as { productId: string; resourceId: string };
    const deleted = await deleteProductResourceMapping(productId, resourceId);
    if (!deleted) {
      throw new HttpError(404, 'Product resource mapping not found.');
    }

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product_resource.deleted',
      entityType: 'product',
      entityId: productId,
      details: { resourceId }
    });

    return { ok: true };
  });

  app.get('/api/admin/regiondo/products', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'products', 'view');
    return { ok: true, items: await listRegiondoCatalogProducts() };
  });

  app.post('/api/admin/regiondo/sync-products', async (request, reply) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'regiondo', 'manage');

    try {
      const result = await runRegiondoCatalogSyncJob();

      await recordAdminWriteAudit({
        request,
        auth,
        action: 'admin.regiondo.sync_products',
        entityType: 'sync',
        details: result.metadata
      });

      return { ok: true, job: result };
    } catch (error) {
      if (error instanceof RegiondoCatalogSyncError) {
        return reply.status(error.statusCode).send({
          ok: false,
          error: error.message,
          ...(error.details ? { details: error.details } : {})
        });
      }

      if (error instanceof RegiondoApiError) {
        const details = error.responseBody?.trim();

        return reply.status(getRegiondoSyncStatusCode(error)).send({
          ok: false,
          error: error.message,
          ...(details ? { details } : {})
        });
      }

      throw error;
    }
  });
}
