import '@testing-library/jest-dom';

// Polyfill Web APIs (Request/Response/fetch/headers) for Next.js route handlers
// running under jsdom, which doesn't expose them.
import { TextEncoder, TextDecoder } from 'util';

if (typeof global.TextEncoder === 'undefined') {
  (global as any).TextEncoder = TextEncoder;
  (global as any).TextDecoder = TextDecoder;
}

// Use Node 18+ built-in fetch/Request/Response if available; else leave undefined.
// jsdom doesn't define these, but Node's undici globals do.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const undici = require('undici');
  if (typeof global.Request === 'undefined') (global as any).Request = undici.Request;
  if (typeof global.Response === 'undefined') (global as any).Response = undici.Response;
  if (typeof global.Headers === 'undefined') (global as any).Headers = undici.Headers;
  if (typeof global.fetch === 'undefined') (global as any).fetch = undici.fetch;
} catch {
  // undici not available; Next's web spec extensions will still fail for Request,
  // so route tests should run in the node environment instead.
}
