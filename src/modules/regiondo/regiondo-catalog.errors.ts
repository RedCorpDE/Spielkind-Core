export class RegiondoCatalogSyncError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 502,
    readonly details?: string
  ) {
    super(message);
    this.name = 'RegiondoCatalogSyncError';
  }
}
