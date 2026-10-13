# Source Rights Decision Schema v2

`guru.schemas.rights_decision.RightsDecision` is a strict, versioned record for
one source artifact. It binds the source ID, URI, immutable revision, and
artifact SHA-256 to a named reviewer, a timezone-qualified decision time, a
provenance statement, an explicit authority basis, and hashed evidence
references.

The `rights` object requires six explicit booleans: training, evaluation,
ephemeral transformation, transformed-data retention, provider transmission,
and weight distribution. `false` means denied. Ephemeral transformation is a
separate source permission from retaining transformed data. The owner-selected
I7 policy currently permits only ephemeral transformed-data use, denies
retention and corpus persistence, and does not provide an ephemeral training
runtime. A passing license check establishes rights inputs only; it does not
prove that ephemeral processing or training occurred. A missing value, `null`,
string, integer, unknown authority basis, or unrecognized extra field is
rejected. The schema does not infer any permission from an SPDX identifier or
license text; the reviewer must make and evidence each decision.

Version 1 records are intentionally not accepted as version 2. Re-issue any
trusted record only after the reviewer explicitly decides the new
`allow_ephemeral_transformation` permission, then update the rights manifest
digest and its trusted pin. Test fixtures are not production approvals.

`authority_basis` accepts only `license_text`, `provider_terms`,
`direct_permission`, `public_domain_record`, or `owner_attestation`. Each record
must include at least one evidence reference with a unique ID and lowercase
SHA-256 digest. The schema checks the supplied structure and digest format; it
does not fetch, verify, or independently assess external evidence.
