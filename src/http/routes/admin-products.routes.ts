import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConflictHttpError, HttpError, ValidationHttpError } from '../errors.js';
import { type AdminFastifyRequest } from '../admin.js';
import { requireAdminPermission } from '../access-control.js';
import { recordAdminWriteAudit } from '../admin-audit.js';
import {
  deleteProductResourceMapping,
  addProductOffering,
  cloneAdminProduct,
  createAdminProduct,
  createProductOption,
  createProductVariant,
  deleteAdminProduct,
  deleteProductOption,
  deleteProductVariant,
  getAdminProduct,
  listLocationProducts,
  listAdminProducts,
  listRegiondoCatalogProducts,
  updateAdminProduct,
  removeProductOffering,
  prepareProductCoreMigration,
  updateProductOption,
  updateProductVariant,
  updateProductOffering,
  validateCoreProviderSwitch,
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
import {
  deleteOfferingResource,
  listOfferingResourceMigrationConflicts,
  listOfferingResources,
  upsertOfferingResource
} from '../../modules/products/product-offering-resource.repository.js';
import { getCatalogProductOffering } from '../../modules/catalog/catalog.repository.js';

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

const createProductSchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().nullable().optional(),
    imageUrl: z.string().url().nullable().optional(),
    baseAmount: z.number().int().nonnegative().safe(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/)
      .default('EUR'),
    vatBasisPoints: z.number().int().min(0).max(10_000)
  })
  .strict();

const productResourceSchema = z.object({
  resourceId: z.string().uuid(),
  quantity: z.number().int().positive()
});
const offeringResourceSchema = z.object({
  resourceId: z.string().uuid(),
  quantity: z.number().int().positive(),
  scalingMode: z.enum(['per_quantity', 'per_booking']).default('per_quantity')
});
const catalogParamsSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  optionId: z.string().uuid().optional()
});
const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/);
const allowedWeekdaysSchema = z
  .array(z.number().int().min(1).max(7))
  .min(1)
  .max(7)
  .refine((values) => new Set(values).size === values.length, 'Weekday values must be unique.')
  .nullable();
const createVariantSchema = z
  .object({
    title: z.string().trim().min(1).nullable().optional(),
    isDefault: z.boolean().optional().default(false),
    priceMinor: z.number().int().nonnegative().safe(),
    currency: currencySchema,
    durationOverrideMinutes: z.number().int().positive().nullable().optional(),
    active: z.boolean().optional(),
    scheduleRuleEnabled: z.boolean().optional(),
    allowedWeekdays: allowedWeekdaysSchema.optional(),
    localStartTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional(),
    localEndTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.isDefault && !value.title) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['title'],
        message: 'A named variant requires a title.'
      });
    }
    if ((value.localStartTime == null) !== (value.localEndTime == null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localStartTime'],
        message: 'Both schedule window times are required.'
      });
    }
  });
const updateVariantSchema = z
  .object({
    title: z.string().trim().min(1).nullable().optional(),
    isDefault: z.boolean().optional(),
    priceMinor: z.number().int().nonnegative().safe().optional(),
    currency: currencySchema.optional(),
    durationOverrideMinutes: z.number().int().positive().nullable().optional(),
    active: z.boolean().optional(),
    scheduleRuleEnabled: z.boolean().optional(),
    allowedWeekdays: allowedWeekdaysSchema.optional(),
    localStartTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional(),
    localEndTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (!Object.keys(value).length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one variant field is required.'
      });
    }
    const startProvided = value.localStartTime !== undefined;
    const endProvided = value.localEndTime !== undefined;
    if (startProvided !== endProvided) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localStartTime'],
        message: 'Update both schedule window times together.'
      });
    }
    if ((value.localStartTime === null) !== (value.localEndTime === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localStartTime'],
        message: 'Both schedule window times are required.'
      });
    }
  });
const createOptionSchema = z
  .object({
    title: z.string().trim().min(1),
    values: z.array(z.string().trim().min(1)).max(100).default([]),
    priceDeltaMinor: z.number().int().safe(),
    currency: currencySchema,
    durationDeltaMinutes: z
      .number()
      .int()
      .min(-7 * 24 * 60)
      .max(7 * 24 * 60)
      .default(0)
  })
  .strict();
const updateOptionSchema = createOptionSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one option field is required.'
});
const offeringParamsSchema = z.object({
  locationId: z.string().uuid(),
  productId: z.string().uuid()
});
const updateOfferingSchema = z
  .object({
    bookingProvider: z.enum(['core', 'regiondo']).optional(),
    regiondoProductId: z.string().trim().min(1).optional(),
    timeSelectionMode: z.enum(['date_range', 'start_end', 'start_duration', 'fixed_duration']).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    fixedStartTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional(),
    fixedEndTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional(),
    earliestStartTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional(),
    latestStartTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional(),
    startIntervalMinutes: z.number().int().min(1).max(1440).optional(),
    minParticipants: z.number().int().positive().optional(),
    maxParticipants: z.number().int().positive().optional(),
    minDurationMinutes: z.number().int().positive().nullable().optional(),
    maxDurationMinutes: z.number().int().positive().nullable().optional(),
    durationStepMinutes: z.number().int().positive().nullable().optional(),
    defaultDurationMinutes: z.number().int().positive().nullable().optional(),
    allowedDurationMinutes: z.array(z.number().int().positive()).max(100).nullable().optional(),
    minAdvanceMinutes: z.number().int().nonnegative().optional(),
    maxAdvanceDays: z.number().int().nonnegative().nullable().optional(),
    sameDayBookingAllowed: z.boolean().optional(),
    enabled: z.boolean().optional(),
    pricingMode: z.enum(['once', 'per_quantity', 'per_date_unit', 'per_date_unit_per_quantity']).optional(),
    dateRangeBillingUnit: z.enum(['nights', 'calendar_days']).optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one offering field is required.'
  });
const offeringResourceParamsSchema = z.object({
  offeringId: z.string().uuid(),
  resourceId: z.string().uuid().optional()
});
const availabilityQuerySchema = z
  .object({
    locationId: z.string().uuid(),
    variantId: z.string().uuid().optional(),
    start: z.string().datetime(),
    end: z.string().datetime(),
    quantity: z.coerce.number().int().positive().max(100).default(1)
  })
  .refine((value) => new Date(value.end) > new Date(value.start), {
    message: 'End must be after start.'
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

function throwCatalogMutationFailure(result: string): never {
  if (result === 'provider_managed') {
    throw new ConflictHttpError(
      'This catalog is managed by Regiondo and cannot be edited through Core catalog endpoints.',
      'PROVIDER_MANAGED_CATALOG'
    );
  }
  if (result === 'in_use') {
    throw new ConflictHttpError(
      'This variant is referenced by an existing booking or reservation and cannot be deleted. Historical snapshots were preserved.',
      'CATALOG_ENTITY_IN_USE'
    );
  }
  if (result === 'default_exists') {
    throw new ConflictHttpError('This product already has an internal default variant.', 'DEFAULT_VARIANT_EXISTS');
  }
  throw new HttpError(404, 'Catalog entity not found.');
}

export async function registerAdminProductRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/products', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'products', 'view');
    return { ok: true, items: await listAdminProducts() };
  });

  app.get('/api/admin/product-offerings/:offeringId/resources', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'products', 'view');
    const params = offeringResourceParamsSchema.safeParse(request.params);
    if (!params.success) throw new ValidationHttpError('Invalid Product Offering id.');
    const items = await listOfferingResources(params.data.offeringId);
    if (!items) throw new HttpError(404, 'Product Offering not found.');
    return { ok: true, items };
  });

  app.post('/api/admin/product-offerings/:offeringId/resources', async (request, reply) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const params = offeringResourceParamsSchema.safeParse(request.params);
    const body = offeringResourceSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new ValidationHttpError('Invalid Offering Resource payload.');
    const result = await upsertOfferingResource({
      offeringId: params.data.offeringId,
      ...body.data
    });
    if (result === 'offering_not_found' || result === 'resource_not_found') {
      throw new HttpError(404, result === 'offering_not_found' ? 'Product Offering not found.' : 'Resource not found.');
    }
    if (result === 'wrong_location') {
      throw new ConflictHttpError(
        'The Resource must belong to the same Location as the Product Offering.',
        'OFFERING_RESOURCE_LOCATION_MISMATCH'
      );
    }
    if (result === 'provider_managed_scaling') {
      throw new ConflictHttpError(
        'Per-booking Resource scaling is available only for Core-managed Product Offerings.',
        'CORE_RESOURCE_SCALING_REQUIRED'
      );
    }
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product_offering_resource.upserted',
      entityType: 'product_offering',
      entityId: params.data.offeringId,
      details: body.data as Record<string, unknown>
    });
    reply.code(201);
    return { ok: true, item: result };
  });

  app.patch('/api/admin/product-offerings/:offeringId/resources/:resourceId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const params = offeringResourceParamsSchema.safeParse(request.params);
    const body = z
      .object({
        quantity: z.number().int().positive().optional(),
        scalingMode: z.enum(['per_quantity', 'per_booking']).optional()
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, {
        message: 'At least one Offering Resource field is required.'
      })
      .safeParse(request.body);
    if (!params.success || !params.data.resourceId || !body.success) {
      throw new ValidationHttpError('Invalid Offering Resource update.');
    }
    const current = await listOfferingResources(params.data.offeringId);
    const existing = current?.find((item) => item.resourceId === params.data.resourceId);
    if (!existing) throw new HttpError(404, 'Offering Resource requirement not found.');
    const result = await upsertOfferingResource({
      offeringId: params.data.offeringId,
      resourceId: params.data.resourceId,
      quantity: body.data.quantity ?? existing.quantity,
      scalingMode: body.data.scalingMode
    });
    if (result === 'provider_managed_scaling') {
      throw new ConflictHttpError(
        'Per-booking Resource scaling is available only for Core-managed Product Offerings.',
        'CORE_RESOURCE_SCALING_REQUIRED'
      );
    }
    if (typeof result === 'string') throw new HttpError(404, 'Offering Resource requirement not found.');
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product_offering_resource.updated',
      entityType: 'product_offering',
      entityId: params.data.offeringId,
      details: { resourceId: params.data.resourceId, ...body.data }
    });
    return { ok: true, item: result };
  });

  app.delete('/api/admin/product-offerings/:offeringId/resources/:resourceId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const params = offeringResourceParamsSchema.safeParse(request.params);
    if (!params.success || !params.data.resourceId) throw new ValidationHttpError('Invalid Offering Resource ids.');
    if (!(await deleteOfferingResource(params.data.offeringId, params.data.resourceId))) {
      throw new HttpError(404, 'Offering Resource requirement not found.');
    }
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product_offering_resource.deleted',
      entityType: 'product_offering',
      entityId: params.data.offeringId,
      details: { resourceId: params.data.resourceId }
    });
    return { ok: true };
  });

  app.get('/api/admin/product-offering-resource-migration-conflicts', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    return {
      ok: true,
      items: await listOfferingResourceMigrationConflicts()
    };
  });

  app.post('/api/admin/products', async (request, reply) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const parsed = createProductSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationHttpError('Invalid product creation payload.');
    }

    const product = await createAdminProduct(parsed.data);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product.created',
      entityType: 'product',
      entityId: product.productId,
      details: {
        bookingProvider: product.bookingProvider,
        currency: product.currency,
        priceMinor: product.priceMinor
      }
    });

    reply.code(201);
    return { ok: true, item: product };
  });

  app.post('/api/admin/products/:productId/clone', async (request, reply) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const parsed = z.object({ productId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) throw new ValidationHttpError('Invalid product id.');

    const product = await cloneAdminProduct(parsed.data.productId);
    if (!product) throw new HttpError(404, 'Product not found.');

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product.cloned',
      entityType: 'product',
      entityId: product.productId,
      details: { sourceProductId: parsed.data.productId }
    });

    reply.code(201);
    return { ok: true, item: product };
  });

  app.delete('/api/admin/products/:productId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const parsed = z.object({ productId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) throw new ValidationHttpError('Invalid product id.');

    const result = await deleteAdminProduct(parsed.data.productId);
    if (result === 'not_found') throw new HttpError(404, 'Product not found.');
    if (result === 'in_use') {
      throw new ConflictHttpError(
        'This product is referenced by booking history and cannot be deleted.',
        'PRODUCT_IN_USE'
      );
    }

    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product.deleted',
      entityType: 'product',
      entityId: parsed.data.productId,
      details: {}
    });

    return { ok: true };
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
    return {
      ok: true,
      items: await listLocationProducts(parsed.data.locationId)
    };
  });

  app.get('/api/admin/locations/:locationId/products/:productId/booking-configuration', async (request) => {
    await requireAdminPermission(request as AdminFastifyRequest, 'bookings', 'create');
    const parsed = offeringParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new ValidationHttpError('Invalid product offering ids.');
    const product = await getCatalogProductOffering(parsed.data.productId, parsed.data.locationId);
    if (!product) throw new HttpError(404, 'Product offering not found.');
    return {
      ok: true,
      item: {
        id: product.id,
        title: product.title,
        price: product.price,
        variants: product.variants,
        offering: product.offering,
        bookingConfiguration: product.bookingConfiguration
      }
    };
  });

  app.post('/api/admin/locations/:locationId/products/:productId', async (request, reply) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const parsed = offeringParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new ValidationHttpError('Invalid product offering ids.');
    const product = await addProductOffering(parsed.data.locationId, parsed.data.productId);
    if (!product) throw new HttpError(404, 'Location or product not found.');
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product_offering.created',
      entityType: 'product',
      entityId: parsed.data.productId,
      details: { locationId: parsed.data.locationId }
    });
    reply.code(201);
    return { ok: true, item: product };
  });

  app.patch('/api/admin/locations/:locationId/products/:productId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const params = offeringParamsSchema.safeParse(request.params);
    const body = updateOfferingSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new ValidationHttpError('Invalid product offering payload.');
    const product = await updateProductOffering(params.data.locationId, params.data.productId, body.data);
    if (!product) throw new HttpError(404, 'Product offering not found.');
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product_offering.updated',
      entityType: 'product',
      entityId: params.data.productId,
      details: { locationId: params.data.locationId, ...body.data }
    });
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
      request,
      auth,
      action: 'admin.product_offering.deleted',
      entityType: 'product',
      entityId: parsed.data.productId,
      details: { locationId: parsed.data.locationId }
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
    const offering = product.locations.find((item) => item.locationId === parsed.data.locationId && item.enabled);
    if (!offering) throw new HttpError(404, 'Product Offering not found.');
    if (offering.bookingProvider !== 'core') {
      throw new ValidationHttpError('Admin availability diagnostics currently support Core products only.');
    }
    return getAvailabilitySummary({
      product_id: productId,
      product_variant_id: parsed.data.variantId,
      location_id: parsed.data.locationId,
      dt_from: parsed.data.start,
      dt_to: parsed.data.end,
      guest_count: parsed.data.quantity,
      max_quantity: offering.maxParticipants
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
      throw new ValidationHttpError(
        'A product must have a Regiondo reference before it can use the Regiondo provider.'
      );
    }
    if (currentProduct?.bookingProvider === 'regiondo' && parsed.data.bookingProvider === 'core') {
      const validation = await validateCoreProviderSwitch(productId);
      if (!validation.valid) {
        throw new ConflictHttpError(
          `The Core catalog is not ready: ${validation.issues.join(' ')}`,
          'CORE_CATALOG_NOT_READY'
        );
      }
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

  app.post('/api/admin/products/:productId/variants', async (request, reply) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const params = catalogParamsSchema.safeParse(request.params);
    const body = createVariantSchema.safeParse(request.body);
    if (!params.success || !body.success) throw new ValidationHttpError('Invalid variant creation payload.');
    const product = await getAdminProduct(params.data.productId);
    if (!product) throw new HttpError(404, 'Product not found.');
    if (body.data.currency !== product.currency) {
      throw new ValidationHttpError('Variant currency must match the Product currency.');
    }
    const result = await createProductVariant(params.data.productId, {
      title: body.data.isDefault ? null : (body.data.title ?? null),
      priceMinor: body.data.priceMinor,
      currency: body.data.currency,
      ...(body.data.durationOverrideMinutes !== undefined
        ? { durationOverrideMinutes: body.data.durationOverrideMinutes }
        : {}),
      ...(body.data.active !== undefined ? { active: body.data.active } : {}),
      ...(body.data.scheduleRuleEnabled !== undefined ? { scheduleRuleEnabled: body.data.scheduleRuleEnabled } : {}),
      ...(body.data.allowedWeekdays !== undefined ? { allowedWeekdays: body.data.allowedWeekdays } : {}),
      ...(body.data.localStartTime !== undefined ? { localStartTime: body.data.localStartTime } : {}),
      ...(body.data.localEndTime !== undefined ? { localEndTime: body.data.localEndTime } : {})
    });
    if (typeof result === 'string') throwCatalogMutationFailure(result);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product_variant.created',
      entityType: 'product_variant',
      entityId: result.variantId,
      details: {
        productId: params.data.productId,
        isDefault: result.isDefault
      }
    });
    reply.code(201);
    return { ok: true, item: await getAdminProduct(params.data.productId) };
  });

  app.patch('/api/admin/products/:productId/variants/:variantId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const params = catalogParamsSchema.safeParse(request.params);
    const body = updateVariantSchema.safeParse(request.body);
    if (!params.success || !params.data.variantId || !body.success) {
      throw new ValidationHttpError('Invalid variant update payload.');
    }
    const product = await getAdminProduct(params.data.productId);
    if (!product) throw new HttpError(404, 'Product not found.');
    if (body.data.currency && body.data.currency !== product.currency) {
      throw new ValidationHttpError('Variant currency must match the Product currency.');
    }
    const title =
      body.data.isDefault === true
        ? null
        : body.data.isDefault === false && body.data.title === undefined
          ? undefined
          : body.data.title;
    const result = await updateProductVariant(params.data.productId, params.data.variantId, {
      ...(title !== undefined ? { title } : {}),
      ...(body.data.priceMinor !== undefined ? { priceMinor: body.data.priceMinor } : {}),
      ...(body.data.currency !== undefined ? { currency: body.data.currency } : {}),
      ...(body.data.durationOverrideMinutes !== undefined
        ? { durationOverrideMinutes: body.data.durationOverrideMinutes }
        : {}),
      ...(body.data.active !== undefined ? { active: body.data.active } : {}),
      ...(body.data.scheduleRuleEnabled !== undefined ? { scheduleRuleEnabled: body.data.scheduleRuleEnabled } : {}),
      ...(body.data.allowedWeekdays !== undefined ? { allowedWeekdays: body.data.allowedWeekdays } : {}),
      ...(body.data.localStartTime !== undefined ? { localStartTime: body.data.localStartTime } : {}),
      ...(body.data.localEndTime !== undefined ? { localEndTime: body.data.localEndTime } : {})
    });
    if (typeof result === 'string') throwCatalogMutationFailure(result);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product_variant.updated',
      entityType: 'product_variant',
      entityId: result.variantId,
      details: { productId: params.data.productId }
    });
    return { ok: true, item: await getAdminProduct(params.data.productId) };
  });

  app.delete('/api/admin/products/:productId/variants/:variantId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const params = catalogParamsSchema.safeParse(request.params);
    if (!params.success || !params.data.variantId) throw new ValidationHttpError('Invalid variant ids.');
    const result = await deleteProductVariant(params.data.productId, params.data.variantId);
    if (result !== 'deleted') throwCatalogMutationFailure(result);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product_variant.deleted',
      entityType: 'product_variant',
      entityId: params.data.variantId,
      details: { productId: params.data.productId }
    });
    return { ok: true };
  });

  app.post('/api/admin/products/:productId/variants/:variantId/options', async (request, reply) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const params = catalogParamsSchema.safeParse(request.params);
    const body = createOptionSchema.safeParse(request.body);
    if (!params.success || !params.data.variantId || !body.success) {
      throw new ValidationHttpError('Invalid option creation payload.');
    }
    const product = await getAdminProduct(params.data.productId);
    if (!product) throw new HttpError(404, 'Product not found.');
    if (body.data.currency !== product.currency) {
      throw new ValidationHttpError('Option currency must match the Product currency.');
    }
    const values = [...new Set(body.data.values.map((value) => value.trim()))];
    const result = await createProductOption(params.data.productId, params.data.variantId, { ...body.data, values });
    if (typeof result === 'string') throwCatalogMutationFailure(result);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product_option.created',
      entityType: 'product_option',
      entityId: result.optionId,
      details: {
        productId: params.data.productId,
        variantId: params.data.variantId
      }
    });
    reply.code(201);
    return { ok: true, item: await getAdminProduct(params.data.productId) };
  });

  app.patch('/api/admin/products/:productId/variants/:variantId/options/:optionId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const params = catalogParamsSchema.safeParse(request.params);
    const body = updateOptionSchema.safeParse(request.body);
    if (!params.success || !params.data.variantId || !params.data.optionId || !body.success) {
      throw new ValidationHttpError('Invalid option update payload.');
    }
    const product = await getAdminProduct(params.data.productId);
    if (!product) throw new HttpError(404, 'Product not found.');
    if (body.data.currency && body.data.currency !== product.currency) {
      throw new ValidationHttpError('Option currency must match the Product currency.');
    }
    const result = await updateProductOption(params.data.productId, params.data.variantId, params.data.optionId, {
      ...body.data,
      ...(body.data.values
        ? {
            values: [...new Set(body.data.values.map((value) => value.trim()))]
          }
        : {})
    });
    if (typeof result === 'string') throwCatalogMutationFailure(result);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product_option.updated',
      entityType: 'product_option',
      entityId: result.optionId,
      details: {
        productId: params.data.productId,
        variantId: params.data.variantId
      }
    });
    return { ok: true, item: await getAdminProduct(params.data.productId) };
  });

  app.delete('/api/admin/products/:productId/variants/:variantId/options/:optionId', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const params = catalogParamsSchema.safeParse(request.params);
    if (!params.success || !params.data.variantId || !params.data.optionId) {
      throw new ValidationHttpError('Invalid option ids.');
    }
    const result = await deleteProductOption(params.data.productId, params.data.variantId, params.data.optionId);
    if (result !== 'deleted') throwCatalogMutationFailure(result);
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product_option.deleted',
      entityType: 'product_option',
      entityId: params.data.optionId,
      details: {
        productId: params.data.productId,
        variantId: params.data.variantId
      }
    });
    return { ok: true };
  });

  app.post('/api/admin/products/:productId/core-migration/prepare', async (request) => {
    const { auth } = await requireAdminPermission(request as AdminFastifyRequest, 'products', 'manage');
    const params = catalogParamsSchema.safeParse(request.params);
    if (!params.success) throw new ValidationHttpError('Invalid product id.');
    const result = await prepareProductCoreMigration(params.data.productId);
    if (typeof result === 'string') {
      if (result === 'provider_managed') {
        throw new ConflictHttpError('Only an active Regiondo product can prepare a Core migration snapshot.');
      }
      throw new HttpError(404, 'Product or Regiondo variants not found.');
    }
    await recordAdminWriteAudit({
      request,
      auth,
      action: 'admin.product.core_migration_prepared',
      entityType: 'product',
      entityId: params.data.productId,
      details: {
        policy: 'prepare_once',
        variantCount: result.coreMigration?.variantCount ?? 0
      }
    });
    return { ok: true, item: result };
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
    const { productId, resourceId } = request.params as {
      productId: string;
      resourceId: string;
    };
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
