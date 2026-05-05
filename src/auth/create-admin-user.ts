import { pool } from '../db/client.js';
import { hashPassword, PasswordValidationError } from './password.js';
import { upsertAdminUser } from './repository.js';

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const directMatch = process.argv.find((entry) => entry.startsWith(prefix));

  if (directMatch) {
    return directMatch.slice(prefix.length);
  }

  const flagIndex = process.argv.findIndex((entry) => entry === `--${name}`);
  return flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
}

async function main(): Promise<void> {
  const email = readArg('email');
  const password = readArg('password');
  const displayName = readArg('name');
  const role = readArg('role') ?? 'Admin';
  const canAccessDashboard = (readArg('dashboard-access') ?? 'true').toLowerCase() !== 'false';

  if (!email || !password || !displayName) {
    throw new Error(
      'Usage: npm run admin:create -- --email admin@example.com --name "Admin User" --password "long-secret-password" [--role Admin] [--dashboard-access true]'
    );
  }

  const passwordHash = await hashPassword(password);
  const user = await upsertAdminUser({
    email,
    displayName,
    role,
    passwordHash,
    canAccessDashboard
  });

  console.log(
    `Admin user ready: ${user.email} (${user.displayName}) role=${user.role} dashboardAccess=${user.canAccessDashboard}`
  );
}

main()
  .catch((error) => {
    if (error instanceof PasswordValidationError || error instanceof Error) {
      console.error(error.message);
    } else {
      console.error('Failed to create admin user:', error);
    }

    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
