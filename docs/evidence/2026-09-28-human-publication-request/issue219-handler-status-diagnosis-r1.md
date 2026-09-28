The first handler run after the context fix (`issue219-handler-green-r1.json`)
observed four passing tests and one failure. The failure was the newly added
claim assertion expecting HTTP 403 after changing the saved human authorizer's
role from owner to guest. The native `ensure_actor_role_tx` check rejects that
change using an unprefixed error, and the existing server mapping returns HTTP
400. This is an incorrect new test expectation, not an observed authorization
bypass. No production error mapping was changed to satisfy the test.

The revised test requires HTTP 400 and the exact native role-change error, then
checks that artifact access without an active lease is rejected and the
publication attempt count remains zero. Its result is recorded separately in
the subsequent handler receipt; this diagnosis is not a passing test receipt.

The original behavioral red evidence remains `issue219-handler-red-r4.json`:
tokenless metadata readback failed after room revocation and cross-Corp artifact
metadata was returned. Earlier fixture setup errors remain separate from those
behavioral findings. The fixtures contain explicitly synthetic saved metadata
and do not establish genuine verification, a human decision, or Git effects.
