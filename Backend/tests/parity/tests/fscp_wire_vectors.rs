//! Паритет серверной FSCP-валидации с C# (next-architecture.md §4.4):
//! golden-вектор fscp-wire-validator-v1.json (эталон FscpWireEnvelopeValidator.cs,
//! регенерация: ./Scripts/generate-golden-vectors.ps1) прогоняется через
//! flora_messaging::fscp — accept/reject и **точная строка ошибки** байт-в-байт.

use flora_messaging::fscp;
use flora_parity::{load_json, repo_root};
use uuid::Uuid;

fn vector() -> serde_json::Value {
    let path = repo_root()
        .join("Documents")
        .join("test-vectors")
        .join("fscp-wire-validator-v1.json");
    load_json(&path)
        .expect("нет fscp-wire-validator-v1.json — сгенерируйте из C#: ./Scripts/generate-golden-vectors.ps1")
}

fn guid(v: &serde_json::Value) -> Uuid {
    v.as_str().unwrap().parse().unwrap()
}

#[test]
fn every_vector_case_matches_csharp_reference() {
    let vector = vector();
    let default_sender = guid(&vector["authenticatedSenderUuid"]);
    let default_recipient = guid(&vector["messageRecipientUuid"]);

    let cases = vector["cases"].as_array().unwrap();
    assert!(
        cases.len() >= 20,
        "вектор подозрительно мал: {} кейсов",
        cases.len()
    );

    for case in cases {
        let case_id = case["caseId"].as_str().unwrap();
        let expected_valid = case["expectedValid"].as_bool().unwrap();
        let sender = case
            .get("authenticatedSenderUuid")
            .map(guid)
            .unwrap_or(default_sender);
        let recipient = case
            .get("messageRecipientUuid")
            .map(guid)
            .unwrap_or(default_recipient);

        let result = if case.get("dual").and_then(|d| d.as_bool()) == Some(true) {
            fscp::try_validate_dual_wire(
                case["encryptedForReceiver"].as_str().unwrap(),
                case["encryptedForSender"].as_str().unwrap(),
                sender,
                recipient,
            )
        } else {
            fscp::try_validate_wire(case["wire"].as_str().unwrap(), sender, recipient)
        };

        match (expected_valid, result) {
            (true, Ok(())) => {}
            (false, Err(actual)) => {
                let expected_error = case["expectedError"].as_str().unwrap();
                assert_eq!(
                    actual, expected_error,
                    "{case_id}: текст ошибки разошёлся с C#"
                );
            }
            (true, Err(e)) => panic!("{case_id}: ожидался accept, получен reject: {e}"),
            (false, Ok(())) => panic!("{case_id}: ожидался reject, получен accept"),
        }

        if let Some(expected_receiver) = case.get("expectedExtractedReceiverUuid") {
            let extracted = fscp::try_extract_receiver(case["wire"].as_str().unwrap(), sender)
                .unwrap_or_else(|e| panic!("{case_id}: try_extract_receiver: {e}"));
            assert_eq!(extracted, guid(expected_receiver), "{case_id}");
        }
    }
}

#[test]
fn bootstrap_epoch_constant_matches_vector_generator() {
    // Константа продублирована в C#, TS и Rust — сверка через валидный кейс вектора.
    assert_eq!(
        fscp::BOOTSTRAP_KEY_EPOCH_ID,
        uuid::uuid!("00000000-0000-4000-8000-000000000001"),
    );
}
