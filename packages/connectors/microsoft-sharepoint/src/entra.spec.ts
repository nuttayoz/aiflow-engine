import { MicrosoftEntraClientCredentialsTokenProvider } from './entra';
import type { SharePointGraphError } from './graph-port';

const clientId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';

const token = (expiresAt: number): string =>
  [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        aud: '00000003-0000-0000-c000-000000000000',
        exp: expiresAt,
        tid: tenantId,
      }),
    ).toString('base64url'),
    'signature',
  ].join('.');

describe('Microsoft Entra client credentials', () => {
  it('uses the tenant-specific fixed authority and caches a validated token', async () => {
    const accessToken = token(Math.floor(Date.now() / 1_000) + 3_600);
    const fetcher = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: accessToken,
            expires_in: 3_600,
            token_type: 'Bearer',
          }),
          { status: 200 },
        ),
    );
    const provider = new MicrosoftEntraClientCredentialsTokenProvider(
      clientId,
      'a-long-test-client-secret',
      5_000,
      fetcher as unknown as typeof fetch,
    );

    await expect(
      provider.getAccessToken({ externalTenantId: tenantId }),
    ).resolves.toBe(accessToken);
    await expect(
      provider.getAccessToken({ externalTenantId: tenantId }),
    ).resolves.toBe(accessToken);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    );
  });

  it('preserves bounded Retry-After throttling and rejects wrong-tenant tokens', async () => {
    const throttled = new MicrosoftEntraClientCredentialsTokenProvider(
      clientId,
      'a-long-test-client-secret',
      5_000,
      (async () =>
        new Response('', {
          headers: { 'retry-after': '2' },
          status: 429,
        })) as typeof fetch,
    );
    await expect(
      throttled.getAccessToken({ externalTenantId: tenantId }),
    ).rejects.toMatchObject<Partial<SharePointGraphError>>({
      code: 'GRAPH_THROTTLED',
    });

    const wrongTenantToken = token(
      Math.floor(Date.now() / 1_000) + 3_600,
    ).replace(Buffer.from(JSON.stringify({})).toString('base64url'), 'unused');
    const denied = new MicrosoftEntraClientCredentialsTokenProvider(
      clientId,
      'a-long-test-client-secret',
      5_000,
      (async () =>
        new Response(
          JSON.stringify({
            access_token: wrongTenantToken,
            expires_in: 3_600,
            token_type: 'Bearer',
          }),
          { status: 200 },
        )) as typeof fetch,
    );
    await expect(
      denied.getAccessToken({
        externalTenantId: '33333333-3333-4333-8333-333333333333',
      }),
    ).rejects.toMatchObject<Partial<SharePointGraphError>>({
      code: 'GRAPH_PERMISSION_DENIED',
    });
  });

  it('builds an encoded admin-consent URL without accepting insecure redirects', () => {
    const provider = new MicrosoftEntraClientCredentialsTokenProvider(
      clientId,
      'a-long-test-client-secret',
      5_000,
    );
    const url = new URL(
      provider.adminConsentUrl({
        externalTenantId: tenantId,
        redirectUri:
          'https://portal.example.com/microsoft/adminconsent/callback',
        state: 'x'.repeat(64),
      }),
    );

    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.searchParams.get('client_id')).toBe(clientId);
    expect(() =>
      provider.adminConsentUrl({
        externalTenantId: tenantId,
        redirectUri: 'http://portal.example.com/callback',
        state: 'x'.repeat(64),
      }),
    ).toThrow('SHAREPOINT_CONSENT_REDIRECT_INVALID');
  });
});
