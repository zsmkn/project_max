import unittest

from mocks.monitoring_station.mapping import (
    scrap_notice_to_gateway_payload,
    transfer_notice_to_gateway_payload,
)


class ScrapNoticeToGatewayPayloadTests(unittest.TestCase):
    def test_maps_reason_code_and_text_into_single_reason_field_EIR1(self) -> None:
        notice = {
            "vin": "VIN123",
            "deregistrationReasonCode": "SCRAP01",
            "deregistrationReasonText": "車體嚴重鏽蝕",
            "officerId": "REG-0001",
        }

        payload = scrap_notice_to_gateway_payload(notice)

        self.assertEqual(payload, {"vin": "VIN123", "reason": "[SCRAP01] 車體嚴重鏽蝕"})

    def test_missing_required_field_raises_value_error_EIR1(self) -> None:
        notice = {"vin": "VIN123", "deregistrationReasonCode": "SCRAP01"}

        with self.assertRaises(ValueError):
            scrap_notice_to_gateway_payload(notice)


class TransferNoticeToGatewayPayloadTests(unittest.TestCase):
    def test_renames_new_owner_identity_hash_to_new_owner_hash_EIR1(self) -> None:
        notice = {"vin": "VIN123", "newOwnerIdentityHash": "abc123", "officerId": "REG-0001"}

        payload = transfer_notice_to_gateway_payload(notice)

        self.assertEqual(payload, {"vin": "VIN123", "newOwnerHash": "abc123"})

    def test_missing_new_owner_hash_raises_value_error_EIR1(self) -> None:
        with self.assertRaises(ValueError):
            transfer_notice_to_gateway_payload({"vin": "VIN123"})


if __name__ == "__main__":
    unittest.main()
