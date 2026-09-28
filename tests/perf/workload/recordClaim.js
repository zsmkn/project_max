'use strict';
// RecordClaim（BFR2／EIR2，INS）：無 PQC 驗證，用來與 addMaintenance 對照「有無
// Dilithium 簽章驗證」對 TPS 的影響。
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { loadSeedVehicles, makeVinPicker } = require('../lib/seedPool.js');

class RecordClaimWorkload extends WorkloadModuleBase {
  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
    const { vins } = loadSeedVehicles();
    this.pickVin = makeVinPicker(vins, workerIndex, totalWorkers);
    this.runId = Date.now();
    this.txIndex = 0;
  }

  async submitTransaction() {
    const vin = this.pickVin();
    const claimId = `PERF-CLAIM-${this.runId}-${this.workerIndex}-${this.txIndex}`;
    this.txIndex += 1;

    const request = {
      contractId: 'vehicle',
      contractFunction: 'RecordClaim',
      contractArguments: [vin, claimId, 'COLLISION', '20000', 'BUMPER'],
      invokerIdentity: 'User1',
      invokerMspId: 'INSMSP',
      readOnly: false,
    };
    await this.sutAdapter.sendRequests(request);
  }
}

function createWorkloadModule() {
  return new RecordClaimWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
