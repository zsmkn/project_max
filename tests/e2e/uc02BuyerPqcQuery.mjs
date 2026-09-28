#!/usr/bin/env node
// UC-02「買家查詢與 PQC 連線」端到端腳本（階段 6，FFR1、BFR4、IIR1、plan.md §7 #10）。
//
// 流程：OEM 出廠初始化 → 車主登記 PQC 金鑰 → 車主簽署買家查詢授權（QR Code 內容）→
// 買家驗證授權 → 買家查詢車輛履歷（量測延遲，NFR2）。
//
// 驗證重點：
// 1. 合法簽章的查詢授權驗證通過（主流程）。
// 2. 偽造／竄改簽章的查詢授權驗證失敗（例外流程，見 authorizationMessages.ts 的說明：
//    這驗證的是「車主同意」的意圖，不是資料存取的硬性關卡）。
// 3. GetSummary 查詢延遲低於 1 秒（NFR2 初驗目標）。
// 4. Kyber TLS 邊界（BFR4／IIR1）：用支援 X25519MLKEM768 的用戶端（本腳本預設設定）
//    連線成功；改用傳統橢圓曲線（不含後量子混合金鑰交換）連線則直接握手失敗，
//    對應 UC-02 例外流程「握手失敗時拒絕連線」。
//
// 前提：network/ 已啟動並部署 chaincode，gateway/（npm run dev 或 npm start）已啟動。
import { assert, expectOk, request, uniqueVin } from './lib/gatewayClient.mjs';

export async function run() {
  const vin = uniqueVin('UC02');
  const ownerIdentity = `owner-${vin}`;

  await expectOk('POST', '/api/vehicles', {
    vin,
    engineSerial: `ENG-${vin}`,
    transmissionSerial: `TRX-${vin}`,
    manufactureYear: 2021,
    msrpAmount: 650000,
    ownerHash: ownerIdentity,
  });
  await expectOk('POST', `/api/pqc-keys/${ownerIdentity}`);

  // 主流程：車主同意查詢，產生短期授權（QR Code 內容）。
  const authorization = await expectOk('POST', `/api/vehicles/${vin}/query-authorization`, {
    ownerIdentity,
    validMinutes: 10,
  });

  const verifyPath = (signatureHex) =>
    `/api/vehicles/${vin}/query-authorization/verify` +
    `?ownerIdentity=${encodeURIComponent(ownerIdentity)}` +
    `&expiresAt=${encodeURIComponent(authorization.expiresAt)}` +
    `&signatureHex=${encodeURIComponent(signatureHex)}`;

  const validResult = await expectOk('GET', verifyPath(authorization.signatureHex));
  assert(validResult.valid === true, `合法簽章的查詢授權應驗證通過，實際：${JSON.stringify(validResult)}`);

  // 例外流程：偽造／竄改簽章（翻轉最後一個十六進位字元）應驗證失敗。
  const tamperedSignature = tamperHex(authorization.signatureHex);
  const invalidResult = await expectOk('GET', verifyPath(tamperedSignature));
  assert(invalidResult.valid === false, `偽造簽章的查詢授權應驗證失敗，實際：${JSON.stringify(invalidResult)}`);

  // NFR2 初驗：查詢延遲應低於 1 秒。
  const startedAt = Date.now();
  const summary = await expectOk('GET', `/api/vehicles/${vin}/summary`);
  const elapsedMs = Date.now() - startedAt;
  assert(summary.vin === vin, 'GetSummary 應回傳對應 VIN 的資料');
  assert(elapsedMs < 1000, `GetSummary 查詢延遲應低於 1000ms（NFR2），實際 ${elapsedMs}ms`);

  // BFR4／IIR1 例外流程：不支援後量子混合金鑰交換的用戶端，握手應直接失敗。
  let handshakeFailed = false;
  try {
    await request('GET', `/api/vehicles/${vin}/summary`, undefined, { ecdhCurve: 'prime256v1' });
  } catch {
    handshakeFailed = true;
  }
  assert(handshakeFailed, '不支援 X25519MLKEM768 的用戶端連線應該握手失敗，但實際連線成功');

  return { vin, queryLatencyMs: elapsedMs };
}

function tamperHex(hex) {
  const lastChar = hex.at(-1);
  const replacement = lastChar === '0' ? '1' : '0';
  return hex.slice(0, -1) + replacement;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then((result) => {
      console.log('UC-02 通過：', result);
    })
    .catch((err) => {
      console.error('UC-02 失敗：', err);
      process.exitCode = 1;
    });
}
