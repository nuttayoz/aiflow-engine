import type { DataSource } from 'typeorm';

import { DatabaseService } from './database.service';

interface TestDataSource {
  destroy: jest.Mock<Promise<void>, []>;
  initialize: jest.Mock<Promise<void>, []>;
  isInitialized: boolean;
  query: jest.Mock<Promise<unknown>, [string]>;
}

const createDataSource = (): TestDataSource => ({
  destroy: jest.fn().mockResolvedValue(undefined),
  initialize: jest.fn().mockResolvedValue(undefined),
  isInitialized: false,
  query: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
});

describe('DatabaseService', () => {
  it('initializes and closes the shared role data source', async () => {
    const dataSource = createDataSource();
    const service = new DatabaseService(dataSource as unknown as DataSource);

    await service.onApplicationBootstrap();
    expect(dataSource.initialize).toHaveBeenCalledTimes(1);

    dataSource.isInitialized = true;
    await service.onApplicationShutdown();
    expect(dataSource.destroy).toHaveBeenCalledTimes(1);
  });

  it('reports readiness without disclosing a connection failure', async () => {
    const dataSource = createDataSource();
    const service = new DatabaseService(dataSource as unknown as DataSource);

    await expect(service.checkReadiness()).resolves.toEqual({
      code: 'DATABASE_UNAVAILABLE',
      status: 'unavailable',
    });

    dataSource.isInitialized = true;
    await expect(service.checkReadiness()).resolves.toEqual({
      status: 'ready',
    });
    expect(dataSource.query).toHaveBeenCalledWith('SELECT 1');

    dataSource.query.mockRejectedValueOnce(
      new Error('postgresql://user:secret@database'),
    );
    await expect(service.checkReadiness()).resolves.toEqual({
      code: 'DATABASE_UNAVAILABLE',
      status: 'unavailable',
    });
  });
});
