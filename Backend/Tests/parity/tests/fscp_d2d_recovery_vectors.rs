//! Golden-вектор DeviceToDeviceRecoveryEnvelope (e2e-security.md §DeviceToDeviceRecoveryEnvelope):
//! серверная валидация fscp-core (структура + Ed25519-подпись source-устройства, без
//! расшифровки) против fscp-d2d-recovery-v1.json.
//! Регенерация: python Documents/test-vectors/_gen_fscp_d2d_recovery_v1.py.
//! Клиентский consumer (build/open, AEAD) — d2dRecoveryVector.test.ts в @flora/fscp.

use flora_messaging::fscp;
use flora_parity::{load_json, repo_root};

fn vector() -> serde_json::Value {
    let path = repo_root()
        .join("Documents")
        .join("test-vectors")
        .join("fscp-d2d-recovery-v1.json");
    load_json(&path).expect(
        "нет fscp-d2d-recovery-v1.json (регенерация: python Documents/test-vectors/_gen_fscp_d2d_recovery_v1.py)",
    )
}

#[test]
fn canonical_signing_payload_is_reproduced_byte_for_byte() {
    let v = vector();
    let mut env_no_sig = v["envelope"].clone();
    env_no_sig
        .as_object_mut()
        .unwrap()
        .remove("sourceDeviceSignatureBase64Url");
    let payload = format!(
        "{} | {}",
        fscp::D2D_SIGNATURE_DOMAIN,
        fscp::canonical_json(&env_no_sig)
    );
    assert_eq!(payload, v["canonicalSigningPayloadUtf8"].as_str().unwrap());
}

#[test]
fn aad_domain_matches_vector() {
    let v = vector();
    assert_eq!(fscp::D2D_AAD_DOMAIN, v["aadDomain"].as_str().unwrap());
    assert_eq!(
        fscp::D2D_SIGNATURE_DOMAIN,
        v["signatureDomain"].as_str().unwrap()
    );
}

#[test]
fn summary_fields_and_derived_target_agreement_id_match() {
    let v = vector();
    let summary = fscp::try_validate_d2d_recovery_envelope(&v["envelope"]).unwrap();
    let u = &v["uuids"];
    assert_eq!(
        summary.user_uuid.to_string(),
        u["userUuid"].as_str().unwrap()
    );
    assert_eq!(
        summary.source_device_uuid.to_string(),
        u["sourceDeviceUuid"].as_str().unwrap()
    );
    assert_eq!(
        summary.target_device_uuid.to_string(),
        u["targetDeviceUuid"].as_str().unwrap()
    );
    assert_eq!(
        summary.recovery_request_id.to_string(),
        u["recoveryRequestId"].as_str().unwrap()
    );
    let expected_epochs: Vec<String> = u["transferredKeyEpochIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e.as_str().unwrap().to_string())
        .collect();
    let actual_epochs: Vec<String> = summary
        .transferred_key_epoch_ids
        .iter()
        .map(|e| e.to_string())
        .collect();
    assert_eq!(actual_epochs, expected_epochs);

    // Серверная деривация targetAgreementPublicKeyId — паритет с TS deviceAgreementPublicKeyId.
    let derived =
        fscp::device_agreement_public_key_id(&summary.user_uuid, &summary.target_device_uuid);
    assert_eq!(
        derived.to_string(),
        u["targetAgreementPublicKeyId"].as_str().unwrap()
    );
}

#[test]
fn every_vector_case_matches_expected_server_outcome() {
    let v = vector();
    let source_pk = v["keys"]["sourceSigningPublicKeyBase64Url"]
        .as_str()
        .unwrap();

    for case in v["cases"].as_array().unwrap() {
        let case_id = case["caseId"].as_str().unwrap();
        let envelope = &case["envelope"];
        let expected_ok = case["expectedServer"].as_str().unwrap() == "ok";

        let result = fscp::try_validate_d2d_recovery_envelope(envelope)
            .map(|_| ())
            .and_then(|()| fscp::verify_d2d_recovery_signature(envelope, source_pk));

        match (expected_ok, result) {
            (true, Ok(())) => {}
            (false, Err(actual)) => {
                let expected_error = case["expectedServerError"].as_str().unwrap();
                assert_eq!(actual, expected_error, "{case_id}: строка ошибки");
            }
            (expected, actual) => {
                panic!("{case_id}: ожидалось ok={expected}, получено {actual:?}");
            }
        }
    }
}
