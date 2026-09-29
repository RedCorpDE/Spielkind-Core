import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';

const productId = '11111111-1111-1111-1111-111111111111';
const userId = '22222222-2222-2222-2222-222222222222';

const {
  buildAccessContextForUserMock,
  createAdminProductMock,
  findAuthenticatedAdminBySessionMock,
  recordAdminAuditEventMock,
  verifyAccessTokenMock
} = vi.hoisted(() => ({
  buildAccessContextForUserMock: vi.fn(),
  createAdminProductMock: vi.fn(),
  findAuthenticatedAdminBySessionMock: vi.fn(),
  recordAdminAuditEventMock: vi.fn(),
  verifyAccessTokenMock: vi.fn()
}));

vi.mock('../../src/auth/tokens.js', () => ({
  AdminAccessTokenError: class AdminAccessTokenError extends Error {},
  createAccessToken: vi.fn(),
  createRefreshToken: vi.fn(),
  verifyAccessToken: verifyAccessTokenMock
}));

vi.mock('../../src/auth/repository.js', () => ({
  createAdminSession: vi.fn(),
  findAdminUserByEmail: vi.fn(),
  findAuthenticatedAdminByRefreshToken: vi.fn(),
  findAuthenticatedAdminBySession: findAuthenticatedAdminBySessionMock,
  recordAdminAuditEvent: recordAdminAuditEventMock,
  revokeAdminSession: vi.fn(),
  rotateAdminSession: vi.fn(),
  updateAdminLastLogin: vi.fn()
}));

vi.mock('../../src/access-control/repository.js', () => ({
  buildAccessContextForUser: buildAccessContextForUserMock,
  listRoleMatrix: vi.fn(),
  replaceRolePermissions: vi.fn()
}));

vi.mock('../../src/modules/products/product-admin.repository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/modules/products/product-admin.repository.js')>()),
  createAdminProduct: createAdminProductMock
}));

const createdProduct = {
  productId,
  title: 'Escape Room',
  description: null,
  imageUrl: null,
  baseAmount: 20,
  bookingProvider: 'core',
  priceMinor: 2000,
  currency: 'EUR',
  vatBasisPoints: 1900,
  regiondoProductId: null,
  regiondoCatalog: { options: [], variations: [] },
  rawJson: null,
  resources: [],
  locations: []
};

describe('POST /api/admin/products', () => {
  beforeEach(() => {
    verifyAccessTokenMock.mockReset().mockReturnValue({
      email: 'admin@example.com', exp: 1_899_999_999, iat: 1_800_000_000,
      name: 'Admin', role: 'Custom', sid: 'session-1', sub: userId, type: 'access'
    });
    findAuthenticatedAdminBySessionMock.mockReset().mockResolvedValue({
      sessionId: 'session-1',
      user: { canAccessDashboard: true, displayName: 'Admin', email: 'admin@example.com', id: userId, isActive: true, lastLoginAt: null, passwordHash: null, role: 'Custom' }
    });
    buildAccessContextForUserMock.mockReset().mockResolvedValue({
      permissions: [{ action: 'manage', resource: 'products', scope: 'all' }],
      roleKey: 'custom', roleName: 'Custom', userId, userLocationIds: []
    });
    createAdminProductMock.mockReset().mockResolvedValue(createdProduct);
    recordAdminAuditEventMock.mockReset().mockResolvedValue(undefined);
  });

  it('creates and returns a Core-native product', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = createApp();
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer test-token' },
        method: 'POST',
        payload: { title: ' Escape Room ', baseAmount: 2000, currency: 'eur', vatBasisPoints: 1900 },
        url: '/api/admin/products'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().item).toMatchObject({ bookingProvider: 'core', regiondoProductId: null });
      expect(createAdminProductMock).toHaveBeenCalledWith({
        title: 'Escape Room', baseAmount: 2000, currency: 'EUR', vatBasisPoints: 1900
      });
      expect(recordAdminAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
        action: 'admin.product.created', entityId: productId, entityType: 'product'
      }));
    } finally {
      await app.close();
    }
  });

  it.each([
    { title: ' ', baseAmount: 2000, vatBasisPoints: 1900 },
    { title: 'Invalid price', baseAmount: 20.5, vatBasisPoints: 1900 },
    { title: 'Invalid VAT', baseAmount: 2000, vatBasisPoints: 10001 },
    { title: 'Provider injection', baseAmount: 2000, vatBasisPoints: 1900, bookingProvider: 'regiondo' }
  ])('rejects invalid or provider-controlled input %#', async (payload) => {
    const { createApp } = await import('../../src/app.js');
    const app = createApp();
    try {
      const response = await app.inject({
        headers: { authorization: 'Bearer test-token' }, method: 'POST', payload, url: '/api/admin/products'
      });
      expect(response.statusCode).toBe(400);
      expect(createAdminProductMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
