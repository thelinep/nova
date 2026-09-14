/**
 * @jest-environment node
 */
import http from 'node:http';
import { fetchViaAddress } from '@/lib/knowledge';

async function withServer(
  handler: http.RequestListener,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start test server');
    await run(address.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('fetchViaAddress (pinned connection)', () => {
  it('connects to the given address regardless of what the hostname would actually resolve to', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('reached the pinned server, host header was: ' + req.headers.host);
      },
      async (port) => {
        // This hostname does not resolve to our test server at all -- if the
        // request still reaches it, that proves the connection used `address`
        // rather than doing its own DNS lookup of the hostname.
        const url = new URL(`http://definitely-not-this-machine.invalid:${port}/`);
        const response = await fetchViaAddress(url, '127.0.0.1');
        expect(response.statusCode).toBe(200);
        const body = response.body.toString('utf8');
        expect(body).toContain('reached the pinned server');
        // The real hostname is still sent as Host, even though we connected by IP.
        expect(body).toContain(`definitely-not-this-machine.invalid:${port}`);
      },
    );
  });

  it('enforces the byte cap while streaming, not after buffering the full body', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        // Send well over the cap; a correct implementation aborts partway
        // through rather than reading all of this into memory first.
        const chunk = Buffer.alloc(1024, 'x');
        let sent = 0;
        const interval = setInterval(() => {
          if (sent > 200_000) {
            clearInterval(interval);
            res.end();
            return;
          }
          sent += chunk.length;
          res.write(chunk);
        }, 0);
        res.once('close', () => clearInterval(interval));
      },
      async (port) => {
        const url = new URL(`http://example.invalid:${port}/`);
        await expect(fetchViaAddress(url, '127.0.0.1', { maxBytes: 5_000 })).rejects.toThrow('larger than 2 MB');
      },
    );
  });

  it('rejects redirects instead of following them', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(302, { location: 'http://example.invalid/elsewhere' });
        res.end();
      },
      async (port) => {
        const url = new URL(`http://example.invalid:${port}/`);
        await expect(fetchViaAddress(url, '127.0.0.1')).rejects.toThrow('Redirects are not followed');
      },
    );
  });
});
