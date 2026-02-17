/**
 * Shared utilities for NanoClaw
 * Reusable across all backends and agents
 */

export { SharedS3Client, type S3ClientConfig } from './s3-client.js';
export {
  QuarterPlanSync,
  type Initiative,
  type QuarterPlanData,
  type ARRData,
} from './quarterplan.js';
