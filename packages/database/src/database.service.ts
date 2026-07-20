import { Inject, Injectable } from '@nestjs/common';
import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';

export const DATABASE_DATA_SOURCE = Symbol('DATABASE_DATA_SOURCE');

export interface DatabaseReadiness {
  code?: 'DATABASE_UNAVAILABLE';
  status: 'ready' | 'unavailable';
}

@Injectable()
export class DatabaseService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(
    @Inject(DATABASE_DATA_SOURCE)
    readonly dataSource: DataSource,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.dataSource.isInitialized) {
      await this.dataSource.initialize();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }

  async checkReadiness(): Promise<DatabaseReadiness> {
    if (!this.dataSource.isInitialized) {
      return { code: 'DATABASE_UNAVAILABLE', status: 'unavailable' };
    }

    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return { code: 'DATABASE_UNAVAILABLE', status: 'unavailable' };
    }
  }
}
