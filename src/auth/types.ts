export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  canAccessDashboard: boolean;
  passwordHash: string | null;
  lastLoginAt: string | null;
}

export type AdminAuthUser = Pick<
  AdminUser,
  'id' | 'email' | 'displayName' | 'role' | 'isActive' | 'canAccessDashboard' | 'lastLoginAt'
>;

export interface AuthenticatedAdmin {
  user: AdminUser;
  sessionId: string;
}

export interface AdminAccessTokenPayload {
  type: 'access';
  sub: string;
  sid: string;
  email: string;
  name: string;
  role: string;
  iat: number;
  exp: number;
}

export interface AdminAuditEvent {
  actorUserId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown>;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}
