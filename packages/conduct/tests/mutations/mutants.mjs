const cp = `    if (!this.counterparties.has(action.counterparty)) {
      return deny("COUNTERPARTY_NOT_ALLOWED");
    }
`;
const cap = `    const spent = this.spentInWindow(action.timestamp);
    if (spent + action.amount > cap.amount) {
      return deny("SPEND_CAP_EXCEEDED");
    }
`;
// The review's 16 semantic mutations, rebased onto the hardened implementation.
export const mutants = [
  ["M1_counterparty_after_cap", "guard.ts", cp + cap, cap + cp],
  ["M2_asset_after_counterparty", "guard.ts", "if (action.asset !== cap.asset) {", "if (action.asset !== cap.asset && this.counterparties.has(action.counterparty)) {"],
  ["M3_egress_skips_validity", "guard.ts", "    const { validityWindow } = this.policy;", "    if (action.kind === \"egress\") return this.evaluateEgress(action);\n    const { validityWindow } = this.policy;"],
  ["M4_wrapping_u64_sum", "guard.ts", "if (spent + action.amount > cap.amount) {", "if (((spent + action.amount) & ((1n << 64n) - 1n)) > cap.amount) {"],
  ["M5_CTRL_denyall_after_membership", "guard.ts", "    if (this.policy.egressPolicy.mode === EGRESS_DENY_ALL) {\n      return deny(\"EGRESS_DENIED\");\n    }\n", ""],
  ["M6_CTRL_notafter_inclusive", "guard.ts", "if (action.timestamp >= validityWindow.notAfter)", "if (action.timestamp > validityWindow.notAfter)"],
  ["M7_CTRL_denied_accrues", "guard.ts", "if (decision.allowed && action.kind === \"payment\") {", "if (action.kind === \"payment\") {"],
  ["M8_trace_drops_actionDigest", "events.ts", "return { ...event, seq: event.seq.toString(),", "return { ...event, actionDigest: undefined, seq: event.seq.toString(),"],
  ["M9_trace_drops_mandateCommitment", "events.ts", "return { ...event, seq: event.seq.toString(),", "return { ...event, mandateCommitment: undefined, seq: event.seq.toString(),"],
  ["M10_digest_omits_counterparty", "actions.ts", "          [3n, action.counterparty],\n", ""],
  ["M11_digest_domain_changed", "actions.ts", "orynq:conduct:guard:action:v1|", "orynq:conduct:guard:action:v9|"],
  ["M12_CTRL_denial_typed_as_action", "guard.ts", "type: \"orynq.conduct.guard.denial.v1\",\n          ...base,", "type: \"orynq.conduct.guard.action.v1\" as \"orynq.conduct.guard.denial.v1\",\n          ...base,"],
  ["M13_CTRL_no_action_copy", "guard.ts", "    action = { ...action };\n    validateAction(action);\n    if (typeof enforcedAt", "    validateAction(action);\n    if (typeof enforcedAt"],
  ["M14_CTRL_cap_exact_denied", "guard.ts", "if (spent + action.amount > cap.amount) {", "if (spent + action.amount >= cap.amount) {"],
  ["M15_digest_omits_timestamp", "actions.ts", "          [4n, action.timestamp],\n", ""],
  ["M16_egress_uses_counterparty_list", "guard.ts", "this.egressDestinations = new Set(egressList);", "this.egressDestinations = new Set([...egressList, ...counterparties]);"],
];
