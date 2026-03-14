import type { IrisConfig } from '../types/index.js';
import type { IStorageAdapter } from '../types/query.js';
import { SqliteAdapter } from './sqlite-adapter.js';

export function createStorage(config: IrisConfig): IStorageAdapter {
  switch (config.storage.type) {
    case 'sqlite':
      return new SqliteAdapter(config.storage.path);
    default:
      throw new Error(`Unsupported storage type: ${config.storage.type}`);
  }
}

export { SqliteAdapter } from './sqlite-adapter.js';
