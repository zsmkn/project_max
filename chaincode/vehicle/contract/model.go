package contract

// CouchDB 文件類型標記，供 rich query 依 docType 篩選（VEH／EVT／PART／PQC 共用同一命名空間）。
const (
	docTypeVehicle = "vehicle"
	docTypeEvent   = "event"
	docTypePart    = "part"
	docTypePQCKey  = "pqcKey"

	docTypePQCKeyLog = "pqcKeyLog"
)

// VehicleStatus 車輛狀態列舉。
type VehicleStatus string

const (
	VehicleStatusActive   VehicleStatus = "ACTIVE"
	VehicleStatusScrapped VehicleStatus = "SCRAPPED"
)

// EventType 生命週期事件類型列舉，對應 plan.md §3.1 的合約函式。
type EventType string

const (
	EventTypeInit        EventType = "INIT"
	EventTypeMaintenance EventType = "MAINTENANCE"
	EventTypeClaim       EventType = "CLAIM"
	EventTypeInspection  EventType = "INSPECTION"
	EventTypeTransfer    EventType = "TRANSFER"
	EventTypeScrap       EventType = "SCRAP"
	EventTypeAnomaly     EventType = "ANOMALY"
)

// Vehicle 車輛主檔（VEH:{vin}），對應 plan.md §3.2、BFR1。
// IntegrityScore（誠信分數）與 ResidualValue（殘值）由 scoring.go 的 recalcAndApply
// 於每個寫入函式（AddMaintenance／RecordClaim／SubmitInspection／TransferOwnership／
// ScrapVehicle）之後動態重算（BFR3、IIR3）。
type Vehicle struct {
	DocType          string        `json:"docType"`
	VIN              string        `json:"vin"`
	EngineHash       string        `json:"engineHash"`
	TransmissionHash string        `json:"transmissionHash"`
	ManufactureYear  int           `json:"manufactureYear"`
	MsrpAmount       float64       `json:"msrpAmount"`
	OwnerHash        string        `json:"ownerHash"`
	Status           VehicleStatus `json:"status"`
	Mileage          int           `json:"mileage"`
	IntegrityScore   int           `json:"integrityScore"`
	ResidualValue    float64       `json:"residualValue"`
	CreatedAt        string        `json:"createdAt"`
	UpdatedAt        string        `json:"updatedAt"`
}

// Event 生命週期事件（EVT:{vin}:{txTimestamp}:{txId}），對應 plan.md §3.2、BFR2。
// 依事件類型只會填入對應的欄位，其餘留空。
// 除了 json 的 omitempty（控制序列化輸出），條件欄位還需要
// fabric-contract-api-go 專用的 metadata:",optional" tag——它產生查詢函式
// 回傳型別的 JSON Schema 時只看 metadata tag，不看 json tag，少了它會讓
// GetVehicleHistory 的回傳值被要求「每筆事件都要有全部類型的欄位」而驗證失敗。
type Event struct {
	DocType       string    `json:"docType"`
	VIN           string    `json:"vin"`
	TxID          string    `json:"txId"`
	Timestamp     string    `json:"timestamp"`
	Type          EventType `json:"type"`
	SubmittingOrg string    `json:"submittingOrg"`

	// MAINTENANCE
	ServiceType string `json:"serviceType,omitempty" metadata:",optional"`
	Mileage     int    `json:"mileage,omitempty" metadata:",optional"`

	// CLAIM
	ClaimID        string  `json:"claimId,omitempty" metadata:",optional"`
	IncidentType   string  `json:"incidentType,omitempty" metadata:",optional"`
	IncidentAmount float64 `json:"incidentAmount,omitempty" metadata:",optional"`
	IncidentPart   string  `json:"incidentPart,omitempty" metadata:",optional"`

	// TRANSFER
	PreviousOwnerHash string `json:"previousOwnerHash,omitempty" metadata:",optional"`
	NewOwnerHash      string `json:"newOwnerHash,omitempty" metadata:",optional"`

	// SCRAP
	Reason string `json:"reason,omitempty" metadata:",optional"`

	// ANOMALY（BFR3、UC-01；由評分引擎於 recalcAndApply 內部產生，見 scoring.go）
	AnomalyType string `json:"anomalyType,omitempty" metadata:",optional"`
	ScoreDelta  int    `json:"scoreDelta,omitempty" metadata:",optional"`
	RelatedTxID string `json:"relatedTxId,omitempty" metadata:",optional"`

	// 通用備註（INIT／MAINTENANCE／INSPECTION 皆可能使用）
	Description string `json:"description,omitempty" metadata:",optional"`
}

// PQCKey 儲存某個身分（組織成員或車主化名雜湊）登記的 Dilithium（ML-DSA）公鑰
// （PQC:{identity}），對應 plan.md §3.1 RegisterPQCKey、BFR5、NFR1。
// 鏈上只存公鑰，私鑰由使用者自己的瀏覽器錢包（plan_dApp.md D1）或 Gateway 託管錢包
// （plan.md §7 #5，保留供 e2e 測試與展示備援）保管。
// Version 從 1 起算，每次換鑰或強制重綁加 1；RegisteredAt 為目前這一版的登記時間。
type PQCKey struct {
	DocType      string `json:"docType"`
	Identity     string `json:"identity"`
	Algorithm    string `json:"algorithm"`
	PublicKeyHex string `json:"publicKeyHex"`
	RegisteredAt string `json:"registeredAt"`
	Version      int    `json:"version"`
}

// PQCKeyAction 公鑰變更的類型，記錄於 PQCKeyLog 稽核紀錄與 PQCKeyEvent 鏈上事件。
type PQCKeyAction string

const (
	PQCKeyActionRegister    PQCKeyAction = "REGISTER"
	PQCKeyActionRotate      PQCKeyAction = "ROTATE"
	PQCKeyActionForceRebind PQCKeyAction = "FORCE_REBIND"
)

// PQCKeyLog 公鑰變更稽核紀錄（PQCLOG:{identity}:{txTimestamp}:{txId}），plan_dApp.md §2
// 要求強制重綁「寫入一筆事件留下紀錄」；一般登記與換鑰也一併記錄，方便追查。
// 只存公鑰的 SHA-256 雜湊，完整公鑰以 PQC:{identity} 為準。
type PQCKeyLog struct {
	DocType       string       `json:"docType"`
	Identity      string       `json:"identity"`
	Action        PQCKeyAction `json:"action"`
	Version       int          `json:"version"`
	PublicKeyHash string       `json:"publicKeyHash"`
	SubmittingOrg string       `json:"submittingOrg"`
	Reason        string       `json:"reason,omitempty" metadata:",optional"`
	TxID          string       `json:"txId"`
	Timestamp     string       `json:"timestamp"`
}

// PartBinding 核心零件數位孿生綁定索引（PART:{零件雜湊}），對應 plan.md §3.2。
// Released 為 true 時表示車輛已報廢、零件已合法釋出，允許回收後重新綁定至其他車輛
// （零件轉生，EIR1）；為 false 時視為仍綁定於現役車輛，重複綁定視為套牌／零件拼裝。
type PartBinding struct {
	DocType    string `json:"docType"`
	PartHash   string `json:"partHash"`
	PartType   string `json:"partType"`
	VIN        string `json:"vin"`
	BoundAt    string `json:"boundAt"`
	Released   bool   `json:"released"`
	ReleasedAt string `json:"releasedAt,omitempty"`
}
