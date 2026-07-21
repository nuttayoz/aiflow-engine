import type { NextFunction, Response } from 'express';

import {
  authorizeProject,
  type AuthorizedRequest,
  createDemoAuthMiddleware,
} from './api-auth';

const response = () => {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { json, response: { status } as unknown as Response, status };
};

describe('demo API authentication composition', () => {
  it('derives tenant and project from the server-owned token mapping', () => {
    const request = {
      aiflowCorrelationId: 'correlation-1',
      headers: { authorization: 'Bearer aiflow-demo-token-b' },
      path: '/api/v1/connectors',
    } as unknown as AuthorizedRequest;
    const next = jest.fn() as NextFunction;

    createDemoAuthMiddleware('test')(request, response().response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(request.aiflowAuthorization).toEqual({
      actor: { id: 'demo-user-b', type: 'USER' },
      correlationId: 'correlation-1',
      projectId: 'demo-project-b',
      tenantId: 'demo-tenant-b',
    });
    expect(() =>
      authorizeProject(request.aiflowAuthorization!, 'demo-project-a'),
    ).toThrow('PROJECT_ACCESS_DENIED');
  });

  it('rejects browser-selected identity headers', () => {
    const request = {
      headers: {
        authorization: 'Bearer aiflow-demo-token-a',
        'x-client-id': 'another-tenant',
      },
      path: '/api/v1/connectors',
    } as unknown as AuthorizedRequest;
    const output = response();
    const next = jest.fn() as NextFunction;

    createDemoAuthMiddleware('test')(request, output.response, next);

    expect(next).not.toHaveBeenCalled();
    expect(output.status).toHaveBeenCalledWith(400);
    expect(output.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'UNTRUSTED_IDENTITY_HEADER' }),
      }),
    );
  });

  it('cannot select a demo validator in production', () => {
    expect(() => createDemoAuthMiddleware('production')).toThrow(
      'PRODUCTION_AUTH_ADAPTER_NOT_CONFIGURED',
    );
  });
});
