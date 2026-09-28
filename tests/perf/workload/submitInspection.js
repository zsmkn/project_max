'use strict';
// SubmitInspection（BFR3／FFR3，APP）：每筆交易都會觸發 scoring.go 的
// recalcAndApply（讀取完整事件歷史、重算誠信分數與殘值），用來量測「連動評分引擎」
// 的寫入函式與單純寫入（如 recordClaim）的 TPS 落差。
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { loadSeedVehicles, makeVinPicker } = require('../lib/seedPool.js');

class SubmitInspectionWorkload extends WorkloadModuleBase {
  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
    const { vins } = loadSeedVehicles();
    this.pickVin = makeVinPicker(vins, workerIndex, totalWorkers);
    this.txIndex = 0;
  }

  async submitTransaction() {
    const vin = this.pickVin();
    // 里程持續遞增，避免觸發里程倒退異常（BFR3 扣分邏輯）干擾 TPS 量測本身。
    const mileage = 20000 + this.txIndex * 10;
    this.txIndex += 1;

    const request = {
      contractId: 'vehicle',
      contractFunction: 'SubmitInspection',
      contractArguments: [vin, String(mileage), `Caliper 效能測試複檢 #${this.txIndex}`],
      invokerIdentity: 'User1',
      invokerMspId: 'APPMSP',
      readOnly: false,
    };
    await this.sutAdapter.sendRequests(request);
  }
}

function createWorkloadModule() {
  return new SubmitInspectionWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
