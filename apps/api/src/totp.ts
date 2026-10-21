import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newTotp() {
  let bits = "";
  for (const b of randomBytes(20)) bits += b.toString(2).padStart(8, "0");
  return bits
    .match(/.{5}/g)!
    .map((b) => alphabet[parseInt(b, 2)])
    .join("");
}
export function totp(key: string, step: number) {
  const bits = key
    .split("")
    .map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0"))
    .join("");
  const raw = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", raw).update(counter).digest();
  const offset = digest[19] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, "0");
}
export function verifyTotp(key: string, code: string) {
  if (!/^\d{6}$/.test(code)) return false;
  const step = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some((d) =>
    timingSafeEqual(Buffer.from(totp(key, step + d)), Buffer.from(code)),
  );
}

export function totpStep(key: string, code: string): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(Date.now() / 30000);
  return (
    [-1, 0, 1]
      .map((d) => step + d)
      .find((v) =>
        timingSafeEqual(Buffer.from(totp(key, v)), Buffer.from(code)),
      ) ?? null
  );
}
