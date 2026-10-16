use base_crypto::{signatures::Signature, time::Timestamp};
use base64::{Engine, engine::general_purpose::STANDARD};
use ledger::{
    error::MalformedTransaction,
    structure::{ContractAction, INITIAL_PARAMETERS, LedgerState, ProofMarker, Transaction},
    verify::WellFormedStrictness,
};
use onchain_runtime::state::ContractState;
use serde::Deserialize;
use serde_json::json;
use serialize::{tagged_deserialize, tagged_serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use storage::db::InMemoryDB;
use transient_crypto::{commitment::PureGeneratorPedersen, proofs::VerifierKey};

const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
type FinalizedTransaction = Transaction<Signature, ProofMarker, PureGeneratorPedersen, InMemoryDB>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    circuit_id: String,
    transaction_base64: String,
    reference_state_base64: String,
    verification_time_unix_seconds: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u32,
    circuits: BTreeMap<String, Circuit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Circuit {
    entry_point: String,
    verifier_key_path: PathBuf,
    initial_contract_state_path: PathBuf,
}

fn verify(registry_path: &Path, input: &[u8]) -> Result<(), &'static str> {
    let request: Request = serde_json::from_slice(input).map_err(|_| "malformed-input")?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "invalid-time")?
        .as_secs();
    if now.abs_diff(request.verification_time_unix_seconds) > 30 {
        return Err("invalid-time");
    }
    let registry_bytes = fs::read(registry_path).map_err(|_| "configuration-error")?;
    let registry: Registry =
        serde_json::from_slice(&registry_bytes).map_err(|_| "configuration-error")?;
    if registry.version != 1 {
        return Err("configuration-error");
    }
    let circuit = registry
        .circuits
        .get(&request.circuit_id)
        .ok_or("unknown-circuit")?;
    let directory = registry_path.parent().ok_or("configuration-error")?;
    let key_bytes =
        fs::read(directory.join(&circuit.verifier_key_path)).map_err(|_| "configuration-error")?;
    let trusted_key: VerifierKey =
        tagged_deserialize(&key_bytes[..]).map_err(|_| "configuration-error")?;
    let initial_bytes = fs::read(directory.join(&circuit.initial_contract_state_path))
        .map_err(|_| "configuration-error")?;
    let template: ContractState<InMemoryDB> =
        tagged_deserialize(&initial_bytes[..]).map_err(|_| "configuration-error")?;
    let entry_point = circuit.entry_point.as_bytes().into();
    let template_operation = template
        .operations
        .get(&entry_point)
        .ok_or("configuration-error")?;
    if template_operation.v2.as_ref() != Some(&trusted_key) {
        return Err("configuration-error");
    }

    let tx_bytes = STANDARD
        .decode(&request.transaction_base64)
        .map_err(|_| "malformed-input")?;
    let state_bytes = STANDARD
        .decode(&request.reference_state_base64)
        .map_err(|_| "malformed-input")?;
    let transaction: FinalizedTransaction =
        tagged_deserialize(&tx_bytes[..]).map_err(|_| "malformed-input")?;
    let state: LedgerState<InMemoryDB> =
        tagged_deserialize(&state_bytes[..]).map_err(|_| "malformed-input")?;
    let Transaction::Standard(standard) = &transaction else {
        return Err("unexpected-transaction");
    };
    if standard.intents.iter().take(2).count() != 1
        || standard.guaranteed_coins.is_some()
        || !standard.fallible_coins.is_empty()
    {
        return Err("unexpected-transaction");
    }
    let selected_intent = standard
        .intents
        .iter()
        .next()
        .ok_or("unexpected-transaction")?;
    let intent = &selected_intent.1;
    if intent.actions.len() != 1
        || intent.dust_actions.is_some()
        || intent.guaranteed_unshielded_offer.is_some()
        || intent.fallible_unshielded_offer.is_some()
    {
        return Err("unexpected-transaction");
    }
    let action = intent.actions.get(0).ok_or("unexpected-transaction")?;
    let ContractAction::Call(call) = action else {
        return Err("unexpected-transaction");
    };
    if call.entry_point != entry_point {
        return Err("unexpected-transaction");
    }
    if *state.parameters != INITIAL_PARAMETERS {
        return Err("untrusted-state");
    }
    let selected_state = state.index(call.address).ok_or("untrusted-state")?;
    let selected_operation = selected_state
        .operations
        .get(&call.entry_point)
        .ok_or("untrusted-state")?;
    if selected_operation.v2.as_ref() != Some(&trusted_key) {
        return Err("untrusted-state");
    }
    let mut selected_bytes = Vec::new();
    tagged_serialize(&selected_state, &mut selected_bytes).map_err(|_| "untrusted-state")?;
    if selected_bytes != initial_bytes {
        return Err("untrusted-state");
    }

    // This verifies an offchain statement; funding and network submission are separate operations.
    let mut strictness = WellFormedStrictness::default();
    strictness.enforce_balancing = false;
    transaction
        .well_formed(&state, strictness, Timestamp::from_secs(now))
        .map_err(|error| match error {
            MalformedTransaction::InvalidProof(_) => "invalid-proof",
            _ => "invalid-transaction",
        })?;
    Ok(())
}

fn main() {
    let args: Vec<_> = env::args_os().collect();
    let mut input = Vec::new();
    let read_result = io::stdin()
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut input);
    let result = if read_result.is_err() || input.len() > MAX_INPUT_BYTES {
        Err("malformed-input")
    } else if args.len() != 3 || args[1] != "--registry" {
        Err("configuration-error")
    } else {
        verify(Path::new(&args[2]), &input)
    };
    let (valid, code) = match result {
        Ok(()) => (true, "verified"),
        Err(code) => (false, code),
    };
    println!("{}", json!({ "valid": valid, "code": code }));
    if code == "configuration-error" {
        std::process::exit(2);
    }
}
