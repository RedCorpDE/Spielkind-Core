import { buildAccessContextForUser } from '../access-control/repository.js';
import {
  hasRoutePermission,
  type AccessContext,
  type PermissionAction,
  type PermissionResource
} from '../access-control/model.js';
import { type AdminFastifyRequest, requireAdminAuth } from './admin.js';
import { ForbiddenHttpError } from './errors.js';

function formatPermissionMessage(resource: PermissionResource, action: PermissionAction): string {
  return `You do not have permission to ${action} ${resource.replace(/_/g, ' ')}.`;
}

export async function getAdminAccessContext(request: AdminFastifyRequest): Promise<AccessContext> {
  if (request.adminAccessContext) {
    return request.adminAccessContext;
  }

  const auth = await requireAdminAuth(request);
  const accessContext = await buildAccessContextForUser({
    id: auth.user.id,
    role: auth.user.role
  });

  request.adminAccessContext = accessContext;
  return accessContext;
}

export async function requireAdminPermission(
  request: AdminFastifyRequest,
  resource: PermissionResource,
  action: PermissionAction
) {
  const auth = await requireAdminAuth(request);
  const accessContext = await getAdminAccessContext(request);

  if (!hasRoutePermission(accessContext.permissions, resource, action)) {
    throw new ForbiddenHttpError(formatPermissionMessage(resource, action));
  }

  return {
    accessContext,
    auth
  };
}
