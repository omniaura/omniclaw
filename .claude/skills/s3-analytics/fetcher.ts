/**
 * Time-Series Data Fetcher for Analytics Dashboard
 *
 * Fetches and parses historical metrics from S3 for trend analysis.
 * Reads userstats-YYYY-MM-DD.json files and builds chronological timelines.
 */

import { ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, BUCKET_NAME, TIMESERIES_PREFIX } from './s3-client';
import type { UserStats, TimeSeriesDataPoint, TimeSeriesMetrics } from './types';

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
 * Uses parallel fetching with batching for improved performance
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

  // Fetch files in parallel batches of 10 for optimal performance
  const BATCH_SIZE = 10;
  const results: Array<{ date: string; stats: UserStats }> = [];

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (file) => {
        const date = extractDateFromFilename(file);
        if (!date) {
          console.warn(`Skipping file with invalid name: ${file}`);
          return null;
        }

        const stats = await fetchUserStats(file);
        if (!stats) {
          console.warn(`Skipping file with no data: ${file}`);
          return null;
        }

        return { date, stats };
      })
    );

    results.push(...batchResults.filter((r): r is NonNullable<typeof r> => r !== null));
  }

  // Sort by date to ensure chronological order
  results.sort((a, b) => a.date.localeCompare(b.date));

  // Build data points for each metric from sorted results
  for (const { date, stats } of results) {
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

/**
 * Get the most recent N days of data from a timeline
 */
export function getRecentDays(data: TimeSeriesDataPoint[], n: number): TimeSeriesDataPoint[] {
  if (n >= data.length) {
    return data;
  }
  return data.slice(-n);
}

/**
 * Calculate rolling average for smoothing noisy data
 * Returns a new array with the same length, with averaged values
 */
export function calculateRollingAverage(
  data: TimeSeriesDataPoint[],
  window: number
): TimeSeriesDataPoint[] {
  if (data.length === 0) {
    return [];
  }

  const result: TimeSeriesDataPoint[] = [];

  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - Math.floor(window / 2));
    const end = Math.min(data.length, i + Math.ceil(window / 2));
    const windowData = data.slice(start, end);
    const average = windowData.reduce((sum, point) => sum + point.value, 0) / windowData.length;

    result.push({
      date: data[i].date,
      value: average,
    });
  }

  return result;
}
