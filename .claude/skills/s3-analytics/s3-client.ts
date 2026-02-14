/**
 * S3 Client Configuration for Backblaze B2
 *
 * Configured for omniaura-agents bucket
 */

import { S3Client } from '@aws-sdk/client-s3';

export const s3Client = new S3Client({
  endpoint: 'https://s3.us-east-005.backblazeb2.com',
  region: 'us-east-005',
  credentials: {
    accessKeyId: '005f1542e777e830000000010',
    secretAccessKey: 'K005XMskvE9Y7nRJfZm0o9zYvvCAzGo',
  },
});

export const BUCKET_NAME = 'omniaura-agents';
export const TIMESERIES_PREFIX = 'analytics/timeseries/';
