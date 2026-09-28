// Package contract 實作車輛履歷智慧合約（plan.md §3.1）。
package contract

import "fmt"

// 狀態鍵前綴。集中定義於此檔案，避免各處拼字串（CLAUDE.md 編程風格）。
const (
	vehicleKeyPrefix = "VEH:"
	eventKeyPrefix   = "EVT:"
	partKeyPrefix    = "PART:"
	claimKeyPrefix   = "CLAIM:"
	pqcKeyPrefix     = "PQC:"
	pqcKeyLogPrefix  = "PQCLOG:"
)

// VehicleKey 回傳車輛主檔的狀態鍵（plan.md §3.2）。
func VehicleKey(vin string) string {
	return vehicleKeyPrefix + vin
}

// PartKey 回傳零件雜湊綁定索引的狀態鍵，用來偵測同一零件出現在兩輛車（套牌／拼裝）。
func PartKey(partHash string) string {
	return partKeyPrefix + partHash
}

// ClaimKey 回傳理賠編號索引鍵，用於防止同一理賠編號被重複存證。
func ClaimKey(claimID string) string {
	return claimKeyPrefix + claimID
}

// PQCKeyKey 回傳某身分（組織成員或車主化名雜湊）登記的 Dilithium 公鑰狀態鍵。
func PQCKeyKey(identity string) string {
	return pqcKeyPrefix + identity
}

// PQCKeyLogKey 回傳公鑰變更稽核紀錄的狀態鍵，格式與 EventKey 相同，鍵序即時間序。
func PQCKeyLogKey(identity string, txTimestampNanos int64, txID string) string {
	return fmt.Sprintf("%s%s:%020d:%s", pqcKeyLogPrefix, identity, txTimestampNanos, txID)
}

// EventKey 回傳單筆生命週期事件的狀態鍵。txTimestampNanos 取自
// stub.GetTxTimestamp()（而非系統時間，維持鏈碼決定性），以固定寬度零填補的奈秒數
// 確保鍵的字典序等同時間順序；txID 作為同一奈秒內的排序後備。
func EventKey(vin string, txTimestampNanos int64, txID string) string {
	return fmt.Sprintf("%s%s:%020d:%s", eventKeyPrefix, vin, txTimestampNanos, txID)
}

// EventRangeStart／EventRangeEnd 界定 GetStateByRange 查詢某 VIN 所有事件的區間。
// 結尾使用 ';'（0x3B）而非 ':'（0x3A），確保涵蓋該 VIN 下所有事件鍵，
// 又不會誤含下一個字典序 VIN 的事件。
func EventRangeStart(vin string) string {
	return fmt.Sprintf("%s%s:", eventKeyPrefix, vin)
}

func EventRangeEnd(vin string) string {
	return fmt.Sprintf("%s%s;", eventKeyPrefix, vin)
}

// AnomalyEventKey 回傳異常事件（EventTypeAnomaly）的狀態鍵。沿用一般事件鍵格式，
// 額外附加 index：同一筆交易觸發 recalcAndApply 時可能一次偵測到多筆異常
// （例如同時符合里程倒退與理賠未維修），共用同一組時間戳與交易 ID，需要 index 避免鍵碰撞。
func AnomalyEventKey(vin string, txTimestampNanos int64, txID string, index int) string {
	return fmt.Sprintf("%s%s:%020d:%s:A%d", eventKeyPrefix, vin, txTimestampNanos, txID, index)
}
