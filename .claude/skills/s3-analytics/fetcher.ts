/**
 * Time-Series Data Fetcher for Analytics Dashboard
 *
 * Fetches and parses historical metrics from S3 for trend analysis.
 * Reads userstats-YYYY-MM-DD.json files and builds chronological timelines.
 */

import { ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, BUCKET_NAME, TIMESERIES_PREFIX } from './s3-client';

/**
 * UserStats interface matching backend output
 * From: ditto-assistant/backend/cmd/userstats
 */
export interface UserStats {
  generated_at: string;
  daily_active_users: number;
  weekly_active_users: number;
  monthly_active_users: number;
  quarterly_active_users: number;
  total_users: number;
  new_signups_week: number;
  new_signups_month: number;

  // Stripe metrics (the ones we care about for charts)
  stripe_mrr_cents?: number;
  stripe_arr_cents?: number;
  stripe_active_subscribers?: number;
  stripe_monthly_subscribers?: number;
  stripe_yearly_subscribers?: number;

  // Growth rates
  dau_mau_ratio?: {
    dau: number;
    mau: number;
    ratio: number;
  };
  conversion_rate?: {
    free_users: number;
    paid_users: number;
    conversion_rate: number;
  };

  // Cost & Profitability
  estimated_monthly_margin_cents?: number;
  estimated_monthly_cost_cents?: number;
}

/**
 * Chart-ready data point
 */
export interface TimeSeriesDataPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

/**
 * Key metrics for charting (matches task requirements)
 */
export interface TimeSeriesMetrics {
  subscribers: TimeSeriesDataPoint[];
  mrr: TimeSeriesDataPoint[];
  arr: TimeSeriesDataPoint[];
  dau: TimeSeriesDataPoint[];
  mau: TimeSeriesDataPoint[];
  conversion_rate: TimeSeriesDataPoint[];
  total_users: TimeSeriesDataPoint[];
  weekly_signups: TimeSeriesDataPoint[];
  monthly_margin: TimeSeriesDataPoint[];
}

/**
 * Fetch all timeseries files from S3
 */
export async function listTimeseriesFiles(): Promise<string[]> {
  const allKeys: string[] = [];
  let continuationToken: string | undefined;

  // Paginate through all objects (max 1000 per request)
  do {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: TIMESERIES_PREFIX,
      ContinuationToken: continuationToken,
    });

    const response = await s3Client.send(command);

    if (response.Contents) {
      const keys = response.Contents
        .filter((item) => item.Key?.includes('userstats-') && item.Key.endsWith('.json'))
        .map((item) => item.Key!);
      allKeys.push(...keys);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return allKeys.sort(); // Chronological order (YYYY-MM-DD sorts naturally)
}

/**
 * Fetch and parse a single userstats file
 */
export async function fetchUserStats(key: string): Promise<UserStats | null> {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    const response = await s3Client.send(command);

    if (!response.Body) {
      return null;
    }

    // Stream to string
    const bodyString = await response.Body.transformToString();
    return JSON.parse(bodyString) as UserStats;
  } catch (error) {
    console.error(`Failed to fetch ${key}:`, error);
    return null;
  }
}

/**
 * Extract date from filename (userstats-YYYY-MM-DD.json)
 */
export function extractDateFromFilename(key: string): string {
  const match = key.match(/userstats-(\d{4}-\d{2}-\d{2})\.json$/);
  return match ? match[1] : '';
}

/**
 * Fetch all timeseries data and build chart-ready metrics
 * Extracts key metrics: subscribers, MRR, DAU, MAU, conversion_rate over time
 */
export async function fetchTimeSeriesMetrics(): Promise<TimeSeriesMetrics> {
  const files = await listTimeseriesFiles();

  console.log(`Found ${files.length} timeseries files`);

  // Initialize metric arrays
  const metrics: TimeSeriesMetrics = {
    subscribers: [],
    mrr: [],
    arr: [],
    dau: [],
    mau: [],
    conversion_rate: [],
    total_users: [],
    weekly_signups: [],
    monthly_margin: [],
  };

  // Fetch and parse each file
  for (const file of files) {
    const date = extractDateFromFilename(file);
    if (!date) {
      console.warn(`Skipping file with invalid name: ${file}`);
      continue;
    }

    const stats = await fetchUserStats(file);
    if (!stats) {
      console.warn(`Skipping file with no data: ${file}`);
      continue;
    }

    // Build data points for each metric
    metrics.subscribers.push({
      date,
      value: stats.stripe_active_subscribers || 0,
    });

    metrics.mrr.push({
      date,
      value: stats.stripe_mrr_cents ? stats.stripe_mrr_cents / 100 : 0,
    });

    metrics.arr.push({
      date,
      value: stats.stripe_arr_cents ? stats.stripe_arr_cents / 100 : 0,
    });

    metrics.dau.push({
      date,
      value: stats.daily_active_users,
    });

    metrics.mau.push({
      date,
      value: stats.monthly_active_users,
    });

    metrics.conversion_rate.push({
      date,
      value: stats.conversion_rate && !isNaN(stats.conversion_rate.conversion_rate)
        ? stats.conversion_rate.conversion_rate * 100
        : 0,
    });

    metrics.total_users.push({
      date,
      value: stats.total_users,
    });

    metrics.weekly_signups.push({
      date,
      value: stats.new_signups_week,
    });

    metrics.monthly_margin.push({
      date,
      value: stats.estimated_monthly_margin_cents
        ? stats.estimated_monthly_margin_cents / 100
        : 0,
    });
  }

  console.log(`Built timeseries for ${metrics.total_users.length} data points`);

  return metrics;
}

/**
 * Get a specific metric timeline
 */
export async function fetchMetricTimeline(
  metric: keyof TimeSeriesMetrics
): Promise<TimeSeriesDataPoint[]> {
  const allMetrics = await fetchTimeSeriesMetrics();
  return allMetrics[metric];
}

/**
 * Get latest value for a metric
 */
export async function getLatestMetricValue(metric: keyof TimeSeriesMetrics): Promise<number | null> {
  const timeline = await fetchMetricTimeline(metric);
  if (timeline.length === 0) {
    return null;
  }
  return timeline[timeline.length - 1].value;
}

/**
 * Calculate percentage change between first and last data point
 */
export function calculateGrowth(timeline: TimeSeriesDataPoint[]): number | null {
  if (timeline.length < 2) {
    return null;
  }

  const first = timeline[0].value;
  const last = timeline[timeline.length - 1].value;

  if (first === 0) {
    return null;
  }

  return ((last - first) / first) * 100;
}

/**
 * Get date range for available data
 */
export async function getDataDateRange(): Promise<{ start: string; end: string } | null> {
  const files = await listTimeseriesFiles();

  if (files.length === 0) {
    return null;
  }

  const firstDate = extractDateFromFilename(files[0]);
  const lastDate = extractDateFromFilename(files[files.length - 1]);

  return { start: firstDate, end: lastDate };
}
