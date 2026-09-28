import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

import { config } from './config.js';

// 伺服器端 PQC 金鑰錢包（plan.md §7 #5：PoC 階段的已定案簡化）。
//
// **安全性警示（PoC 限制，畢業專題報告需標註）**：私鑰以明文 JSON 存放於
// config.wallet.dir（見 .gitignore 的 **/wallet/ 規則，確保不會被提交到 git），
// 依登入身分（identity）取用，不加密、不經 HSM。正式產品必須改為加密靜態儲存
// 或交由使用者裝置端（瀏覽器 WASM／行動裝置安全元件）保管私鑰，鏈碼端的
// Dilithium 驗證邏輯與資料格式不需改變。
//
// 簽章演算法為 ML-DSA-65（CRYSTALS-Dilithium 第三安全等級），與
// chaincode/vehicle/contract/pqc.go 使用的 CIRCL 函式庫驗證同一套 FIPS 204
// 標準；兩者的跨語言相容性已手動驗證（noble 簽出的簽章能被 CIRCL 驗證通過）。

interface StoredKey {
  identity: string;
  publicKeyHex: string;
  secretKeyHex: string;
  createdAt: string;
}

// identity（車主化名雜湊或組織成員名稱）可能含有不適合當檔名的字元，
// 用十六進位編碼檔名，內容仍保留原始 identity 供比對／稽核。
function keyFilePath(identity: string): string {
  const fileName = Buffer.from(identity, 'utf8').toString('hex') + '.json';
  return path.join(config.wallet.dir, fileName);
}

async function ensureWalletDir(): Promise<void> {
  await fs.mkdir(config.wallet.dir, { recursive: true });
}

async function loadKey(identity: string): Promise<StoredKey | null> {
  try {
    const data = await fs.readFile(keyFilePath(identity), 'utf8');
    return JSON.parse(data) as StoredKey;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export interface KeyPair {
  publicKeyHex: string;
  secretKeyHex: string;
}

// newKeyPair 產生一組新的 ML-DSA-65 金鑰，**不寫入錢包**：plan_dApp.md D0 之後，鏈碼要求
// 持有證明／舊鑰簽章，必須等 RegisterPQCKey 上鏈成功才以 saveKey 保存，避免錢包與鏈上不一致。
export function newKeyPair(): KeyPair {
  const seedLength = ml_dsa65.lengths.seed ?? 32;
  const { secretKey, publicKey } = ml_dsa65.keygen(randomBytes(seedLength));
  return {
    publicKeyHex: Buffer.from(publicKey).toString('hex'),
    secretKeyHex: Buffer.from(secretKey).toString('hex'),
  };
}

// saveKey 將金鑰寫入 identity 的錢包檔（覆蓋舊檔，即金鑰輪替）。
export async function saveKey(identity: string, pair: KeyPair): Promise<void> {
  await ensureWalletDir();
  const record: StoredKey = { identity, ...pair, createdAt: new Date().toISOString() };
  await fs.writeFile(keyFilePath(identity), JSON.stringify(record, null, 2), { mode: 0o600 });
}

// generateKey 產生並直接保存一組新金鑰，回傳公鑰（不經鏈上登記的單純錢包操作）。
export async function generateKey(identity: string): Promise<{ publicKeyHex: string }> {
  const pair = newKeyPair();
  await saveKey(identity, pair);
  return { publicKeyHex: pair.publicKeyHex };
}

// signWithSecretKey 用尚未保存的私鑰簽章（例如新金鑰的持有證明）。
export function signWithSecretKey(secretKeyHex: string, message: Uint8Array): string {
  const signature = ml_dsa65.sign(message, Uint8Array.from(Buffer.from(secretKeyHex, 'hex')));
  return Buffer.from(signature).toString('hex');
}

// getPublicKey 回傳已登記金鑰的公鑰，identity 尚未產生金鑰時回傳 null。
export async function getPublicKey(identity: string): Promise<string | null> {
  const key = await loadKey(identity);
  return key?.publicKeyHex ?? null;
}

// sign 用 identity 的錢包私鑰對 message 簽章，回傳十六進位編碼簽章
// （格式需與 chaincode/vehicle/contract/pqc.go 的 verifyDilithiumAuthorization 相容）。
export async function sign(identity: string, message: Uint8Array): Promise<string> {
  const key = await loadKey(identity);
  if (!key) {
    throw new Error(`身分 ${identity} 尚未在金鑰錢包中產生 PQC 金鑰`);
  }
  return signWithSecretKey(key.secretKeyHex, message);
}

// verifyWithPublicKey 用指定公鑰（呼叫端應取自鏈上 GetPQCKey，而非 Gateway 錢包——車主改用
// 瀏覽器自持金鑰後，Gateway 錢包裡根本沒有他的公鑰，plan_dApp.md D1）驗證簽章。
// 簽章或公鑰格式錯誤時視為驗證失敗（回傳 false），不拋例外——呼叫端把它當作一般的
// true/false 判斷式使用。
export function verifyWithPublicKey(publicKeyHex: string, message: Uint8Array, signatureHex: string): boolean {
  if (!/^[0-9a-fA-F]*$/.test(signatureHex) || !/^[0-9a-fA-F]+$/.test(publicKeyHex)) {
    return false;
  }
  const signature = Uint8Array.from(Buffer.from(signatureHex, 'hex'));
  const publicKey = Uint8Array.from(Buffer.from(publicKeyHex, 'hex'));
  try {
    return ml_dsa65.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
