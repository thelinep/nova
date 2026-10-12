# Source Rights Decision Schema v1

`guru.schemas.rights_decision.RightsDecision` is a strict, versioned record for
one source artifact. It binds the source ID, URI, immutable revision, and
artifact SHA-256 to a named reviewer, a timezone-qualified decision time, a
provenance statement, an explicit authority basis, and hashed evidence
references.

The `rights` object requires five explicit booleans: training, evaluation,
transformed-data retention, provider transmission, and weight distribution.
`false` means denied. A missing value, `null`, string, integer, unknown authority
basis, or unrecognized extra field is rejected. The schema does not infer any
permission from an SPDX identifier or license text; the reviewer must make and
evidence each decision. It is a data contract only and is not yet wired into
corpus admission or quality checks.

`authority_basis` accepts only `license_text`, `provider_terms`,
`direct_permission`, `public_domain_record`, or `owner_attestation`. Each record
must include at least one evidence reference with a unique ID and lowercase
SHA-256 digest. The schema checks the supplied structure and digest format; it
does not fetch, verify, or independently assess external evidence.
