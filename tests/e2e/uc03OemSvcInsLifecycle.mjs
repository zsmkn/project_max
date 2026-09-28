#!/usr/bin/env node
// UC-03「車廠初始化與理賠存證」端到端腳本（階段 6，BFR1、BFR2、FFR2、EIR2）。
//
// 流程：OEM 出廠初始化 → 車主登記 PQC 金鑰 → 車主簽署保養授權 → SVC 回報保養 →
// 保險公司（模擬服務，EIR2，見 mocks/insurance/）受理理賠並轉送 → INS 理賠存證。
//
// 與 UC-01／UC-02 不同之處：理賠這一步刻意不直接呼叫 Gateway 的
// POST /api/vehicles/:vin/claims，而是呼叫 mocks/insurance/app.py 對外暴露的
// /claim-settlements（模擬保險公司自己的理賠系統格式），由它轉換格式後再呼叫
// Gateway——完整示範 EIR2「透過 Gateway 呼叫合約，只做介面示範」的外部系統整合路徑
// （plan.md §3.5）。
//
// 前提：除了 network/、gateway/，還需先啟動保險公司模擬服務：
//   python3 -m mocks.insurance.app
import { assert, expectOk, uniqueVin } from './lib/gatewayClient.mjs';

const INSURANCE_MOCK_URL = process.env.INSURANCE_MOCK_URL ?? 'http://127.0.0.1:9002';

export async function run() {
  const vin = uniqueVin('UC03');
  const ownerIdentity = `owner-${vin}`;

  await expectOk('POST', '/api/vehicles', {
    vin,
    engineSerial: `ENG-${vin}`,
    transmissionSerial: `TRX-${vin}`,
    manufactureYear: 2023,
    msrpAmount: 950000,
    ownerHash: ownerIdentity,
  });
  await expectOk('POST', `/api/pqc-keys/${ownerIdentity}`);

  const authorized = await expectOk('POST', `/api/vehicles/${vin}/maintenance/authorize`, {
    ownerIdentity,
    serviceType: '交車前檢查',
    mileage: 20,
    description: '出廠交車檢查',
  });
  await expectOk('POST', `/api/vehicles/${vin}/maintenance`, {
    serviceType: '交車前檢查',
    mileage: 20,
    description: '出廠交車檢查',
    ownerSignatureHex: authorized.signatureHex,
  });

  // EIR2：呼叫保險公司模擬服務（保險公司自己的理賠結案格式），由它轉換格式並
  // 送出 RecordClaim（INS 組織身分）。
  const claimId = `CLM-${vin}`;
  const settlementResponse = await fetch(`${INSURANCE_MOCK_URL}/claim-settlements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vin,
      policyClaimNo: claimId,
      accidentType: '追撞',
      settlementAmount: 35000,
      damagedComponent: '後保險桿',
    }),
  });
  assert(
    settlementResponse.ok,
    `保險公司模擬服務應成功受理理賠並轉送 Gateway，實際 HTTP ${settlementResponse.status}`,
  );

  const history = await expectOk('GET', `/api/vehicles/${vin}/history`);
  const claimEvent = history.find((event) => event.type === 'CLAIM' && event.claimId === claimId);
  assert(claimEvent !== undefined, 'GetVehicleHistory 應包含保險公司模擬服務轉送的理賠事件');
  assert(claimEvent.incidentType === '追撞', `理賠事件的 incidentType 應為「追撞」，實際 ${claimEvent.incidentType}`);
  assert(
    claimEvent.incidentAmount === 35000,
    `理賠事件的 incidentAmount 應為 35000，實際 ${claimEvent.incidentAmount}`,
  );

  const summary = await expectOk('GET', `/api/vehicles/${vin}/summary`);
  assert(
    summary.integrityScore === 100,
    `理賠觀察期（30 天）尚未屆滿，誠信分數應維持 100，實際 ${summary.integrityScore}`,
  );

  return { vin, claimId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then((result) => {
      console.log('UC-03 通過：', result);
    })
    .catch((err) => {
      console.error('UC-03 失敗：', err);
      process.exitCode = 1;
    });
}
