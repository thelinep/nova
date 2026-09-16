'use strict';

const crypto = require('node:crypto');
const ALLOWED_STATUSES = new Set(['blocked', 'no_results', 'limited_view', 'visible_list_exhausted', 'partial', 'failed']);
const CATEGORY_BY_METHOD = { 'venue-banquet-halls': 'banquet halls', 'venue-wedding-venues': 'wedding venues', 'venue-conference-centres': 'conference centres', 'venue-party-halls': 'party halls' };

function httpError(message) { return Object.assign(new Error(message), { statusCode: 422 }); }
function validIso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validateRecord(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(`Collector raw record ${index} is invalid.`);
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw httpError(`Collector raw record ${index} has no name.`);
  if (typeof raw.maps_url !== 'string' || !raw.maps_url.startsWith('https://www.google.com/maps/')) throw httpError(`Collector raw record ${index} has an invalid Maps URL.`);
  if (raw.source !== 'Google Maps public search' || raw.verification_status !== 'SOURCE_LISTED_UNVERIFIED' || raw.district_membership !== 'UNVERIFIED_SEARCH_ASSOCIATION') throw httpError(`Collector raw record ${index} has invalid provenance labels.`);
}
function normalize(run, value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) throw httpError('Collector output does not use evidence schema version 1.');
  const category = CATEGORY_BY_METHOD[value.methodId];
  if (!category || !run.categories.includes(category)) throw httpError('Collector output method is outside the approved plan.');
  for (const field of ['queryHistoryId','taskId','query','district','sourceUrl','startedAt','finishedAt','status','limitation']) if (typeof value[field] !== 'string' || !value[field].trim()) throw httpError(`Collector output is missing ${field}.`);
  if (!value.sourceUrl.startsWith('https://www.google.com/maps/search/')) throw httpError('Collector source URL is outside the configured source.');
  if (!validIso(value.startedAt) || !validIso(value.finishedAt) || Date.parse(value.finishedAt) < Date.parse(value.startedAt)) throw httpError('Collector timestamps are invalid.');
  if (!ALLOWED_STATUSES.has(value.status)) throw httpError('Collector status is invalid.');
  if (!Array.isArray(value.rawRecords)) throw httpError('Collector rawRecords must be an array.');
  value.rawRecords.forEach(validateRecord);
  if (!Number.isInteger(value.resultCount) || value.resultCount !== value.rawRecords.length) throw httpError('Collector result count does not match rawRecords.');
  const evidenceId = 'evidence_' + crypto.createHash('sha256').update(`${run.id}\0${value.queryHistoryId}`).digest('hex').slice(0, 24);
  return { id:evidenceId, schemaVersion:1, runId:run.id, queryHistoryId:value.queryHistoryId, taskId:value.taskId, sourceUrl:value.sourceUrl, methodId:value.methodId, query:value.query, district:value.district, category, startedAt:value.startedAt, finishedAt:value.finishedAt, receivedAt:new Date().toISOString(), status:value.status, resultCount:value.resultCount, limitation:value.limitation, rawRecords:value.rawRecords, rawResult:value };
}
function persist(store, run, value) {
  const evidence = normalize(run, value);
  store.put('collectorEvidence', evidence);
  for (const [index, raw] of evidence.rawRecords.entries()) {
    const listingKey = crypto.createHash('sha256').update(String(raw.place_id||raw.placeId||raw.maps_url)).digest('hex').slice(0, 24);
    store.put('venueObservations', { id:'observation_'+crypto.createHash('sha256').update(`${evidence.id}\0${listingKey}\0${index}`).digest('hex').slice(0,24), listingKey, runId:run.id, evidenceId:evidence.id, queryHistoryId:evidence.queryHistoryId, category:evidence.category, district:evidence.district, districtAssociation:'unverified', observedAt:evidence.finishedAt, receivedAt:evidence.receivedAt, sourceUrl:evidence.sourceUrl, raw });
  }
  return evidence;
}

module.exports = { ALLOWED_STATUSES, CATEGORY_BY_METHOD, normalize, persist };
