// 瀏覽器自持金鑰錢包的純密碼學部分（plan_dApp.md D1／D2），不碰 DOM 與 IndexedDB，
// 因此同一份程式可在 Node.js 22 內做單元測試與端到端測試（web/tests/、tests/e2e/）。
//
// - ML-DSA-65（Dilithium）：web/vendor/ 內固定版本的 @noble/post-quantum，與 Gateway 使用同一
//   套件，已驗證能與鏈碼的 CIRCL 互通（docs/stage3-pqc.md）。不從 CDN 載入，避免 CDN 被竄改時
//   偷走私鑰（見 web/vendor/README.md）。
// - 備份檔加密：WebCrypto PBKDF2-SHA256 由密碼導出 AES-256-GCM 金鑰（不自行實作密碼學）。

import { ml_dsa65 } from './vendor/noble-post-quantum-0.7.1-ml-dsa.js';
import { pqcKeyRegistrationMessage, pqcKeyRotationMessage, queryAuthorizationMessage } from './shared/authMessages.js';

export const BACKUP_FORMAT = 'vehiclenet-pqc-wallet-backup';
// OWASP 2023 對 PBKDF2-HMAC-SHA256 的建議迭代次數。
const PBKDF2_ITERATIONS = 600_000;
const SEED_BYTES = 32;

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('十六進位字串格式錯誤');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// generateKeyPair 在本機產生 ML-DSA-65 金鑰，私鑰從此不離開使用者裝置。
export function generateKeyPair() {
  const { publicKey, secretKey } = ml_dsa65.keygen(crypto.getRandomValues(new Uint8Array(SEED_BYTES)));
  return { publicKeyHex: bytesToHex(publicKey), secretKeyHex: bytesToHex(secretKey) };
}

export function signMessage(secretKeyHex, message) {
  return bytesToHex(ml_dsa65.sign(message, hexToBytes(secretKeyHex)));
}

// verifySignature 格式錯誤一律視為驗證失敗（回傳 false），不拋例外。
export function verifySignature(publicKeyHex, message, signatureHex) {
  try {
    return ml_dsa65.verify(hexToBytes(signatureHex), message, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

// buildRegistrationProof 依鏈上目前狀態組出 RegisterPQCKey 需要的 proofSignatureHex
// （規則見 chaincode/vehicle/contract/pqc.go）：
// - onChainKey 為 null（第一次登記）：新私鑰簽署持有證明。
// - 已登記：須由目前登記的舊私鑰（currentKeyPair）簽署換鑰訊息，含鏈上版本號防重放。
export function buildRegistrationProof(identity, newKeyPair, onChainKey, currentKeyPair) {
  if (!onChainKey) {
    return signMessage(newKeyPair.secretKeyHex, pqcKeyRegistrationMessage(identity, newKeyPair.publicKeyHex));
  }
  if (!currentKeyPair || currentKeyPair.publicKeyHex !== onChainKey.publicKeyHex) {
    throw new Error('鏈上已登記其他公鑰，而本機沒有對應的私鑰：請匯入原私鑰備份後換鑰，或至監理站臨櫃申請強制重綁');
  }
  return signMessage(
    currentKeyPair.secretKeyHex,
    pqcKeyRotationMessage(identity, onChainKey.version, newKeyPair.publicKeyHex),
  );
}

// verifyQueryAuthorization 買家瀏覽器自行驗證車主的查詢授權（plan_dApp.md D2），不依賴
// Gateway 的 verify 端點。onChainKey 取自鏈上 GetPQCKey，vehicleOwnerHash 取自鏈上 GetSummary：
// 除了簽章與期限，也確認簽署者就是這台車目前的車主，避免有人用自己的金鑰替別人的車簽 QR。
// 回傳 { valid: true } 或 { valid: false, reason }。
export function verifyQueryAuthorization({ payload, onChainKey, vehicleOwnerHash, now = new Date() }) {
  const { vin, ownerIdentity, expiresAt, signatureHex } = payload || {};
  if (!vin || !ownerIdentity || !expiresAt || !signatureHex) {
    return { valid: false, reason: '授權內容缺少必要欄位（vin、ownerIdentity、expiresAt、signatureHex）' };
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return { valid: false, reason: '有效期限格式錯誤' };
  }
  if (expiresAtMs < now.getTime()) {
    return { valid: false, reason: '查詢授權已過期' };
  }
  if (!onChainKey) {
    return { valid: false, reason: '車主尚未在鏈上登記 PQC 公鑰' };
  }
  if (vehicleOwnerHash !== ownerIdentity) {
    return { valid: false, reason: '簽署者不是鏈上登記的目前車主' };
  }
  if (!verifySignature(onChainKey.publicKeyHex, queryAuthorizationMessage(vin, expiresAt), signatureHex)) {
    return { valid: false, reason: '簽章驗證失敗（內容可能遭竄改）' };
  }
  return { valid: true };
}

async function deriveBackupKey(password, salt, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// encryptBackup 將金鑰紀錄加密成可下載的 JSON 字串（換電腦時用 decryptBackup 匯入）。
// identity 也放進 AES-GCM 的附加驗證資料，改動檔案中的 identity 會讓解密失敗。
export async function encryptBackup(record, password) {
  if (!password || password.length < 8) {
    throw new Error('備份密碼至少需要 8 個字元');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(password, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(record));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(record.identity) },
    key,
    plaintext,
  );
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: 1,
    identity: record.identity,
    kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, saltHex: bytesToHex(salt) },
    cipher: { name: 'AES-256-GCM', ivHex: bytesToHex(iv) },
    ciphertextHex: bytesToHex(new Uint8Array(ciphertext)),
  });
}

export async function decryptBackup(backupText, password) {
  let backup;
  try {
    backup = JSON.parse(backupText);
  } catch {
    throw new Error('備份檔不是合法的 JSON');
  }
  if (backup.format !== BACKUP_FORMAT || backup.version !== 1) {
    throw new Error('不是本系統的金鑰備份檔');
  }
  const key = await deriveBackupKey(password, hexToBytes(backup.kdf.saltHex), backup.kdf.iterations);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: hexToBytes(backup.cipher.ivHex),
        additionalData: new TextEncoder().encode(backup.identity),
      },
      key,
      hexToBytes(backup.ciphertextHex),
    );
  } catch {
    throw new Error('密碼錯誤或備份檔已損毀');
  }
  const record = JSON.parse(new TextDecoder().decode(plaintext));
  if (record.identity !== backup.identity || !record.publicKeyHex || !record.secretKeyHex) {
    throw new Error('備份檔內容不完整');
  }
  return record;
}
