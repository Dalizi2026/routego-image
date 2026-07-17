const CRC32_TABLE = new Uint32Array(256);

for (let value = 0; value < CRC32_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  CRC32_TABLE[value] = crc >>> 0;
}

export class Crc32 {
  #state = 0xffff_ffff;

  update(bytes: Uint8Array): this {
    for (const byte of bytes) {
      this.#state = (this.#state >>> 8) ^ CRC32_TABLE[(this.#state ^ byte) & 0xff]!;
    }
    return this;
  }

  digest(): number {
    return (this.#state ^ 0xffff_ffff) >>> 0;
  }
}

export function crc32(bytes: Uint8Array): number {
  return new Crc32().update(bytes).digest();
}
