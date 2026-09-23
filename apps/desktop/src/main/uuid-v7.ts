import { randomBytes } from "node:crypto";

export function uuidV7(timestamp = Date.now(), random = randomBytes(16)): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new RangeError("The UUID timestamp is outside the supported range.");
  }
  if (random.length < 16) {
    throw new RangeError("UUID generation requires 16 random bytes.");
  }

  const bytes = Buffer.from(random.subarray(0, 16));
  let remaining = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
