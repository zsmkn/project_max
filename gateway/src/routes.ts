import express, { type Express, type Request, type Response } from 'express';

import type { FabricConnection, FabricConnectionPool } from './fabricClient.js';
import {
  maintenanceAuthorizationMessage,
  pqcKeyRegistrationMessage,
  pqcKeyRotationMessage,
  queryAuthorizationMessage,
} from './authorizationMessages.js';
import type { QueryAuthorizationStore } from './authorizationStore.js';
import { config } from './config.js';
import { userFacingErrorMessage } from './gatewayErrors.js';
import { type ChaincodeEventHub, type HubMessage, pqcKeyChannel, vehicleChannel } from './events.js';
import * as pqcWallet from './pqcWallet.js';

// REST API（階段 3／5）。
//
// 階段 5：依角色切換組織身分（BFR2、FFR2、FFR3、UC-01/02/03）——鏈碼的寫入函式各自
// 要求特定組織 MSP 身分呼叫（見 chaincode/vehicle/contract/contract.go 的 requireOrg），
// Gateway 透過 FabricConnectionPool 依函式對應的組織送出交易，而不是單一固定身分。
// 查詢類交易（GetSummary／GetVehicleHistory）任何組織皆可執行，統一用
// config.fabric.defaultQueryOrg。

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      // 取出鏈碼設計給使用者看的中文拒絕原因（見 gatewayErrors.ts），不外洩內部細節。
      res.status(502).json({ error: userFacingErrorMessage(err) });
    });
  };
}

interface OnChainPQCKey {
  identity: string;
  algorithm: string;
  publicKeyHex: string;
  registeredAt: string;
  version: number;
}

// queryPQCKey 查詢鏈上 GetPQCKey；尚未登記時回傳 null（其餘錯誤照常拋出）。
async function queryPQCKey(conn: FabricConnection, identity: string): Promise<OnChainPQCKey | null> {
  try {
    const result = await conn.contract.evaluateTransaction('GetPQCKey', identity);
    return JSON.parse(new TextDecoder().decode(result)) as OnChainPQCKey;
  } catch (err) {
    if (userFacingErrorMessage(err).includes('尚未登記')) {
      return null;
    }
    throw err;
  }
}

// openEventStream 以 Server-Sent Events 推送 hub 上某個 channel 的訊息（plan_dApp.md D3）。
// SSE 為單向、瀏覽器原生 EventSource 即可接收並自動重連，比 WebSocket 簡單。
function openEventStream(req: Request, res: Response, hub: ChaincodeEventHub, channel: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const listener = (message: HubMessage) => {
    res.write(`event: ${message.eventName}\ndata: ${JSON.stringify(message)}\n\n`);
  };
  hub.on(channel, listener);
  // 定期送註解行，避免閒置連線被中間設備或瀏覽器視為逾時。
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    hub.off(channel, listener);
  });
}

export interface AppOptions {
  // isInternal 為 true 時是只綁定 loopback 的內部服務埠（見 server.ts），額外開放僅限監理站
  // 使用的 REG 管理端點（強制重綁）；對外的 Kyber TLS 埠則額外提供 web/ 靜態頁面。
  isInternal: boolean;
}

export interface AppDeps {
  pool: FabricConnectionPool;
  hub: ChaincodeEventHub;
  authorizationStore: QueryAuthorizationStore;
}

export function createApp({ pool, hub, authorizationStore }: AppDeps, options: AppOptions): Express {
  const app = express();
  app.use(express.json());

  // plan_dApp.md D0／plan-aws.md §4 #2：網頁改由 Gateway 同源提供，瀏覽器呼叫 API 不再跨來源，
  // 不需要 CORS 標頭，也只需接受一次 Gateway 自簽憑證。
  if (!options.isInternal) {
    app.use(express.static(config.server.webDir));
  }

  // POST /api/pqc-keys/:identity（託管錢包模式，保留供 e2e 測試與展示備援，plan_dApp.md D1）
  // 在 Gateway 錢包為 identity 產生新金鑰並登記上鏈。鏈碼要求（plan_dApp.md §2）：
  // 第一次登記附新私鑰的持有證明；已登記則以錢包內的舊私鑰簽署換鑰授權。
  // 上鏈成功後才寫入錢包，避免錢包與鏈上公鑰不一致。
  app.post(
    '/api/pqc-keys/:identity',
    asyncHandler(async (req, res) => {
      const { identity } = req.params;
      const conn = await pool.getConnection(config.fabric.defaultQueryOrg);
      const current = await queryPQCKey(conn, identity);
      const pair = pqcWallet.newKeyPair();
      const proofSignatureHex = current
        ? await pqcWallet.sign(identity, pqcKeyRotationMessage(identity, current.version, pair.publicKeyHex))
        : pqcWallet.signWithSecretKey(pair.secretKeyHex, pqcKeyRegistrationMessage(identity, pair.publicKeyHex));
      await conn.contract.submitTransaction('RegisterPQCKey', identity, pair.publicKeyHex, proofSignatureHex);
      await pqcWallet.saveKey(identity, pair);
      res.status(201).json({ identity, publicKeyHex: pair.publicKeyHex });
    }),
  );

  // POST /api/pqc-keys/:identity/register（自持金鑰模式，plan_dApp.md D1）
  // body: { publicKeyHex, proofSignatureHex }
  // 瀏覽器自行產生金鑰與簽章，Gateway 只代為送出交易，全程看不到私鑰。
  // proofSignatureHex：第一次登記為新私鑰的持有證明；換鑰為舊私鑰對換鑰訊息的簽章。
  app.post(
    '/api/pqc-keys/:identity/register',
    asyncHandler(async (req, res) => {
      const { publicKeyHex, proofSignatureHex } = req.body as { publicKeyHex?: string; proofSignatureHex?: string };
      if (!publicKeyHex || !proofSignatureHex) {
        res.status(400).json({ error: 'publicKeyHex、proofSignatureHex 皆為必填' });
        return;
      }
      const conn = await pool.getConnection(config.fabric.defaultQueryOrg);
      await conn.contract.submitTransaction('RegisterPQCKey', req.params.identity, publicKeyHex, proofSignatureHex);
      res.status(201).json({ identity: req.params.identity, publicKeyHex });
    }),
  );

  // GET /api/pqc-keys/:identity
  // 回傳鏈上 GetPQCKey 的公鑰（plan_dApp.md D2：買家瀏覽器據此自行驗證車主簽章）。
  app.get(
    '/api/pqc-keys/:identity',
    asyncHandler(async (req, res) => {
      const { identity } = req.params;
      const conn = await pool.getConnection(config.fabric.defaultQueryOrg);
      const key = await queryPQCKey(conn, identity);
      if (!key) {
        res.status(404).json({ error: `身分 ${identity} 尚未在鏈上登記 PQC 公鑰` });
        return;
      }
      res.json(key);
    }),
  );

  // GET /api/pqc-keys/:identity/events（SSE，plan_dApp.md D3）：公鑰登記／換鑰／強制重綁通知。
  app.get('/api/pqc-keys/:identity/events', (req, res) => {
    openEventStream(req, res, hub, pqcKeyChannel(req.params.identity));
  });

  // POST /api/pqc-keys/:identity/force-rebind（僅內部服務埠，REG 組織身分）
  // body: { publicKeyHex, proofSignatureHex, reason }
  // 私鑰遺失時由監理站線下核對身分後強制重綁（plan_dApp.md §6 #3 已定案）。只掛在 loopback
  // 內部埠，外部瀏覽器無法透過 Gateway 代用 REG 身分觸發（PoC 未實作登入，見 web/README.md）。
  if (options.isInternal) {
    app.post(
      '/api/pqc-keys/:identity/force-rebind',
      asyncHandler(async (req, res) => {
        const { publicKeyHex, proofSignatureHex, reason } = req.body as {
          publicKeyHex?: string;
          proofSignatureHex?: string;
          reason?: string;
        };
        if (!publicKeyHex || !proofSignatureHex || !reason) {
          res.status(400).json({ error: 'publicKeyHex、proofSignatureHex、reason 皆為必填' });
          return;
        }
        const conn = await pool.getConnection('reg');
        await conn.contract.submitTransaction(
          'ForceRebindPQCKey',
          req.params.identity,
          publicKeyHex,
          proofSignatureHex,
          reason,
        );
        res.status(201).json({ identity: req.params.identity, publicKeyHex, reason });
      }),
    );
  }

  // POST /api/query-authorizations（plan_dApp.md D2）
  // body: { vin, ownerIdentity, expiresAt, signatureHex }（車主瀏覽器已簽好的查詢授權）
  // 暫存完整授權並回傳內容定址 ID，QR Code 只放這個 ID（簽章太大放不進 QR，見 authorizationStore.ts）。
  // 此處不驗章：驗章是買家瀏覽器的工作，Gateway 只負責轉交。
  app.post(
    '/api/query-authorizations',
    asyncHandler(async (req, res) => {
      const { vin, ownerIdentity, expiresAt, signatureHex } = req.body as Record<string, unknown>;
      const fields = { vin, ownerIdentity, expiresAt, signatureHex };
      const missing = Object.entries(fields).filter(([, v]) => typeof v !== 'string' || v === '');
      if (missing.length > 0) {
        res.status(400).json({ error: `缺少必填欄位：${missing.map(([k]) => k).join('、')}` });
        return;
      }
      try {
        const id = await authorizationStore.put(fields as Record<keyof typeof fields, string>);
        res.status(201).json({ id });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : '查詢授權格式錯誤' });
      }
    }),
  );

  // GET /api/query-authorizations/:id：取回暫存的查詢授權，買家須自行重算 ID 比對內容。
  app.get('/api/query-authorizations/:id', (req, res) => {
    const authorization = authorizationStore.get(req.params.id);
    if (!authorization) {
      res.status(404).json({ error: '查詢授權不存在或已過期，請車主重新產生 QR Code' });
      return;
    }
    res.json(authorization);
  });

  // GET /api/vehicles/:vin/events（SSE，plan_dApp.md D3）：該車的保養、理賠、複檢、過戶、
  // 報廢事件，以及評分引擎偵測到的異常扣分（UC-01）。
  app.get('/api/vehicles/:vin/events', (req, res) => {
    openEventStream(req, res, hub, vehicleChannel(req.params.vin));
  });

  // POST /api/vehicles（BFR1，UC-03 前半段）
  // body: { vin, engineSerial, transmissionSerial, manufactureYear, msrpAmount, ownerHash }
  app.post(
    '/api/vehicles',
    asyncHandler(async (req, res) => {
      const b = req.body as Record<string, unknown>;
      const missing = ['vin', 'engineSerial', 'transmissionSerial', 'manufactureYear', 'msrpAmount', 'ownerHash'].filter(
        (k) => b[k] === undefined || b[k] === null || b[k] === '',
      );
      if (missing.length > 0) {
        res.status(400).json({ error: `缺少必填欄位：${missing.join('、')}` });
        return;
      }
      const conn = await pool.getConnection('oem');
      await conn.contract.submitTransaction(
        'InitVehicle',
        String(b.vin),
        String(b.engineSerial),
        String(b.transmissionSerial),
        String(b.manufactureYear),
        String(b.msrpAmount),
        String(b.ownerHash),
      );
      res.status(201).json({ vin: b.vin });
    }),
  );

  // GET /api/vehicles/:vin/summary（FFR1／IIR2）
  app.get(
    '/api/vehicles/:vin/summary',
    asyncHandler(async (req, res) => {
      const conn = await pool.getConnection(config.fabric.defaultQueryOrg);
      const result = await conn.contract.evaluateTransaction('GetSummary', req.params.vin);
      res.type('application/json').send(Buffer.from(result));
    }),
  );

  // GET /api/vehicles/:vin/history?from=&to=（RFC3339，可省略，FFR1／IIR2）
  app.get(
    '/api/vehicles/:vin/history',
    asyncHandler(async (req, res) => {
      const from = typeof req.query.from === 'string' ? req.query.from : '';
      const to = typeof req.query.to === 'string' ? req.query.to : '';
      const conn = await pool.getConnection(config.fabric.defaultQueryOrg);
      const result = await conn.contract.evaluateTransaction('GetVehicleHistory', req.params.vin, from, to);
      res.type('application/json').send(Buffer.from(result));
    }),
  );

  // POST /api/vehicles/:vin/maintenance/authorize
  // body: { ownerIdentity, serviceType, mileage, description }
  // 車主用金鑰錢包中的私鑰，對「本次保養內容」簽章，回傳 message／signatureHex。
  // 這一步**不會**送出鏈上交易；回傳值供下面的 POST .../maintenance 呼叫時附帶
  // （對應 FFR2：先取得車主授權簽章，SVC 端再以自己的組織身分送出交易）。
  app.post(
    '/api/vehicles/:vin/maintenance/authorize',
    asyncHandler(async (req, res) => {
      const { ownerIdentity, serviceType, mileage, description } = req.body as {
        ownerIdentity?: string;
        serviceType?: string;
        mileage?: number;
        description?: string;
      };
      if (!ownerIdentity || !serviceType || typeof mileage !== 'number' || !description) {
        res.status(400).json({ error: 'ownerIdentity、serviceType、mileage、description 皆為必填' });
        return;
      }
      const message = maintenanceAuthorizationMessage(req.params.vin, serviceType, mileage, description);
      const signatureHex = await pqcWallet.sign(ownerIdentity, message);
      res.json({ vin: req.params.vin, serviceType, mileage, description, signatureHex });
    }),
  );

  // POST /api/vehicles/:vin/maintenance（BFR2、FFR2，UC-03 後半段）：SVC 以自己的組織
  // 身分送出 AddMaintenance，附帶上一步取得的車主授權簽章。
  // body: { serviceType, mileage, description, ownerSignatureHex }
  app.post(
    '/api/vehicles/:vin/maintenance',
    asyncHandler(async (req, res) => {
      const { serviceType, mileage, description, ownerSignatureHex } = req.body as {
        serviceType?: string;
        mileage?: number;
        description?: string;
        ownerSignatureHex?: string;
      };
      if (!serviceType || typeof mileage !== 'number' || !description || !ownerSignatureHex) {
        res.status(400).json({ error: 'serviceType、mileage、description、ownerSignatureHex 皆為必填' });
        return;
      }
      const conn = await pool.getConnection('svc');
      await conn.contract.submitTransaction(
        'AddMaintenance',
        req.params.vin,
        serviceType,
        String(mileage),
        description,
        ownerSignatureHex,
      );
      res.status(201).json({ vin: req.params.vin, serviceType, mileage, description });
    }),
  );

  // POST /api/vehicles/:vin/claims（BFR2、EIR2）：INS 組織身分。
  // body: { claimId, incidentType, incidentAmount, incidentPart }
  app.post(
    '/api/vehicles/:vin/claims',
    asyncHandler(async (req, res) => {
      const { claimId, incidentType, incidentAmount, incidentPart } = req.body as {
        claimId?: string;
        incidentType?: string;
        incidentAmount?: number;
        incidentPart?: string;
      };
      if (!claimId || !incidentType || typeof incidentAmount !== 'number' || !incidentPart) {
        res.status(400).json({ error: 'claimId、incidentType、incidentAmount、incidentPart 皆為必填' });
        return;
      }
      const conn = await pool.getConnection('ins');
      await conn.contract.submitTransaction(
        'RecordClaim',
        req.params.vin,
        claimId,
        incidentType,
        String(incidentAmount),
        incidentPart,
      );
      res.status(201).json({ vin: req.params.vin, claimId });
    }),
  );

  // POST /api/vehicles/:vin/inspections（BFR3、FFR3、FFR4，UC-01）：APP 組織身分。
  // 里程倒退不會被拒絕（見 SubmitInspection 的鏈碼註解），回應一律 201；
  // 呼叫端（網頁）應另外查詢 GetVehicleHistory／GetSummary 確認是否新增了 ANOMALY 事件
  // 以顯示紅字警示（FFR4，見 web/appraiser.html）。
  // body: { mileage, findings }
  app.post(
    '/api/vehicles/:vin/inspections',
    asyncHandler(async (req, res) => {
      const { mileage, findings } = req.body as { mileage?: number; findings?: string };
      if (typeof mileage !== 'number' || !findings) {
        res.status(400).json({ error: 'mileage、findings 皆為必填' });
        return;
      }
      const conn = await pool.getConnection('app');
      await conn.contract.submitTransaction('SubmitInspection', req.params.vin, String(mileage), findings);
      res.status(201).json({ vin: req.params.vin, mileage, findings });
    }),
  );

  // POST /api/vehicles/:vin/transfer（BFR2）：REG 組織身分。
  // body: { newOwnerHash }
  app.post(
    '/api/vehicles/:vin/transfer',
    asyncHandler(async (req, res) => {
      const { newOwnerHash } = req.body as { newOwnerHash?: string };
      if (!newOwnerHash) {
        res.status(400).json({ error: 'newOwnerHash 為必填' });
        return;
      }
      const conn = await pool.getConnection('reg');
      await conn.contract.submitTransaction('TransferOwnership', req.params.vin, newOwnerHash);
      res.status(201).json({ vin: req.params.vin, newOwnerHash });
    }),
  );

  // POST /api/vehicles/:vin/scrap（BFR2、EIR1）：REG 組織身分。
  // body: { reason }
  app.post(
    '/api/vehicles/:vin/scrap',
    asyncHandler(async (req, res) => {
      const { reason } = req.body as { reason?: string };
      if (!reason) {
        res.status(400).json({ error: 'reason 為必填' });
        return;
      }
      const conn = await pool.getConnection('reg');
      await conn.contract.submitTransaction('ScrapVehicle', req.params.vin, reason);
      res.status(201).json({ vin: req.params.vin, reason });
    }),
  );

  // POST /api/vehicles/:vin/query-authorization（plan.md §7 #10，UC-02 前置條件）
  // body: { ownerIdentity, validMinutes? }（預設 10 分鐘）
  // 車主簽署「VIN + 有效期限」的短期查詢授權，回傳值即為 QR Code 應編碼的內容。
  app.post(
    '/api/vehicles/:vin/query-authorization',
    asyncHandler(async (req, res) => {
      const { ownerIdentity, validMinutes } = req.body as { ownerIdentity?: string; validMinutes?: number };
      if (!ownerIdentity) {
        res.status(400).json({ error: 'ownerIdentity 為必填' });
        return;
      }
      const minutes = typeof validMinutes === 'number' && validMinutes > 0 ? validMinutes : 10;
      const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
      const message = queryAuthorizationMessage(req.params.vin, expiresAt);
      const signatureHex = await pqcWallet.sign(ownerIdentity, message);
      res.json({ vin: req.params.vin, ownerIdentity, expiresAt, signatureHex });
    }),
  );

  // GET /api/vehicles/:vin/query-authorization/verify?ownerIdentity=&expiresAt=&signatureHex=
  // 確認 QR 內容確實由車主簽署且尚未過期（PoC 示範用途，見 authorizationMessages.ts 的說明：
  // 不是資料存取的硬性關卡）。公鑰取自鏈上 GetPQCKey，因此瀏覽器自持金鑰的車主也適用。
  // plan_dApp.md D2 之後買家頁改在瀏覽器內自行驗證，本端點保留給 e2e 測試與非瀏覽器用戶端。
  app.get(
    '/api/vehicles/:vin/query-authorization/verify',
    asyncHandler(async (req, res) => {
      const ownerIdentity = typeof req.query.ownerIdentity === 'string' ? req.query.ownerIdentity : '';
      const expiresAt = typeof req.query.expiresAt === 'string' ? req.query.expiresAt : '';
      const signatureHex = typeof req.query.signatureHex === 'string' ? req.query.signatureHex : '';
      if (!ownerIdentity || !expiresAt || !signatureHex) {
        res.status(400).json({ error: 'ownerIdentity、expiresAt、signatureHex 皆為必填' });
        return;
      }
      if (new Date(expiresAt).getTime() < Date.now()) {
        res.json({ valid: false, reason: '查詢授權已過期' });
        return;
      }
      const conn = await pool.getConnection(config.fabric.defaultQueryOrg);
      const key = await queryPQCKey(conn, ownerIdentity);
      if (!key) {
        res.json({ valid: false, reason: '車主尚未在鏈上登記 PQC 公鑰' });
        return;
      }
      // 簽署者必須是這台車目前的車主，否則任何人都能用自己的金鑰替別人的車簽授權。
      const summary = JSON.parse(
        new TextDecoder().decode(await conn.contract.evaluateTransaction('GetSummary', req.params.vin)),
      ) as { ownerHash: string };
      if (summary.ownerHash !== ownerIdentity) {
        res.json({ valid: false, reason: '簽署者不是鏈上登記的目前車主' });
        return;
      }
      const message = queryAuthorizationMessage(req.params.vin, expiresAt);
      const valid = pqcWallet.verifyWithPublicKey(key.publicKeyHex, message, signatureHex);
      res.json(valid ? { valid: true } : { valid: false, reason: '簽章驗證失敗' });
    }),
  );

  return app;
}
