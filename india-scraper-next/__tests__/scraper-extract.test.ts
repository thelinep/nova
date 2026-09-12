import { extractListings } from '@/lib/scraper-extract';

function setDom(html: string) {
  document.body.innerHTML = html;
}

describe('extractListings', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('extracts name, rating, reviews, phone, address, website, and coordinates from a full listing', () => {
    setDom(`
      <div role="feed">
        <div role="article">
          <a class="hfpxzc" aria-label="Sunrise Event Planners"
             href="https://www.google.com/maps/place/Sunrise/@28.6,77.2,15z/data=!4m7!3m6!1s0x0!8m2!3d28.6139!4d77.2090">
            <div class="fontHeadlineSmall">Sunrise Event Planners</div>
          </a>
          <span role="img" aria-label="4.5 stars"></span>
          <span aria-label="128 reviews"></span>
          <div class="W4Efsd">Wedding planner · Closed ⋅ Opens 10 AM · +91 98765 43210</div>
          <div class="W4Efsd">12 MG Road, Bengaluru, Karnataka 560001</div>
          <a data-value="Website" href="https://sunrise-events.example.com"></a>
        </div>
      </div>
    `);

    const [listing] = extractListings(document);

    expect(listing.business_name).toBe('Sunrise Event Planners');
    expect(listing.rating).toBe('4.5');
    expect(listing.reviews).toBe('128');
    // Regression check: the detail-row filter used to also strip out
    // phone-shaped values before the phone lookup ran against that same
    // filtered list, so `phone` was unconditionally ''. It must be found here.
    expect(listing.phone).toBe('+91 98765 43210');
    expect(listing.address).toBe('12 MG Road, Bengaluru, Karnataka 560001');
    expect(listing.website).toBe('https://sunrise-events.example.com/');
    expect(listing.maps_url).toContain('Sunrise');
    expect(listing.latitude).toBeCloseTo(28.6139);
    expect(listing.longitude).toBeCloseTo(77.209);
  });

  it('falls back to text content when aria-labels are absent, and to null for missing optional fields', () => {
    setDom(`
      <div role="article">
        <a class="hfpxzc">
          <div class="fontHeadlineSmall">Budget Caterers</div>
        </a>
        <div class="MW4etd">3.8</div>
        <div class="UY7F9">42 reviews</div>
        <div class="W4Efsd">Catering service · Open ⋅ Closes 8 PM</div>
        <div class="W4Efsd">Sector 18, Noida</div>
      </div>
    `);

    const [listing] = extractListings(document);

    expect(listing.business_name).toBe('Budget Caterers');
    expect(listing.rating).toBe('3.8');
    // The reviews regex still pulls the digits out of the .UY7F9 fallback text.
    expect(listing.reviews).toBe('42');
    expect(listing.phone).toBe('');
    expect(listing.address).toBe('Sector 18, Noida');
    expect(listing.website).toBeNull();
    expect(listing.maps_url).toBeNull();
    expect(listing.latitude).toBeNull();
    expect(listing.longitude).toBeNull();
  });

  it('skips an article that has no business name at all', () => {
    setDom(`
      <div role="article">
        <div class="W4Efsd">Some detail with no identifiable name</div>
      </div>
    `);

    expect(extractListings(document)).toEqual([]);
  });

  it('deduplicates articles that share the same maps_url, keeping the later entry', () => {
    setDom(`
      <div role="article">
        <a class="hfpxzc" aria-label="Old Name" href="https://maps.google.com/maps/place/dup!3d1!4d1"></a>
      </div>
      <div role="article">
        <a class="hfpxzc" aria-label="New Name" href="https://maps.google.com/maps/place/dup!3d1!4d1"></a>
      </div>
    `);

    const listings = extractListings(document);
    expect(listings).toHaveLength(1);
    expect(listings[0].business_name).toBe('New Name');
  });

  it('deduplicates by business name when no maps_url is present', () => {
    setDom(`
      <div role="article"><a class="hfpxzc" aria-label="Repeat Co"></a></div>
      <div role="article"><a class="hfpxzc" aria-label="Repeat Co"></a></div>
      <div role="article"><a class="hfpxzc" aria-label="Unique Co"></a></div>
    `);

    const listings = extractListings(document);
    expect(listings.map((l) => l.business_name).sort()).toEqual(['Repeat Co', 'Unique Co']);
  });
});
