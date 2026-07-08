import argon2 from 'argon2';

/**
 * Hash a password using argon2id with sensible defaults.
 * Per Vol VI: "Encrypted secrets, MFA, RBAC" — passwords are never stored in cleartext.
 */
export async function hash(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verify(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
