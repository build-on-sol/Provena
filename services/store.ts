import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export class ServiceError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); this.name = 'ServiceError'; }
}
export function requireCondition(value: unknown, code: string, status = 400): asserts value {
  if (!value) throw new ServiceError(code, status);
}
export interface DatabaseState {
  version: 1;
  nonces: Record<string, number>;
  content: Record<string, unknown>;
  fingerprints: Record<string, string>;
  provenance: Record<string, unknown>;
  events: Record<string, unknown>;
  reactions: Record<string, Record<string, 'LIKE' | 'UNLIKE'>>;
  views: Record<string, number>;
  messages: Record<string, unknown[]>;
  checkpoint: string | null;
}
function emptyState(): DatabaseState {
  return { version: 1, nonces: {}, content: {}, fingerprints: {}, provenance: {}, events: {}, reactions: {}, views: {}, messages: {}, checkpoint: null };
}
/** One writer per local store; writes are atomic and contain only offchain state. */
export class LocalStore {
  private state: DatabaseState = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(readonly path: string) {}
  static async open(path: string): Promise<LocalStore> {
    const store = new LocalStore(path);
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      requireCondition(value !== null && typeof value === 'object' && (value as DatabaseState).version === 1, 'UnsupportedStoreVersion', 503);
      const loaded = value as DatabaseState;
      for (const key of ['nonces', 'content', 'fingerprints', 'provenance', 'events', 'reactions', 'views', 'messages'] as const) {
        requireCondition(loaded[key] !== null && typeof loaded[key] === 'object' && !Array.isArray(loaded[key]), 'CorruptStore', 503);
      }
      requireCondition(loaded.checkpoint === null || typeof loaded.checkpoint === 'string', 'CorruptStore', 503);
      store.state = loaded;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return store;
  }
  snapshot(): DatabaseState { return structuredClone(this.state); }
  async transact<T>(apply: (state: DatabaseState) => T): Promise<T> {
    const transaction = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const result = apply(next);
      requireCondition(!(result instanceof Promise), 'AsyncStoreMutationUnsupported', 500);
      const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx', flush: true });
      await rename(temporary, this.path);
      this.state = next;
      return result;
    });
    this.queue = transaction.catch(() => undefined);
    return transaction;
  }
}
