// crypto.js - fixed-key encryption for Chrome extension storage
// NOTE: Fixed passphrase means this is obfuscation-level security.
// If someone can read the extension source, they can decrypt.

const FIXED_PASSPHRASE = "replace-with-your-fixed-passphrase-CHANGE-ME";
const FIXED_SALT = "site-summarizer-fixed-salt-v1"; // change if you want
const PBKDF2_ITERS = 200000; // ok for extension
const AES_KEY_LEN = 256;

function toU8(str) {
  return new TextEncoder().encode(str);
}
function toB64(u8) {
  let s = "";
  u8.forEach(b => (s += String.fromCharCode(b)));
  return btoa(s);
}
function fromB64(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function deriveAesKey() {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    toU8(FIXED_PASSPHRASE),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toU8(FIXED_SALT),
      iterations: PBKDF2_ITERS,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: AES_KEY_LEN },
    false,
    ["encrypt", "decrypt"]
  );
}

// Returns string like: "v1:<iv_b64>:<ct_b64>"
export async function encryptString(plainText) {
  const key = await deriveAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = toU8(plainText);

  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt);
  const ct = new Uint8Array(ctBuf);

  return `v1:${toB64(iv)}:${toB64(ct)}`;
}

export async function decryptString(cipherText) {
  if (!cipherText || typeof cipherText !== "string") return "";
  const parts = cipherText.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Bad cipher format");

  const iv = fromB64(parts[1]);
  const ct = fromB64(parts[2]);

  const key = await deriveAesKey();
  const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(ptBuf);
}
