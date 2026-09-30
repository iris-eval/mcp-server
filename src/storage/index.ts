import type { IrisConfig } from '../types/index.js';
import type { IStorageAdapter } from '../types/query.js';
import { SqliteAdapter, type SqliteAdapterOptions } from './sqlite-adapter.js';

/** `log`: where the store's own lines go (the search index build); the server passes its logger. */
export function createStorage(config: IrisConfig, options: Pick<SqliteAdapterOptions, 'log' | 'upgradeAfterStart'> = {}): IStorageAdapter {
  switch (config.storage.type) {
    case 'sqlite':
      return new SqliteAdapter(config.storage.path, {
        redact: config.storage.redact ?? 'none',
        synchronous: config.storage.synchronous ?? 'normal',
        ...options,
        ...(config.storage.searchBudgetMs !== undefined ? { searchBudgetMs: config.storage.searchBudgetMs } : {}),
      });
    default:
      throw new Error(`Unsupported storage type: ${config.storage.type} (supported: sqlite)`);
  }
}

export { SqliteAdapter } from './sqlite-adapter.js';
