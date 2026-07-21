import type { NextFunction, Request, Response } from 'express';

import type { ActorIdentity } from '@aiflow/core';

export interface ApiAuthorization {
  readonly actor: ActorIdentity;
  readonly correlationId: string;
  readonly projectId: string;
  readonly tenantId: string;
}

export interface AuthorizedRequest extends Request {
  aiflowAuthorization?: ApiAuthorization;
  aiflowCorrelationId?: string;
  rawBody?: Buffer;
}

const demoTokens: ReadonlyMap<
  string,
  Omit<ApiAuthorization, 'correlationId'>
> = new Map([
  [
    'aiflow-demo-token-a',
    {
      actor: { id: 'demo-user-a', type: 'USER' },
      projectId: 'demo-project-a',
      tenantId: 'demo-tenant-a',
    },
  ],
  [
    'aiflow-demo-token-b',
    {
      actor: { id: 'demo-user-b', type: 'USER' },
      projectId: 'demo-project-b',
      tenantId: 'demo-tenant-b',
    },
  ],
]);

const error = (request: AuthorizedRequest, code: string, message: string) => ({
  error: {
    code,
    correlationId: request.aiflowCorrelationId ?? 'unavailable',
    message,
    retryable: false,
  },
});

export const createDemoAuthMiddleware = (
  environment: 'development' | 'production' | 'test',
) => {
  if (environment === 'production') {
    throw new Error('PRODUCTION_AUTH_ADAPTER_NOT_CONFIGURED');
  }
  return (
    request: AuthorizedRequest,
    response: Response,
    next: NextFunction,
  ): void => {
    if (
      !request.path.startsWith('/api/v1') ||
      request.path.startsWith('/api/v1/callbacks/')
    ) {
      next();
      return;
    }
    if (
      request.headers['x-client-id'] !== undefined ||
      request.headers['x-tenant-id'] !== undefined
    ) {
      response
        .status(400)
        .json(
          error(
            request,
            'UNTRUSTED_IDENTITY_HEADER',
            'Identity headers are not accepted',
          ),
        );
      return;
    }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    const identity = token === undefined ? undefined : demoTokens.get(token);
    if (identity === undefined) {
      response
        .status(401)
        .json(
          error(
            request,
            'AUTHENTICATION_REQUIRED',
            'A valid access token is required',
          ),
        );
      return;
    }
    request.aiflowAuthorization = {
      ...identity,
      correlationId: request.aiflowCorrelationId ?? 'unavailable',
    };
    next();
  };
};

export const requireAuthorization = (
  request: AuthorizedRequest,
): ApiAuthorization => {
  if (request.aiflowAuthorization === undefined) {
    throw new Error('AUTHENTICATION_REQUIRED');
  }
  return request.aiflowAuthorization;
};

export const authorizeProject = (
  authorization: ApiAuthorization,
  projectId: string,
): void => {
  if (authorization.projectId !== projectId) {
    throw new Error('PROJECT_ACCESS_DENIED');
  }
};
