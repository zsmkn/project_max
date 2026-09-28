'use strict';
// AddMaintenance（BFR2／FFR2／BFR5，SVC）：本專案生命週期函式中最重的一筆——除了
// 一般狀態讀寫，鏈碼還需驗證車主的 ML-DSA-65（Dilithium）簽章
// （chaincode/vehicle/contract/pqc.go verifyDilithiumAuthorization），預期 TPS 會
// 明顯低於不需要 PQC 驗證的函式，量測目的正是要呈現這個落差供報告引用。
//
// 簽章在 workload 本機就地產生（重用 setup/seedData.mjs 複製出的測試車主私鑰），
// 不透過 Gateway REST 的 /maintenance/authorize 端點，避免額外的 HTTP 往返污染
// 量測到的鏈上交易延遲。@noble/post-quantum 僅提供 ESM 套件，因此用動態 import()
// 於非同步的 initializeWorkloadModule 中載入（本檔案仍是 CommonJS，供 Caliper 的
// require() 載入器使用）。
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { loadSeedVehicles, loadPerfOwnerKey, makeVinPicker } = require('../lib/seedPool.js');

function maintenanceAuthorizationMessage(vin, serviceType, mileage, description) {
  const text = `AddMaintenance|${vin}|${serviceType}|${mileage}|${description}`;
  return new TextEncoder().encode(text);
}

class AddMaintenanceWorkload extends WorkloadModuleBase {
  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
    const { vins } = loadSeedVehicles();
    const { secretKeyHex } = loadPerfOwnerKey();
    this.secretKey = Uint8Array.from(Buffer.from(secretKeyHex, 'hex'));
    this.pickVin = makeVinPicker(vins, workerIndex, totalWorkers);
    this.txIndex = 0;

    const { ml_dsa65 } = await import('@noble/post-quantum/ml-dsa.js');
    this.mlDsa65 = ml_dsa65;
  }

  async submitTransaction() {
    const vin = this.pickVin();
    const serviceType = 'OIL_CHANGE';
    const mileage = 10000 + this.txIndex;
    const description = `Caliper 效能測試保養紀錄 #${this.txIndex}`;
    this.txIndex += 1;

    const message = maintenanceAuthorizationMessage(vin, serviceType, mileage, description);
    const signature = this.mlDsa65.sign(message, this.secretKey);
    const ownerSignatureHex = Buffer.from(signature).toString('hex');

    const request = {
      contractId: 'vehicle',
      contractFunction: 'AddMaintenance',
      contractArguments: [vin, serviceType, String(mileage), description, ownerSignatureHex],
      invokerIdentity: 'User1',
      invokerMspId: 'SVCMSP',
      readOnly: false,
    };
    await this.sutAdapter.sendRequests(request);
  }
}

function createWorkloadModule() {
  return new AddMaintenanceWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
