// Package main 為車輛履歷鏈碼的進入點。
package main

import (
	"log"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"

	"vehiclenet.tw/chaincode/vehicle/contract"
)

func main() {
	chaincode, err := contractapi.NewChaincode(&contract.VehicleContract{})
	if err != nil {
		log.Panicf("建立車輛履歷鏈碼失敗：%v", err)
	}
	if err := chaincode.Start(); err != nil {
		log.Panicf("啟動車輛履歷鏈碼失敗：%v", err)
	}
}
