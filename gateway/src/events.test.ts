import { describe, expect, it } from 'vitest';

import { ChaincodeEventHub, pqcKeyChannel, vehicleChannel, type HubMessage } from './events.js';
import type { FabricConnectionPool } from './fabricClient.js';

// plan_dApp.md D3：鏈碼事件依 VIN／身分分流，SSE 端點只收到自己訂閱的那一台車。

function newHub(): ChaincodeEventHub {
  return new ChaincodeEventHub({} as FabricConnectionPool);
}

function chaincodeEvent(eventName: string, payload: unknown) {
  return {
    eventName,
    payload: new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    transactionId: 'tx-1',
    blockNumber: 42n,
  };
}

describe('ChaincodeEventHub.dispatch', () => {
  it('routes VehicleEvent to the channel of its VIN only (UC-01 anomaly notification)', () => {
    const hub = newHub();
    const received: HubMessage[] = [];
    const other: HubMessage[] = [];
    hub.on(vehicleChannel('VIN-A'), (m: HubMessage) => received.push(m));
    hub.on(vehicleChannel('VIN-B'), (m: HubMessage) => other.push(m));

    hub.dispatch(
      chaincodeEvent('VehicleEvent', {
        vin: 'VIN-A',
        eventType: 'INSPECTION',
        anomalies: [{ anomalyType: 'MILEAGE_ROLLBACK', scoreDelta: -40 }],
      }),
    );

    expect(other).toHaveLength(0);
    expect(received).toHaveLength(1);
    expect(received[0].txId).toBe('tx-1');
    expect(received[0].blockNumber).toBe('42');
    expect(received[0].payload.anomalies).toEqual([{ anomalyType: 'MILEAGE_ROLLBACK', scoreDelta: -40 }]);
  });

  it('routes PQCKeyEvent to the identity channel (force rebind notification)', () => {
    const hub = newHub();
    const received: HubMessage[] = [];
    hub.on(pqcKeyChannel('owner-1'), (m: HubMessage) => received.push(m));

    hub.dispatch(chaincodeEvent('PQCKeyEvent', { identity: 'owner-1', action: 'FORCE_REBIND' }));

    expect(received).toHaveLength(1);
    expect(received[0].payload.action).toBe('FORCE_REBIND');
  });

  it('ignores events whose payload is not valid JSON instead of throwing', () => {
    const hub = newHub();
    expect(() => hub.dispatch(chaincodeEvent('VehicleEvent', 'not json'))).not.toThrow();
  });
});
