use base_crypto::{
    signatures::Signature,
    time::{Duration, Timestamp},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use ledger::structure::{ContractAction, LedgerState, ProofMarker, Transaction};
use onchain_runtime::state::{ChargedState, StateValue};
use serde_json::{Value, json};
use serialize::{tagged_deserialize, tagged_serialize};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};
use storage::{arena::Sp, db::InMemoryDB};
use transient_crypto::commitment::{PedersenRandomness, PureGeneratorPedersen};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn request(transaction: &str) -> Value {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    type Unbound = Transaction<Signature, ProofMarker, PedersenRandomness, InMemoryDB>;
    let mut unbound: Unbound =
        tagged_deserialize(&fs::read(fixtures().join(transaction)).unwrap()[..]).unwrap();
    let Transaction::Standard(standard) = &mut unbound else {
        panic!("expected standard fixture");
    };
    let selected = standard.intents.iter().next().unwrap();
    let mut intent = (*selected.1).clone();
    // Refresh only the synthetic transaction's lifetime; proof public inputs and witness stay unchanged.
    intent.ttl = Timestamp::from_secs(now + 1800);
    standard.intents = standard.intents.insert(*selected.0, intent);
    let finalized = unbound.seal(rand::rngs::OsRng);
    let mut tx_bytes = Vec::new();
    tagged_serialize(&finalized, &mut tx_bytes).unwrap();
    json!({
        "circuitId": "synthetic-sha256-fixture-v1",
        "transactionBase64": STANDARD.encode(tx_bytes),
        "referenceStateBase64": STANDARD.encode(fs::read(fixtures().join("reference-state.bin")).unwrap()),
        "verificationTimeUnixSeconds": now
    })
}

// The binding signature does not cover the TTL, so anyone holding a transaction can rewrite it.
fn retimed(input: &Value, ttl: u64) -> String {
    type Bound = Transaction<Signature, ProofMarker, PureGeneratorPedersen, InMemoryDB>;
    let raw = STANDARD
        .decode(input["transactionBase64"].as_str().unwrap())
        .unwrap();
    let mut tx: Bound = tagged_deserialize(&raw[..]).unwrap();
    let Transaction::Standard(standard) = &mut tx else {
        panic!("expected standard fixture");
    };
    let selected = standard.intents.iter().next().unwrap();
    let mut intent = (*selected.1).clone();
    intent.ttl = Timestamp::from_secs(ttl);
    standard.intents = standard.intents.insert(*selected.0, intent);
    let mut bytes = Vec::new();
    tagged_serialize(&tx, &mut bytes).unwrap();
    STANDARD.encode(bytes)
}

fn invoke(input: Value, registry: PathBuf) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_orynq-midnight-verifier"))
        .args(["--registry", registry.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&input).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|_| panic!("invalid response; exit {:?}", output.status.code()))
}

#[test]
fn accepts_genuine_proof_using_trusted_key_and_initial_state() {
    let result = invoke(
        request("valid-unbound.bin"),
        fixtures().join("registry.json"),
    );
    assert_eq!(result["valid"], true);
    assert_eq!(result["code"], "verified");
}

#[test]
fn rejects_corrupted_proof_cryptographically() {
    let result = invoke(
        request("tampered-proof-unbound.bin"),
        fixtures().join("registry.json"),
    );
    assert_eq!(result["valid"], false);
    assert_eq!(result["code"], "invalid-proof");
}

#[test]
fn rejects_changed_public_root_after_valid_rebinding() {
    let result = invoke(
        request("tampered-root-unbound.bin"),
        fixtures().join("registry.json"),
    );
    assert_eq!(result["valid"], false);
    assert_eq!(result["code"], "invalid-proof");
}

#[test]
fn rejects_unknown_circuit() {
    let mut input = request("valid-unbound.bin");
    input["circuitId"] = json!("unregistered");
    let result = invoke(input, fixtures().join("registry.json"));
    assert_eq!(result["valid"], false);
    assert_eq!(result["code"], "unknown-circuit");
}

#[test]
fn rejects_invalid_base64_and_serialized_state() {
    for field in ["transactionBase64", "referenceStateBase64"] {
        for invalid in ["!", "eA=="] {
            let mut input = request("valid-unbound.bin");
            input[field] = json!(invalid);
            let result = invoke(input, fixtures().join("registry.json"));
            assert_eq!(result["valid"], false);
            assert_eq!(result["code"], "malformed-input");
        }
    }
}

#[test]
fn missing_trust_configuration_fails_closed() {
    let result = invoke(
        request("valid-unbound.bin"),
        fixtures().join("absent-registry.json"),
    );
    assert_eq!(result["valid"], false);
    assert_eq!(result["code"], "configuration-error");
}

#[test]
fn caller_cannot_supply_verifier_key_path() {
    let mut input = request("valid-unbound.bin");
    input["verifierKeyPath"] = json!("proveRoot.verifier");
    let result = invoke(input, fixtures().join("registry.json"));
    assert_eq!(result["valid"], false);
    assert_eq!(result["code"], "malformed-input");
}

#[test]
fn caller_cannot_choose_a_stale_validation_clock() {
    let mut input = request("valid-unbound.bin");
    input["verificationTimeUnixSeconds"] =
        json!(input["verificationTimeUnixSeconds"].as_u64().unwrap() - 300);
    let result = invoke(input, fixtures().join("registry.json"));
    assert_eq!(result["valid"], false);
    assert_eq!(result["code"], "invalid-time");
}

#[test]
fn past_clock_cannot_resurrect_an_expired_transaction() {
    let mut input = request("valid-unbound.bin");
    let now = input["verificationTimeUnixSeconds"].as_u64().unwrap();
    input["transactionBase64"] = json!(retimed(&input, now - 60));
    input["verificationTimeUnixSeconds"] = json!(now - 300);
    let result = invoke(input, fixtures().join("registry.json"));
    assert_eq!(result["valid"], false);
    assert_eq!(result["code"], "invalid-time");
}

#[test]
fn substituted_reference_key_or_ledger_values_are_rejected() {
    for alter_key in [true, false] {
        let mut input = request("valid-unbound.bin");
        type Bound = Transaction<Signature, ProofMarker, PureGeneratorPedersen, InMemoryDB>;
        let raw = STANDARD
            .decode(input["transactionBase64"].as_str().unwrap())
            .unwrap();
        let tx: Bound = tagged_deserialize(&raw[..]).unwrap();
        let Transaction::Standard(standard) = tx else {
            panic!("expected standard fixture");
        };
        let (_, action) = standard.actions().next().unwrap();
        let ContractAction::Call(call) = action else {
            panic!("expected call fixture");
        };
        let mut state: LedgerState<InMemoryDB> =
            tagged_deserialize(&fs::read(fixtures().join("reference-state.bin")).unwrap()[..])
                .unwrap();
        let mut selected = state.index(call.address).unwrap();
        if alter_key {
            let mut op = (*selected.operations.get(&call.entry_point).unwrap()).clone();
            op.v2 = Some(
                tagged_deserialize(
                    &fs::read(fixtures().join("different-circuit.verifier")).unwrap()[..],
                )
                .unwrap(),
            );
            selected.operations = selected.operations.insert(call.entry_point.clone(), op);
        } else {
            selected.data = ChargedState::new(StateValue::Null);
        }
        state.contract = state.contract.insert(call.address, selected);
        let mut modified = Vec::new();
        tagged_serialize(&state, &mut modified).unwrap();
        input["referenceStateBase64"] = json!(STANDARD.encode(modified));
        let result = invoke(input, fixtures().join("registry.json"));
        assert_eq!(result["valid"], false);
        assert_eq!(result["code"], "untrusted-state");
    }
}

#[test]
fn reference_state_must_carry_initial_ledger_parameters() {
    let mut input = request("valid-unbound.bin");
    let mut state: LedgerState<InMemoryDB> =
        tagged_deserialize(&fs::read(fixtures().join("reference-state.bin")).unwrap()[..]).unwrap();
    let mut parameters = (*state.parameters).clone();
    parameters.global_ttl = Duration::from_secs(400_000_000);
    state.parameters = Sp::new(parameters);
    let mut modified = Vec::new();
    tagged_serialize(&state, &mut modified).unwrap();
    input["referenceStateBase64"] = json!(STANDARD.encode(modified));
    let result = invoke(input, fixtures().join("registry.json"));
    assert_eq!(result["valid"], false);
    assert_eq!(result["code"], "untrusted-state");
}

#[test]
fn expired_ttl_is_rejected_at_the_current_clock() {
    let mut input = request("valid-unbound.bin");
    let now = input["verificationTimeUnixSeconds"].as_u64().unwrap();
    input["transactionBase64"] = json!(retimed(&input, now - 60));
    let result = invoke(input, fixtures().join("registry.json"));
    assert_eq!(result["valid"], false);
    assert_eq!(result["code"], "invalid-transaction");
}

#[test]
fn registry_key_must_match_trusted_constructor_template() {
    let result = invoke(
        request("valid-unbound.bin"),
        fixtures().join("wrong-key-registry.json"),
    );
    assert_eq!(result["valid"], false);
    assert_eq!(result["code"], "configuration-error");
}

#[test]
fn additional_calls_are_rejected() {
    let mut input = request("valid-unbound.bin");
    type Bound = Transaction<Signature, ProofMarker, PureGeneratorPedersen, InMemoryDB>;
    let raw = STANDARD
        .decode(input["transactionBase64"].as_str().unwrap())
        .unwrap();
    let mut tx: Bound = tagged_deserialize(&raw[..]).unwrap();
    let Transaction::Standard(standard) = &mut tx else {
        panic!("expected standard fixture");
    };
    let selected = standard.intents.iter().next().unwrap();
    let mut intent = (*selected.1).clone();
    let action = intent.actions.get(0).unwrap().clone();
    intent.actions = vec![action.clone(), action].into();
    standard.intents = standard.intents.insert(*selected.0, intent);
    let mut modified = Vec::new();
    tagged_serialize(&tx, &mut modified).unwrap();
    input["transactionBase64"] = json!(STANDARD.encode(modified));
    let result = invoke(input, fixtures().join("registry.json"));
    assert_eq!(result["valid"], false);
    assert_eq!(result["code"], "unexpected-transaction");
}

#[test]
fn oversized_requests_are_rejected() {
    let mut input = request("valid-unbound.bin");
    input["transactionBase64"] = json!("A".repeat(4 * 1024 * 1024));
    let result = invoke(input, fixtures().join("registry.json"));
    assert_eq!(result["valid"], false);
    assert_eq!(result["code"], "malformed-input");
}
