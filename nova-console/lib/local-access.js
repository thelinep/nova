'use strict';

// This is a single-user local service. The loopback listener is the network
// boundary; Host and Origin checks additionally defend against DNS rebinding
// and cross-site browser requests. Local programs are trusted, not authenticated.
function checkLocalAccess(req, port) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
    return 'Loopback connection required';
  }
  const authorities = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (port === 80) { authorities.add('127.0.0.1'); authorities.add('localhost'); }
  const host = req.headers.host;
  if (!authorities.has(host)) return 'Local Host header required';
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return 'Same-origin request required';
  if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) {
    return 'Same-origin request required';
  }
  if (!['GET', 'HEAD'].includes(req.method) && origin !== `http://${host}`) {
    return 'Same-origin Origin header required for mutations';
  }
  return null;
}

module.exports = { checkLocalAccess };
