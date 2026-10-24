/**
 * CloudWatch metrics — port of `cost-optimization.py:110-124` `cw_avg()`.
 *
 * Averages the datapoints for one metric over a window. Any failure (permission,
 * throttle, missing metric) yields `null`, exactly like the Python version — the
 * audit degrades gracefully instead of aborting.
 */
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";

export interface MetricDim {
	Name: string;
	Value: string;
}

export type MetricStat = "Average" | "Sum" | "Maximum" | "Minimum";

export async function cwAvg(
	cw: CloudWatchClient,
	namespace: string,
	metric: string,
	dimensions: MetricDim[],
	days: number,
	stat: MetricStat = "Average",
): Promise<number | null> {
	const end = new Date();
	const start = new Date(end.getTime() - days * 86_400_000);
	try {
		const r = await cw.send(
			new GetMetricStatisticsCommand({
				Namespace: namespace,
				MetricName: metric,
				Dimensions: dimensions,
				StartTime: start,
				EndTime: end,
				Period: 86400,
				Statistics: [stat],
			}),
		);
		const dps = r.Datapoints ?? [];
		if (dps.length === 0) return null;
		let sum = 0;
		for (const d of dps) {
			const v = d[stat];
			if (typeof v === "number") sum += v;
		}
		return sum / dps.length;
	} catch {
		return null;
	}
}
