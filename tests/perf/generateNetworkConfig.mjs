// 產生 Caliper 的 networkConfig.yaml（Fabric Gateway 連接器設定）。
//
// 不手寫固定路徑，因為 fabric-ca 簽發的私鑰檔名是隨機雜湊（見
// network/organizations/peerOrganizations/{org}.vehiclenet.tw/users/User1@.../msp/keystore/），
// 每次 network.sh down && up 重新產生憑證後檔名都會變動；比照 gateway/src/config.ts
// 的做法，執行時才動態找出目錄內唯一的檔案。
//
// 輸出的 networkConfig.yaml 屬於機器相依的產生物（含本機絕對路徑），不進版控
// （見 tests/perf/.gitignore），每次要跑 Caliper 前先執行 `npm run config` 重新產生。
import { readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const networkHome = path.resolve(__dirname, '../../network');
const domain = 'vehiclenet.tw';

const ORG_MSP_ID = { reg: 'REGMSP', oem: 'OEMMSP', svc: 'SVCMSP', ins: 'INSMSP', app: 'APPMSP' };
const ORG_PEER_PORT = { reg: 7051, oem: 8051, svc: 9051, ins: 10051, app: 11051 };
const ORG_CODES = ['reg', 'oem', 'svc', 'ins', 'app'];

function singleFileIn(dir) {
  const entries = readdirSync(dir);
  if (entries.length !== 1) {
    throw new Error(`預期 ${dir} 內恰好有 1 個檔案，實際為 ${entries.length} 個`);
  }
  return path.join(dir, entries[0]);
}

function orgBlock(org) {
  const mspid = ORG_MSP_ID[org];
  const orgHome = path.join(networkHome, `organizations/peerOrganizations/${org}.${domain}`);
  const userHome = path.join(orgHome, `users/User1@${org}.${domain}/msp`);
  const clientPrivateKeyPath = singleFileIn(path.join(userHome, 'keystore'));
  const clientSignedCertPath = singleFileIn(path.join(userHome, 'signcerts'));
  const tlsCACertsPath = path.join(orgHome, `tlsca/tlsca.${org}.${domain}-cert.pem`);

  return `  - mspid: ${mspid}
    identities:
      certificates:
        - name: User1
          clientPrivateKey:
            path: ${toYamlPath(clientPrivateKeyPath)}
          clientSignedCert:
            path: ${toYamlPath(clientSignedCertPath)}
    peers:
      - endpoint: localhost:${ORG_PEER_PORT[org]}
        tlsCACerts:
          path: ${toYamlPath(tlsCACertsPath)}
        grpcOptions:
          ssl-target-name-override: peer0.${org}.${domain}
`;
}

// Windows 上 path.join 會產生反斜線，YAML／js-yaml 解析路徑字串時容易誤判跳脫字元；
// 一律轉成正斜線（Node.js 的 fs API 在 Windows 上兩種分隔符號皆可接受）。
function toYamlPath(p) {
  return p.split(path.sep).join('/');
}

const organizations = ORG_CODES.map(orgBlock).join('\n');

const yaml = `# 由 generateNetworkConfig.mjs 產生，請勿手動修改（machine-specific，不進版控）。
name: vehiclenet caliper network config
version: "2.0.0"
caliper:
  blockchain: fabric
  sutOptions:
    mutualTls: false
channels:
  - channelName: vehiclechannel
    contracts:
      - id: vehicle
organizations:
${organizations}`;

const outPath = path.join(__dirname, 'networkConfig.yaml');
await writeFile(outPath, yaml, 'utf8');
console.log(`已產生 ${outPath}`);
