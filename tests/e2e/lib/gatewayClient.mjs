// UC-01/02/03 端到端腳本共用的 Gateway HTTP 用戶端（階段 6）。
//
// 比照 docs/stage5-gateway-web.md 記錄的驗證模式：用 Node.js 的 https 模組直接送出
// 請求，並可指定 ecdhCurve 模擬瀏覽器的 Kyber TLS 設定（預設 X25519MLKEM768，
// 對應 web/api.js 的 fetch() 在真實瀏覽器中的握手行為）。也刻意支援覆寫成其他曲線
// （見 uc02），用來驗證 BFR4「握手失敗時拒絕連線」的例外流程。
import http from 'node:http';
import https from 'node:https';

const KYBER_GROUP = 'X25519MLKEM768';

export const GATEWAY_HOST = process.env.GATEWAY_HOST ?? 'localhost';
export const GATEWAY_PORT = Number(process.env.GATEWAY_HTTPS_PORT ?? 8443);
export const GATEWAY_INTERNAL_PORT = Number(process.env.GATEWAY_INTERNAL_HTTP_PORT ?? 8080);

// request 送出一次 HTTPS 請求，回傳 { statusCode, body }；body 為解析後的 JSON
// （回應內容為空時為 undefined）。TLS 握手失敗會讓回傳的 Promise reject，呼叫端
// （見 uc02）可用它來驗證「不支援的用戶端連線失敗」。
export function request(method, urlPath, body, options = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: options.host ?? GATEWAY_HOST,
        port: options.port ?? GATEWAY_PORT,
        path: urlPath,
        method,
        // 本機開發用自簽憑證，非 CA 簽發，僅供測試環境使用。
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
        ecdhCurve: options.ecdhCurve ?? KYBER_GROUP,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            parsed = text;
          }
          resolve({ statusCode: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// expectOk 送出請求並要求 2xx 狀態碼，否則拋出含狀態碼與回應內容的錯誤，
// 讓 e2e 腳本失敗時能直接看出是哪個步驟、哪個狀態碼失敗。
export async function expectOk(method, urlPath, body, options) {
  const { statusCode, body: responseBody } = await request(method, urlPath, body, options);
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`${method} ${urlPath} 預期成功，實際回傳 ${statusCode}：${JSON.stringify(responseBody)}`);
  }
  return responseBody;
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(`斷言失敗：${message}`);
  }
}

// uniqueVin 產生本次執行專用的測試 VIN，避免重複執行 e2e 腳本時撞到「車輛已存在」。
export function uniqueVin(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0');
  return `${prefix}${stamp}${rand}`;
}

// internalRequest 對 Gateway 的 loopback 內部服務埠（純 HTTP）送出請求，供監理站（REG）限定的
// 端點使用，例如 plan_dApp.md §2 的強制重綁。回傳格式與 request 相同。
export function internalRequest(method, urlPath, body) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: GATEWAY_INTERNAL_PORT,
        path: urlPath,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            parsed = text;
          }
          resolve({ statusCode: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// openEventStream 經 Kyber TLS 連上 Gateway 的 Server-Sent Events 端點（plan_dApp.md D3），
// 行為比照瀏覽器 EventSource。回傳 { ready, next(predicate, timeoutMs), close }：
// ready 在連線建立後 resolve；next 等待下一則符合 predicate 的事件（{ event, data, receivedAt }）。
export function openEventStream(urlPath) {
  const received = [];
  const waiters = [];
  let buffer = '';
  let req;

  const deliver = (message) => {
    received.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  };

  const ready = new Promise((resolve, reject) => {
    req = https.request(
      {
        hostname: GATEWAY_HOST,
        port: GATEWAY_PORT,
        path: urlPath,
        method: 'GET',
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
        ecdhCurve: KYBER_GROUP,
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE ${urlPath} 回傳 ${res.statusCode}`));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let separator;
          while ((separator = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const lines = block.split('\n');
            const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
            const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
            if (event && data) {
              deliver({ event, data: JSON.parse(data), receivedAt: Date.now() });
            }
          }
        });
        resolve();
      },
    );
    req.on('error', reject);
    req.end();
  });

  return {
    ready,
    next(predicate, timeoutMs = 15000) {
      const existing = received.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`${timeoutMs}ms 內未收到符合條件的 SSE 事件（${urlPath}）`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close() {
      req?.destroy();
    },
  };
}
