import { z } from 'zod';
import type { ClientProfile } from '../../client-api/types.js';
import { ValidationHttpError } from '../../http/errors.js';

export interface WebCheckoutContact {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
}

export type WebCheckoutIdentity =
  | { kind: 'authenticated'; clientId: string; contact: WebCheckoutContact }
  | { kind: 'guest'; contact: WebCheckoutContact };

const guestSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  phone: z.string().trim().max(50).optional()
});

export function resolveWebCheckoutIdentity(
  authenticatedClient: ClientProfile | null,
  guest: unknown
): WebCheckoutIdentity {
  if (authenticatedClient) {
    return {
      kind: 'authenticated',
      clientId: authenticatedClient.id,
      contact: {
        firstName: authenticatedClient.firstName,
        lastName: authenticatedClient.lastName,
        email: authenticatedClient.email.toLowerCase(),
        ...(authenticatedClient.phone ? { phone: authenticatedClient.phone } : {})
      }
    };
  }

  const parsed = guestSchema.safeParse(guest);
  if (!parsed.success) {
    throw new ValidationHttpError('Guest details must include first name, last name, and a valid email address.');
  }
  return { kind: 'guest', contact: parsed.data };
}
