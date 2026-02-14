/**
 * TypeScript interfaces for S3 Analytics Skill
 *
 * Shared types for metrics data structures
 */

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
