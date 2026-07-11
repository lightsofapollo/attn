// Error types shared by browser-storage.ts and the workspace schema module
// (split out so the schema can be imported without the full storage graph).

export class BrowserStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserStorageError';
  }
}

export class MissingBrowserStorageError extends BrowserStorageError {
  constructor(databaseName: string) {
    super(`browser storage database does not exist: ${databaseName}`);
    this.name = 'MissingBrowserStorageError';
  }
}

export class StorageConflictError extends BrowserStorageError {
  constructor(message: string) {
    super(message);
    this.name = 'StorageConflictError';
  }
}
