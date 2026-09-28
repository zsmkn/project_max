'use strict';
// InitVehicle（BFR1，OEM）：無需既有狀態，每筆交易用全新 VIN，量測「最單純寫入」
// 的基準 TPS／延遲，作為與其餘（需要既有狀態或 PQC 驗證）函式比較的對照組。
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

class InitVehicleWorkload extends WorkloadModuleBase {
  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
    this.runId = Date.now();
    this.txIndex = 0;
  }

  async submitTransaction() {
    const vin = `PERF-INIT-${this.runId}-${this.workerIndex}-${this.txIndex}`;
    this.txIndex += 1;

    const request = {
      contractId: 'vehicle',
      contractFunction: 'InitVehicle',
      contractArguments: [
        vin,
        `PERF-ENG-${vin}`,
        `PERF-TRANS-${vin}`,
        '2024',
        '600000',
        'PERF-OWNER',
      ],
      invokerIdentity: 'User1',
      invokerMspId: 'OEMMSP',
      readOnly: false,
    };
    await this.sutAdapter.sendRequests(request);
  }
}

function createWorkloadModule() {
  return new InitVehicleWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
