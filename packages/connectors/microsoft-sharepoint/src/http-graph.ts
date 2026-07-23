import { Readable } from 'node:stream';

import {
  SharePointGraphError,
  type SharePointGraphDeltaPage,
  type SharePointGraphItem,
  type SharePointGraphPort,
  type SharePointGraphResource,
  type SharePointGraphResourcePage,
  type SharePointGraphSubscription,
} from './graph-port';
import type {
  SharePointAccessTokenPort,
  SharePointConnectionAuthorityPort,
} from './entra';

interface GraphResponse {
  readonly '@odata.deltaLink'?: unknown;
  readonly '@odata.nextLink'?: unknown;
  readonly cTag?: unknown;
  readonly changeType?: unknown;
  readonly clientState?: unknown;
  readonly deleted?: unknown;
  readonly displayName?: unknown;
  readonly driveType?: unknown;
  readonly eTag?: unknown;
  readonly expirationDateTime?: unknown;
  readonly file?: unknown;
  readonly folder?: unknown;
  readonly id?: unknown;
  readonly lifecycleNotificationUrl?: unknown;
  readonly name?: unknown;
  readonly notificationUrl?: unknown;
  readonly parentReference?: unknown;
  readonly resource?: unknown;
  readonly root?: unknown;
  readonly sharepointIds?: unknown;
  readonly size?: unknown;
  readonly value?: unknown;
}

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const MAXIMUM_JSON_BYTES = 2 * 1_024 * 1_024;
const MAXIMUM_PAGE_ITEMS = 1_000;
const identifier = (value: string): string => encodeURIComponent(value);

const requireString = (value: unknown, maximumLength: number): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new SharePointGraphError('GRAPH_UNAVAILABLE');
  }
  return value;
};

const optionalString = (
  value: unknown,
  maximumLength: number,
): string | undefined =>
  value === undefined ? undefined : requireString(value, maximumLength);

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

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

const graphError = (response: Response): SharePointGraphError => {
  if (response.status === 404) {
    return new SharePointGraphError('GRAPH_NOT_FOUND');
  }
  if (response.status === 409) {
    return new SharePointGraphError('GRAPH_CONFLICT');
  }
  if (response.status === 401 || response.status === 403) {
    return new SharePointGraphError('GRAPH_PERMISSION_DENIED');
  }
  if (response.status === 410) {
    return new SharePointGraphError('GRAPH_CURSOR_INVALID');
  }
  if (response.status === 429) {
    return new SharePointGraphError('GRAPH_THROTTLED', retryAt(response));
  }
  return new SharePointGraphError(
    response.status >= 500 ? 'GRAPH_UNAVAILABLE' : 'GRAPH_OUTCOME_UNKNOWN',
  );
};

const parseSubscription = (value: unknown): SharePointGraphSubscription => {
  const item = object(value);
  if (item === undefined || item.changeType !== 'updated') {
    throw new SharePointGraphError('GRAPH_UNAVAILABLE');
  }
  const expiresAt = new Date(requireString(item.expirationDateTime, 64));
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new SharePointGraphError('GRAPH_UNAVAILABLE');
  }
  return {
    changeType: 'updated',
    clientState: requireString(item.clientState, 512),
    expiresAt,
    id: requireString(item.id, 512),
    lifecycleNotificationUrl: requireString(
      item.lifecycleNotificationUrl,
      2_048,
    ),
    notificationUrl: requireString(item.notificationUrl, 2_048),
    resource: requireString(item.resource, 768),
  };
};

export class HttpSharePointGraphAdapter implements SharePointGraphPort {
  constructor(
    private readonly authorities: SharePointConnectionAuthorityPort,
    private readonly tokens: SharePointAccessTokenPort,
    private readonly requestTimeoutMs: number,
    private readonly allowedDownloadHostSuffixes: readonly string[],
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1_000 ||
      requestTimeoutMs > 300_000 ||
      allowedDownloadHostSuffixes.length === 0 ||
      allowedDownloadHostSuffixes.some(
        (suffix) => !/^\.[a-z0-9.-]+$/u.test(suffix) || suffix.length > 255,
      )
    ) {
      throw new Error('SHAREPOINT_GRAPH_CONFIGURATION_INVALID');
    }
  }

  async resolveTarget(input: {
    readonly connectionId: string;
    readonly driveId: string;
    readonly folderId: string;
    readonly siteId: string;
    readonly tenantId: string;
  }) {
    const [authority, site, drive, folder, root] = await Promise.all([
      this.authorities.resolve(input),
      this.get(input, `/sites/${identifier(input.siteId)}?$select=id`),
      this.get(
        input,
        `/sites/${identifier(input.siteId)}/drives/${identifier(input.driveId)}?$select=id,sharepointIds`,
      ),
      this.get(
        input,
        `/drives/${identifier(input.driveId)}/items/${identifier(input.folderId)}?$select=id,folder`,
      ),
      this.get(
        input,
        `/drives/${identifier(input.driveId)}/root?$select=id,root`,
      ),
    ]);
    if (
      requireString(site.id, 512) !== input.siteId ||
      requireString(drive.id, 512) !== input.driveId ||
      requireString(folder.id, 512) !== input.folderId ||
      object(folder.folder) === undefined
    ) {
      throw new SharePointGraphError('GRAPH_NOT_FOUND');
    }
    return {
      driveId: input.driveId,
      externalTenantId: authority.externalTenantId,
      folderId: input.folderId,
      rootItemId: requireString(root.id, 512),
      siteId: input.siteId,
    };
  }

  async createSubscription(input: {
    readonly changeType: 'updated';
    readonly clientState: string;
    readonly connectionId: string;
    readonly expiresAt: Date;
    readonly lifecycleNotificationUrl: string;
    readonly notificationUrl: string;
    readonly resource: string;
    readonly tenantId: string;
  }) {
    return parseSubscription(
      await this.requestJson(input, '/subscriptions', {
        body: JSON.stringify({
          changeType: input.changeType,
          clientState: input.clientState,
          expirationDateTime: input.expiresAt.toISOString(),
          includeResourceData: false,
          lifecycleNotificationUrl: input.lifecycleNotificationUrl,
          notificationUrl: input.notificationUrl,
          resource: input.resource,
        }),
        method: 'POST',
      }),
    );
  }

  async renewSubscription(input: {
    readonly connectionId: string;
    readonly expiresAt: Date;
    readonly subscriptionId: string;
    readonly tenantId: string;
  }) {
    return parseSubscription(
      await this.requestJson(
        input,
        `/subscriptions/${identifier(input.subscriptionId)}`,
        {
          body: JSON.stringify({
            expirationDateTime: input.expiresAt.toISOString(),
          }),
          method: 'PATCH',
        },
      ),
    );
  }

  async deleteSubscription(input: {
    readonly connectionId: string;
    readonly subscriptionId: string;
    readonly tenantId: string;
  }): Promise<void> {
    const response = await this.request(
      input,
      `/subscriptions/${identifier(input.subscriptionId)}`,
      { method: 'DELETE' },
    );
    if (response.status === 404 || response.status === 204) return;
    if (!response.ok) throw graphError(response);
  }

  async getSubscription(input: {
    readonly connectionId: string;
    readonly subscriptionId: string;
    readonly tenantId: string;
  }) {
    const response = await this.request(
      input,
      `/subscriptions/${identifier(input.subscriptionId)}`,
    );
    if (response.status === 404) return undefined;
    return parseSubscription(await this.readJson(response));
  }

  async listSubscriptions(input: {
    readonly connectionId: string;
    readonly tenantId: string;
  }) {
    const body = await this.get(
      input,
      '/subscriptions?$top=100&$select=id,resource,changeType,clientState,expirationDateTime,notificationUrl,lifecycleNotificationUrl',
    );
    if (!Array.isArray(body.value) || body.value.length > 100) {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    return body.value.map(parseSubscription);
  }

  async listDeltaPage(input: {
    readonly connectionId: string;
    readonly cursor?: string;
    readonly driveId: string;
    readonly tenantId: string;
  }): Promise<SharePointGraphDeltaPage> {
    const path =
      input.cursor === undefined
        ? `/drives/${identifier(input.driveId)}/root/delta?$top=200&$select=id,name,parentReference,file,folder,deleted,size,cTag,eTag`
        : this.validateGraphCursor(input.cursor, input.driveId);
    const body = await this.get(input, path);
    if (!Array.isArray(body.value) || body.value.length > MAXIMUM_PAGE_ITEMS) {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    const items = body.value.map((item) => this.parseItem(item));
    const nextCursor = optionalString(body['@odata.nextLink'], 8_192);
    const finalCursor = optionalString(body['@odata.deltaLink'], 8_192);
    if ((nextCursor === undefined) === (finalCursor === undefined)) {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    return {
      ...(finalCursor === undefined ? {} : { finalCursor }),
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async getItem(input: {
    readonly connectionId: string;
    readonly driveId: string;
    readonly itemId: string;
    readonly tenantId: string;
  }): Promise<SharePointGraphItem | undefined> {
    const response = await this.request(
      input,
      `/drives/${identifier(input.driveId)}/items/${identifier(input.itemId)}?$select=id,name,parentReference,file,folder,deleted,size,cTag,eTag`,
    );
    if (response.status === 404) return undefined;
    return this.parseItem(await this.readJson(response));
  }

  async openFileContent(input: {
    readonly connectionId: string;
    readonly driveId: string;
    readonly itemId: string;
    readonly tenantId: string;
  }) {
    const graphResponse = await this.request(
      input,
      `/drives/${identifier(input.driveId)}/items/${identifier(input.itemId)}/content`,
      { redirect: 'manual' },
    );
    if (![301, 302, 303, 307, 308].includes(graphResponse.status)) {
      if (!graphResponse.ok) throw graphError(graphResponse);
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    const location = this.validateDownloadUrl(
      requireString(graphResponse.headers.get('location'), 8_192),
    );
    let response: Response;
    try {
      response = await this.fetcher(location, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    if (!response.ok) throw graphError(response);
    const contentLength = Number(response.headers.get('content-length'));
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength <= 0 ||
      response.body === null
    ) {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    return {
      contentLength,
      contentType:
        response.headers.get('content-type') ?? 'application/octet-stream',
      stream: Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
    };
  }

  async listResources(input: {
    readonly connectionId: string;
    readonly containerResourceId?: string;
    readonly cursor?: string;
    readonly parentResourceId?: string;
    readonly resourceType: 'DRIVE' | 'FOLDER' | 'SITE';
    readonly search?: string;
    readonly tenantId: string;
  }): Promise<SharePointGraphResourcePage> {
    const path =
      input.cursor === undefined
        ? this.resourcePath(input)
        : this.validateResourceCursor(input.cursor);
    const body = await this.get(input, path);
    if (!Array.isArray(body.value) || body.value.length > 200) {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    const items: SharePointGraphResource[] = [];
    for (const raw of body.value) {
      const item = object(raw);
      if (item === undefined) {
        throw new SharePointGraphError('GRAPH_UNAVAILABLE');
      }
      if (
        input.resourceType === 'FOLDER' &&
        object(item.folder) === undefined
      ) {
        continue;
      }
      const id = requireString(item.id, 512);
      const label = requireString(item.displayName ?? item.name, 512);
      if (input.resourceType === 'SITE') {
        items.push({
          id,
          label,
          resourceType: 'SITE',
          selectable: true,
        });
      } else if (input.resourceType === 'DRIVE') {
        items.push({
          id,
          label,
          ...(input.parentResourceId === undefined
            ? {}
            : { parentResourceId: input.parentResourceId }),
          resourceType: 'DRIVE',
          selectable: true,
        });
      } else {
        const parentResourceId = optionalString(
          object(item.parentReference)?.id,
          512,
        );
        items.push({
          ...(input.containerResourceId === undefined
            ? {}
            : { containerResourceId: input.containerResourceId }),
          id,
          label,
          ...(parentResourceId === undefined ? {} : { parentResourceId }),
          resourceType: 'FOLDER',
          selectable: true,
        });
      }
    }
    const nextCursor = optionalString(body['@odata.nextLink'], 8_192);
    return {
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  private resourcePath(input: {
    readonly containerResourceId?: string;
    readonly parentResourceId?: string;
    readonly resourceType: 'DRIVE' | 'FOLDER' | 'SITE';
    readonly search?: string;
  }): string {
    if (input.resourceType === 'SITE') {
      const search = encodeURIComponent(input.search?.trim() || '*');
      return `/sites?search=${search}&$top=100&$select=id,displayName`;
    }
    if (
      input.resourceType === 'DRIVE' &&
      input.parentResourceId !== undefined
    ) {
      return `/sites/${identifier(input.parentResourceId)}/drives?$top=100&$select=id,name,driveType`;
    }
    if (
      input.resourceType === 'FOLDER' &&
      input.containerResourceId !== undefined
    ) {
      const parent =
        input.parentResourceId === undefined
          ? 'root'
          : `items/${identifier(input.parentResourceId)}`;
      return `/drives/${identifier(input.containerResourceId)}/${parent}/children?$top=200&$select=id,name,parentReference,folder`;
    }
    throw new Error('CONNECTION_RESOURCE_QUERY_INVALID');
  }

  private async get(
    input: { readonly connectionId: string; readonly tenantId: string },
    path: string,
  ): Promise<GraphResponse> {
    return this.requestJson(input, path);
  }

  private async requestJson(
    input: { readonly connectionId: string; readonly tenantId: string },
    path: string,
    init: RequestInit = {},
  ): Promise<GraphResponse> {
    return (await this.readJson(
      await this.request(input, path, init),
    )) as GraphResponse;
  }

  private async request(
    input: { readonly connectionId: string; readonly tenantId: string },
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const authority = await this.authorities.resolve(input);
    const token = await this.tokens.getAccessToken(authority);
    const url = path.startsWith('https://')
      ? this.validateResourceCursor(path)
      : `${GRAPH_BASE_URL}${path}`;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
        redirect: init.redirect ?? 'error',
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new SharePointGraphError(
        init.method === 'POST' ||
          init.method === 'PATCH' ||
          init.method === 'DELETE'
          ? 'GRAPH_OUTCOME_UNKNOWN'
          : 'GRAPH_UNAVAILABLE',
      );
    }
    return response;
  }

  private async readJson(response: Response): Promise<unknown> {
    if (!response.ok) throw graphError(response);
    const raw = await response.text();
    if (Buffer.byteLength(raw) > MAXIMUM_JSON_BYTES) {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
  }

  private parseItem(value: unknown): SharePointGraphItem {
    const item = object(value);
    if (item === undefined) throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    const id = requireString(item.id, 512);
    const parentId = optionalString(object(item.parentReference)?.id, 512);
    if (object(item.deleted) !== undefined) {
      return {
        id,
        kind: 'DELETED',
        ...(parentId === undefined ? {} : { parentId }),
      };
    }
    const eTag = requireString(item.eTag, 512);
    const name = requireString(item.name, 512);
    if (object(item.folder) !== undefined) {
      return {
        eTag,
        id,
        kind: 'FOLDER',
        name,
        ...(parentId === undefined ? {} : { parentId }),
      };
    }
    const file = object(item.file);
    if (
      file === undefined ||
      parentId === undefined ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0
    ) {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    return {
      contentType: optionalString(file.mimeType, 255),
      cTag: optionalString(item.cTag, 512),
      eTag,
      id,
      kind: 'FILE',
      name,
      parentId,
      sizeBytes: item.size,
    };
  }

  private validateGraphCursor(value: string, driveId: string): string {
    const url = this.validGraphUrl(value);
    if (
      !url.pathname.startsWith(`/v1.0/drives/${identifier(driveId)}/root/delta`)
    ) {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    return url.toString();
  }

  private validateResourceCursor(value: string): string {
    return this.validGraphUrl(value).toString();
  }

  private validGraphUrl(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    if (
      url.protocol !== 'https:' ||
      url.origin !== 'https://graph.microsoft.com' ||
      !url.pathname.startsWith('/v1.0/') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      (url.port.length > 0 && url.port !== '443') ||
      url.hash.length > 0
    ) {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    return url;
  }

  private validateDownloadUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    const hostname = url.hostname.toLocaleLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      (url.port.length > 0 && url.port !== '443') ||
      url.hash.length > 0 ||
      /^[\d.]+$/u.test(hostname) ||
      !this.allowedDownloadHostSuffixes.some(
        (suffix) =>
          hostname.endsWith(suffix) && hostname.length > suffix.length,
      )
    ) {
      throw new SharePointGraphError('GRAPH_UNAVAILABLE');
    }
    return url.toString();
  }
}
