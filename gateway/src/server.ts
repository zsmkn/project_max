import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { Express } from 'express';

import { config } from './config.js';

// Kyber TLS 邊界（BFR4）：docs/stage0-validation.md 的結論——Node.js 22（OpenSSL 3.5+）
// 原生支援 X25519MLKEM768（X25519 與 ML-KEM-768 的混合金鑰交換），比原計畫的
// liboqs + oqs-provider + nginx 更輕量，優先採用此路線；liboqs 仍保留為備案
// （例如需要純 Kyber-768、或用戶端環境不支援混合群組時）。
//
// 只設定 X25519MLKEM768（不含傳統群組作為備援），刻意讓不支援後量子混合金鑰
// 交換的用戶端連線失敗，對應 UC-02 例外流程「握手失敗時拒絕連線」。
const KYBER_GROUP = 'X25519MLKEM768';

export function createHttpsServer(app: Express): https.Server {
  const options: https.ServerOptions = {
    cert: fs.readFileSync(config.server.tlsCertPath),
    key: fs.readFileSync(config.server.tlsKeyPath),
    minVersion: 'TLSv1.3',
    ecdhCurve: KYBER_GROUP,
  };
  return https.createServer(options, app);
}

// 階段 6：EIR1（監理站）／EIR2（保險公司）模擬服務（mocks/）用的內部服務埠——純
// HTTP、不套用上面的 Kyber-only TLS 限制。原因：
// 1. 範圍界線——BFR4／IIR1 的 Kyber TLS 要求鎖定在「瀏覽器／客戶端 ↔ Gateway」這個
//    面向使用者的公開邊界（plan.md §2 #2），EIR 模擬服務是後端對後端的系統整合，
//    不在此邊界範圍內。
// 2. 環境現實——mocks/ 以 Python 3.10 撰寫（plan.md §7 #3），WSL2 Ubuntu 22.04
//    系統內建的 OpenSSL 3.0.2 尚不支援 X25519MLKEM768（見 docs/stage0-validation.md
//    的 Go／Node.js 驗證只涵蓋這兩個執行環境），Python 用戶端無法完成 Kyber-only
//    的 TLS 握手；改用純 HTTP 讓模擬服務得以運作，不影響 BFR4 本身已驗證的邊界。
// 只綁定 127.0.0.1（呼叫端見 index.ts），不對外開放，降低繞過 TLS 邊界的疑慮。
export function createInternalHttpServer(app: Express): http.Server {
  return http.createServer(app);
}
