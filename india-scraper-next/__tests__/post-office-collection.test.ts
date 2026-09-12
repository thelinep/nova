import { normalizePostOfficeBatch, normalizePostOfficeRecord } from '@/lib/post-office';

describe('worldwide post-office collection contract', () => {
  const source = 'https://directory.example.org/post-offices.json';

  it('normalizes PIN/postal-code, full address, location, and published contact fields from multiple countries', () => {
    const { accepted, rejected } = normalizePostOfficeBatch([
      { id: 'IN-DL-001', name: 'New Delhi GPO', country_code: 'in', pincode: '110001', address: 'Sansad Marg, New Delhi, Delhi 110001', latitude: 28.6304, longitude: 77.2177, postmaster: 'Published contact' },
      { id: 'GB-SW1A', name: 'Westminster Delivery Office', country_code: 'GB', postcode: 'SW1A 1AA', address: 'London SW1A 1AA', latitude: '51.5014', longitude: '-0.1419' },
      { id: 'BR-70002', name: 'Agência Central Brasília', country: 'BR', zip_code: '70002-900', address: 'Setor Bancário Norte, Brasília - DF, 70002-900', lat: -15.7939, lng: -47.8828 },
    ], source);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual(expect.arrayContaining([
      expect.objectContaining({ country_code: 'IN', postal_code: '110001', contact_person: 'Published contact', source_url: source }),
      expect.objectContaining({ country_code: 'GB', postal_code: 'SW1A 1AA', contact_person: null, latitude: 51.5014, longitude: -0.1419 }),
      expect.objectContaining({ country_code: 'BR', postal_code: '70002-900', address: expect.stringContaining('Brasília') }),
    ]));
  });

  it('reports invalid and duplicate entries instead of silently inventing missing data', () => {
    const { accepted, rejected } = normalizePostOfficeBatch([
      { id: 'US-1', name: 'Example Post Office', country_code: 'US', postal_code: '10001', address: 'New York, NY 10001' },
      { id: 'US-1', name: 'Example Post Office', country_code: 'US', postal_code: '10001', address: 'New York, NY 10001' },
      { id: 'NO-POSTCODE', name: 'Incomplete Office', country_code: 'US', address: 'Unknown' },
      { id: 'BAD-COORDS', name: 'Broken Coordinates', country_code: 'US', postal_code: '10002', address: 'New York', latitude: 100, longitude: 20 },
    ], source);

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    expect(rejected.map((item) => item.error)).toEqual(expect.arrayContaining([
      'Duplicate source record',
      expect.stringContaining('requires source_id'),
      expect.stringContaining('Coordinates'),
    ]));
  });

  it('does not fabricate a contact person or accept a non-web source', () => {
    const record = normalizePostOfficeRecord({ id: 'JP-100', name: 'Tokyo Central Post Office', country_code: 'JP', postal_code: '100-8799', address: '2-3-2 Marunouchi, Chiyoda City, Tokyo' }, source);
    expect(record.contact_person).toBeNull();
    expect(() => normalizePostOfficeRecord({ id: 'X', name: 'X', country_code: 'US', postal_code: '1', address: 'X' }, 'file:///tmp/post-offices.json')).toThrow('HTTP(S)');
  });
});
