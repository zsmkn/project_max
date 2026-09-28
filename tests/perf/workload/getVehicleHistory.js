'use strict';
// GetVehicleHistory（FFR1／IIR2，查詢，任何組織皆可）：區間查詢，量測查詢延遲（NFR2）。
// 此時種子車輛已累積 addMaintenance／recordClaim／submitInspection／transferOwnership
// 各回合的事件，比 getSummary 的單鍵讀取更貼近真實「完整履歷查詢」的負載特性。
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { loadSeedVehicles, makeVinPicker } = require('../lib/seedPool.js');

class GetVehicleHistoryWorkload extends WorkloadModuleBase {
  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
    const { vins } = loadSeedVehicles();
    this.pickVin = makeVinPicker(vins, workerIndex, totalWorkers);
  }

  async submitTransaction() {
    const vin = this.pickVin();
    const request = {
      contractId: 'vehicle',
      contractFunction: 'GetVehicleHistory',
      contractArguments: [vin, '', ''],
      invokerIdentity: 'User1',
      invokerMspId: 'REGMSP',
      readOnly: true,
    };
    await this.sutAdapter.sendRequests(request);
  }
}

function createWorkloadModule() {
  return new GetVehicleHistoryWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
