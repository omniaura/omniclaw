# S3 Analytics Skill

Fetch and analyze time-series analytics data from S3 storage (Backblaze B2).

## Use Cases

- Analyze user growth trends over time
- Generate charts and reports from historical metrics
- Calculate KPIs (DAU, MAU, MRR, ARR, conversion rates)
- Export data for dashboards and visualizations

## How to Use

The skill provides utilities to fetch analytics data from S3 and transform it into chart-ready formats.

### Example Usage

```typescript
import { fetchTimeSeriesMetrics } from './s3-analytics/fetcher.ts';

// Get all historical metrics
const metrics = await fetchTimeSeriesMetrics();

// Access chart-ready data
console.log(metrics.mrr);              // Monthly recurring revenue over time
console.log(metrics.subscribers);       // Subscriber count over time
console.log(metrics.dau);              // Daily active users over time
console.log(metrics.conversion_rate);  // Conversion rate trends
```

### Available Metrics

- **subscribers** - Active paying subscribers
- **mrr** - Monthly Recurring Revenue (dollars)
- **arr** - Annual Recurring Revenue (dollars)
- **dau** - Daily Active Users
- **mau** - Monthly Active Users
- **conversion_rate** - Free to paid conversion (percentage)
- **total_users** - Total registered users
- **weekly_signups** - New signups per week
- **monthly_margin** - Estimated profit margin (dollars)

## Configuration

Set S3 credentials via environment or edit `s3-client.ts`:

```typescript
export const s3Client = new S3Client({
  endpoint: 'https://s3.us-east-005.backblazeb2.com',
  region: 'us-east-005',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});
```

## File Structure

- `fetcher.ts` - Main data fetching, parsing logic, and TypeScript interfaces
- `s3-client.ts` - S3 client configuration

## Data Format

Expects S3 files at: `s3://bucket/analytics/timeseries/userstats-YYYY-MM-DD.json`

Each file should contain:

```json
{
  "generated_at": "2026-02-14T12:00:00Z",
  "daily_active_users": 7,
  "monthly_active_users": 31,
  "total_users": 539,
  "stripe_mrr_cents": 149900,
  "stripe_active_subscribers": 11,
  "conversion_rate": {
    "free_users": 20,
    "paid_users": 11,
    "conversion_rate": 0.35
  }
}
```

## Tips

- Use `calculateGrowth()` helper to get percentage changes
- Data points are sorted chronologically by date
- All revenue metrics are automatically converted from cents to dollars
- Dates are in YYYY-MM-DD format for easy sorting and filtering

## Dependencies

```json
{
  "dependencies": {
    "@aws-sdk/client-s3": "^3.709.0"
  }
}
```
