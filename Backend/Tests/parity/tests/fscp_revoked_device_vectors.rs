//! Golden-транскрипт `message_session_revoked_device_v1_failure`
//! (FSCP.md §Device revocation): серверная сторона — форма + Ed25519 остаются
//! валидными для wire отозванного устройства, отказ обязан приходить из
//! device-policy (`extract_sender_device_uuid` + `REVOKED_SENDER_DEVICE_ERROR`,
//! enforcement — `ConversationService::send_message`).
//! Регенерация: python Documents/test-vectors/_gen_fscp_revoked_device_v1.py.
//! Клиентский consumer — revokedDeviceVector.test.ts в @flora/fscp.

use flora_messaging::fscp;
use flora_parity::{load_json, repo_root};
use uuid::Uuid;

fn vector() -> serde_json::Value {
    let path = repo_root()
        .join("Documents")
        .join("test-vectors")
        .join("fscp-revoked-device-v1.json");
    load_json(&path).expect(
        "нет fscp-revoked-device-v1.json (регенерация: python Documents/test-vectors/_gen_fscp_revoked_device_v1.py)",
    )
}

fn guid(v: &serde_json::Value) -> Uuid {
    v.as_str().unwrap().parse().unwrap()
}

#[test]
fn both_wires_pass_frozen_form_validation_and_signature() {
    let v = vector();
    let sender = guid(&v["uuids"]["senderUserUuid"]);
    let receiver = guid(&v["uuids"]["receiverUserUuid"]);

    for (key, expected_form) in [
        ("messageBeforeRevoke", "accept"),
        ("messageAfterRevoke", "accept"),
    ] {
        let wire = v[key]["wire"].as_str().unwrap();
        assert_eq!(
            fscp::try_validate_wire(wire, sender, receiver),
            Ok(()),
            "{key}: форма"
        );
        assert_eq!(
            fscp::verify_envelope_signature(wire),
            Ok(()),
            "{key}: подпись"
        );
        assert_eq!(
            v["expected"]["beforeRevoke"]["serverFormValidation"]
                .as_str()
                .unwrap(),
            expected_form
        );
    }
}

#[test]
fn sender_device_uuid_is_extracted_for_policy_layer() {
    let v = vector();
    let expected_device = guid(&v["uuids"]["senderDeviceUuid"]);
    for key in ["messageBeforeRevoke", "messageAfterRevoke"] {
        let wire = v[key]["wire"].as_str().unwrap();
        assert_eq!(
            fscp::extract_sender_device_uuid(wire),
            Ok(expected_device),
            "{key}"
        );
    }
    // Bootstrap sentinel policy-проверкой пропускается (device без bindings).
    assert_ne!(expected_device, fscp::BOOTSTRAP_DEVICE_UUID);
}

#[test]
fn revoked_policy_error_string_matches_golden() {
    let v = vector();
    assert_eq!(
        v["expected"]["afterRevoke"]["serverDevicePolicy"]
            .as_str()
            .unwrap(),
        "reject"
    );
    assert_eq!(
        fscp::REVOKED_SENDER_DEVICE_ERROR,
        v["expected"]["afterRevoke"]["serverDevicePolicyError"]
            .as_str()
            .unwrap()
    );
}

#[test]
fn device_set_snapshots_encode_the_revocation() {
    let v = vector();
    let sender_device = v["uuids"]["senderDeviceUuid"].as_str().unwrap();
    let status_of = |set: &serde_json::Value| -> String {
        set.as_array()
            .unwrap()
            .iter()
            .find(|d| d["deviceUuid"].as_str() == Some(sender_device))
            .map(|d| d["status"].as_str().unwrap().to_string())
            .unwrap()
    };
    assert_eq!(status_of(&v["deviceSetBeforeRevoke"]), "Active");
    assert_eq!(status_of(&v["deviceSetAfterRevoke"]), "Revoked");
}
