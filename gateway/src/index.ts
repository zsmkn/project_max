import { QueryAuthorizationStore } from './authorizationStore.js';
import { config } from './config.js';
import { ChaincodeEventHub } from './events.js';
import { FabricConnectionPool } from './fabricClient.js';
import { createApp } from './routes.js';
import { createHttpsServer, createInternalHttpServer } from './server.js';

async function main(): Promise<void> {
  const pool = new FabricConnectionPool();
  // 啟動時就把預設查詢組織的連線建立好，讓第一筆查詢請求不用等待連線建立
  // （其餘組織身分的連線在第一次需要時才建立，見 FabricConnectionPool.getConnection）。
  await pool.getConnection(config.fabric.defaultQueryOrg);

  // plan_dApp.md D3：訂閱鏈碼事件，供 SSE 端點即時推播。
  const hub = new ChaincodeEventHub(pool);
  hub.start();

  const deps = { pool, hub, authorizationStore: new QueryAuthorizationStore() };
  const server = createHttpsServer(createApp(deps, { isInternal: false }));
  // 階段 6：EIR1／EIR2 模擬服務（mocks/）用的內部埠，見 server.ts 的說明；另外提供僅限
  // 監理站使用的強制重綁端點（plan_dApp.md §2）。
  const internalServer = createInternalHttpServer(createApp(deps, { isInternal: true }));

  server.listen(config.server.httpsPort, () => {
    console.log(`Gateway 監聽 https://localhost:${config.server.httpsPort}（Kyber TLS：X25519MLKEM768）`);
  });
  internalServer.listen(config.server.internalHttpPort, '127.0.0.1', () => {
    console.log(
      `Gateway 內部服務埠（EIR1／EIR2 模擬服務用，僅限 loopback，無 Kyber TLS 限制）：` +
        `http://127.0.0.1:${config.server.internalHttpPort}`,
    );
  });

  const shutdown = () => {
    console.log('關閉中...');
    hub.stop();
    // SSE 長連線不會自行結束，需主動關閉，否則 server.close 會一直等待。
    server.closeAllConnections();
    internalServer.closeAllConnections();
    server.close(() => {
      internalServer.close(() => {
        pool.closeAll();
        process.exit(0);
      });
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('Gateway 啟動失敗：', err);
  process.exit(1);
});
