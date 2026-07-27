import type { Response } from 'express';

import type { AuthorizedRequest } from './api-auth';
import {
  SharePointCallbackController,
  type SharePointCallbackService,
} from './sharepoint-callback.controller';

const response = () => {
  const send = jest.fn();
  const type = jest.fn().mockReturnValue({ send });
  const setHeader = jest.fn().mockReturnValue({ send, type });
  const status = jest.fn().mockReturnValue({ send, setHeader, type });
  return {
    response: { status } as unknown as Response,
    send,
    setHeader,
    status,
    type,
  };
};

describe('SharePoint callback controller', () => {
  it('echoes a bounded validation challenge as plain text', async () => {
    const service = { accept: jest.fn() };
    const controller = new SharePointCallbackController(
      service as unknown as SharePointCallbackService,
    );
    const output = response();

    await controller.callback(
      {
        headers: {},
        query: { validationToken: 'opaque challenge' },
      } as unknown as AuthorizedRequest,
      undefined,
      output.response,
    );

    expect(output.status).toHaveBeenCalledWith(200);
    expect(output.type).toHaveBeenCalledWith('text/plain');
    expect(output.send).toHaveBeenCalledWith('opaque challenge');
    expect(service.accept).not.toHaveBeenCalled();
  });

  it('durably accepts JSON notifications before returning 202', async () => {
    const service = { accept: jest.fn().mockResolvedValue(undefined) };
    const controller = new SharePointCallbackController(
      service as unknown as SharePointCallbackService,
    );
    const output = response();
    const body = { value: [] };
    const rawBody = Buffer.from(JSON.stringify(body));

    await controller.callback(
      {
        headers: { 'content-type': 'application/json; charset=utf-8' },
        query: {},
        rawBody,
      } as unknown as AuthorizedRequest,
      body,
      output.response,
    );

    expect(service.accept).toHaveBeenCalledWith(body, rawBody);
    expect(output.status).toHaveBeenCalledWith(202);
    expect(output.send).toHaveBeenCalledWith();
  });

  it('rejects duplicate validation tokens and non-JSON callbacks', async () => {
    const controller = new SharePointCallbackController({
      accept: jest.fn(),
    } as unknown as SharePointCallbackService);

    await expect(
      controller.callback(
        {
          headers: {},
          query: { validationToken: ['one', 'two'] },
        } as unknown as AuthorizedRequest,
        undefined,
        response().response,
      ),
    ).rejects.toThrow('SHAREPOINT_VALIDATION_TOKEN_INVALID');
    await expect(
      controller.callback(
        {
          headers: { 'content-type': 'text/plain' },
          query: {},
          rawBody: Buffer.from('{}'),
        } as unknown as AuthorizedRequest,
        {},
        response().response,
      ),
    ).rejects.toThrow('SHAREPOINT_NOTIFICATION_CONTENT_TYPE_INVALID');
  });
});
