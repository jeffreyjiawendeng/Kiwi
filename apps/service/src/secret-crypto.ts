import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretCipher {
  encrypt(plaintext: string, context: string): string;
  decrypt(ciphertext: string, context: string): string;
  encrypted(value: string): boolean;
}

function decode(value: string, name: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new Error(`Protected credential has an invalid ${name}.`);
  }
}

export function createSecretCipher(key: Uint8Array): SecretCipher {
  if (key.byteLength !== 32) {
    throw new Error("The connected-account encryption key must contain exactly 32 bytes.");
  }
  const protectedKey = Buffer.from(key);
  return {
    encrypt(plaintext, context) {
      if (plaintext === "") throw new Error("An empty credential cannot be protected.");
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", protectedKey, nonce, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [
        VERSION,
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        body.toString("base64url"),
      ].join(".");
    },
    decrypt(ciphertext, context) {
      const [version, nonceValue, tagValue, bodyValue, ...rest] = ciphertext.split(".");
      if (
        version !== VERSION ||
        nonceValue === undefined ||
        tagValue === undefined ||
        bodyValue === undefined ||
        rest.length > 0
      ) {
        throw new Error("Protected credential has an unsupported format.");
      }
      const nonce = decode(nonceValue, "nonce");
      const tag = decode(tagValue, "authentication tag");
      const body = decode(bodyValue, "ciphertext");
      if (nonce.byteLength !== NONCE_BYTES || tag.byteLength !== TAG_BYTES) {
        throw new Error("Protected credential has invalid encryption metadata.");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", protectedKey, nonce, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      } catch {
        throw new Error("Protected credential could not be authenticated.");
      }
    },
    encrypted(value) {
      return value.startsWith(`${VERSION}.`);
    },
  };
}
