import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Best-effort "is this request local" check, used uniformly across every API
 * route in this app.
 *
 * IMPORTANT: this only reads the client-supplied `Host` header, which any
 * client can forge. It is NOT a security boundary by itself. The actual
 * boundary is that `npm run dev` and `npm run start` bind to 127.0.0.1 only
 * (see package.json) -- non-local traffic cannot reach this process at the
 * network level in the first place. This check is defense-in-depth for the
 * case where something still reaches the process (e.g. a misconfigured
 * reverse proxy on the same machine); it does not make it safe to bind this
 * server to 0.0.0.0 or expose it through a tunnel.
 */
export function isLocalRequest(request: NextRequest | Request): boolean {
  const host = request.headers.get('host');
  if (!host) return false;
  try {
    return LOCAL_HOSTNAMES.has(new URL('http://' + host).hostname);
  } catch {
    return false;
  }
}

export function localOnlyResponse(): NextResponse {
  return NextResponse.json({ error: 'Local-only request required' }, { status: 403 });
}
