'use strict';
// ScrapVehicle（BFR2／EIR1，REG）：鏈碼拒絕對已報廢車輛重複報廢（見 contract.go），
// 因此本回合必須放在 benchmarkConfig.yaml 的最後一個回合，且交易總數不可超過種子車輛池
// 大小（tests/perf/setup/seedVehicles.json 的 vins.length），確保每台種子車輛只會被
// 報廢恰好一次（lib/seedPool.js 的 round-robin 配置在總交易數 <= 池大小時保證不重複）。
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { loadSeedVehicles, makeVinPicker } = require('../lib/seedPool.js');

class ScrapVehicleWorkload extends WorkloadModuleBase {
  async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
    await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
    const { vins } = loadSeedVehicles();
    this.pickVin = makeVinPicker(vins, workerIndex, totalWorkers);
  }

  async submitTransaction() {
    const vin = this.pickVin();

    const request = {
      contractId: 'vehicle',
      contractFunction: 'ScrapVehicle',
      contractArguments: [vin, 'Caliper 效能測試報廢'],
      invokerIdentity: 'User1',
      invokerMspId: 'REGMSP',
      readOnly: false,
    };
    await this.sutAdapter.sendRequests(request);
  }
}

function createWorkloadModule() {
  return new ScrapVehicleWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
