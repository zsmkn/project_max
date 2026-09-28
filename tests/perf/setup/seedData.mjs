// 階段 7 效能測試的前置資料準備（不計入 Caliper 量測時間）：
//
// 1. 透過 Gateway 內部服務埠（見 gateway/src/server.ts，8080，純 HTTP、無 Kyber TLS
//    限制，與 mocks/ 使用同一個埠）登記一個共用的測試車主 PQC 身分 PERF-OWNER，
//    重用 gateway/src/pqcWallet.ts 既有的金鑰產生與 RegisterPQCKey 上鏈邏輯，
//    避免在測試工具裡重新實作一份金鑰管理。
// 2. 直接讀取 Gateway 金鑰錢包檔案（gateway/wallet/）取出剛產生的私鑰，複製一份到
//    tests/perf/setup/perfOwnerKey.local.json（.gitignore 排除，含私鑰，僅供本機
//    Caliper workload 模組讀取，用來在 AddMaintenance 交易的高頻迴圈中就地簽章，
//    不必每筆交易都額外呼叫 Gateway REST API，量測到的才是鏈本身的 TPS）。
// 3. 建立一批種子車輛（InitVehicle），供 addMaintenance／recordClaim／
//    submitInspection／transferOwnership／getSummary／getVehicleHistory 等
//    Caliper 回合重複使用，VIN 清單寫入 tests/perf/setup/seedVehicles.json。
//
// 用法：node setup/seedData.mjs [seedPoolSize]
// 前提：network/ 已啟動並部署 chaincode、gateway/ 已啟動（npm run dev，內部埠 8080）。
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_HOST = process.env.GATEWAY_HOST ?? '127.0.0.1';
const GATEWAY_PORT = Number(process.env.GATEWAY_INTERNAL_HTTP_PORT ?? 8080);
const GATEWAY_WALLET_DIR = process.env.PQC_WALLET_DIR ?? path.resolve(__dirname, '../../../gateway/wallet');

const OWNER_IDENTITY = 'PERF-OWNER';
const SEED_POOL_SIZE = Number(process.argv[2] ?? process.env.SEED_POOL_SIZE ?? 300);

function request(method, urlPath, body) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: GATEWAY_HOST, port: GATEWAY_PORT, path: urlPath, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const parsed = text.length > 0 ? JSON.parse(text) : undefined;
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`${method} ${urlPath} -> ${res.statusCode}: ${text}`));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  console.log(`=== 登記測試車主 PQC 身分 ${OWNER_IDENTITY} ===`);
  await request('POST', `/api/pqc-keys/${OWNER_IDENTITY}`);

  const keyFileName = Buffer.from(OWNER_IDENTITY, 'utf8').toString('hex') + '.json';
  const keyFilePath = path.join(GATEWAY_WALLET_DIR, keyFileName);
  const storedKey = JSON.parse(await readFile(keyFilePath, 'utf8'));
  const localKeyPath = path.join(__dirname, 'perfOwnerKey.local.json');
  await writeFile(
    localKeyPath,
    JSON.stringify({ identity: OWNER_IDENTITY, publicKeyHex: storedKey.publicKeyHex, secretKeyHex: storedKey.secretKeyHex }, null, 2),
    { mode: 0o600 },
  );
  console.log(`已複製車主金鑰至 ${localKeyPath}（本機測試專用，不進版控）`);

  console.log(`=== 建立 ${SEED_POOL_SIZE} 台種子車輛（InitVehicle） ===`);
  const runId = Date.now();
  const vins = [];
  for (let i = 0; i < SEED_POOL_SIZE; i++) {
    const vin = `PERF-SEED-${runId}-${i}`;
    await request('POST', '/api/vehicles', {
      vin,
      engineSerial: `PERF-ENG-${runId}-${i}`,
      transmissionSerial: `PERF-TRANS-${runId}-${i}`,
      manufactureYear: 2024,
      msrpAmount: 600000,
      ownerHash: OWNER_IDENTITY,
    });
    vins.push(vin);
    if ((i + 1) % 50 === 0) {
      console.log(`  已建立 ${i + 1}/${SEED_POOL_SIZE}`);
    }
  }

  const seedFilePath = path.join(__dirname, 'seedVehicles.json');
  await writeFile(seedFilePath, JSON.stringify({ runId, ownerHash: OWNER_IDENTITY, vins }, null, 2));
  console.log(`已寫入種子車輛清單至 ${seedFilePath}（共 ${vins.length} 台）`);
}

main().catch((err) => {
  console.error('種子資料建立失敗：', err);
  process.exitCode = 1;
});
