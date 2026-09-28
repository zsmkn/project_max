import { EventEmitter } from 'node:events';
import type { ChaincodeEvent } from '@hyperledger/fabric-gateway';

import { config } from './config.js';
import type { FabricConnectionPool } from './fabricClient.js';

// 鏈碼事件訂閱（plan_dApp.md D3）：以 network.getChaincodeEvents() 接收鏈碼 SetEvent 發出的
// VehicleEvent／PQCKeyEvent（見 chaincode/vehicle/contract/events.go），依 VIN／身分分流給
// routes.ts 的 Server-Sent Events 端點，讓車主頁即時看到保養、理賠與異常扣分通知。
// 只有「已提交」區塊內的有效交易會送出事件，背書失敗或驗證失敗的交易不會觸發通知。

export const VEHICLE_EVENT = 'VehicleEvent';
export const PQC_KEY_EVENT = 'PQCKeyEvent';

// 斷線（peer 重啟、網路中斷）後的重新訂閱間隔。
const RESUBSCRIBE_DELAY_MS = 3000;

export function vehicleChannel(vin: string): string {
  return `vehicle:${vin}`;
}

export function pqcKeyChannel(identity: string): string {
  return `pqc:${identity}`;
}

export interface HubMessage {
  eventName: string;
  txId: string;
  blockNumber: string;
  payload: Record<string, unknown>;
}

// ChaincodeEventHub 對每則鏈碼事件，在對應的 channel（vehicleChannel／pqcKeyChannel）上 emit
// 一則 HubMessage。SSE 連線數量不固定，因此取消 EventEmitter 的預設監聽者數量上限。
export class ChaincodeEventHub extends EventEmitter {
  private isStopped = false;
  private closeCurrent: (() => void) | null = null;

  constructor(private readonly pool: FabricConnectionPool) {
    super();
    this.setMaxListeners(0);
  }

  // start 在背景持續訂閱，不阻塞呼叫端；訂閱中斷時等待後重試，直到 stop()。
  start(): void {
    void this.subscribeLoop();
  }

  stop(): void {
    this.isStopped = true;
    this.closeCurrent?.();
  }

  // dispatch 解析單則鏈碼事件並分流；payload 不是合法 JSON 時略過（不影響其他事件）。
  dispatch(event: Pick<ChaincodeEvent, 'eventName' | 'payload' | 'transactionId' | 'blockNumber'>): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(new TextDecoder().decode(event.payload)) as Record<string, unknown>;
    } catch {
      console.warn(`略過無法解析的鏈碼事件 ${event.eventName}（交易 ${event.transactionId}）`);
      return;
    }
    const message: HubMessage = {
      eventName: event.eventName,
      txId: event.transactionId,
      blockNumber: event.blockNumber.toString(),
      payload,
    };
    if (event.eventName === VEHICLE_EVENT && typeof payload.vin === 'string') {
      this.emit(vehicleChannel(payload.vin), message);
    } else if (event.eventName === PQC_KEY_EVENT && typeof payload.identity === 'string') {
      this.emit(pqcKeyChannel(payload.identity), message);
    }
  }

  private async subscribeLoop(): Promise<void> {
    while (!this.isStopped) {
      try {
        const conn = await this.pool.getConnection(config.fabric.defaultQueryOrg);
        const events = await conn.network.getChaincodeEvents(config.fabric.chaincodeName);
        this.closeCurrent = () => events.close();
        console.log('已訂閱鏈碼事件（VehicleEvent／PQCKeyEvent）');
        for await (const event of events) {
          this.dispatch(event);
        }
      } catch (err) {
        if (!this.isStopped) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`鏈碼事件訂閱中斷，${RESUBSCRIBE_DELAY_MS} ms 後重試：${message}`);
        }
      } finally {
        this.closeCurrent = null;
      }
      if (!this.isStopped) {
        await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_DELAY_MS));
      }
    }
  }
}
