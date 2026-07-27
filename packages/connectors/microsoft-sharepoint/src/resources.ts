import type {
  ConnectionResourceBrowser,
  ConnectionResourceQuery,
} from '@aiflow/connections';

import type { SharePointGraphPort } from './graph-port';
import type { SharePointCursorProtector } from './protection';

interface ProtectedCursor {
  readonly connectionId: string;
  readonly containerResourceId?: string;
  readonly parentResourceId?: string;
  readonly providerCursor: string;
  readonly resourceType: ConnectionResourceQuery['resourceType'];
  readonly tenantId: string;
}

const bounded = (value: string | undefined, maximumLength: number): boolean =>
  value === undefined || (value.length > 0 && value.length <= maximumLength);

const parseCursor = (
  value: string,
  protector: SharePointCursorProtector,
): ProtectedCursor => {
  if (value.length > 4_096) {
    throw new Error('CONNECTION_RESOURCE_CURSOR_INVALID');
  }
  try {
    const decoded = protector.unprotect(Buffer.from(value, 'base64url'));
    const cursor = JSON.parse(decoded) as Partial<ProtectedCursor>;
    if (
      typeof cursor.tenantId !== 'string' ||
      typeof cursor.connectionId !== 'string' ||
      !['DRIVE', 'FOLDER', 'SITE'].includes(String(cursor.resourceType)) ||
      typeof cursor.providerCursor !== 'string' ||
      !bounded(cursor.parentResourceId, 512) ||
      !bounded(cursor.containerResourceId, 512)
    ) {
      throw new Error('invalid cursor');
    }
    return cursor as ProtectedCursor;
  } catch {
    throw new Error('CONNECTION_RESOURCE_CURSOR_INVALID');
  }
};

export class SharePointResourceBrowser implements ConnectionResourceBrowser {
  readonly connectorId = 'microsoft-sharepoint';

  constructor(
    private readonly graph: SharePointGraphPort,
    private readonly cursorProtector: SharePointCursorProtector,
  ) {}

  async list(query: ConnectionResourceQuery) {
    if (
      !['DRIVE', 'FOLDER', 'SITE'].includes(query.resourceType) ||
      !bounded(query.parentResourceId, 512) ||
      !bounded(query.containerResourceId, 512) ||
      !bounded(query.search, 100)
    ) {
      throw new Error('CONNECTION_RESOURCE_QUERY_INVALID');
    }
    const protectedCursor =
      query.cursor === undefined
        ? undefined
        : parseCursor(query.cursor, this.cursorProtector);
    if (
      protectedCursor !== undefined &&
      (protectedCursor.tenantId !== query.tenantId ||
        protectedCursor.connectionId !== query.connectionId ||
        protectedCursor.resourceType !== query.resourceType ||
        protectedCursor.parentResourceId !== query.parentResourceId ||
        protectedCursor.containerResourceId !== query.containerResourceId)
    ) {
      throw new Error('CONNECTION_RESOURCE_CURSOR_INVALID');
    }
    const page = await this.graph.listResources({
      connectionId: query.connectionId,
      ...(query.containerResourceId === undefined
        ? {}
        : { containerResourceId: query.containerResourceId }),
      ...(protectedCursor === undefined
        ? {}
        : { cursor: protectedCursor.providerCursor }),
      ...(query.parentResourceId === undefined
        ? {}
        : { parentResourceId: query.parentResourceId }),
      resourceType: query.resourceType,
      ...(query.search === undefined ? {} : { search: query.search }),
      tenantId: query.tenantId,
    });
    return {
      items: page.items,
      ...(page.nextCursor === undefined
        ? {}
        : {
            nextCursor: Buffer.from(
              this.cursorProtector.protect(
                JSON.stringify({
                  connectionId: query.connectionId,
                  ...(query.containerResourceId === undefined
                    ? {}
                    : { containerResourceId: query.containerResourceId }),
                  ...(query.parentResourceId === undefined
                    ? {}
                    : { parentResourceId: query.parentResourceId }),
                  providerCursor: page.nextCursor,
                  resourceType: query.resourceType,
                  tenantId: query.tenantId,
                } satisfies ProtectedCursor),
              ),
            ).toString('base64url'),
          }),
    };
  }
}
