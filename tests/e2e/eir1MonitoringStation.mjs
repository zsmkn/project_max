#!/usr/bin/env node
// EIR1「監理站外部系統模擬服務」整合測試（階段 6）。
//
// 不屬於 UC-01／UC-02／UC-03 的既定範圍（三個 UC 分別聚焦鑑定師複檢、買家查詢、
// 車廠與理賠），但 EIR1（監理站，見 plan.md §3.5）同樣需要「每項需求都有對應測試」
// （plan.md §5 階段 6 驗收標準），因此獨立成一支腳本：呼叫
// mocks/monitoring_station/app.py 對外暴露的過戶登記通知／報廢通知端點，驗證它能
// 正確轉換格式並促成 Gateway 的 TransferOwnership／ScrapVehicle（皆為 REG 組織身分，
// BFR2）。
//
// 前提：除了 network/、gateway/，還需先啟動監理站模擬服務：
//   python3 -m mocks.monitoring_station.app
import { assert, expectOk, uniqueVin } from './lib/gatewayClient.mjs';

const MONITORING_STATION_MOCK_URL = process.env.MONITORING_STATION_MOCK_URL ?? 'http://127.0.0.1:9001';

export async function run() {
  const vin = uniqueVin('EIR1');
  const originalOwnerIdentity = `owner-${vin}`;
  const newOwnerIdentityHash = `buyer-${vin}`;

  await expectOk('POST', '/api/vehicles', {
    vin,
    engineSerial: `ENG-${vin}`,
    transmissionSerial: `TRX-${vin}`,
    manufactureYear: 2019,
    msrpAmount: 500000,
    ownerHash: originalOwnerIdentity,
  });

  // 監理站過戶登記通知 → 應轉送 TransferOwnership（REG）。
  const transferResponse = await fetch(`${MONITORING_STATION_MOCK_URL}/transfer-notices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vin, newOwnerIdentityHash, officerId: 'REG-0001' }),
  });
  assert(transferResponse.ok, `監理站模擬服務應成功轉送過戶登記，實際 HTTP ${transferResponse.status}`);

  const afterTransfer = await expectOk('GET', `/api/vehicles/${vin}/summary`);
  assert(
    afterTransfer.ownerHash === newOwnerIdentityHash,
    `過戶後車主應更新為 ${newOwnerIdentityHash}，實際 ${afterTransfer.ownerHash}`,
  );

  // 監理站報廢通知 → 應轉送 ScrapVehicle（REG）。
  const scrapResponse = await fetch(`${MONITORING_STATION_MOCK_URL}/scrap-notices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vin,
      deregistrationReasonCode: 'SCRAP01',
      deregistrationReasonText: '車齡過高，車主申請報廢',
      officerId: 'REG-0001',
    }),
  });
  assert(scrapResponse.ok, `監理站模擬服務應成功轉送報廢註銷，實際 HTTP ${scrapResponse.status}`);

  const afterScrap = await expectOk('GET', `/api/vehicles/${vin}/summary`);
  assert(afterScrap.status === 'SCRAPPED', `報廢後車輛狀態應為 SCRAPPED，實際 ${afterScrap.status}`);

  // 例外流程：對已報廢車輛重複送出報廢通知，鏈碼應拒絕，模擬服務應如實回報失敗
  // （而不是吞掉錯誤回傳成功）。
  const duplicateScrapResponse = await fetch(`${MONITORING_STATION_MOCK_URL}/scrap-notices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vin,
      deregistrationReasonCode: 'SCRAP01',
      deregistrationReasonText: '重複報廢測試',
      officerId: 'REG-0001',
    }),
  });
  assert(
    !duplicateScrapResponse.ok,
    '對已報廢車輛重複送出報廢通知應該失敗（鏈碼拒絕），但監理站模擬服務回報成功',
  );

  return { vin };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then((result) => {
      console.log('EIR1 監理站整合測試通過：', result);
    })
    .catch((err) => {
      console.error('EIR1 監理站整合測試失敗：', err);
      process.exitCode = 1;
    });
}
