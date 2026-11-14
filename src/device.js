import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Each device (computer) has its own id, so selecle does not have to tell people apart by name.
// The id is the fingerprint of an ed25519 key pair made once per device and kept in
// ~/.selecle/device.json. A host checks it with a challenge: the device signs a random nonce, so
// a client cannot claim another device's id by just sending it.
//
//   device.json   { id: "dev-<16 hex>", publicKey (spki, base64), privateKey (pkcs8, base64), createdAt }
//
// It is separate from profile.json on purpose: your soul id (profile uid) may follow you to other
// devices (selecle soul / pairing); a device id never does.

export const DEVICE_OK = /^dev-[0-9a-f]{16}$/;
const PROOF_PREFIX = 'selecle-device-proof:';

export const devicePath = () => path.join(process.env.SELECLE_HOME || path.join(os.homedir(), '.selecle'), 'device.json');

// The id that belongs to a public key (spki DER, base64).
export function fingerprint(publicKey) {
  const der = Buffer.from(String(publicKey ?? ''), 'base64');
  return `dev-${crypto.createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

export function makeDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  return { id: fingerprint(pub), publicKey: pub, privateKey: priv, createdAt: new Date().toISOString() };
}

const valid = (d) => d && DEVICE_OK.test(d.id) && typeof d.publicKey === 'string' && typeof d.privateKey === 'string' && fingerprint(d.publicKey) === d.id;

// This device, made on first use. Under `node --test` without SELECLE_HOME every process gets a
// throwaway device in memory (tests never write to the real home, and two pretend friends in one
// test are two devices). If the file cannot be written, the device lives for this run only.
let cached = null;
export function loadDevice(file = devicePath()) {
  if (process.env.NODE_TEST_CONTEXT && !process.env.SELECLE_HOME && file === devicePath()) return (cached ??= makeDevice());
  if (cached?.file === file) return cached;
  let device = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (valid(saved)) device = saved;
  } catch { /* none yet, or damaged: make a new one */ }
  if (!device) {
    device = makeDevice();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(device, null, 2)}\n`, { mode: 0o600 });
    } catch { /* read-only home: this run only */ }
  }
  cached = { ...device, file };
  return cached;
}
export const resetDevice = () => { cached = null; };

// What a device shows the host: never the private key.
export const publicPart = (d) => ({ id: d.id, publicKey: d.publicKey });

// Sign the host's challenge.
export function proveDevice(device, nonce) {
  const key = crypto.createPrivateKey({ key: Buffer.from(device.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(PROOF_PREFIX + String(nonce)), key).toString('base64');
}

// Check a claimed device: the id must match the key, and the key must have signed the nonce.
export function verifyDevice({ id, publicKey, nonce, signature }) {
  try {
    if (!DEVICE_OK.test(String(id)) || fingerprint(publicKey) !== id) return false;
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(PROOF_PREFIX + String(nonce)), key, Buffer.from(String(signature ?? ''), 'base64'));
  } catch {
    return false;
  }
}

export const newNonce = () => crypto.randomBytes(24).toString('base64');

// A short form for people: "dev-3fa2c1d0…" -> "3fa2c1d0".
export const shortDevice = (id) => (DEVICE_OK.test(String(id)) ? id.slice(4, 12) : '');
