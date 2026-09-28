package contract

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// scoringConfigJSON 在建置時內嵌 scoring_config.json（plan.md §3.4／§7 的預設參數），
// 讓評分規則與殘值公式的數值集中在設定檔而非寫死於邏輯中（CLAUDE.md「給 Claude 的工作方式」）。
// 因為鏈碼打包成單一二進位檔、所有背書節點執行相同映像檔，go:embed 內嵌的設定檔在所有
// peer 上必定一致，不會破壞鏈碼決定性；調整參數只需改 JSON 檔並以新版本重新部署。
//
//go:embed scoring_config.json
var scoringConfigJSON []byte

// ResidualValueConfig 對應 plan.md §3.4 殘值公式的三個係數。
type ResidualValueConfig struct {
	AgeCoefficientPerYear       float64 `json:"ageCoefficientPerYear"`
	AgeCoefficientMin           float64 `json:"ageCoefficientMin"`
	MileageCoefficientDivisorKm float64 `json:"mileageCoefficientDivisorKm"`
	MileageCoefficientMin       float64 `json:"mileageCoefficientMin"`
	IntegrityCoefficientBase    float64 `json:"integrityCoefficientBase"`
	IntegrityCoefficientWeight  float64 `json:"integrityCoefficientWeight"`
}

// ScoringConfig 對應 plan.md §3.4 誠信評分與折舊的全部可調參數。
type ScoringConfig struct {
	InitialScore                      int                 `json:"initialScore"`
	MinScore                          int                 `json:"minScore"`
	MileageRollbackDeduction          int                 `json:"mileageRollbackDeduction"`
	ClaimWithoutMaintenanceDeduction  int                 `json:"claimWithoutMaintenanceDeduction"`
	ClaimWithoutMaintenanceWindowDays int                 `json:"claimWithoutMaintenanceWindowDays"`
	DuplicatePartDeduction            int                 `json:"duplicatePartDeduction"`
	ResidualValue                     ResidualValueConfig `json:"residualValue"`
}

// loadScoringConfig 解析內嵌的設定檔；格式錯誤代表建置環節出錯，故直接 panic
// （在套件初始化階段發生，而非交易執行期間，不影響鏈碼決定性）。
func loadScoringConfig() *ScoringConfig {
	var cfg ScoringConfig
	if err := json.Unmarshal(scoringConfigJSON, &cfg); err != nil {
		panic(fmt.Sprintf("解析評分設定檔 scoring_config.json 失敗：%v", err))
	}
	return &cfg
}

// defaultScoringConfig 是鏈碼實際使用的評分參數；測試可自行建立不同 ScoringConfig 驗證公式本身。
var defaultScoringConfig = loadScoringConfig()

// 異常類型常數，對應 plan.md §3.4 的三種扣分規則。
const (
	AnomalyTypeMileageRollback     = "MILEAGE_ROLLBACK"
	AnomalyTypeClaimWithoutService = "CLAIM_WITHOUT_MAINTENANCE"
	AnomalyTypeDuplicatePart       = "DUPLICATE_PART"
)

// Anomaly 是評分引擎偵測到的一筆異常，尚未附上狀態鍵（由呼叫端決定如何寫入 EVT:ANOMALY）。
type Anomaly struct {
	Type        string
	Deduction   int
	Description string
	RelatedTxID string
	OccurredAt  string
}

// DetectMileageRollbacks 依時間序掃描 INIT／MAINTENANCE／INSPECTION 事件，若某筆事件回報的
// 里程低於在它之前已出現過的最高里程，判定為里程倒退異常（BFR3、UC-01）。
// events 必須已依時間序排列（EventKey 的鍵序即時間序，見 keys.go）。
// 純函式：只依賴輸入的 events，不觸及任何鏈上狀態，方便單元測試（CLAUDE.md）。
func DetectMileageRollbacks(cfg *ScoringConfig, events []*Event) []Anomaly {
	anomalies := []Anomaly{}
	maxMileage := 0
	for _, e := range events {
		if e.Type != EventTypeInit && e.Type != EventTypeMaintenance && e.Type != EventTypeInspection {
			continue
		}
		if e.Mileage < maxMileage {
			anomalies = append(anomalies, Anomaly{
				Type:        AnomalyTypeMileageRollback,
				Deduction:   cfg.MileageRollbackDeduction,
				Description: fmt.Sprintf("回報里程 %d 低於歷史最高里程 %d", e.Mileage, maxMileage),
				RelatedTxID: e.TxID,
				OccurredAt:  e.Timestamp,
			})
			continue
		}
		if e.Mileage > maxMileage {
			maxMileage = e.Mileage
		}
	}
	return anomalies
}

// DetectClaimsWithoutMaintenance 找出每一筆理賠事件：若已超過設定的觀察天數
// （ClaimWithoutMaintenanceWindowDays，預設 30 天），卻在理賠時間到觀察期截止之間
// 找不到任何 MAINTENANCE 事件，判定為「有理賠卻無維修證明」異常。asOf 為觸發本次重算的
// 交易時間戳（而非系統時間，維持鏈碼決定性）；觀察期尚未屆滿的理賠暫不判定，等待後續交易
// 觸發下一次重算時再評估。純函式：只依賴輸入參數。
func DetectClaimsWithoutMaintenance(cfg *ScoringConfig, events []*Event, asOf time.Time) ([]Anomaly, error) {
	anomalies := []Anomaly{}
	window := time.Duration(cfg.ClaimWithoutMaintenanceWindowDays) * 24 * time.Hour
	for _, claim := range events {
		if claim.Type != EventTypeClaim {
			continue
		}
		claimTime, err := time.Parse(time.RFC3339, claim.Timestamp)
		if err != nil {
			return nil, fmt.Errorf("解析理賠事件 %s 時間戳失敗：%w", claim.ClaimID, err)
		}
		deadline := claimTime.Add(window)
		if asOf.Before(deadline) {
			continue
		}
		hasMaintenance := false
		for _, e := range events {
			if e.Type != EventTypeMaintenance {
				continue
			}
			svcTime, err := time.Parse(time.RFC3339, e.Timestamp)
			if err != nil {
				return nil, fmt.Errorf("解析保養事件時間戳失敗：%w", err)
			}
			if !svcTime.Before(claimTime) && !svcTime.After(deadline) {
				hasMaintenance = true
				break
			}
		}
		if !hasMaintenance {
			anomalies = append(anomalies, Anomaly{
				Type:        AnomalyTypeClaimWithoutService,
				Deduction:   cfg.ClaimWithoutMaintenanceDeduction,
				Description: fmt.Sprintf("理賠 %s 後 %d 天內查無維修紀錄", claim.ClaimID, cfg.ClaimWithoutMaintenanceWindowDays),
				RelatedTxID: claim.TxID,
				OccurredAt:  claim.Timestamp,
			})
		}
	}
	return anomalies, nil
}

// DetectDuplicatePartUsage 偵測同一零件雜湊被綁定在兩輛不同、且皆非已報廢的車輛上
// （套牌／零件拼裝，plan.md §3.4）。純函式，輸入為欲檢查車輛的零件雜湊清單，以及
// 「零件雜湊 -> 目前綁定且未釋出的 VIN 清單」的索引（由呼叫端從 PART:{雜湊} 狀態彙整）。
//
// 已知限制（見 docs/stage4-scoring.md）：目前 InitVehicle 的 bindPart 對重複綁定採取
// 「直接拒絕交易」（stage 2 已定案的防偽核心機制），因此在現行資料流程中，此規則實際上
// 不會被觸發——重複綁定在寫入當下就被擋下，不會產生「兩輛車共用同一零件」的鏈上狀態供
// 本函式事後偵測。保留此函式與其單元測試，是為了滿足 plan.md §3.4 評分公式的完整性與
// 未來若調整 bindPart 政策（改為記錄而非拒絕）時可直接沿用。
func DetectDuplicatePartUsage(cfg *ScoringConfig, vin string, partHashToVINs map[string][]string) []Anomaly {
	anomalies := []Anomaly{}
	for partHash, vins := range partHashToVINs {
		if len(vins) < 2 {
			continue
		}
		involved := false
		for _, v := range vins {
			if v == vin {
				involved = true
				break
			}
		}
		if !involved {
			continue
		}
		anomalies = append(anomalies, Anomaly{
			Type:        AnomalyTypeDuplicatePart,
			Deduction:   cfg.DuplicatePartDeduction,
			Description: fmt.Sprintf("零件雜湊 %s 同時綁定於 %d 輛車，疑似套牌或零件拼裝", partHash, len(vins)),
		})
	}
	return anomalies
}

// ComputeResidualValue 依 plan.md §3.4 公式計算殘值：原廠建議售價 × 車齡係數 × 里程係數 ×
// 誠信係數。asOf 為計算基準時間（交易時間戳，維持鏈碼決定性）。純函式。
func ComputeResidualValue(cfg *ScoringConfig, msrpAmount float64, manufactureYear int, mileageKm int, integrityScore int, asOf time.Time) float64 {
	ageYears := float64(asOf.Year() - manufactureYear)
	if ageYears < 0 {
		ageYears = 0
	}
	ageCoefficient := 1 - cfg.ResidualValue.AgeCoefficientPerYear*ageYears
	if ageCoefficient < cfg.ResidualValue.AgeCoefficientMin {
		ageCoefficient = cfg.ResidualValue.AgeCoefficientMin
	}

	mileageCoefficient := 1 - float64(mileageKm)/cfg.ResidualValue.MileageCoefficientDivisorKm
	if mileageCoefficient < cfg.ResidualValue.MileageCoefficientMin {
		mileageCoefficient = cfg.ResidualValue.MileageCoefficientMin
	}

	integrityCoefficient := cfg.ResidualValue.IntegrityCoefficientBase + cfg.ResidualValue.IntegrityCoefficientWeight*float64(integrityScore)/100

	return msrpAmount * ageCoefficient * mileageCoefficient * integrityCoefficient
}

// RecalculatedResult 統整一次重算的結果，供呼叫端套用至 Vehicle 主檔並寫入新異常事件。
type RecalculatedResult struct {
	IntegrityScore int
	ResidualValue  float64
	NewAnomalies   []Anomaly
}

// Recalculate 依車輛目前資料與完整事件歷史重新計算誠信分數與殘值（BFR3、IIR3）。
// 分數與殘值皆為「事件歷史的純函式」（plan.md §3.4）：輸入相同則輸出必定相同，不論呼叫
// 幾次；alreadyRecorded 用來過濾已經上鏈記錄過的異常（key 為 anomalyDedupeKey），避免同一
// 異常被重複寫入 EVT:ANOMALY。純函式：不觸及任何鏈上狀態。
func Recalculate(cfg *ScoringConfig, vehicle *Vehicle, events []*Event, alreadyRecorded map[string]bool, asOf time.Time) (*RecalculatedResult, error) {
	anomalies := DetectMileageRollbacks(cfg, events)
	claimAnomalies, err := DetectClaimsWithoutMaintenance(cfg, events, asOf)
	if err != nil {
		return nil, err
	}
	anomalies = append(anomalies, claimAnomalies...)
	// 重複零件偵測（DetectDuplicatePartUsage）需要跨車輛的 PART: 索引資料，不在單一 VIN
	// 的事件歷史範圍內，且現行 bindPart 已在寫入當下拒絕重複綁定（見上方說明），因此
	// 未接上鏈碼呼叫端；函式本身已備妥並有單元測試覆蓋。

	totalDeduction := 0
	newAnomalies := []Anomaly{}
	for _, a := range anomalies {
		totalDeduction += a.Deduction
		if !alreadyRecorded[anomalyDedupeKey(a)] {
			newAnomalies = append(newAnomalies, a)
		}
	}

	score := cfg.InitialScore - totalDeduction
	if score < cfg.MinScore {
		score = cfg.MinScore
	}

	residual := ComputeResidualValue(cfg, vehicle.MsrpAmount, vehicle.ManufactureYear, vehicle.Mileage, score, asOf)

	return &RecalculatedResult{
		IntegrityScore: score,
		ResidualValue:  residual,
		NewAnomalies:   newAnomalies,
	}, nil
}

// anomalyDedupeKey 以「異常類型 + 觸發事件的交易 ID」識別同一筆異常，避免每次重算都
// 重複寫入相同的 ANOMALY 事件。
func anomalyDedupeKey(a Anomaly) string {
	return a.Type + "|" + a.RelatedTxID
}

// recalcAndApply 重新計算誠信分數與殘值並寫入車輛主檔，同時將本次新偵測到、尚未記錄過的
// 異常寫成 EVT:ANOMALY 事件（CLAUDE.md「異常要記錄而不是拒絕」）。由 AddMaintenance、
// RecordClaim、SubmitInspection、TransferOwnership、ScrapVehicle 在寫入各自的業務事件之後
// 呼叫，並傳入該筆剛寫入的業務事件（newBusinessEvent）。
//
// 重要：Fabric 的 GetStateByRange（getEventHistory 依賴的底層 API）只讀取已提交的帳本狀態，
// 不會合併同一筆交易內尚未提交的 PutState 寫入（與單鍵 GetState 的「讀自己剛寫入」行為不同，
// 2026-09-23 以真實五組織網路實測 SubmitInspection 確認：里程倒退未被偵測到，
// 即為此因——見 docs/stage4-scoring.md）。因此必須手動把 newBusinessEvent 併入歷史清單，
// 不能只依賴 getEventHistory 重新查詢。newBusinessEvent 的時間戳必為目前交易時間戳，
// 晚於歷史中其餘所有事件，故直接附加於清單末尾即可維持時間序。
func recalcAndApply(ctx contractapi.TransactionContextInterface, vehicle *Vehicle, newBusinessEvent *Event) error {
	events, err := getEventHistory(ctx, vehicle.VIN)
	if err != nil {
		return err
	}
	if newBusinessEvent != nil {
		// 保守起見先移除任何與 newBusinessEvent 相同 TxID 的既有項目，避免在真實 GetStateByRange
		// 行為不確定的情況下（是否合併同一交易內的待寫入，Fabric 版本／狀態庫可能有差異）重複計入
		// 同一筆事件；TxID 對每筆交易皆唯一，不會誤刪其他歷史事件。
		filtered := events[:0]
		for _, e := range events {
			if e.TxID != newBusinessEvent.TxID {
				filtered = append(filtered, e)
			}
		}
		events = append(filtered, newBusinessEvent)
	}
	alreadyRecorded := map[string]bool{}
	for _, e := range events {
		if e.Type == EventTypeAnomaly {
			alreadyRecorded[e.AnomalyType+"|"+e.RelatedTxID] = true
		}
	}

	asOf, err := txTimestamp(ctx)
	if err != nil {
		return err
	}

	result, err := Recalculate(defaultScoringConfig, vehicle, events, alreadyRecorded, asOf)
	if err != nil {
		return err
	}

	vehicle.IntegrityScore = result.IntegrityScore
	vehicle.ResidualValue = result.ResidualValue
	if err := putVehicle(ctx, vehicle); err != nil {
		return err
	}

	for i, anomaly := range result.NewAnomalies {
		event, key, err := newAnomalyEvent(ctx, vehicle.VIN, i, anomaly)
		if err != nil {
			return err
		}
		data, err := json.Marshal(event)
		if err != nil {
			return fmt.Errorf("序列化異常事件失敗：%w", err)
		}
		if err := ctx.GetStub().PutState(key, data); err != nil {
			return fmt.Errorf("寫入異常事件失敗：%w", err)
		}
	}
	// plan_dApp.md D3：所有觸發重算的寫入函式都經過這裡，在此統一發出 VehicleEvent，
	// 附上本次新偵測到的異常，讓車主頁即時看到扣分（UC-01）。
	if newBusinessEvent == nil {
		return nil
	}
	return emitVehicleEvent(ctx, vehicle, newBusinessEvent, result.NewAnomalies)
}

// newAnomalyEvent 建立異常事件與其狀態鍵。ANOMALY 事件屬於觸發它的交易的附帶效果
// （非某一組織的主動業務動作），沿用該交易本身的背書結果即可，不另外呼叫
// SetStateValidationParameter（維持鏈碼層級預設政策，與 VEH 主檔鍵一致，見 policy.go）。
func newAnomalyEvent(ctx contractapi.TransactionContextInterface, vin string, index int, anomaly Anomaly) (*Event, string, error) {
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
		Type:          EventTypeAnomaly,
		SubmittingOrg: clientMSPID,
		AnomalyType:   anomaly.Type,
		ScoreDelta:    -anomaly.Deduction,
		RelatedTxID:   anomaly.RelatedTxID,
		Description:   anomaly.Description,
	}
	key := AnomalyEventKey(vin, ts.UnixNano(), txID, index)
	return event, key, nil
}
