import crypto from 'node:crypto';
import os from 'node:os';

const PREFIX = 'enc:v1:';

function encryptionKey(): Buffer {
  const secret = process.env.LEOCODEBOX_PROVIDER_KEY_SECRET || `${os.userInfo().username}:${os.homedir()}:leocodebox`;
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptProviderSecret(value: string): string {
  if (!value || value.startsWith(PREFIX)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptProviderSecret(value: string): string {
  if (!value || !value.startsWith(PREFIX)) return value;
  try {
    const [iv, tag, ciphertext] = value.slice(PREFIX.length).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
