export const ALL_PERMISSION_ACTIONS = ['view', 'create', 'update', 'delete', 'manage', 'export'] as const;
export const ALL_PERMISSION_SCOPES = ['none', 'own', 'location', 'all'] as const;

export type PermissionAction = (typeof ALL_PERMISSION_ACTIONS)[number];
export type PermissionScope = (typeof ALL_PERMISSION_SCOPES)[number];
export type PermissionResource =
  | 'dashboard'
  | 'settings'
  | 'tasks'
  | 'task_columns'
  | 'locations'
  | 'bookings'
  | 'products'
  | 'messages'
  | 'users'
  | 'roles'
  | 'customers'
  | 'client_groups'
  | 'resources'
  | 'regiondo';

export interface PermissionDefinition {
  resource: PermissionResource;
  label: string;
  description: string;
  actions: PermissionAction[];
}

export interface AccessRole {
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
}

export interface RolePermission {
  roleKey: string;
  resource: PermissionResource;
  action: PermissionAction;
  scope: PermissionScope;
}

export interface ResolvedPermission {
  resource: PermissionResource;
  action: PermissionAction;
  scope: PermissionScope;
}

export interface AccessContext {
  userId: string;
  roleKey: string | null;
  roleName: string;
  userLocationIds: string[];
  permissions: ResolvedPermission[];
}

export interface RecordAccessTarget {
  ownerUserId?: string | null;
  locationId?: string | null;
}

type PermissionGrant = {
  action: PermissionAction;
  resource: PermissionResource;
  scope: PermissionScope;
};

type PermissionGrantMap = Partial<Record<PermissionAction, PermissionScope>>;

export const permissionDefinitions: PermissionDefinition[] = [
  {
    resource: 'dashboard',
    label: 'Dashboard',
    description: 'Access dashboard summaries and workspace overview metrics.',
    actions: ['view']
  },
  {
    resource: 'settings',
    label: 'Settings',
    description: 'Open the settings workspace and administrative configuration areas.',
    actions: ['view', 'manage']
  },
  {
    resource: 'tasks',
    label: 'Tasks',
    description: 'View and manage internal task boards and task records.',
    actions: ['view', 'create', 'update', 'delete']
  },
  {
    resource: 'task_columns',
    label: 'Task Columns',
    description: 'Configure task board columns and task board structure.',
    actions: ['view', 'create', 'update', 'delete', 'manage']
  },
  {
    resource: 'locations',
    label: 'Locations',
    description: 'Manage dashboard locations and Regiondo location mappings.',
    actions: ['view', 'create', 'update', 'delete']
  },
  {
    resource: 'bookings',
    label: 'Bookings',
    description: 'View, create, cancel, and manage booking operations, metadata, and exports.',
    actions: ['view', 'create', 'update', 'delete', 'manage', 'export']
  },
  {
    resource: 'products',
    label: 'Products',
    description: 'View and manage product details, resource mappings, and catalog sync actions.',
    actions: ['view', 'update', 'manage']
  },
  {
    resource: 'messages',
    label: 'Reminder Rules',
    description: 'Manage reminder rules, delivery retries, and messaging operations.',
    actions: ['view', 'create', 'update', 'delete', 'manage']
  },
  {
    resource: 'users',
    label: 'Users',
    description: 'View and manage dashboard users and role assignments.',
    actions: ['view', 'create', 'update', 'delete', 'manage']
  },
  {
    resource: 'roles',
    label: 'Roles & Permissions',
    description: 'Create roles and maintain the role-permission matrix.',
    actions: ['view', 'create', 'update', 'delete', 'manage']
  },
  {
    resource: 'customers',
    label: 'Customers',
    description: 'View and update customer records and customer data exports.',
    actions: ['view', 'update', 'export']
  },
  {
    resource: 'client_groups',
    label: 'Client Groups',
    description: 'Manage reusable customer groups and group memberships.',
    actions: ['view', 'create', 'update', 'delete', 'manage']
  },
  {
    resource: 'resources',
    label: 'Resources',
    description: 'Inspect resource inventory and resource availability.',
    actions: ['view', 'manage']
  },
  {
    resource: 'regiondo',
    label: 'Regiondo',
    description: 'Inspect Regiondo sync state and retry operational sync actions.',
    actions: ['view', 'manage']
  }
];

const permissionDefinitionsByResource = new Map(
  permissionDefinitions.map((definition) => [definition.resource, definition] as const)
);

function grantAll(resource: PermissionResource, scope: PermissionScope): PermissionGrant[] {
  const definition = permissionDefinitionsByResource.get(resource);
  if (!definition) {
    return [];
  }

  return definition.actions.map((action) => ({ action, resource, scope }));
}

function grant(resource: PermissionResource, scopes: PermissionGrantMap): PermissionGrant[] {
  return Object.entries(scopes).flatMap(([action, scope]) => {
    if (!scope) {
      return [];
    }

    return isSupportedPermission(resource, action as PermissionAction)
      ? [{ action: action as PermissionAction, resource, scope }]
      : [];
  });
}

const defaultRoleGrants: Record<string, PermissionGrant[]> = {
  admin: permissionDefinitions.flatMap((definition) => grantAll(definition.resource, 'all')),
  operations: [
    ...grant('dashboard', { view: 'all' }),
    ...grant('settings', { view: 'all' }),
    ...grant('tasks', { view: 'all', create: 'all', update: 'all', delete: 'all' }),
    ...grant('task_columns', { view: 'all' }),
    ...grant('locations', { view: 'all' }),
    ...grant('bookings', { view: 'all', create: 'all', update: 'all', delete: 'all', manage: 'all', export: 'all' }),
    ...grant('products', { view: 'all', update: 'all' }),
    ...grant('messages', { view: 'all', create: 'all', update: 'all', delete: 'all', manage: 'all' }),
    ...grant('customers', { view: 'all', update: 'all' }),
    ...grant('client_groups', { view: 'all' }),
    ...grant('resources', { view: 'all' }),
    ...grant('regiondo', { view: 'all' })
  ],
  operations_lead: [
    ...grant('dashboard', { view: 'all' }),
    ...grant('settings', { view: 'all', manage: 'all' }),
    ...grant('tasks', { view: 'all', create: 'all', update: 'all', delete: 'all' }),
    ...grant('task_columns', { view: 'all', create: 'all', update: 'all', delete: 'all', manage: 'all' }),
    ...grant('locations', { view: 'all', create: 'all', update: 'all', delete: 'all' }),
    ...grant('bookings', { view: 'all', create: 'all', update: 'all', delete: 'all', manage: 'all', export: 'all' }),
    ...grant('products', { view: 'all', update: 'all', manage: 'all' }),
    ...grant('messages', { view: 'all', create: 'all', update: 'all', delete: 'all', manage: 'all' }),
    ...grant('users', { view: 'all', update: 'all', manage: 'all' }),
    ...grant('roles', { view: 'all', manage: 'all' }),
    ...grant('customers', { view: 'all', update: 'all', export: 'all' }),
    ...grant('client_groups', { view: 'all', create: 'all', update: 'all', delete: 'all', manage: 'all' }),
    ...grant('resources', { view: 'all', manage: 'all' }),
    ...grant('regiondo', { view: 'all', manage: 'all' })
  ],
  program_manager: [
    ...grant('dashboard', { view: 'all' }),
    ...grant('tasks', { view: 'all', create: 'all', update: 'all' }),
    ...grant('bookings', { view: 'all', create: 'all', update: 'all', delete: 'all', manage: 'all' }),
    ...grant('products', { view: 'all' }),
    ...grant('messages', { view: 'all', create: 'all', update: 'all' }),
    ...grant('locations', { view: 'all' }),
    ...grant('customers', { view: 'all', update: 'all' })
  ],
  finance_coordinator: [
    ...grant('dashboard', { view: 'all' }),
    ...grant('bookings', { view: 'all', export: 'all' }),
    ...grant('products', { view: 'all' }),
    ...grant('customers', { view: 'all', export: 'all' }),
    ...grant('resources', { view: 'all' })
  ],
  people_operations: [
    ...grant('dashboard', { view: 'all' }),
    ...grant('settings', { view: 'all', manage: 'all' }),
    ...grant('users', { view: 'all', create: 'all', update: 'all', delete: 'all', manage: 'all' }),
    ...grant('roles', { view: 'all', manage: 'all' }),
    ...grant('locations', { view: 'all' })
  ]
};

export const scopeRank: Record<PermissionScope, number> = {
  none: 0,
  own: 1,
  location: 2,
  all: 3
};

export function isPermissionScope(value: string): value is PermissionScope {
  return ALL_PERMISSION_SCOPES.includes(value as PermissionScope);
}

export function isPermissionAction(value: string): value is PermissionAction {
  return ALL_PERMISSION_ACTIONS.includes(value as PermissionAction);
}

export function isPermissionResource(value: string): value is PermissionResource {
  return permissionDefinitionsByResource.has(value as PermissionResource);
}

export function isSupportedPermission(resource: PermissionResource, action: PermissionAction): boolean {
  return permissionDefinitionsByResource.get(resource)?.actions.includes(action) ?? false;
}

export function normalizePermissionSet(entries: Iterable<ResolvedPermission>): ResolvedPermission[] {
  const scopeByKey = new Map<string, PermissionScope>();

  for (const entry of entries) {
    if (!isSupportedPermission(entry.resource, entry.action)) {
      continue;
    }

    scopeByKey.set(`${entry.resource}:${entry.action}`, entry.scope);
  }

  return permissionDefinitions.flatMap((definition) =>
    definition.actions.map((action) => ({
      action,
      resource: definition.resource,
      scope: scopeByKey.get(`${definition.resource}:${action}`) ?? 'none'
    }))
  );
}

export function getDefaultRolePermissions(roleKey: string): ResolvedPermission[] {
  return normalizePermissionSet(defaultRoleGrants[roleKey] ?? []);
}

export function resolveHighestScope(scopes: PermissionScope[]): PermissionScope {
  return scopes.reduce<PermissionScope>(
    (highest, current) => (scopeRank[current] > scopeRank[highest] ? current : highest),
    'none'
  );
}

export function getPermissionScope(
  permissions: Iterable<ResolvedPermission>,
  resource: PermissionResource,
  action: PermissionAction
): PermissionScope {
  for (const permission of permissions) {
    if (permission.resource === resource && permission.action === action) {
      return permission.scope;
    }
  }

  return 'none';
}

export function hasRoutePermission(
  permissions: Iterable<ResolvedPermission>,
  resource: PermissionResource,
  action: PermissionAction
): boolean {
  return getPermissionScope(permissions, resource, action) !== 'none';
}

export function hasPermission(
  context: AccessContext,
  resource: PermissionResource,
  action: PermissionAction,
  target?: RecordAccessTarget
): boolean {
  const scope = getPermissionScope(context.permissions, resource, action);

  if (scope === 'none') {
    return false;
  }

  if (!target || scope === 'all') {
    return true;
  }

  if (scope === 'own') {
    return target.ownerUserId === context.userId;
  }

  if (scope === 'location') {
    return Boolean(target.locationId && context.userLocationIds.includes(target.locationId));
  }

  return false;
}
