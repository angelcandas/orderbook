// Standard CRC-32 (IEEE 802.3), table driven. Used for Kraken's book checksum.
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC32 of an ASCII string, without allocating. Returns an unsigned 32 bit integer. */
export function crc32Ascii(s: string): number {
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) c = TABLE[(c ^ s.charCodeAt(i)) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
