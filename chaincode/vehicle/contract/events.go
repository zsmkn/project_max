package contract

import (
	"encoding/json"
	"fmt"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// 鏈碼事件名稱（plan_dApp.md D3）。Gateway 以 network.getChaincodeEvents() 訂閱後依名稱分流，
// 再以 Server-Sent Events 推播給瀏覽器。Fabric 每筆交易只能設定一個事件（後設定者覆蓋先前的），
// 因此同一筆交易內偵測到的異常以 Anomalies 欄位一併帶出，而不是各自發一個事件。
const (
	chaincodeEventVehicle = "VehicleEvent"
	chaincodeEventPQCKey  = "PQCKeyEvent"
)

// VehicleEventAnomaly 是 VehicleEvent 內附帶的單筆異常摘要（BFR3、UC-01）。
type VehicleEventAnomaly struct {
	AnomalyType string `json:"anomalyType"`
	ScoreDelta  int    `json:"scoreDelta"`
	Description string `json:"description"`
}

// VehicleEventPayload 是 VehicleEvent 的內容。只帶 VIN、事件類型與分數等摘要，
// 不含車主雜湊以外的身分資訊（NFR1）；完整內容由接收端以 txId／VIN 回查履歷。
type VehicleEventPayload struct {
	VIN            string                `json:"vin"`
	EventType      EventType             `json:"eventType"`
	TxID           string                `json:"txId"`
	Timestamp      string                `json:"timestamp"`
	SubmittingOrg  string                `json:"submittingOrg"`
	IntegrityScore int                   `json:"integrityScore"`
	ResidualValue  float64               `json:"residualValue"`
	Anomalies      []VehicleEventAnomaly `json:"anomalies"`
}

// emitVehicleEvent 在寫入函式成功改動車輛狀態後發出 VehicleEvent。
func emitVehicleEvent(ctx contractapi.TransactionContextInterface, vehicle *Vehicle, businessEvent *Event, anomalies []Anomaly) error {
	payload := VehicleEventPayload{
		VIN:            vehicle.VIN,
		EventType:      businessEvent.Type,
		TxID:           businessEvent.TxID,
		Timestamp:      businessEvent.Timestamp,
		SubmittingOrg:  businessEvent.SubmittingOrg,
		IntegrityScore: vehicle.IntegrityScore,
		ResidualValue:  vehicle.ResidualValue,
		Anomalies:      make([]VehicleEventAnomaly, 0, len(anomalies)),
	}
	for _, a := range anomalies {
		payload.Anomalies = append(payload.Anomalies, VehicleEventAnomaly{
			AnomalyType: a.Type,
			ScoreDelta:  -a.Deduction,
			Description: a.Description,
		})
	}
	return setJSONEvent(ctx, chaincodeEventVehicle, payload)
}

// emitPQCKeyEvent 在公鑰登記、換鑰或強制重綁後發出 PQCKeyEvent，內容即稽核紀錄本身，
// 讓車主能即時得知自己的金鑰被監理站強制重綁（plan_dApp.md §2）。
func emitPQCKeyEvent(ctx contractapi.TransactionContextInterface, logEntry *PQCKeyLog) error {
	return setJSONEvent(ctx, chaincodeEventPQCKey, logEntry)
}

func setJSONEvent(ctx contractapi.TransactionContextInterface, name string, payload interface{}) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("序列化鏈碼事件 %s 失敗：%w", name, err)
	}
	if err := ctx.GetStub().SetEvent(name, data); err != nil {
		return fmt.Errorf("設定鏈碼事件 %s 失敗：%w", name, err)
	}
	return nil
}
