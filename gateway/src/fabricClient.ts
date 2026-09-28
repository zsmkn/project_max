import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { connect, Contract, Gateway, Identity, Network, Signer, signers } from '@hyperledger/fabric-gateway';

import { type OrgCode, type OrgFabricConfig, config, orgConfigs } from './config.js';

// 建立 gRPC 連線、Fabric 身分與簽署器，連上各組織 peer 內建的 Fabric Gateway 服務
// （Fabric 2.4+），對應 plan.md「Gateway 語言：Node.js/TypeScript」的決定。
// 本模組只負責「連線」，業務邏輯（查詢／送出交易）留給呼叫端透過回傳的 Contract 操作，
// 避免這個檔案的職責蔓延（CLAUDE.md「小而專注」）。
//
// 階段 5：依角色切換組織身分——鏈碼的寫入函式各自要求特定組織 MSP
// （AddMaintenance 需 SVC、RecordClaim 需 INS、SubmitInspection 需 APP、
// TransferOwnership／ScrapVehicle／InitVehicle 需 REG 或 OEM），因此 Gateway
// 改為維護「每個組織各自一條 gRPC 連線＋身分」的連線池（FabricConnectionPool），
// 而非單一固定身分。五個組織的連線數量固定且不多，採取「首次使用時建立、
// 之後重複使用」（lazy + cache）即可，不需要連線池的借還／逾時等複雜機制。

async function newGrpcConnection(orgConfig: OrgFabricConfig): Promise<grpc.Client> {
  const tlsRootCert = await fs.readFile(orgConfig.tlsCertPath);
  const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
  return new grpc.Client(orgConfig.peerEndpoint, tlsCredentials, {
    'grpc.ssl_target_name_override': orgConfig.peerHostAlias,
  });
}

async function newIdentity(orgConfig: OrgFabricConfig): Promise<Identity> {
  const certPath = await soleFileIn(orgConfig.certDirPath);
  const credentials = await fs.readFile(certPath);
  return { mspId: orgConfig.mspId, credentials };
}

async function newSigner(orgConfig: OrgFabricConfig): Promise<Signer> {
  const keyPath = await soleFileIn(orgConfig.keyDirPath);
  const privateKeyPem = await fs.readFile(keyPath);
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  return signers.newPrivateKeySigner(privateKey);
}

// Fabric CA 產生的 signcerts／keystore 目錄底下只會有唯一一個檔案，檔名含雜湊、
// 無法寫死，因此列出目錄取第一個檔案。
async function soleFileIn(dirPath: string): Promise<string> {
  const files = await fs.readdir(dirPath);
  if (files.length === 0) {
    throw new Error(`找不到憑證／私鑰檔案：${dirPath}`);
  }
  return path.join(dirPath, files[0]);
}

export interface FabricConnection {
  org: OrgCode;
  client: grpc.Client;
  gateway: Gateway;
  network: Network;
  contract: Contract;
  close: () => void;
}

async function connectAs(orgConfig: OrgFabricConfig): Promise<FabricConnection> {
  const client = await newGrpcConnection(orgConfig);
  const gateway = connect({
    client,
    identity: await newIdentity(orgConfig),
    signer: await newSigner(orgConfig),
    // 查詢／背書／送出／等待 commit 各自的逾時設定，避免任一階段無限期卡住。
    evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
    endorseOptions: () => ({ deadline: Date.now() + 15000 }),
    submitOptions: () => ({ deadline: Date.now() + 5000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
  });
  const network = gateway.getNetwork(config.fabric.channelName);
  const contract = network.getContract(config.fabric.chaincodeName);

  return {
    org: orgConfig.org,
    client,
    gateway,
    network,
    contract,
    close: () => {
      gateway.close();
      client.close();
    },
  };
}

// FabricConnectionPool 維護每個組織身分各自的 Fabric Gateway 連線，供 routes.ts
// 依鏈碼函式所需的組織身分取用（getConnection('svc') 用於 AddMaintenance 等）。
export class FabricConnectionPool {
  private readonly connections = new Map<OrgCode, FabricConnection>();
  private readonly pending = new Map<OrgCode, Promise<FabricConnection>>();

  // getConnection 回傳（必要時先建立）org 身分的連線；同一組織的並行請求共用同一個
  // 建立中的 Promise，避免重複連線。
  async getConnection(org: OrgCode): Promise<FabricConnection> {
    const existing = this.connections.get(org);
    if (existing) {
      return existing;
    }
    let inFlight = this.pending.get(org);
    if (!inFlight) {
      inFlight = connectAs(orgConfigs[org]).then((conn) => {
        this.connections.set(org, conn);
        this.pending.delete(org);
        return conn;
      });
      this.pending.set(org, inFlight);
    }
    return inFlight;
  }

  closeAll(): void {
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
  }
}
