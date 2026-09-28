import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM 模組沒有 __dirname，改用 import.meta.url 換算。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 集中管理環境變數設定，避免各處拼路徑（CLAUDE.md 編程風格）。
function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const networkHome = path.resolve(__dirname, '../../network');

// 五個業務組織代號，對應 network/scripts/orgs.sh 的 PEER_ORG_CODES；
// Gateway 依角色（呼叫哪個鏈碼函式）決定要用哪個組織身分送出交易（階段 5）。
export const ORG_CODES = ['reg', 'oem', 'svc', 'ins', 'app'] as const;
export type OrgCode = (typeof ORG_CODES)[number];

export interface OrgFabricConfig {
  org: OrgCode;
  mspId: string;
  peerEndpoint: string;
  peerHostAlias: string;
  tlsCertPath: string;
  certDirPath: string;
  keyDirPath: string;
}

// 對應 network/scripts/orgs.sh 的 ORG_MSP／ORG_PEER_PORT。
const ORG_MSP_ID: Record<OrgCode, string> = {
  reg: 'REGMSP',
  oem: 'OEMMSP',
  svc: 'SVCMSP',
  ins: 'INSMSP',
  app: 'APPMSP',
};
const ORG_PEER_PORT: Record<OrgCode, number> = {
  reg: 7051,
  oem: 8051,
  svc: 9051,
  ins: 10051,
  app: 11051,
};

// 每個組織各自的 peer 連線設定，皆以 User1@{org}.vehiclenet.tw 身分連線
// （對應 network/organizations/peerOrganizations/{org}.vehiclenet.tw/users/User1@...，
// 五個組織皆有此身分，見 docs/stage5-gateway-web.md）。環境變數可用
// `FABRIC_<ORG>_*`（大寫組織代號）分別覆寫，未設定時使用以下依組織代號推導的預設值。
function orgFabricConfig(org: OrgCode): OrgFabricConfig {
  const domain = 'vehiclenet.tw';
  const orgHome = path.join(networkHome, `organizations/peerOrganizations/${org}.${domain}`);
  const envPrefix = `FABRIC_${org.toUpperCase()}_`;
  return {
    org,
    mspId: env(`${envPrefix}MSP_ID`, ORG_MSP_ID[org]),
    // peer0.{org} 同時提供 endorser 與 Fabric Gateway 服務（Fabric 2.4+ 內建）。
    peerEndpoint: env(`${envPrefix}PEER_ENDPOINT`, `localhost:${ORG_PEER_PORT[org]}`),
    peerHostAlias: env(`${envPrefix}PEER_HOST_ALIAS`, `peer0.${org}.${domain}`),
    tlsCertPath: env(`${envPrefix}TLS_CERT_PATH`, path.join(orgHome, `tlsca/tlsca.${org}.${domain}-cert.pem`)),
    certDirPath: env(`${envPrefix}CERT_DIR`, path.join(orgHome, `users/User1@${org}.${domain}/msp/signcerts`)),
    keyDirPath: env(`${envPrefix}KEY_DIR`, path.join(orgHome, `users/User1@${org}.${domain}/msp/keystore`)),
  };
}

export const orgConfigs: Record<OrgCode, OrgFabricConfig> = Object.fromEntries(
  ORG_CODES.map((org) => [org, orgFabricConfig(org)]),
) as Record<OrgCode, OrgFabricConfig>;

export const config = {
  fabric: {
    channelName: env('FABRIC_CHANNEL_NAME', 'vehiclechannel'),
    chaincodeName: env('FABRIC_CHAINCODE_NAME', 'vehicle'),
    // 查詢類交易（GetSummary／GetVehicleHistory）任何組織皆可執行，固定用 REG
    // （監理站，中立單位）身分送出，避免每次查詢都要指定組織。
    defaultQueryOrg: (env('FABRIC_DEFAULT_QUERY_ORG', 'reg') as OrgCode),
  },
  wallet: {
    // PQC 金鑰錢包：PoC 階段私鑰存於 Gateway 本機（plan.md §7 #5，已定案的簡化）。
    // 目錄名稱 "wallet" 對應 .gitignore 的 **/wallet/ 規則，避免私鑰誤入版控。
    dir: env('PQC_WALLET_DIR', path.resolve(__dirname, '../wallet')),
  },
  server: {
    httpsPort: Number(env('GATEWAY_HTTPS_PORT', '8443')),
    // .pem 副檔名對應 .gitignore 的 *.pem 規則，確保自簽憑證／私鑰不會被提交。
    tlsCertPath: env('GATEWAY_TLS_CERT_PATH', path.resolve(__dirname, '../certs/gateway-cert.pem')),
    tlsKeyPath: env('GATEWAY_TLS_KEY_PATH', path.resolve(__dirname, '../certs/gateway-key.pem')),
    // 階段 6：EIR1／EIR2 模擬服務（mocks/）走的內部服務埠，見 server.ts 的說明——
    // 只綁定 loopback，不套用 Kyber-only 的 X25519MLKEM768 限制（BFR4／IIR1 範圍
    // 是「瀏覽器／客戶端 ↔ Gateway」邊界，不含後端對後端的 EIR 整合）。
    internalHttpPort: Number(env('GATEWAY_INTERNAL_HTTP_PORT', '8080')),
    // plan_dApp.md D0：web/ 由 Gateway 同源提供（express.static），不需要 CORS。
    webDir: env('GATEWAY_WEB_DIR', path.resolve(__dirname, '../../web')),
  },
};
