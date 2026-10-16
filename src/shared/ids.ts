const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A short random ID of lowercase letters and digits, e.g. "k3f9x2ab". */
export function newId(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}
