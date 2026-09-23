// Executor availability is not execution evidence. These scopes must never be merged.
export const requiredAdversarialCases = Object.freeze([
  'missing-file', 'altered-content', 'undeclared-file',
  'cross-corp', 'cross-task', 'cross-run', 'cross-recovery', 'cross-room', 'traversal',
  'destination-symlink', 'destination-reparse', 'file-count-limit',
  'oversized-file', 'wire-file-byte-limit', 'aggregate-byte-limit', 'prompt-byte-limit',
  'envelope-byte-limit', 'exact-limit-control', 'parent-tree-isolation', 'invalid-probe',
  'failed-parent', 'cancelled-parent', 'unauthorized-artifact',
])

export const serverAssertions = Object.freeze({
  'altered-content': ['signed_object_digest_mismatch_rejected', 'signed_envelope_inner_digest_mismatch_rejected'],
  'undeclared-file': ['signed_undeclared_file_rejected'],
  'cross-corp': ['signed_cross_corp_lineage_rejected'],
  'cross-task': ['signed_cross_task_lineage_rejected'],
  'cross-run': ['signed_cross_run_lineage_rejected'],
  'cross-recovery': ['signed_cross_recovery_edge_rejected'],
  'cross-room': ['cross_room_download_selector_rejected'],
  traversal: ['signed_traversal_path_rejected'],
  'prompt-byte-limit': ['exact_parent_prompt_bound_accepted_plus_one_rejected',
    'exact_combined_prompt_bound_accepted_plus_one_rejected',
    'typed_source_before_text_receipt_combined_bound_rejected',
    'legacy_only_combined_prompt_bound_rejected',
    'final_resumed_prompt_exact_bytes_accepted_instruction_and_notes_overflow_rejected'],
  'envelope-byte-limit': ['exact_envelope_bound_accepted_plus_one_rejected'],
  'cancelled-parent': ['persisted_cancelled_parent_task_rejected', 'persisted_cancelled_parent_run_rejected'],
  'failed-parent': ['persisted_failed_parent_task_rejected', 'persisted_failed_parent_run_rejected'],
  'unauthorized-artifact': ['nonmember_signed_download_selector_rejected'],
})
export const runnerCases = Object.freeze([
  'destination-symlink', 'destination-reparse', 'file-count-limit', 'wire-file-byte-limit',
  'aggregate-byte-limit', 'exact-limit-control', 'parent-tree-isolation',
  'missing-file', 'oversized-file', 'invalid-probe',
])
export const verifierCases = Object.freeze(['missing-file', 'oversized-file', 'invalid-probe'])
export const fixtureEntrypoints = Object.freeze({
  runner: 'issue297_native_fixtures::issue297_native_fixture_dispatch',
  server: 'artifacts::tests::issue297_native_adversarial_fixture',
})

export function adversarialExecutors() {
  return requiredAdversarialCases.map(case_id => {
    const native = runnerCases.includes(case_id) ? 'runner' : Object.hasOwn(serverAssertions, case_id) ? 'server' : null
    return { case_id, implemented: true, executor: native ? fixtureEntrypoints[native] : 'runResearchAdversarial',
      lane: native ?? 'owned-live-stack',
      evidence_scope: verifierCases.includes(case_id) ? 'native-runner-verifier'
        : native === 'runner' ? 'native-runner-assignment-materialization'
        : native === 'server' ? 'native-integrated-fixture' : 'native-full-stack-required' }
  })
}
