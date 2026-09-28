#!/usr/bin/env node
// UC-01「鑑定師複檢與動態扣分」端到端腳本（階段 6，BFR3、FFR3、FFR4）。
//
// 流程：OEM 出廠初始化 → 車主登記 PQC 金鑰 → 車主簽署保養授權 → SVC 回報保養
// （里程 50000） → APP 複檢回報里程倒退（30000，低於歷史最高值）。
//
// 驗證重點：
// 1. 里程倒退不會讓交易失敗（CLAUDE.md「異常要記錄而不是拒絕」）——複檢請求仍回傳
//    2xx，而不是被拒絕。
// 2. 誠信分數依 scoring_config.json 的 mileageRollbackDeduction（40）從 100 扣到 60。
// 3. GetVehicleHistory 多一筆 ANOMALY 事件，anomalyType=MILEAGE_ROLLBACK、
//    scoreDelta=-40，且關聯到本次複檢交易（BFR3、UC-01）。
// 4. 車輛主檔的 mileage 欄位仍會更新為複檢回報值（30000，最新一筆回報里程）——
//    「記錄異常」指的是額外寫入 ANOMALY 事件並扣分，不是拒絕或竄改本次回報資料；
//    倒退判斷（DetectMileageRollbacks）依據的是完整事件歷史裡的歷史最高值，
//    不是車輛主檔目前的單一 mileage 欄位。
//
// 前提：network/ 已啟動並部署 chaincode，gateway/（npm run dev 或 npm start）已啟動。
import { assert, expectOk, uniqueVin } from './lib/gatewayClient.mjs';

export async function run() {
  const vin = uniqueVin('UC01');
  const ownerIdentity = `owner-${vin}`;

  await expectOk('POST', '/api/vehicles', {
    vin,
    engineSerial: `ENG-${vin}`,
    transmissionSerial: `TRX-${vin}`,
    manufactureYear: 2022,
    msrpAmount: 800000,
    ownerHash: ownerIdentity,
  });

  await expectOk('POST', `/api/pqc-keys/${ownerIdentity}`);

  const authorized = await expectOk('POST', `/api/vehicles/${vin}/maintenance/authorize`, {
    ownerIdentity,
    serviceType: '定期保養',
    mileage: 50000,
    description: '更換機油與濾芯',
  });
  await expectOk('POST', `/api/vehicles/${vin}/maintenance`, {
    serviceType: '定期保養',
    mileage: 50000,
    description: '更換機油與濾芯',
    ownerSignatureHex: authorized.signatureHex,
  });

  const afterMaintenance = await expectOk('GET', `/api/vehicles/${vin}/summary`);
  assert(afterMaintenance.mileage === 50000, `保養後里程應為 50000，實際 ${afterMaintenance.mileage}`);
  assert(afterMaintenance.integrityScore === 100, `保養後誠信分數應維持 100，實際 ${afterMaintenance.integrityScore}`);

  // 例外流程：複檢回報里程 30000，低於歷史最高值 50000（里程倒退）。
  const inspection = await expectOk('POST', `/api/vehicles/${vin}/inspections`, {
    mileage: 30000,
    findings: '外觀正常，惟儀表里程低於保養紀錄，疑似調錶',
  });
  assert(inspection.vin === vin, '複檢回應應包含對應的 VIN');

  const afterInspection = await expectOk('GET', `/api/vehicles/${vin}/summary`);
  assert(
    afterInspection.integrityScore === 60,
    `里程倒退後誠信分數應扣 40 分至 60，實際 ${afterInspection.integrityScore}`,
  );
  assert(
    afterInspection.mileage === 30000,
    `車輛主檔里程應更新為複檢回報值 30000（記錄異常但不拒絕交易），實際 ${afterInspection.mileage}`,
  );

  const history = await expectOk('GET', `/api/vehicles/${vin}/history`);
  const anomaly = history.find((event) => event.type === 'ANOMALY' && event.anomalyType === 'MILEAGE_ROLLBACK');
  assert(anomaly !== undefined, 'GetVehicleHistory 應包含一筆 MILEAGE_ROLLBACK 的 ANOMALY 事件');
  assert(anomaly.scoreDelta === -40, `ANOMALY 事件的 scoreDelta 應為 -40，實際 ${anomaly.scoreDelta}`);

  return { vin, integrityScore: afterInspection.integrityScore };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then((result) => {
      console.log('UC-01 通過：', result);
    })
    .catch((err) => {
      console.error('UC-01 失敗：', err);
      process.exitCode = 1;
    });
}
