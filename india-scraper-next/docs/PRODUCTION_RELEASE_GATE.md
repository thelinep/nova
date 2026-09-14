# Production release gate

This repository is a **local, single-operator application**. Its current
loopback-only routes, SQLite files, and local Ollama integration are not an
authorization or tenancy system. Do not expose the process through a tunnel,
reverse proxy, container port mapping, or public deployment until every gate
below has verified evidence.

## Authorization

Before any non-loopback deployment, select and configure an identity provider,
an issuer/audience, session lifetime, organization model, and role model. The
application must then enforce authenticated identity and organization scope on
every API route before it reads or writes data. At minimum, define distinct
operator, curator, reviewer, and read-only roles; deny collection, export,
deletion, model/network settings, and query-method changes unless the role is
explicitly allowed. Log the authenticated principal, organization, action,
target, request ID, and outcome for every mutation.

No placeholder header, browser-stored role, or proxy-only rule is evidence of
application authorization. Prove both allowed and denied paths with integration
tests using real signed sessions from the selected provider.

## Deployment

Choose a hosting account, region, domain, TLS configuration, managed database
and object-backup location before deployment. SQLite files and collector state
must not be placed on ephemeral server storage or shared between replicas.
Run the collector as a single supervised worker with one durable lock and a
separate web process. Store secrets in the deployment secret manager, never in
the repository or browser.

The deployment must have health checks, structured logs, alerting, backup
retention, tested restore, rollback, and a documented incident contact. Run a
staging deployment before production and verify that all public ingress reaches
only the authenticated application endpoint.

## Data governance

Every imported or collected dataset needs a source register recording:

* source owner, URL or contract, license/terms, allowed use and redistribution;
* acquisition time, importer version, checksum or immutable source reference;
* fields classified as public business data, personal data, or unknown;
* retention period, deletion/review process, and responsible owner;
* verification, permission, and freshness status.

The GeoNames catalogue remains CC BY 4.0 with provenance in its manifest. The
event-planner dataset is a non-exhaustive public-search snapshot: it is not an
approved supplier list, a census, a verified district-membership record, or a
contact-permission record. Google Maps collection must not be promoted or
redistributed until its permitted use and any required licensing are confirmed.

Keep raw source observations separate from derived planner-category exports.
Do not infer personal contacts. Support deletion/correction requests only after
the public-facing product has an accountable intake and review owner.

## Collection release gate

The all-district run is complete only when every district in the frozen iGOD
manifest has a persisted terminal status, the one retry pass has concluded, and
the final status export includes its manifest hash, per-query timestamps,
method, source URL, result count, and limitation label. A `limited_view`,
`no_results`, or `visible_list_exhausted` status remains an observed search
outcome, not a coverage guarantee.

## Required evidence

Record the date, command/configuration identifier, result, reviewer, and
artifact path for each release check:

1. Unit, type, production-build, and browser tests.
2. Authorization allow/deny and tenant-isolation integration tests.
3. Staging deployment, TLS, health, backup, restore, rollback, and alert tests.
4. Source register and legal/rights review for every published dataset.
5. Final collection coverage report and manual review of access challenges,
   failed districts, and limited-view outcomes.

Without that evidence, label the product as local-only and do not describe it
as production-ready, publicly deployed, authorized, or data-governed.
