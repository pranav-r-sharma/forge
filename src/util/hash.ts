import * as crypto from 'crypto';

export function sha1(text: string): string {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}
