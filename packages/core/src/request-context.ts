import { AsyncLocalStorage } from 'node:async_hooks';

export type ActorType = 'USER' | 'SERVICE' | 'SYSTEM';

export interface ActorIdentity {
  readonly id: string;
  readonly type: ActorType;
}

export interface AuthorizationContext {
  readonly actor: ActorIdentity;
  readonly correlationId: string;
  readonly permissions: readonly string[];
  readonly projectId?: string;
  readonly tenantId: string;
  readonly tokenId?: string;
}

export interface RequestContext {
  readonly authorization?: AuthorizationContext;
  readonly correlationId: string;
}

const freezeAuthorization = (
  authorization: AuthorizationContext | undefined,
): AuthorizationContext | undefined => {
  if (authorization === undefined) {
    return undefined;
  }

  return Object.freeze({
    ...authorization,
    actor: Object.freeze({ ...authorization.actor }),
    permissions: Object.freeze([...authorization.permissions]),
  });
};

export class RequestContextStore {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  current(): RequestContext | undefined {
    return this.storage.getStore();
  }

  run<T>(context: RequestContext, callback: () => T): T {
    if (
      context.authorization !== undefined &&
      context.authorization.correlationId !== context.correlationId
    ) {
      throw new Error(
        'Authorization and request correlation identifiers must match',
      );
    }

    const immutableContext = Object.freeze({
      authorization: freezeAuthorization(context.authorization),
      correlationId: context.correlationId,
    });

    return this.storage.run(immutableContext, callback);
  }
}
