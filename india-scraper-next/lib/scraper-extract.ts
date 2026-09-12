export type RawListing = {
  business_name: string;
  address: string;
  rating: string;
  reviews: string;
  phone: string;
  website: string | null;
  maps_url: string | null;
  latitude: number | null;
  longitude: number | null;
};

/**
 * Parses Google Maps search-result "article" cards out of the DOM.
 *
 * This is intentionally self-contained (no references to anything outside
 * its own body) because Puppeteer's `page.evaluate()` only ships this
 * function's *source text* into the browser -- it re-runs the function body
 * there, not whatever Node-side state happened to be in scope when it was
 * called. That same self-containment is what lets this be unit-tested
 * directly against a jsdom document (see __tests__/scraper-extract.test.ts)
 * instead of requiring a real browser and a live Google Maps page.
 */
export function extractListings(doc: Document = document): RawListing[] {
  const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim() || '';
  const results: RawListing[] = [];
  const items = doc.querySelectorAll('div[role="article"]');
  items.forEach(item => {
    const nameLink = item.querySelector('a.hfpxzc[aria-label]');
    const business_name = nameLink?.getAttribute('aria-label') || text(item.querySelector('.fontHeadlineSmall'));
    if (!business_name) return;

    const ratingElement = item.querySelector('[role="img"][aria-label*="stars"], .MW4etd');
    const ratingLabel = ratingElement?.getAttribute('aria-label') || '';
    const ratingMatch = ratingLabel.match(/([0-5](?:\.\d)?)\s*stars?/i);
    const rating = ratingMatch ? ratingMatch[1] : text(item.querySelector('.MW4etd'));

    const reviewElement = item.querySelector('[aria-label*="reviews"], .UY7F9');
    const reviewLabel = reviewElement?.getAttribute('aria-label') || text(reviewElement);
    const reviewMatch = reviewLabel.match(/([\d,]+)\s*reviews?/i);
    const reviews = reviewMatch ? reviewMatch[1].replace(/,/g, '') : reviewLabel;

    const detailRows = [...item.querySelectorAll('.W4Efsd')]
      .map(row => text(row))
      .filter(Boolean);
    // Note: this filter must NOT also exclude phone-like values -- the next
    // line searches this same list for a phone-shaped entry, so filtering it
    // out here would make `phone` unconditionally empty (it used to).
    const detailParts = detailRows
      .flatMap(row => row.split('·').map(value => value.trim()))
      .filter(value => value && value !== rating && !/^(open|closed|temporarily closed)/i.test(value));
    const phone = detailParts
      .find(value => /^\+?[\d][\d\s().-]{7,}$/.test(value)) || '';
    const addressCandidates = detailParts.filter(value => value !== phone && !/^(wedding planner|event planner|event management company)$/i.test(value));
    const address = addressCandidates[addressCandidates.length - 1] || '';
    const website = (item.querySelector('a[data-value="Website"]') as HTMLAnchorElement)?.href || null;
    const href = (nameLink as HTMLAnchorElement)?.href || null;
    const coordinates = href?.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);

    results.push({
      business_name,
      address,
      rating,
      reviews,
      phone,
      website,
      maps_url: href,
      latitude: coordinates ? Number(coordinates[1]) : null,
      longitude: coordinates ? Number(coordinates[2]) : null,
    });
  });
  return [...new Map(results.map(item => [item.maps_url || item.business_name, item])).values()];
}
