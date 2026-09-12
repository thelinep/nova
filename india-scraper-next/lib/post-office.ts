export type PostOfficeRecord = {
  source_id: string;
  name: string;
  country_code: string;
  postal_code: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  contact_person: string | null;
  source_url: string;
};

type RawPostOffice = Record<string, unknown>;

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/**
 * Normalizes one source record. This deliberately does not infer a missing
 * contact person: most public postal directories do not publish one.
 */
export function normalizePostOfficeRecord(raw: RawPostOffice, sourceUrl: string): PostOfficeRecord {
  const source = new URL(sourceUrl);
  if (!['http:', 'https:'].includes(source.protocol)) throw new Error('Post-office source URL must be HTTP(S)');

  const source_id = text(raw.source_id ?? raw.id ?? raw.code);
  const name = text(raw.name ?? raw.office_name);
  const country_code = text(raw.country_code ?? raw.country).toUpperCase();
  const postal_code = text(raw.postal_code ?? raw.pincode ?? raw.postcode ?? raw.zip_code);
  const address = text(raw.address ?? raw.street_address);
  const contact_person = text(raw.contact_person ?? raw.postmaster ?? raw.manager) || null;
  const latitude = raw.latitude ?? raw.lat;
  const longitude = raw.longitude ?? raw.lng ?? raw.lon;
  const lat = latitude === undefined || latitude === null || latitude === '' ? null : Number(latitude);
  const lng = longitude === undefined || longitude === null || longitude === '' ? null : Number(longitude);

  if (!source_id || !name || !/^[A-Z]{2}$/.test(country_code) || !postal_code || !address) {
    throw new Error('Post-office record requires source_id, name, ISO country code, postal code, and address');
  }
  if ((lat === null) !== (lng === null) || (lat !== null && lng !== null && (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180))) {
    throw new Error('Coordinates must be a valid latitude/longitude pair when supplied');
  }
  return { source_id, name, country_code, postal_code, address, latitude: lat, longitude: lng, contact_person, source_url: source.toString() };
}

export function normalizePostOfficeBatch(records: RawPostOffice[], sourceUrl: string) {
  const accepted: PostOfficeRecord[] = [];
  const rejected: Array<{ index: number; error: string }> = [];
  const seen = new Set<string>();
  records.forEach((record, index) => {
    try {
      const normalized = normalizePostOfficeRecord(record, sourceUrl);
      const key = `${normalized.country_code}:${normalized.source_id}`;
      if (seen.has(key)) throw new Error('Duplicate source record');
      seen.add(key);
      accepted.push(normalized);
    } catch (error) {
      rejected.push({ index, error: error instanceof Error ? error.message : 'Invalid record' });
    }
  });
  return { accepted, rejected };
}
