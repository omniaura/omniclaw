/**
 * Shared S3 Client for OmniClaw
 * Reusable S3 client wrapper for Backblaze B2
 * Used by backends and shared context systems
 */

export interface S3ClientConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

export class SharedS3Client {
  private client: InstanceType<typeof Bun.S3Client>;

  constructor(config: S3ClientConfig) {
    this.client = new Bun.S3Client({
      endpoint: `https://${config.endpoint}`,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      bucket: config.bucket,
      region: config.region || 'us-east-005',
    });
  }

  /** Read file from S3 */
  async read(key: string): Promise<string> {
    const file = this.client.file(key);
    if (!(await file.exists())) {
      throw new Error(`File not found: ${key}`);
    }
    return file.text();
  }

  /** Write file to S3 */
  async write(key: string, content: string): Promise<void> {
    await this.client.write(key, content);
  }

  /** Check if file exists */
  async exists(key: string): Promise<boolean> {
    return this.client.file(key).exists();
  }

  /** Delete file */
  async delete(key: string): Promise<void> {
    await this.client.delete(key);
  }

  /** Get file handle for advanced operations */
  file(key: string) {
    return this.client.file(key);
  }
}
