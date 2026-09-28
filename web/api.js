// 共用 Gateway API 呼叫封裝（FFR1-4 三種角色介面共用），對應 plan.md §5 階段 5。
// 不使用任何前端框架／建置工具，純 HTML5 + vanilla JS（plan.md §7 #3：網頁層用
// Python + HTML5；Python 僅用於本機簡易靜態伺服器，見 web/README.md）。

// Gateway 使用 Kyber TLS（X25519MLKEM768）自簽憑證，瀏覽器須支援
// TLS 1.3 混合金鑰交換（近期 Chrome／Edge／Firefox 皆已支援，見 docs/stage0-validation.md），
// 且第一次連線需手動接受自簽憑證警告（見 web/README.md）。
// plan_dApp.md D0：網頁改由 Gateway 同源提供（https://localhost:8443/owner.html），預設呼叫
// 同源 API，瀏覽器不會因跨來源（CORS）擋下請求；另開靜態伺服器時才退回舊的預設位址。
const GATEWAY_BASE_URL =
  window.localStorage.getItem('gatewayBaseUrl') ||
  (window.location.protocol === 'https:' ? '' : 'https://localhost:8443');

// apiCall 統一處理 JSON 請求／錯誤訊息／耗時量測（NFR2 初驗：查詢延遲 < 1 秒，
// 呼叫端可用回傳值的 elapsedMs 自行顯示）。錯誤訊息一律取自 Gateway 回傳的
// { error } 欄位（Gateway 已確保不外洩內部路徑／金鑰，見 routes.ts）。
async function apiCall(path, options = {}) {
  const startedAt = performance.now();
  let response;
  try {
    response = await fetch(`${GATEWAY_BASE_URL}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  } catch (err) {
    throw new Error(
      `無法連線到 Gateway（${GATEWAY_BASE_URL}）：${err.message}。` +
        '若是第一次使用，請先在瀏覽器分頁開啟該網址並接受自簽憑證警告，見 web/README.md。',
    );
  }
  const elapsedMs = Math.round(performance.now() - startedAt);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = (data && data.error) || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return { data, elapsedMs };
}

const api = {
  // 託管錢包模式（私鑰在 Gateway，保留供展示備援）。
  registerPQCKey: (identity) => apiCall(`/api/pqc-keys/${encodeURIComponent(identity)}`, { method: 'POST' }),
  // 自持金鑰模式（plan_dApp.md D1）：瀏覽器送出公鑰與持有證明／換鑰簽章，Gateway 只代送交易。
  registerSelfCustodyKey: (identity, body) =>
    apiCall(`/api/pqc-keys/${encodeURIComponent(identity)}/register`, { method: 'POST', body: JSON.stringify(body) }),
  // 鏈上 GetPQCKey；尚未登記時回傳 null（而非拋錯），方便呼叫端判斷「第一次登記」。
  getOnChainPQCKey: async (identity) => {
    try {
      return (await apiCall(`/api/pqc-keys/${encodeURIComponent(identity)}`)).data;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  },
  submitMaintenance: (vin, body) =>
    apiCall(`/api/vehicles/${encodeURIComponent(vin)}/maintenance`, { method: 'POST', body: JSON.stringify(body) }),
  // plan_dApp.md D2：查詢授權的內容定址轉交（QR 只放 ID，見 gateway/src/authorizationStore.ts）。
  storeQueryAuthorization: (body) => apiCall('/api/query-authorizations', { method: 'POST', body: JSON.stringify(body) }),
  fetchQueryAuthorization: (id) => apiCall(`/api/query-authorizations/${encodeURIComponent(id)}`),
  // plan_dApp.md D3：Server-Sent Events 端點網址，交給瀏覽器原生 EventSource。
  vehicleEventsUrl: (vin) => `${GATEWAY_BASE_URL}/api/vehicles/${encodeURIComponent(vin)}/events`,
  pqcKeyEventsUrl: (identity) => `${GATEWAY_BASE_URL}/api/pqc-keys/${encodeURIComponent(identity)}/events`,
  getSummary: (vin) => apiCall(`/api/vehicles/${encodeURIComponent(vin)}/summary`),
  getHistory: (vin, from = '', to = '') =>
    apiCall(`/api/vehicles/${encodeURIComponent(vin)}/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  authorizeMaintenance: (vin, body) =>
    apiCall(`/api/vehicles/${encodeURIComponent(vin)}/maintenance/authorize`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  submitInspection: (vin, body) =>
    apiCall(`/api/vehicles/${encodeURIComponent(vin)}/inspections`, { method: 'POST', body: JSON.stringify(body) }),
  createQueryAuthorization: (vin, body) =>
    apiCall(`/api/vehicles/${encodeURIComponent(vin)}/query-authorization`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  verifyQueryAuthorization: (vin, params) =>
    apiCall(`/api/vehicles/${encodeURIComponent(vin)}/query-authorization/verify?${new URLSearchParams(params)}`),
};

// EventType 對照人類可讀標籤（與 chaincode/vehicle/contract/model.go 的 EventType 一致）。
const EVENT_TYPE_LABELS = {
  INIT: '出廠初始化',
  MAINTENANCE: '保養／維修',
  CLAIM: '保險理賠',
  INSPECTION: '複檢',
  TRANSFER: '過戶',
  SCRAP: '報廢',
  ANOMALY: '⚠ 異常',
};

// renderHistoryTable 把 GetVehicleHistory 的事件陣列畫成表格，ANOMALY 事件以紅字標示
// （FFR4：不只鑑定師頁面送出時要警示，任何人查看履歷時異常紀錄本身也要顯眼）。
function renderHistoryTable(events) {
  if (!events || events.length === 0) {
    return '<p class="muted">尚無事件紀錄</p>';
  }
  const rows = events
    .map((e) => {
      const isAnomaly = e.type === 'ANOMALY';
      const label = EVENT_TYPE_LABELS[e.type] || e.type;
      const detail = [
        e.serviceType && `服務：${e.serviceType}`,
        e.mileage !== undefined && `里程：${e.mileage}`,
        e.claimId && `理賠編號：${e.claimId}`,
        e.incidentType && `事故類型：${e.incidentType}`,
        e.anomalyType && `異常類型：${e.anomalyType}`,
        e.scoreDelta !== undefined && `分數變動：${e.scoreDelta}`,
        e.description && `說明：${escapeHtml(e.description)}`,
      ]
        .filter(Boolean)
        .join('　');
      // plan_dApp.md D2：顯示交易編號，使用者可向任一組織的 peer 交叉查證，不必只相信這台 Gateway。
      return `<tr class="${isAnomaly ? 'anomaly-row' : ''}">
        <td>${escapeHtml(e.timestamp)}</td>
        <td>${escapeHtml(label)}</td>
        <td>${escapeHtml(e.submittingOrg || '')}</td>
        <td>${detail}</td>
        <td class="tx-id" title="${escapeHtml(e.txId || '')}">${escapeHtml((e.txId || '').slice(0, 12))}…</td>
      </tr>`;
    })
    .join('');
  return `<table class="history-table">
    <thead><tr><th>時間</th><th>事件</th><th>提交組織</th><th>內容</th><th>交易編號</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
