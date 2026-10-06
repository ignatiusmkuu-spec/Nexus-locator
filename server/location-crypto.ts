import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const secret = process.env.SESSION_SECRET;
if (!secret || secret.length < 32) throw new Error("A strong SESSION_SECRET is required to protect location data.");

// Domain-separated from cookie signing; rotating SESSION_SECRET also invalidates the short-retention location ciphertext.
const encryptionKey = Buffer.from(hkdfSync("sha256", secret, "nexus-locator-v1", "precise-location-aes-256-gcm", 32));

export function encryptLocation(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("hex"), authTag: cipher.getAuthTag().toString("hex") };
}

export function decryptLocation(ciphertext: string, iv: string, authTag: string) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(authTag, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext) as {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude: number | null;
    heading: number | null;
    speed: number | null;
  };
}
