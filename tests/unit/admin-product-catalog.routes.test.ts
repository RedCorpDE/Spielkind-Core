import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';

const productId = '11111111-1111-1111-1111-111111111111';
const variantId = '22222222-2222-2222-2222-222222222222';
const optionId = '33333333-3333-3333-3333-333333333333';
const userId = '44444444-4444-4444-4444-444444444444';

const mocks = vi.hoisted(() => ({
  buildAccessContextForUser: vi.fn(),
  createProductVariant: vi.fn(),
  deleteProductOption: vi.fn(),
  findAuthenticatedAdminBySession: vi.fn(),
  getAdminProduct: vi.fn(),
  prepareProductCoreMigration: vi.fn(),
  recordAdminAuditEvent: vi.fn(),
  verifyAccessToken: vi.fn()
}));

vi.mock('../../src/auth/tokens.js', () => ({
  AdminAccessTokenError: class AdminAccessTokenError extends Error {},
  createAccessToken: vi.fn(), createRefreshToken: vi.fn(), verifyAccessToken: mocks.verifyAccessToken
}));
vi.mock('../../src/auth/repository.js', () => ({
  createAdminSession: vi.fn(), findAdminUserByEmail: vi.fn(), findAuthenticatedAdminByRefreshToken: vi.fn(),
  findAuthenticatedAdminBySession: mocks.findAuthenticatedAdminBySession,
  recordAdminAuditEvent: mocks.recordAdminAuditEvent, revokeAdminSession: vi.fn(), rotateAdminSession: vi.fn(), updateAdminLastLogin: vi.fn()
}));
vi.mock('../../src/access-control/repository.js', () => ({
  buildAccessContextForUser: mocks.buildAccessContextForUser, listRoleMatrix: vi.fn(), replaceRolePermissions: vi.fn()
}));
vi.mock('../../src/modules/products/product-admin.repository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/modules/products/product-admin.repository.js')>()),
  createProductVariant: mocks.createProductVariant,
  deleteProductOption: mocks.deleteProductOption,
  getAdminProduct: mocks.getAdminProduct,
  prepareProductCoreMigration: mocks.prepareProductCoreMigration
}));

const coreProduct = {
  productId, title: 'LAN Session', description: null, imageUrl: null, baseAmount: 20,
  bookingProvider: 'core' as const, priceMinor: 2000, currency: 'EUR', vatBasisPoints: 1900,
  regiondoProductId: null, regiondoCatalog: { options: [], variations: [] }, rawJson: null,
  resources: [], locations: [], variants: [], coreMigration: null
};
const regiondoProduct = {
  ...coreProduct,
  bookingProvider: 'regiondo' as const,
  regiondoProductId: 'regiondo-product',
  coreMigration: { status: 'not_prepared' as const, variantCount: 0, optionCount: 0, preparedAt: null, policy: 'prepare_once' as const }
};

describe('admin native catalog routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyAccessToken.mockReturnValue({
      email: 'admin@example.com', exp: 1_899_999_999, iat: 1_800_000_000,
      name: 'Admin', role: 'Custom', sid: 'session-1', sub: userId, type: 'access'
    });
    mocks.findAuthenticatedAdminBySession.mockResolvedValue({
      sessionId: 'session-1',
      user: { canAccessDashboard: true, displayName: 'Admin', email: 'admin@example.com', id: userId, isActive: true, lastLoginAt: null, passwordHash: null, role: 'Custom' }
    });
    mocks.buildAccessContextForUser.mockResolvedValue({
      permissions: [{ action: 'manage', resource: 'products', scope: 'all' }],
      roleKey: 'custom', roleName: 'Custom', userId, userLocationIds: []
    });
    mocks.recordAdminAuditEvent.mockResolvedValue(undefined);
    mocks.getAdminProduct.mockResolvedValue(coreProduct);
  });

  it('creates a Core variant in authoritative minor units', async () => {
    mocks.createProductVariant.mockResolvedValue({
      variantId, title: '8 Hours', priceMinor: 3500, currency: 'EUR', isDefault: false, providerManaged: false, options: []
    });
    const { createApp } = await import('../../src/app.js');
    const app = createApp();
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer test-token' }, method: 'POST',
        payload: { title: '8 Hours', priceMinor: 3500, currency: 'EUR' },
        url: `/api/admin/products/${productId}/variants`
      });
      expect(response.statusCode).toBe(201);
      expect(mocks.createProductVariant).toHaveBeenCalledWith(productId, {
        title: '8 Hours', priceMinor: 3500, currency: 'EUR'
      });
    } finally { await app.close(); }
  });

  it('rejects Core mutation endpoints for a Regiondo-managed Product', async () => {
    mocks.getAdminProduct.mockResolvedValue(regiondoProduct);
    mocks.createProductVariant.mockResolvedValue('provider_managed');
    const { createApp } = await import('../../src/app.js');
    const app = createApp();
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer test-token' }, method: 'POST',
        payload: { title: '8 Hours', priceMinor: 3500, currency: 'EUR' },
        url: `/api/admin/products/${productId}/variants`
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: 'This catalog is managed by Regiondo and cannot be edited through Core catalog endpoints.'
      });
    } finally { await app.close(); }
  });

  it('rejects an option id that does not belong to the requested Product and Variant', async () => {
    mocks.deleteProductOption.mockResolvedValue('not_found');
    const { createApp } = await import('../../src/app.js');
    const app = createApp();
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer test-token' }, method: 'DELETE',
        url: `/api/admin/products/${productId}/variants/${variantId}/options/${optionId}`
      });
      expect(response.statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it('rejects invalid fractional minor-unit prices before repository access', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = createApp();
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer test-token' }, method: 'POST',
        payload: { title: 'Invalid', priceMinor: 10.5, currency: 'EUR' },
        url: `/api/admin/products/${productId}/variants`
      });
      expect(response.statusCode).toBe(400);
      expect(mocks.createProductVariant).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('prepares a Core snapshot without switching the active provider', async () => {
    const prepared = {
      ...regiondoProduct,
      variants: [{ variantId, title: '8 Hours', priceMinor: 3500, currency: 'EUR', isDefault: false, providerManaged: false, options: [] }],
      coreMigration: { status: 'prepared' as const, variantCount: 1, optionCount: 0, preparedAt: '2026-09-28T10:00:00.000Z', policy: 'prepare_once' as const }
    };
    mocks.prepareProductCoreMigration.mockResolvedValue(prepared);
    const { createApp } = await import('../../src/app.js');
    const app = createApp();
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer test-token' }, method: 'POST',
        url: `/api/admin/products/${productId}/core-migration/prepare`
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().item).toMatchObject({ bookingProvider: 'regiondo' });
    } finally { await app.close(); }
  });
});

