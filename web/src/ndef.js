// NDEF encoding for a single URI record, exactly what NFC Tools writes to an NTAG213.
// Used by the simulator so a "virtual sticker" holds the same bytes a real one will.

export const NTAG213_USER_BYTES = 144;

// NFC Forum URI Record Type Definition, prefix codes (subset).
const PREFIXES = [
  [0x04, 'https://'],
  [0x03, 'http://'],
  [0x02, 'https://www.'],
  [0x01, 'http://www.'],
];

/** URL -> TLV-wrapped NDEF message bytes, as stored in tag memory. */
export function encodeUriSticker(url) {
  const best = PREFIXES.filter(([, p]) => url.startsWith(p)).sort((a, b) => b[1].length - a[1].length)[0];
  const [code, prefix] = best ?? [0x00, ''];
  const rest = new TextEncoder().encode(url.slice(prefix.length));
  const payload = new Uint8Array([code, ...rest]);
  if (payload.length > 255) throw new Error('URL too long for a short record');
  // Record header: MB=1 ME=1 SR=1 TNF=0x01 (well-known) -> 0xD1, type "U".
  const record = new Uint8Array([0xd1, 0x01, payload.length, 0x55, ...payload]);
  // TLV: 0x03 = NDEF message, then length, then the record, then 0xFE terminator.
  return new Uint8Array([0x03, record.length, ...record, 0xfe]);
}

/** TLV bytes -> URL, the way a phone reads the sticker. Throws on anything malformed. */
export function decodeUriSticker(bytes) {
  if (bytes[0] !== 0x03) throw new Error('No NDEF message TLV');
  const len = bytes[1];
  const rec = bytes.slice(2, 2 + len);
  if (rec[0] !== 0xd1 || rec[1] !== 0x01 || rec[3] !== 0x55) throw new Error('Not a single URI record');
  const payload = rec.slice(4, 4 + rec[2]);
  const prefix = PREFIXES.find(([c]) => c === payload[0])?.[1] ?? '';
  return prefix + new TextDecoder().decode(payload.slice(1));
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
