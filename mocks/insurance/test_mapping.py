import unittest

from mocks.insurance.mapping import claim_settlement_to_gateway_payload


class ClaimSettlementToGatewayPayloadTests(unittest.TestCase):
    def test_maps_insurer_fields_to_gateway_claim_fields_EIR2(self) -> None:
        settlement = {
            "vin": "VIN123",
            "policyClaimNo": "CLM-2026-001",
            "accidentType": "碰撞",
            "settlementAmount": 45000,
            "damagedComponent": "前保險桿",
        }

        payload = claim_settlement_to_gateway_payload(settlement)

        self.assertEqual(
            payload,
            {
                "vin": "VIN123",
                "claimId": "CLM-2026-001",
                "incidentType": "碰撞",
                "incidentAmount": 45000,
                "incidentPart": "前保險桿",
            },
        )

    def test_missing_required_field_raises_value_error_EIR2(self) -> None:
        settlement = {"vin": "VIN123", "policyClaimNo": "CLM-2026-001"}

        with self.assertRaises(ValueError):
            claim_settlement_to_gateway_payload(settlement)

    def test_non_numeric_settlement_amount_raises_value_error_EIR2(self) -> None:
        settlement = {
            "vin": "VIN123",
            "policyClaimNo": "CLM-2026-001",
            "accidentType": "碰撞",
            "settlementAmount": "四萬五千",
            "damagedComponent": "前保險桿",
        }

        with self.assertRaises(ValueError):
            claim_settlement_to_gateway_payload(settlement)


if __name__ == "__main__":
    unittest.main()
