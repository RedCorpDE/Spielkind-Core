import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { appConfig } from '../config.js';

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const BCRYPT_ROUNDS = 12;

export class PasswordValidationError extends Error {}

function scryptAsync(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      keyLength,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey as Buffer);
      }
    );
  });
}

function validatePassword(password: string): void {
  if (password.length < appConfig.ADMIN_PASSWORD_MIN_LENGTH) {
    throw new PasswordValidationError(
      `Password must be at least ${appConfig.ADMIN_PASSWORD_MIN_LENGTH} characters long.`
    );
  }

  if (password.length > 128) {
    throw new PasswordValidationError('Password must be 128 characters or fewer.');
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, storedHash: string | null): Promise<boolean> {
  if (!storedHash) {
    return false;
  }

  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
    return bcrypt.compare(password, storedHash);
  }

  const [algorithm, cost, blockSize, parallelization, encodedSalt, encodedHash] = storedHash.split('$');

  if (
    algorithm !== 'scrypt' ||
    !cost ||
    !blockSize ||
    !parallelization ||
    !encodedSalt ||
    !encodedHash
  ) {
    return false;
  }

  const salt = Buffer.from(encodedSalt, 'base64url');
  const expectedHash = Buffer.from(encodedHash, 'base64url');
  if (
    Number(cost) !== SCRYPT_COST ||
    Number(blockSize) !== SCRYPT_BLOCK_SIZE ||
    Number(parallelization) !== SCRYPT_PARALLELIZATION
  ) {
    return false;
  }

  const actualHash = await scryptAsync(password, salt, expectedHash.length);

  if (actualHash.length !== expectedHash.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualHash, expectedHash);
}
