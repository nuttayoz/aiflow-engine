import { HttpSharePointGraphAdapter } from './http-graph';
import type { SharePointGraphError } from './graph-port';

const context = {
  connectionId: 'connection-1',
  tenantId: 'tenant-1',
};

const createAdapter = (fetcher: typeof fetch) =>
  new HttpSharePointGraphAdapter(
    {
      resolve: async () => ({
        externalTenantId: '22222222-2222-4222-8222-222222222222',
      }),
    },
    { getAccessToken: async () => 'graph-token' },
    5_000,
    ['.sharepoint.com'],
    fetcher,
  );

describe('Microsoft Graph HTTP adapter', () => {
  it('discovers only normalized resource fields through the fixed Graph origin', async () => {
    const fetcher = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            value: [
              {
                displayName: 'Finance',
                id: 'site-1',
                webUrl: 'https://secret.example.invalid',
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const adapter = createAdapter(fetcher as unknown as typeof fetch);

    await expect(
      adapter.listResources({ ...context, resourceType: 'SITE' }),
    ).resolves.toEqual({
      items: [
        {
          id: 'site-1',
          label: 'Finance',
          resourceType: 'SITE',
          selectable: true,
        },
      ],
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://graph.microsoft.com/v1.0/sites?search=*&$top=100&$select=id,displayName',
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: 'Bearer graph-token',
      }),
      redirect: 'error',
    });
  });

  it('never forwards Graph authorization to a preauthenticated download URL', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(
        new Response('', {
          headers: {
            location:
              'https://contoso.sharepoint.com/download/document?opaque=1',
          },
          status: 302,
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            'content-length': '3',
            'content-type': 'application/pdf',
          },
          status: 200,
        }),
      );
    const adapter = createAdapter(fetcher as unknown as typeof fetch);

    const content = await adapter.openFileContent({
      ...context,
      driveId: 'drive-1',
      itemId: 'item-1',
    });

    expect(content.contentLength).toBe(3);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toBeUndefined();
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
    });
  });

  it('rejects unapproved download hosts and classifies cursor expiry', async () => {
    const malicious = createAdapter(
      jest.fn(
        async () =>
          new Response('', {
            headers: { location: 'https://169.254.169.254/latest/meta-data' },
            status: 302,
          }),
      ) as unknown as typeof fetch,
    );
    await expect(
      malicious.openFileContent({
        ...context,
        driveId: 'drive-1',
        itemId: 'item-1',
      }),
    ).rejects.toMatchObject<Partial<SharePointGraphError>>({
      code: 'GRAPH_UNAVAILABLE',
    });

    const expired = createAdapter(
      jest.fn(
        async () => new Response('', { status: 410 }),
      ) as unknown as typeof fetch,
    );
    await expect(
      expired.listDeltaPage({
        ...context,
        cursor:
          'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?$deltatoken=old',
        driveId: 'drive-1',
      }),
    ).rejects.toMatchObject<Partial<SharePointGraphError>>({
      code: 'GRAPH_CURSOR_INVALID',
    });
  });
});
