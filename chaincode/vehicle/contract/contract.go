package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// defaultInitialIntegrityScore 為誠信分數初始值（plan.md §3.4）。動態評分規則本身
// 屬於階段 4（BFR3），此常數只用於 InitVehicle 寫入初始狀態。
const defaultInitialIntegrityScore = 100

// VehicleContract 實作車輛資產全生命週期管理。階段 2（BFR1、BFR2）範圍：
// InitVehicle、AddMaintenance、RecordClaim、TransferOwnership、ScrapVehicle、
// GetVehicleHistory、GetSummary，以及核心零件數位孿生綁定。
// 誠信評分／折舊重算（BFR3）留待階段 4；PQC 簽章驗證（BFR5）留待階段 3。
type VehicleContract struct {
	contractapi.Contract
}

// InitVehicle 出廠初始化（BFR1）：由 OEM 建立車輛主檔，並將引擎、變速箱序號以
// SHA-256 雜湊與 VIN 綁定（核心零件數位孿生），寫入創世事件。
// 背書政策：AND(OEM, REG)。
func (c *VehicleContract) InitVehicle(
	ctx contractapi.TransactionContextInterface,
	vin string,
	engineSerial string,
	transmissionSerial string,
	manufactureYear int,
	msrpAmount float64,
	ownerHash string,
) error {
	if err := requireOrg(ctx, mspOEM); err != nil {
		return err
	}
	if vin == "" || engineSerial == "" || transmissionSerial == "" || ownerHash == "" {
		return fmt.Errorf("VIN、引擎序號、變速箱序號與車主雜湊皆為必填")
	}
	if manufactureYear <= 0 {
		return fmt.Errorf("出廠年份需為正數")
	}
	if msrpAmount <= 0 {
		return fmt.Errorf("原廠建議售價需為正數")
	}

	existing, err := ctx.GetStub().GetState(VehicleKey(vin))
	if err != nil {
		return fmt.Errorf("查詢車輛 %s 失敗：%w", vin, err)
	}
	if existing != nil {
		return fmt.Errorf("車輛 %s 已存在，不可重複初始化", vin)
	}

	engineHash := hashSerial(engineSerial)
	transmissionHash := hashSerial(transmissionSerial)
	if engineHash == transmissionHash {
		return fmt.Errorf("引擎序號與變速箱序號不可相同")
	}

	ts, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	now := ts.Format(time.RFC3339)

	if err := bindPart(ctx, engineHash, "ENGINE", vin, now); err != nil {
		return err
	}
	if err := bindPart(ctx, transmissionHash, "TRANSMISSION", vin, now); err != nil {
		return err
	}

	vehicle := &Vehicle{
		DocType:          docTypeVehicle,
		VIN:              vin,
		EngineHash:       engineHash,
		TransmissionHash: transmissionHash,
		ManufactureYear:  manufactureYear,
		MsrpAmount:       msrpAmount,
		OwnerHash:        ownerHash,
		Status:           VehicleStatusActive,
		Mileage:          0,
		IntegrityScore:   defaultInitialIntegrityScore,
		ResidualValue:    msrpAmount,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if err := putVehicle(ctx, vehicle); err != nil {
		return err
	}

	event, key, err := newEventBase(ctx, vin, EventTypeInit)
	if err != nil {
		return err
	}
	event.Description = "車輛出廠初始化"

	policy, err := andPolicy(mspOEM, mspREG)
	if err != nil {
		return fmt.Errorf("建立背書政策失敗：%w", err)
	}
	if err := putEvent(ctx, key, event, policy); err != nil {
		return err
	}
	return emitVehicleEvent(ctx, vehicle, event, nil)
}

// AddMaintenance 保養／維修紀錄（BFR2, FFR2）：由 SVC 提交，記錄服務類型、回報里程與
// 說明。里程異常（倒退）偵測與扣分屬於 BFR3，留待階段 4 實作；本階段如實記錄回報里程。
// FFR2／BFR5：需車主 Dilithium 簽章授權——ownerSignatureHex 是車主（登記於
// PQC:{ownerHash}，見 RegisterPQCKey）對本次保養內容的簽章，驗證失敗一律拒絕整筆交易
// （CLAUDE.md：簽章驗證失敗不可降級為忽略）。
// 背書政策：AND(SVC, OutOf(1, REG, APP))。
func (c *VehicleContract) AddMaintenance(
	ctx contractapi.TransactionContextInterface,
	vin string,
	serviceType string,
	mileage int,
	description string,
	ownerSignatureHex string,
) error {
	if err := requireOrg(ctx, mspSVC); err != nil {
		return err
	}
	if serviceType == "" {
		return fmt.Errorf("服務類型為必填")
	}
	if mileage < 0 {
		return fmt.Errorf("里程不可為負數")
	}

	vehicle, err := getVehicle(ctx, vin)
	if err != nil {
		return err
	}
	if vehicle.Status == VehicleStatusScrapped {
		return fmt.Errorf("車輛 %s 已報廢，無法新增保養紀錄", vin)
	}
	if err := verifyDilithiumAuthorization(ctx, vehicle.OwnerHash, maintenanceAuthorizationMessage(vin, serviceType, mileage, description), ownerSignatureHex); err != nil {
		return fmt.Errorf("車主保養授權驗證失敗：%w", err)
	}

	ts, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	vehicle.Mileage = mileage
	vehicle.UpdatedAt = ts.Format(time.RFC3339)

	event, key, err := newEventBase(ctx, vin, EventTypeMaintenance)
	if err != nil {
		return err
	}
	event.ServiceType = serviceType
	event.Mileage = mileage
	event.Description = description

	policy, err := requiredWithWitness(mspSVC, mspREG, mspAPP)
	if err != nil {
		return fmt.Errorf("建立背書政策失敗：%w", err)
	}
	if err := putEvent(ctx, key, event, policy); err != nil {
		return err
	}
	// BFR3／IIR3：里程更新後重算誠信分數與殘值，並記錄新偵測到的異常（見 scoring.go）。
	return recalcAndApply(ctx, vehicle, event)
}

// RecordClaim 保險理賠事件強制存證（BFR2, EIR2）：由 INS 提交。理賠事件一律成功寫入
// 上鏈，作為階段 4「有理賠卻無維修證明」規則的資料來源，本身不做商業判斷式拒絕。
// 背書政策：AND(INS, OutOf(1, REG, APP))。
func (c *VehicleContract) RecordClaim(
	ctx contractapi.TransactionContextInterface,
	vin string,
	claimID string,
	incidentType string,
	incidentAmount float64,
	incidentPart string,
) error {
	if err := requireOrg(ctx, mspINS); err != nil {
		return err
	}
	if claimID == "" || incidentType == "" {
		return fmt.Errorf("理賠編號與事故類型為必填")
	}
	if incidentAmount < 0 {
		return fmt.Errorf("理賠金額不可為負數")
	}

	vehicle, err := getVehicle(ctx, vin)
	if err != nil {
		return err
	}
	if vehicle.Status == VehicleStatusScrapped {
		return fmt.Errorf("車輛 %s 已報廢，無法受理理賠", vin)
	}

	claimKey := ClaimKey(claimID)
	existing, err := ctx.GetStub().GetState(claimKey)
	if err != nil {
		return fmt.Errorf("查詢理賠編號 %s 失敗：%w", claimID, err)
	}
	if existing != nil {
		return fmt.Errorf("理賠編號 %s 已存在，不可重複存證", claimID)
	}

	event, key, err := newEventBase(ctx, vin, EventTypeClaim)
	if err != nil {
		return err
	}
	event.ClaimID = claimID
	event.IncidentType = incidentType
	event.IncidentAmount = incidentAmount
	event.IncidentPart = incidentPart

	policy, err := requiredWithWitness(mspINS, mspREG, mspAPP)
	if err != nil {
		return fmt.Errorf("建立背書政策失敗：%w", err)
	}
	if err := putEvent(ctx, key, event, policy); err != nil {
		return err
	}
	if err := ctx.GetStub().PutState(claimKey, []byte(vin)); err != nil {
		return fmt.Errorf("寫入理賠編號索引失敗：%w", err)
	}

	ts, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	vehicle.UpdatedAt = ts.Format(time.RFC3339)
	// BFR3／IIR3：理賠事件也可能讓「更早的理賠已逾 30 天觀察期仍無維修」首次可判定，
	// 因此同樣觸發重算（見 scoring.go DetectClaimsWithoutMaintenance）。
	return recalcAndApply(ctx, vehicle, event)
}

// SubmitInspection 第三方鑑定中心實體複檢（BFR3, FFR3, FFR4, UC-01）：由 APP 提交複檢回報
// 里程與檢驗說明。若回報里程低於鏈上已知最高里程，屬於里程倒退異常；依 CLAUDE.md「異常要
// 記錄而不是拒絕」，交易本身照常成功寫入複檢事件、更新車輛回報里程，並由 recalcAndApply
// （scoring.go）偵測、記錄異常與動態扣分——不回傳錯誤、不拒絕交易（UC-01 例外流程）。
// 背書政策：AND(APP, OutOf(1, REG, INS))。
func (c *VehicleContract) SubmitInspection(
	ctx contractapi.TransactionContextInterface,
	vin string,
	mileage int,
	findings string,
) error {
	if err := requireOrg(ctx, mspAPP); err != nil {
		return err
	}
	if mileage < 0 {
		return fmt.Errorf("里程不可為負數")
	}

	vehicle, err := getVehicle(ctx, vin)
	if err != nil {
		return err
	}
	if vehicle.Status == VehicleStatusScrapped {
		return fmt.Errorf("車輛 %s 已報廢，無法複檢", vin)
	}

	ts, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	vehicle.Mileage = mileage
	vehicle.UpdatedAt = ts.Format(time.RFC3339)

	event, key, err := newEventBase(ctx, vin, EventTypeInspection)
	if err != nil {
		return err
	}
	event.Mileage = mileage
	event.Description = findings

	policy, err := requiredWithWitness(mspAPP, mspREG, mspINS)
	if err != nil {
		return fmt.Errorf("建立背書政策失敗：%w", err)
	}
	if err := putEvent(ctx, key, event, policy); err != nil {
		return err
	}
	return recalcAndApply(ctx, vehicle, event)
}

// TransferOwnership 二手過戶（BFR2）：由 REG 登記新車主化名。NFR1：鏈上不存明文
// 個資，車主身分一律以雜湊表示，由呼叫端（Gateway）負責產生。
// 背書政策：AND(REG, OutOf(1, OEM, APP))。
func (c *VehicleContract) TransferOwnership(
	ctx contractapi.TransactionContextInterface,
	vin string,
	newOwnerHash string,
) error {
	if err := requireOrg(ctx, mspREG); err != nil {
		return err
	}
	if newOwnerHash == "" {
		return fmt.Errorf("新車主雜湊為必填")
	}

	vehicle, err := getVehicle(ctx, vin)
	if err != nil {
		return err
	}
	if vehicle.Status == VehicleStatusScrapped {
		return fmt.Errorf("車輛 %s 已報廢，無法過戶", vin)
	}
	if vehicle.OwnerHash == newOwnerHash {
		return fmt.Errorf("新車主與現有車主相同，無需過戶")
	}

	previousOwnerHash := vehicle.OwnerHash
	ts, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	vehicle.OwnerHash = newOwnerHash
	vehicle.UpdatedAt = ts.Format(time.RFC3339)

	event, key, err := newEventBase(ctx, vin, EventTypeTransfer)
	if err != nil {
		return err
	}
	event.PreviousOwnerHash = previousOwnerHash
	event.NewOwnerHash = newOwnerHash

	policy, err := requiredWithWitness(mspREG, mspOEM, mspAPP)
	if err != nil {
		return fmt.Errorf("建立背書政策失敗：%w", err)
	}
	if err := putEvent(ctx, key, event, policy); err != nil {
		return err
	}
	return recalcAndApply(ctx, vehicle, event)
}

// ScrapVehicle 報廢註銷（BFR2, EIR1）：由 REG 登記，車輛狀態改為 SCRAPPED；核心零件
// 綁定標記為已釋出（零件轉生），允許合法回收後重新綁定至其他車輛。
// 背書政策：AND(REG, OutOf(1, OEM, APP))。
func (c *VehicleContract) ScrapVehicle(
	ctx contractapi.TransactionContextInterface,
	vin string,
	reason string,
) error {
	if err := requireOrg(ctx, mspREG); err != nil {
		return err
	}

	vehicle, err := getVehicle(ctx, vin)
	if err != nil {
		return err
	}
	if vehicle.Status == VehicleStatusScrapped {
		return fmt.Errorf("車輛 %s 已報廢，無法重複報廢", vin)
	}

	ts, err := txTimestamp(ctx)
	if err != nil {
		return err
	}
	now := ts.Format(time.RFC3339)
	vehicle.Status = VehicleStatusScrapped
	vehicle.UpdatedAt = now

	if err := releasePart(ctx, vehicle.EngineHash, now); err != nil {
		return err
	}
	if err := releasePart(ctx, vehicle.TransmissionHash, now); err != nil {
		return err
	}

	event, key, err := newEventBase(ctx, vin, EventTypeScrap)
	if err != nil {
		return err
	}
	event.Reason = reason

	policy, err := requiredWithWitness(mspREG, mspOEM, mspAPP)
	if err != nil {
		return fmt.Errorf("建立背書政策失敗：%w", err)
	}
	if err := putEvent(ctx, key, event, policy); err != nil {
		return err
	}
	return recalcAndApply(ctx, vehicle, event)
}

// GetSummary 回傳車輛主檔（含誠信分數、殘值），對應 FFR1、IIR2。任何組織皆可查詢。
func (c *VehicleContract) GetSummary(ctx contractapi.TransactionContextInterface, vin string) (*Vehicle, error) {
	return getVehicle(ctx, vin)
}

// GetVehicleHistory 回傳車輛的生命週期事件，可用 fromTimestamp／toTimestamp
// （RFC3339，空字串表示不限制該端）篩選時間區間，對應 FFR1、IIR2。任何組織皆可查詢。
func (c *VehicleContract) GetVehicleHistory(
	ctx contractapi.TransactionContextInterface,
	vin string,
	fromTimestamp string,
	toTimestamp string,
) ([]*Event, error) {
	events, err := getEventHistory(ctx, vin)
	if err != nil {
		return nil, err
	}
	filtered := []*Event{}
	for _, event := range events {
		if fromTimestamp != "" && event.Timestamp < fromTimestamp {
			continue
		}
		if toTimestamp != "" && event.Timestamp > toTimestamp {
			continue
		}
		filtered = append(filtered, event)
	}
	return filtered, nil
}

// --- 內部輔助函式 ---

// requireOrg 驗證交易呼叫者的 MSP 身分，寫入函式須在改動狀態前呼叫。
func requireOrg(ctx contractapi.TransactionContextInterface, expectedMSPID string) error {
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("無法取得呼叫者組織身分：%w", err)
	}
	if clientMSPID != expectedMSPID {
		return fmt.Errorf("呼叫者組織 %s 無權限執行此操作，須為 %s", clientMSPID, expectedMSPID)
	}
	return nil
}

// txTimestamp 回傳交易時間戳（來自排序服務，而非系統時間），維持鏈碼決定性。
func txTimestamp(ctx contractapi.TransactionContextInterface) (time.Time, error) {
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return time.Time{}, fmt.Errorf("無法取得交易時間戳：%w", err)
	}
	return time.Unix(ts.Seconds, int64(ts.Nanos)).UTC(), nil
}

// hashSerial 以 SHA-256 雜湊零件序號，作為核心零件數位孿生綁定的索引鍵，
// 鏈上不存明文序號。
func hashSerial(serial string) string {
	sum := sha256.Sum256([]byte(serial))
	return hex.EncodeToString(sum[:])
}

func getVehicle(ctx contractapi.TransactionContextInterface, vin string) (*Vehicle, error) {
	data, err := ctx.GetStub().GetState(VehicleKey(vin))
	if err != nil {
		return nil, fmt.Errorf("讀取車輛 %s 失敗：%w", vin, err)
	}
	if data == nil {
		return nil, fmt.Errorf("車輛 %s 不存在", vin)
	}
	var vehicle Vehicle
	if err := json.Unmarshal(data, &vehicle); err != nil {
		return nil, fmt.Errorf("解析車輛 %s 資料失敗：%w", vin, err)
	}
	return &vehicle, nil
}

func putVehicle(ctx contractapi.TransactionContextInterface, vehicle *Vehicle) error {
	data, err := json.Marshal(vehicle)
	if err != nil {
		return fmt.Errorf("序列化車輛 %s 資料失敗：%w", vehicle.VIN, err)
	}
	return ctx.GetStub().PutState(VehicleKey(vehicle.VIN), data)
}

// bindPart 建立零件雜湊與 VIN 的綁定；若該雜湊已綁定於另一輛尚未報廢的車輛，
// 視為套牌／零件拼裝並拒絕交易。
func bindPart(ctx contractapi.TransactionContextInterface, partHash, partType, vin, boundAt string) error {
	data, err := ctx.GetStub().GetState(PartKey(partHash))
	if err != nil {
		return fmt.Errorf("查詢零件綁定 %s 失敗：%w", partHash, err)
	}
	if data != nil {
		var existing PartBinding
		if err := json.Unmarshal(data, &existing); err != nil {
			return fmt.Errorf("解析零件綁定 %s 失敗：%w", partHash, err)
		}
		if !existing.Released {
			return fmt.Errorf("零件雜湊 %s 已綁定於車輛 %s，疑似套牌或零件拼裝，無法重複綁定", partHash, existing.VIN)
		}
	}
	binding := &PartBinding{
		DocType:  docTypePart,
		PartHash: partHash,
		PartType: partType,
		VIN:      vin,
		BoundAt:  boundAt,
		Released: false,
	}
	newData, err := json.Marshal(binding)
	if err != nil {
		return fmt.Errorf("序列化零件綁定失敗：%w", err)
	}
	return ctx.GetStub().PutState(PartKey(partHash), newData)
}

// releasePart 於車輛報廢時釋出零件綁定，允許合法回收後重新綁定（零件轉生）。
func releasePart(ctx contractapi.TransactionContextInterface, partHash, releasedAt string) error {
	data, err := ctx.GetStub().GetState(PartKey(partHash))
	if err != nil {
		return fmt.Errorf("查詢零件綁定 %s 失敗：%w", partHash, err)
	}
	if data == nil {
		return fmt.Errorf("零件綁定 %s 不存在", partHash)
	}
	var binding PartBinding
	if err := json.Unmarshal(data, &binding); err != nil {
		return fmt.Errorf("解析零件綁定 %s 失敗：%w", partHash, err)
	}
	binding.Released = true
	binding.ReleasedAt = releasedAt
	newData, err := json.Marshal(binding)
	if err != nil {
		return fmt.Errorf("序列化零件綁定失敗：%w", err)
	}
	return ctx.GetStub().PutState(PartKey(partHash), newData)
}

// newEventBase 建立事件的共通欄位與對應的狀態鍵，型別特定欄位由呼叫端填入。
func newEventBase(ctx contractapi.TransactionContextInterface, vin string, eventType EventType) (*Event, string, error) {
	ts, err := txTimestamp(ctx)
	if err != nil {
		return nil, "", err
	}
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return nil, "", fmt.Errorf("無法取得呼叫者組織身分：%w", err)
	}
	txID := ctx.GetStub().GetTxID()
	event := &Event{
		DocType:       docTypeEvent,
		VIN:           vin,
		TxID:          txID,
		Timestamp:     ts.Format(time.RFC3339),
		Type:          eventType,
		SubmittingOrg: clientMSPID,
	}
	key := EventKey(vin, ts.UnixNano(), txID)
	return event, key, nil
}

// getEventHistory 依時間序（EventKey 的鍵序）回傳某 VIN 的完整生命週期事件，供
// GetVehicleHistory（查詢）與 recalcAndApply（評分引擎，見 scoring.go）共用。
func getEventHistory(ctx contractapi.TransactionContextInterface, vin string) ([]*Event, error) {
	iterator, err := ctx.GetStub().GetStateByRange(EventRangeStart(vin), EventRangeEnd(vin))
	if err != nil {
		return nil, fmt.Errorf("查詢車輛 %s 歷史失敗：%w", vin, err)
	}
	defer iterator.Close()

	events := []*Event{}
	for iterator.HasNext() {
		item, err := iterator.Next()
		if err != nil {
			return nil, fmt.Errorf("讀取車輛 %s 歷史失敗：%w", vin, err)
		}
		var event Event
		if err := json.Unmarshal(item.GetValue(), &event); err != nil {
			return nil, fmt.Errorf("解析事件資料失敗：%w", err)
		}
		events = append(events, &event)
	}
	return events, nil
}

// putEvent 寫入事件並設定該鍵專屬的狀態背書政策（見 policy.go）。
func putEvent(ctx contractapi.TransactionContextInterface, key string, event *Event, policy []byte) error {
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("序列化事件失敗：%w", err)
	}
	if err := ctx.GetStub().PutState(key, data); err != nil {
		return fmt.Errorf("寫入事件失敗：%w", err)
	}
	if err := ctx.GetStub().SetStateValidationParameter(key, policy); err != nil {
		return fmt.Errorf("設定事件背書政策失敗：%w", err)
	}
	return nil
}
