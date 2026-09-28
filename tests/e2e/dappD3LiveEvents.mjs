#!/usr/bin/env node
// plan_dApp.md D3 驗收（真實五組織網路）：鏈上事件即時推播。
// 以與瀏覽器 EventSource 相同的方式（Kyber TLS 上的 Server-Sent Events）訂閱車主頁使用的端點，
// 鑑定師提交里程倒退的複檢後，數秒內應收到帶有「扣 40 分」異常的 VehicleEvent（UC-01）；
// 監理站強制重綁車主金鑰時，應收到 PQCKeyEvent。
import { maintenanceAuthorizationMessage } from '../../web/shared/authMessages.js';
import { buildRegistrationProof, generateKeyPair, signMessage } from '../../web/walletCrypto.js';
import { assert, expectOk, internalRequest, openEventStream, uniqueVin } from './lib/gatewayClient.mjs';

// 驗收標準「數秒內」：Raft 出塊＋事件轉送，實測遠低於此上限。
const NOTIFY_DEADLINE_MS = 5000;

export async function run() {
  const vin = uniqueVin('D3');
  const ownerIdentity = `owner-${vin}`;
  const vehicleStream = openEventStream(`/api/vehicles/${vin}/events`);
  const keyStream = openEventStream(`/api/pqc-keys/${ownerIdentity}/events`);
  try {
    await Promise.all([vehicleStream.ready, keyStream.ready]);

    await expectOk('POST', '/api/vehicles', {
      vin,
      engineSerial: `ENG-${vin}`,
      transmissionSerial: `TRX-${vin}`,
      manufactureYear: 2019,
      msrpAmount: 900000,
      ownerHash: ownerIdentity,
    });
    const init = await vehicleStream.next((m) => m.data.payload.eventType === 'INIT');
    assert(init.event === 'VehicleEvent', 'INIT 事件應以 VehicleEvent 推送');

    const owner = generateKeyPair();
    await expectOk('POST', `/api/pqc-keys/${ownerIdentity}/register`, {
      publicKeyHex: owner.publicKeyHex,
      proofSignatureHex: buildRegistrationProof(ownerIdentity, owner, null, null),
    });
    const maintenance = { serviceType: 'OIL_CHANGE', mileage: 50000, description: 'D3 保養' };
    await expectOk('POST', `/api/vehicles/${vin}/maintenance`, {
      ...maintenance,
      ownerSignatureHex: signMessage(
        owner.secretKeyHex,
        maintenanceAuthorizationMessage(vin, maintenance.serviceType, maintenance.mileage, maintenance.description),
      ),
    });
    await vehicleStream.next((m) => m.data.payload.eventType === 'MAINTENANCE');

    // UC-01：鑑定師回報里程 30000 < 已知最高 50000 → 里程倒退，扣 40 分。
    const submittedAt = Date.now();
    await expectOk('POST', `/api/vehicles/${vin}/inspections`, { mileage: 30000, findings: 'D3 儀表疑遭調整' });
    const inspection = await vehicleStream.next(
      (m) => m.data.payload.eventType === 'INSPECTION',
      NOTIFY_DEADLINE_MS + 10000,
    );
    // 從送出複檢（含背書、排序、提交）到車主端收到通知的端到端時間。
    const notifyLatencyMs = inspection.receivedAt - submittedAt;
    const anomalies = inspection.data.payload.anomalies;
    assert(anomalies.length === 1 && anomalies[0].anomalyType === 'MILEAGE_ROLLBACK', `應帶出里程倒退異常：${JSON.stringify(anomalies)}`);
    assert(anomalies[0].scoreDelta === -40, `應扣 40 分，實際 ${anomalies[0].scoreDelta}`);
    assert(inspection.data.payload.integrityScore === 60, `誠信分數應降為 60，實際 ${inspection.data.payload.integrityScore}`);
    assert(notifyLatencyMs < NOTIFY_DEADLINE_MS, `通知應在 ${NOTIFY_DEADLINE_MS}ms 內送達，實際 ${notifyLatencyMs}ms`);

    // 監理站強制重綁 → 車主收到 PQCKeyEvent。
    const replacement = generateKeyPair();
    const rebind = await internalRequest('POST', `/api/pqc-keys/${ownerIdentity}/force-rebind`, {
      publicKeyHex: replacement.publicKeyHex,
      proofSignatureHex: buildRegistrationProof(ownerIdentity, replacement, null, null),
      reason: 'D3：車主遺失私鑰，臨櫃重綁',
    });
    assert(rebind.statusCode === 201, `強制重綁應成功：${JSON.stringify(rebind.body)}`);
    const keyEvent = await keyStream.next((m) => m.data.payload.action === 'FORCE_REBIND');
    assert(keyEvent.data.payload.submittingOrg === 'REGMSP', '強制重綁事件應標示由 REGMSP 送出');

    return { vin, notifyLatencyMs, integrityScore: inspection.data.payload.integrityScore };
  } finally {
    vehicleStream.close();
    keyStream.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then((result) => console.log('✅ D3 即時事件', result))
    .catch((err) => {
      console.error('❌ D3 即時事件');
      console.error(err);
      process.exit(1);
    });
}
