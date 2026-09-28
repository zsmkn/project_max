'use strict';
// GetSummary（FFR1／IIR2，查詢，任何組織皆可）：量測查詢延遲（NFR2）。
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { loadSeedVehicles, makeVinPicker } = require('../lib/seedPool.js');

class GetSummaryWorkload extends WorkloadModuleBase {
  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
    const { vins } = loadSeedVehicles();
    this.pickVin = makeVinPicker(vins, workerIndex, totalWorkers);
  }

  async submitTransaction() {
    const vin = this.pickVin();
    const request = {
      contractId: 'vehicle',
      contractFunction: 'GetSummary',
      contractArguments: [vin],
      invokerIdentity: 'User1',
      invokerMspId: 'REGMSP',
      readOnly: true,
    };
    await this.sutAdapter.sendRequests(request);
  }
}

function createWorkloadModule() {
  return new GetSummaryWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
