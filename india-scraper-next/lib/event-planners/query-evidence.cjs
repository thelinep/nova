const ALLOWED_STATUSES = new Set(['blocked', 'no_results', 'limited_view', 'visible_list_exhausted', 'partial', 'failed']);

function iso(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw Error(`Invalid ${field}`);
  return value;
}

function validateRecord(record, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error(`Invalid raw record ${index}`);
  if (typeof record.name !== 'string' || !record.name.trim()) throw Error(`Raw record ${index} has no name`);
  if (typeof record.maps_url !== 'string' || !record.maps_url.startsWith('https://www.google.com/maps/')) throw Error(`Raw record ${index} has an invalid Maps URL`);
  if (record.source !== 'Google Maps public search') throw Error(`Raw record ${index} has invalid source provenance`);
  if (record.verification_status !== 'SOURCE_LISTED_UNVERIFIED') throw Error(`Raw record ${index} has invalid verification status`);
  if (record.district_membership !== 'UNVERIFIED_SEARCH_ASSOCIATION') throw Error(`Raw record ${index} has invalid district association`);
  return record;
}

function validateEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Evidence must be an object');
  if (value.schemaVersion !== 1) throw Error('Unsupported evidence schema version');
  for (const field of ['queryHistoryId', 'taskId', 'methodId', 'query', 'district', 'category', 'limitation']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) throw Error(`Missing ${field}`);
  }
  if (!ALLOWED_STATUSES.has(value.status)) throw Error('Invalid evidence status');
  if (typeof value.sourceUrl !== 'string' || !value.sourceUrl.startsWith('https://www.google.com/maps/search/')) throw Error('Invalid evidence source URL');
  const started = iso(value.startedAt, 'startedAt');
  const finished = iso(value.finishedAt, 'finishedAt');
  if (Date.parse(finished) < Date.parse(started)) throw Error('Evidence finished before it started');
  if (!Array.isArray(value.rawRecords)) throw Error('rawRecords must be an array');
  value.rawRecords.forEach(validateRecord);
  if (!Number.isInteger(value.resultCount) || value.resultCount !== value.rawRecords.length) throw Error('Evidence result count does not match raw records');
  return value;
}

function createEvidence({ id, task, method, query, startedAt, finishedAt, result }) {
  const category = method.id.startsWith('venue-') ? method.id.slice('venue-'.length).replaceAll('-', ' ') : method.name;
  return validateEvidence({
    schemaVersion: 1,
    queryHistoryId: id,
    taskId: task.id,
    methodId: method.id,
    query,
    district: task.district,
    category,
    sourceUrl: result.url,
    startedAt,
    finishedAt,
    status: result.status,
    resultCount: result.records.length,
    limitation: result.note,
    rawRecords: result.records,
  });
}

module.exports = { ALLOWED_STATUSES, createEvidence, validateEvidence };
