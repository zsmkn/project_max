// 車主 PQC 簽章訊息的唯一定義（plan_dApp.md D1），瀏覽器錢包（web/wallet.js）與 Gateway
// （gateway/src/authorizationMessages.ts 直接 re-export 本檔）共用，避免兩處各寫一份而漂移。
// 格式須與 chaincode/vehicle/contract/pqc.go 逐位元組一致，否則鏈碼驗證必定失敗；
// 對應的 Go 函式註記在各函式說明中。純 ESM、無相依套件，瀏覽器可直接 <script type="module"> 載入。

const encoder = new TextEncoder();

// AddMaintenance 車主授權（FFR2、BFR5）↔ pqc.go maintenanceAuthorizationMessage。
export function maintenanceAuthorizationMessage(vin, serviceType, mileage, description) {
  return encoder.encode(`AddMaintenance|${vin}|${serviceType}|${mileage}|${description}`);
}

// 買家查詢授權（QR Code，UC-02）。不上鏈，由買家瀏覽器以鏈上公鑰自行驗證（plan_dApp.md D2）。
export function queryAuthorizationMessage(vin, expiresAt) {
  return encoder.encode(`QueryAuthorization|${vin}|${expiresAt}`);
}

// 公鑰持有證明（第一次登記／強制重綁）↔ pqc.go pqcKeyRegistrationMessage。
export function pqcKeyRegistrationMessage(identity, publicKeyHex) {
  return encoder.encode(`RegisterPQCKey|${identity}|${publicKeyHex}`);
}

// 換鑰授權：由目前登記的舊私鑰簽署，含目前版本號防重放 ↔ pqc.go pqcKeyRotationMessage。
export function pqcKeyRotationMessage(identity, currentVersion, newPublicKeyHex) {
  return encoder.encode(`RotatePQCKey|${identity}|${currentVersion}|${newPublicKeyHex}`);
}

// 查詢授權（QR Code）的內容定址 ID（plan_dApp.md D2）。ML-DSA-65 簽章約 3.3 KB，超過單一
// QR Code 的容量上限（2,953 bytes），因此 QR 只放本 ID，完整授權暫存在 Gateway；買家取回後
// 重新計算 ID 比對，Gateway 無法竄改內容而不被發現（與 IPFS 的內容定址同一概念）。
// 欄位順序固定，確保同一份授權在瀏覽器與 Gateway 算出相同的雜湊。
export function canonicalQueryAuthorization({ vin, ownerIdentity, expiresAt, signatureHex }) {
  return JSON.stringify({ vin, ownerIdentity, expiresAt, signatureHex });
}

export async function queryAuthorizationId(authorization) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalQueryAuthorization(authorization)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
