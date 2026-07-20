import { RequestContextStore } from './request-context';

describe('RequestContextStore', () => {
  it('keeps concurrent asynchronous request contexts isolated', async () => {
    const store = new RequestContextStore();

    const readContext = (correlationId: string): Promise<string | undefined> =>
      store.run({ correlationId }, async () => {
        await Promise.resolve();
        return store.current()?.correlationId;
      });

    await expect(
      Promise.all([readContext('request-a'), readContext('request-b')]),
    ).resolves.toEqual(['request-a', 'request-b']);
    expect(store.current()).toBeUndefined();
  });

  it('copies and freezes validated authorization context', () => {
    const store = new RequestContextStore();
    const permissions = ['aiflow.workflow.read'];

    store.run(
      {
        authorization: {
          actor: { id: 'actor-id', type: 'USER' },
          correlationId: 'correlation-id',
          permissions,
          tenantId: 'tenant-id',
        },
        correlationId: 'correlation-id',
      },
      () => {
        permissions.push('aiflow.workflow.write');

        expect(store.current()?.authorization?.permissions).toEqual([
          'aiflow.workflow.read',
        ]);
        expect(Object.isFrozen(store.current()?.authorization)).toBe(true);
      },
    );
  });

  it('rejects mismatched authorization and request correlation', () => {
    const store = new RequestContextStore();

    expect(() =>
      store.run(
        {
          authorization: {
            actor: { id: 'actor-id', type: 'USER' },
            correlationId: 'authorization-correlation',
            permissions: [],
            tenantId: 'tenant-id',
          },
          correlationId: 'request-correlation',
        },
        () => undefined,
      ),
    ).toThrow('Authorization and request correlation identifiers must match');
  });
});
