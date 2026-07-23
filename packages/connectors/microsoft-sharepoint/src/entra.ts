import { SharePointGraphError } from './graph-port';

export interface SharePointConnectionAuthority {
  readonly externalTenantId: string;
}

export interface SharePointConnectionAuthorityPort {
  resolve(input: {
    readonly connectionId: string;
    readonly tenantId: string;
  }): Promise<SharePointConnectionAuthority>;
}

export interface SharePointAccessTokenPort {
  getAccessToken(input: { readonly externalTenantId: string }): Promise<string>;
}

interface CachedToken {
  readonly expiresAt: number;
  readonly value: string;
}

interface TokenClaims {
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly tid?: unknown;
}

const GRAPH_APPLICATION_ID = '00000003-0000-0000-c000-000000000000';
const tenantPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const parseClaims = (token: string): TokenClaims => {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined) {
    throw new SharePointGraphError('GRAPH_PERMISSION_DENIED');
  }
  try {
    return JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as TokenClaims;
  } catch {
    throw new SharePointGraphError('GRAPH_PERMISSION_DENIED');
  }
};

const retryAt = (response: Response): Date | undefined => {
  const raw = response.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400) {
    return new Date(Date.now() + seconds * 1_000);
  }
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
};

export class MicrosoftEntraClientCredentialsTokenProvider implements SharePointAccessTokenPort {
  private readonly cache = new Map<string, CachedToken>();

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly requestTimeoutMs: number,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (
      !tenantPattern.test(clientId) ||
      clientSecret.length < 16 ||
      clientSecret.length > 4_096 ||
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1_000 ||
      requestTimeoutMs > 120_000
    ) {
      throw new Error('SHAREPOINT_ENTRA_CONFIGURATION_INVALID');
    }
  }

  adminConsentUrl(input: {
    readonly externalTenantId: string;
    readonly redirectUri: string;
    readonly state: string;
  }): string {
    if (
      !tenantPattern.test(input.externalTenantId) ||
      input.state.length < 32 ||
      input.state.length > 2_048
    ) {
      throw new Error('SHAREPOINT_CONSENT_INPUT_INVALID');
    }
    const redirect = new URL(input.redirectUri);
    if (
      redirect.protocol !== 'https:' ||
      redirect.username.length > 0 ||
      redirect.password.length > 0 ||
      redirect.hash.length > 0
    ) {
      throw new Error('SHAREPOINT_CONSENT_REDIRECT_INVALID');
    }
    const url = new URL(
      `https://login.microsoftonline.com/${input.externalTenantId}/adminconsent`,
    );
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('redirect_uri', redirect.toString());
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  async getAccessToken(input: {
    readonly externalTenantId: string;
  }): Promise<string> {
    if (!tenantPattern.test(input.externalTenantId)) {
      throw new SharePointGraphError('GRAPH_PERMISSION_DENIED');
    }
    const cached = this.cache.get(input.externalTenantId);
    if (cached !== undefined && cached.expiresAt > Date.now() + 5 * 60_000) {
      return cached.value;
    }
    let response: Response;
    try {
      response = await this.fetcher(
        `https://login.microsoftonline.com/${input.externalTenantId}/oauth2/v2.0/token`,
        {
          body: new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: 'client_credentials',
            scope: 'https://graph.microsoft.com/.default',
          }),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      );
    } catch {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    if (!response.ok) {
      if (response.status === 429) {
        throw new SharePointGraphError('GRAPH_THROTTLED', retryAt(response));
      }
      throw new SharePointGraphError(
        response.status >= 500
          ? 'GRAPH_UNAVAILABLE'
          : 'GRAPH_PERMISSION_DENIED',
      );
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 64 * 1_024) {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    if (body === null || typeof body !== 'object') {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    const result = body as Record<string, unknown>;
    if (
      result.token_type !== 'Bearer' ||
      typeof result.access_token !== 'string' ||
      result.access_token.length > 32_768 ||
      typeof result.expires_in !== 'number'
    ) {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    const claims = parseClaims(result.access_token);
    if (
      claims.tid !== input.externalTenantId ||
      ![GRAPH_APPLICATION_ID, 'https://graph.microsoft.com'].includes(
        String(claims.aud),
      ) ||
      typeof claims.exp !== 'number' ||
      claims.exp * 1_000 <= Date.now()
    ) {
      throw new SharePointGraphError('GRAPH_PERMISSION_DENIED');
    }
    const expiresAt = Math.min(
      claims.exp * 1_000,
      Date.now() + result.expires_in * 1_000,
    );
    this.cache.set(input.externalTenantId, {
      expiresAt,
      value: result.access_token,
    });
    return result.access_token;
  }
}
