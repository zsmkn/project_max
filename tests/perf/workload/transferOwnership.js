'use strict';
// TransferOwnership（BFR2，REG）：每筆交易都指定一個新的車主雜湊，避免鏈碼「新車主與
// 現有車主相同」的檢查擋下交易（見 contract.go TransferOwnership）。
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { loadSeedVehicles, makeVinPicker } = require('../lib/seedPool.js');

class TransferOwnershipWorkload extends WorkloadModuleBase {
  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
    const { vins } = loadSeedVehicles();
    this.pickVin = makeVinPicker(vins, workerIndex, totalWorkers);
    this.runId = Date.now();
    this.txIndex = 0;
  }

  async submitTransaction() {
    const vin = this.pickVin();
    const newOwnerHash = `PERF-OWNER-${this.runId}-${this.workerIndex}-${this.txIndex}`;
    this.txIndex += 1;

    const request = {
      contractId: 'vehicle',
      contractFunction: 'TransferOwnership',
      contractArguments: [vin, newOwnerHash],
      invokerIdentity: 'User1',
      invokerMspId: 'REGMSP',
      readOnly: false,
    };
    await this.sutAdapter.sendRequests(request);
  }
}

function createWorkloadModule() {
  return new TransferOwnershipWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
