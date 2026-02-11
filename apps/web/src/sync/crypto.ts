const KDF_ITERATIONS = 150_000;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // DOM lib types are strict about ArrayBuffer (not SharedArrayBuffer).
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveAesGcmKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export type EncryptedBlobV1 = {
  v: 1;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  alg: { name: "AES-GCM"; iv: string };
  ct: string;
};

export async function encryptJson(password: string, value: unknown): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesGcmKey(password, salt, KDF_ITERATIONS);

  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, plaintext);
  const ct = new Uint8Array(ctBuf);

  const blob: EncryptedBlobV1 = {
    v: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS, salt: bytesToBase64(salt) },
    alg: { name: "AES-GCM", iv: bytesToBase64(iv) },
    ct: bytesToBase64(ct),
  };

  return JSON.stringify(blob);
}

export async function decryptJson(password: string, blobText: string): Promise<unknown> {
  const parsed = JSON.parse(blobText) as Partial<EncryptedBlobV1>;
  if (parsed.v !== 1) throw new Error("Unsupported blob version");
  if (parsed.kdf?.name !== "PBKDF2" || parsed.kdf.hash !== "SHA-256") throw new Error("Unsupported KDF");
  if (typeof parsed.kdf.iterations !== "number" || parsed.kdf.iterations <= 0) throw new Error("Invalid KDF");
  if (parsed.alg?.name !== "AES-GCM") throw new Error("Unsupported cipher");
  if (typeof parsed.kdf.salt !== "string" || typeof parsed.alg.iv !== "string" || typeof parsed.ct !== "string") {
    throw new Error("Invalid blob");
  }

  const salt = base64ToBytes(parsed.kdf.salt);
  const iv = base64ToBytes(parsed.alg.iv);
  const ct = base64ToBytes(parsed.ct);

  const key = await deriveAesGcmKey(password, salt, parsed.kdf.iterations);
  const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(ct));
  const plaintext = new TextDecoder().decode(ptBuf);
  return JSON.parse(plaintext) as unknown;
}
