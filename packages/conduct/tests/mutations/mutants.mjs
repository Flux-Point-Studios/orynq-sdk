// [name, file, from, to]: `from` must match exactly once in packages/conduct/src/<file>.
const cp = `    if (!this.counterparties.has(action.counterparty)) {
      return deny("COUNTERPARTY_NOT_ALLOWED");
    }
`;
const cap = `    const spent = this.spentInWindow(action.timestamp);
    if (spent + action.amount > cap.amount) {
      return deny("SPEND_CAP_EXCEEDED");
    }
`;
const clockDecision = 'const decision = enforcedAt >= this.policy.validityWindow.notAfter ? deny("MANDATE_EXPIRED") : this.evaluate(action);';
const syncLatch = '    } catch (cause) {\n      this.sinkError = new Error("event sink failed", { cause });\n      throw cause;\n    }\n    return prepared.decision;';
const asyncLatch = '      return prepared.decision;\n    } catch (cause) {\n      this.sinkError = new Error("event sink failed", { cause });\n      throw cause;\n    } finally {';
const paymentSink = '    if (prepared.event.actionKind === "payment" && !this.onEvent) throw new Error("payment enforcement requires an event sink");\n';
const headCheck = "if (this.logHead.count !== recorded.head.count || this.logHead.hash !== recorded.head.hash) {";

// Semantic mutants from the first review.
const review = [
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

// The re-review's mutants of the first fix round, rebased onto the current code. N05 (clock notBefore check removed)
// has no target: an action time is never later than the guard clock, so evaluate's action-time check decides every
// case the clock check did and the redundant check was deleted. H16_evaluate_notBefore_removed covers that path.
const rereview = [
  ["N01_clock_backward_allowed", "guard.ts", "enforcedAt < this.lastEnforcedAt || ", ""],
  ["N02_window_check_removed", "guard.ts", "    if (this.windowIndex(action.timestamp) !== this.windowIndex(enforcedAt)) {\n      throw new Error(\"action timestamp must be in the guard clock's current window\");\n    }\n", ""],
  ["N03_action_time_backward_allowed", "guard.ts", "    if (action.timestamp < this.lastTimestamp) throw new Error(\"action timestamp must not move backward\");\n", ""],
  ["N04_clock_validity_removed", "guard.ts", clockDecision, "const decision = this.evaluate(action);"],
  ["N06_clock_notAfter_inclusive", "guard.ts", "enforcedAt >= this.policy.validityWindow.notAfter", "enforcedAt > this.policy.validityWindow.notAfter"],
  ["N07_clock_notAfter_removed", "guard.ts", clockDecision, "const decision = this.evaluate(action);"],
  ["N08_clock_uint64_bound_removed", "guard.ts", " || enforcedAt >= 1n << 64n) {", ") {"],
  ["N09_replay_compare_removed", "guard.ts", "if (canonicalize(guardEventData(event)) !== canonicalize(guardEventData(prepared.event))) {", "if (false) {"],
  ["N10_replay_no_reserve", "guard.ts", "        this.reserve(prepared);\n      } catch (cause) {", "      } catch (cause) {"],
  ["N12_thenable_check_removed", "guard.ts", "if (result !== null && (typeof result === \"object\" || typeof result === \"function\") && \"then\" in result && typeof result.then === \"function\") {", "if (false) {"],
  ["N13_callable_thenable_missed", "guard.ts", "(typeof result === \"object\" || typeof result === \"function\")", "typeof result === \"object\""],
  ["N14_sync_sink_error_not_latched", "guard.ts", syncLatch, "    } catch (cause) {\n      throw cause;\n    }\n    return prepared.decision;"],
  ["N15_async_sink_error_not_latched", "guard.ts", asyncLatch, "      return prepared.decision;\n    } catch (cause) {\n      throw cause;\n    } finally {"],
  ["N16_pending_not_set", "guard.ts", "    this.pending = true;\n", ""],
  ["N17_checkSink_ignores_error", "guard.ts", "if (this.sinkError) throw", "if (false) throw"],
  ["N18_checkSink_ignores_pending", "guard.ts", "if (this.pending) throw", "if (false) throw"],
  ["N19_enforceAsync_not_awaited", "guard.ts", "      await this.onEvent(prepared.event);", "      void this.onEvent(prepared.event);"],
  ["N20_precheck_canonicalize_removed", "guard.ts", "    return { event, decision, head: nextGuardLogHead(this.logHead, event) };", "    return { event, decision, head: this.logHead };"],
  ["N21_reserve_after_sync_sink", "guard.ts", "    this.reserve(prepared);\n    try {\n      const result = this.onEvent?.(prepared.event);", "    try {\n      const result = this.onEvent?.(prepared.event);\n      this.reserve(prepared);"],
  ["N22_lastEnforcedAt_not_tracked", "guard.ts", "    this.lastEnforcedAt = event.enforcedAt;\n", ""],
  ["N23_lastTimestamp_not_tracked", "guard.ts", "    this.lastTimestamp = event.timestamp;\n", ""],
  ["N24_action_not_frozen", "guard.ts", "      action: Object.freeze(action),", "      action,"],
  ["N25_event_not_frozen", "guard.ts", "const event: GuardEvent = Object.freeze(decision.allowed", "const event: GuardEvent = (decision.allowed"],
  ["N26_seq_not_incremented", "guard.ts", "    this.logHead = head;\n", ""],
  ["N27_default_clock_ms", "guard.ts", "(() => BigInt(Math.floor(Date.now() / 1000)))", "(() => BigInt(Date.now()))"],
  ["N28_async_sink_required_removed", "guard.ts", "    if (!this.onEvent) throw new Error(\"enforceAsync requires an event sink\");\n", ""],
  ["N29_counterparty_snapshot_removed", "guard.ts", "this.counterparties = new Set(counterparties);", "this.counterparties = new Set(counterpartyAllowlist);"],
  ["N30_egress_snapshot_removed", "guard.ts", "this.egressDestinations = new Set(egressList);", "this.egressDestinations = new Set(egressAllowlist);"],
  ["N31_policy_not_snapshotted", "guard.ts", "this.policy = decodeMandate(encodeMandate(mandate));", "this.policy = mandate; encodeMandate(mandate);"],
  ["N32_prepare_action_copy_removed", "guard.ts", "    action = { ...action };\n    validateAction(action);\n    if (typeof enforcedAt", "    validateAction(action);\n    if (typeof enforcedAt"],
  ["N33_evaluate_action_copy_removed", "guard.ts", "    action = { ...action };\n    validateAction(action);\n    const { validityWindow }", "    validateAction(action);\n    const { validityWindow }"],
  ["N34_replay_snapshot_skipped", "guard.ts", "const event = snapshotGuardEvent(source);", "const event = source;"],
  ["E01_event_unknown_key_check_removed", "events.ts", "  if (Reflect.ownKeys(event).some(key => typeof key !== \"string\" || !keys.includes(key))) throw new Error(\"unknown guard event field\");\n", ""],
  ["E02_event_digest_check_removed", "events.ts", "\n    || event.actionDigest !== actionDigestHex(event.action)) {", ") {"],
  ["E03_event_denial_rule_check_removed", "events.ts", "if (event.type === \"orynq.conduct.guard.denial.v1\"\n    && (typeof event.reason !== \"string\" || !Object.hasOwn(DENIAL_RULES, event.reason) || event.rule !== DENIAL_RULES[event.reason])) {", "if (false) {"],
  ["E04_event_type_check_removed", "events.ts", "if (event.type !== \"orynq.conduct.guard.action.v1\" && event.type !== \"orynq.conduct.guard.denial.v1\") {", "if (false) {"],
  ["E05_event_time_kind_binding_removed", "events.ts", "\n    || event.timestamp !== event.action.timestamp || event.actionKind !== event.action.kind", ""],
  ["E06_event_commitment_format_removed", "events.ts", "\n    || typeof event.mandateCommitment !== \"string\" || !/^[0-9a-f]{64}$/.test(event.mandateCommitment)", ""],
  ["E07_event_uint64_removed", "events.ts", "if ([event.seq, event.timestamp, event.enforcedAt].some(value => typeof value !== \"bigint\" || value < 0n || value >= 1n << 64n)", "if (false"],
  ["E08_trace_drops_enforcedAt", "events.ts", "enforcedAt: event.enforcedAt.toString(), action };", "enforcedAt: undefined, action };"],
  ["E09_event_action_copy_removed", "events.ts", "const event = { ...fields, action: { ...action } };", "const event = { ...fields, action };"],
  ["A01_action_unknown_key_removed", "actions.ts", "  if (Reflect.ownKeys(action).some((key) => typeof key !== \"string\" || !keys.includes(key))) {\n    throw new MandateError(\"SCHEMA_UNKNOWN_KEY\", \"unknown action key\");\n  }\n", ""],
  ["A03_zero_amount_allowed", "actions.ts", "  if (action.kind === \"payment\" && action.amount === 0n) {\n    throw new MandateError(\"SCHEMA_BAD_AMOUNT\", \"payment amount must be >= 1\");\n  }\n", ""],
  ["A04_asset_128_bound_removed", "actions.ts", "\n    || (action.kind === \"payment\" && Buffer.byteLength(action.asset, \"utf8\") > 128)) {", ") {"],
  ["A05_identifier_byte_bound_removed", "actions.ts", " || Buffer.byteLength(value, \"utf8\") > 256)", ")"],
  ["A07_digest_copy_removed", "actions.ts", "export function actionDigest(action: GuardAction): Uint8Array {\n  action = { ...action };\n", "export function actionDigest(action: GuardAction): Uint8Array {\n"],
  ["C01_committee_utf16_bound", "codec.ts", "Buffer.byteLength(d.committeeId, \"utf8\") > 128", "d.committeeId.length > 128"],
  ["C02_member_byte_bound_removed", "allowlist.ts", " || Buffer.byteLength(member, \"utf8\") > 256)", ")"],
  ["C03_allowlist_snapshot_removed", "allowlist.ts", "  members = Array.from(members);\n", ""],
  ["C04_mandate_snapshot_removed", "codec.ts", "  m = {\n    ...fields,", "  const _snapshot = {\n    ...fields,"],
  ["C05_decode_copy_removed", "codec.ts", "return cborMapToMandate(cborDecode(Uint8Array.from(bytes)));", "return cborMapToMandate(cborDecode(bytes));"],
  ["C06_commitment_copy_removed", "commitment.ts", "    body = Uint8Array.from(mandate);\n", "    body = mandate;\n"],
  ["P01_compiler_member_snapshot_removed", "predicate.ts", "const counterparties = new Set(counterpartyAllowlist);", "const counterparties = new Set(allowlists.counterpartyAllowlist);"],
  ["P02_compiler_mandate_snapshot_removed", "predicate.ts", "  mandate = decodeMandate(encodeMandate(mandate));\n", "  encodeMandate(mandate);\n"],
  ["P03_buildArgs_copy_removed", "predicate.ts", "      action = { ...action };\n      validateAction(action);", "      validateAction(action);"],
  ["V01_rule_text_changed", "verdict.ts", "\"payment exceeds the remaining window spend cap\"", "\"payment exceeds cap\""],
];

// Accounting state, the sink contract, the log head and the trace sink.
const accounting = [
  ["H01_history_defaults_to_fresh", "guard.ts", "  if (history === \"fresh\") return", "  if (history === \"fresh\" || history === undefined) return"],
  ["H02_history_shape_unchecked", "guard.ts", "  if (!Array.isArray(events) || typeof head !== \"object\" || head === null) throw new GuardConfigError(message);\n", ""],
  ["H03_payment_sink_not_required", "guard.ts", paymentSink, ""],
  ["H04_payment_sink_checked_after_reserve", "guard.ts", paymentSink + "    this.reserve(prepared);\n", "    this.reserve(prepared);\n" + paymentSink],
  ["H05_log_position_unchecked", "log.ts", "  if (snapshot.seq !== current.count) {", "  if (false) {"],
  ["H06_memory_log_head_not_advanced", "log.ts", "    this.head = nextGuardLogHead(this.head, snapshot);", "    nextGuardLogHead(this.head, snapshot);"],
  ["H07_memory_log_stores_caller_object", "log.ts", "    this.events.push(snapshot);", "    this.events.push(event);"],
  ["H08_memory_log_history_shares_array", "log.ts", "return { events: [...this.events], head: this.head };", "return { events: this.events, head: this.head };"],
  ["H09_restore_head_check_removed", "guard.ts", headCheck, "if (false) {"],
  ["H10_restore_head_count_unchecked", "guard.ts", headCheck, "if (this.logHead.hash !== recorded.head.hash) {"],
  ["H11_restore_head_hash_unchecked", "guard.ts", headCheck, "if (this.logHead.count !== recorded.head.count) {"],
  ["H12_head_shape_unchecked", "log.ts", "  if (typeof count !== \"bigint\" || count < 0n || count > 1n << 64n || typeof hash !== \"string\" || !/^[0-9a-f]{64}$/.test(hash)) {", "  if (false) {"],
  ["H13_head_chain_unlinked", "log.ts", "    .update(Buffer.from(current.hash, \"hex\"))\n", ""],
  ["H14_head_domain_dropped", "log.ts", "    .update(GUARD_LOG_DOMAIN)\n", ""],
  ["H15_future_action_time_allowed", "guard.ts", "    if (action.timestamp > enforcedAt) throw new Error(\"action timestamp must not be later than the guard clock\");\n", ""],
  ["H16_evaluate_notBefore_removed", "guard.ts", "    if (action.timestamp < validityWindow.notBefore) return deny(\"MANDATE_NOT_YET_VALID\");\n", ""],
  ["H17_denial_reason_type_unchecked", "events.ts", "typeof event.reason !== \"string\" || ", ""],
  ["H18_trace_sink_detached", "events.ts", "  return event => addEvent(run, spanId, customEventFields(event, visibility));", "  return event => (void addEvent(run, spanId, customEventFields(event, visibility)), Promise.resolve(undefined as never));"],
  ["H19_trace_sink_ignores_visibility", "events.ts", "customEventFields(event, visibility));", "customEventFields(event, \"private\"));"],
  ["H20_spend_window_never_resets", "guard.ts", "      if (window !== this.spendWindow) {\n        this.spendWindow = window;\n        this.windowSpent = 0n;\n      }\n", ""],
  ["H21_spend_reported_for_every_window", "guard.ts", "return this.windowIndex(timestamp) === this.spendWindow ? this.windowSpent : 0n;", "return this.windowSpent;"],
  ["H22_snapshot_not_frozen", "events.ts", "  Object.freeze(event.action);\n  return Object.freeze(event);", "  return event;"],
];

export const mutants = [...review, ...rereview, ...accounting];
