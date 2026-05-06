import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, ValidationHttpError } from '../errors.js';
import { type AdminFastifyRequest } from '../admin.js';
import { requireAdminPermission } from '../access-control.js';
import { recordAdminWriteAudit } from '../admin-audit.js';
import {
  deleteProductResourceMapping,
  getAdminProduct,
  listAdminProducts,
  listRegiondoCatalogProducts,
  updateAdminProduct,
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

const updateProductSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    imageUrl: z.string().nullable().optional(),
    baseAmount: z.number().nonnegative().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one product field must be provided.'
  });

const productResourceSchema = z.object({
  resourceId: z.string().uuid(),
  quantity: z.number().int().positive()
});

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

  app.patch('/api/admin/products/:productId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'update');
    const parsed = updateProductSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid product update payload.');
    }

    const { productId } = request.params as { productId: string };
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

    await upsertProductResourceMapping({
      productId,
      resourceId: parsed.data.resourceId,
      quantity: parsed.data.quantity
    });

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
