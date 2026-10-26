use base_crypto::{signatures::Signature, time::Timestamp};
use ledger::{
    semantics::{TransactionContext, TransactionResult},
    structure::{LedgerState, ProofMarker, Transaction},
    verify::WellFormedStrictness,
};
use onchain_runtime::context::BlockContext;
use serde::Deserialize;
use serialize::{tagged_deserialize, tagged_serialize};
use std::{error::Error, fs, path::PathBuf};
use storage::db::InMemoryDB;
use transient_crypto::commitment::PureGeneratorPedersen;

type Tx = Transaction<Signature, ProofMarker, PureGeneratorPedersen, InMemoryDB>;

#[derive(Deserialize)]
struct Fixture {
    timestamp: u64,
    deadline: u64,
}

fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/onchain")
}

fn context(state: &LedgerState<InMemoryDB>, seconds: u64) -> TransactionContext<InMemoryDB> {
    TransactionContext {
        ref_state: state.clone(),
        block_context: BlockContext {
            tblock: Timestamp::from_secs(seconds),
            last_block_time: Timestamp::from_secs(seconds - 1),
            ..BlockContext::default()
        },
        whitelist: None,
    }
}

#[test]
fn native_ledger_applies_deploy_and_concurrent_real_proofs() -> Result<(), Box<dyn Error>> {
    let dir = directory();
    let fixture: Fixture = serde_json::from_slice(&fs::read(dir.join("fixture.json"))?)?;
    let mut state: LedgerState<InMemoryDB> =
        tagged_deserialize(&fs::read(dir.join("blank.bin"))?[..])?;
    let mut strictness = WellFormedStrictness::default();
    strictness.enforce_balancing = false;
    for name in ["deploy", "proveCapability", "proveRolling1"] {
        let tx: Tx = tagged_deserialize(&fs::read(dir.join(format!("{name}.bin")))?[..])?;
        let verified =
            tx.well_formed(&state, strictness, Timestamp::from_secs(fixture.timestamp))?;
        let (next, result) = state.apply(&verified, &context(&state, fixture.timestamp));
        assert!(
            matches!(result, TransactionResult::Success(_)),
            "{name}: {result:?}"
        );
        state = next;
    }
    let mut encoded = Vec::new();
    tagged_serialize(&state, &mut encoded)?;
    assert_eq!(
        encoded,
        fs::read(dir.join("final.bin"))?,
        "native and JS ledger states differ"
    );
    Ok(())
}

#[test]
fn native_ledger_rechecks_the_proved_deadline() -> Result<(), Box<dyn Error>> {
    let dir = directory();
    let fixture: Fixture = serde_json::from_slice(&fs::read(dir.join("fixture.json"))?)?;
    let state: LedgerState<InMemoryDB> =
        tagged_deserialize(&fs::read(dir.join("deployed.bin"))?[..])?;
    let mut strictness = WellFormedStrictness::default();
    strictness.enforce_balancing = false;
    for name in ["proveCapability", "proveRolling1"] {
        let mut tx: Tx = tagged_deserialize(&fs::read(dir.join(format!("{name}.bin")))?[..])?;
        let Transaction::Standard(standard) = &mut tx else {
            panic!("expected standard proof transaction")
        };
        let selected = standard.intents.iter().next().ok_or("missing intent")?;
        let key = *selected.0;
        let mut intent = (*selected.1).clone();
        intent.ttl = Timestamp::from_secs(fixture.deadline + 1800);
        standard.intents = standard.intents.insert(key, intent);
        let verified =
            tx.well_formed(&state, strictness, Timestamp::from_secs(fixture.deadline))?;
        let (_, result) = state.apply(&verified, &context(&state, fixture.deadline));
        assert!(
            matches!(result, TransactionResult::Failure(_)),
            "expired {name}: {result:?}"
        );
    }
    Ok(())
}
