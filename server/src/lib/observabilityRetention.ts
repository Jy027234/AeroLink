export type ObservabilityRetentionPolicy = {
  exporterEnabled: boolean;
  configured: boolean;
  metricsRetentionDays?: number;
  traceRetentionHours?: number;
  issues: string[];
};

function positiveInteger(name: string, value: string | undefined) {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return `${name} must be a positive integer`;
  return parsed;
}
/**
 * Reads the deployment retention contract without contacting an external collector.
 * The app owns only the exporter switch; the collector owns actual deletion. Requiring
 * explicit values when export is enabled prevents an undocumented infinite-retention
 * default from being mistaken for an approved internal-trial policy.
 */
export function getObservabilityRetentionPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): ObservabilityRetentionPolicy {
  const exporterEnabled = Boolean(environment.TRACE_EXPORTER_URL?.trim());
  const metricsValue = positiveInteger(
    'OBSERVABILITY_METRICS_RETENTION_DAYS',
    environment.OBSERVABILITY_METRICS_RETENTION_DAYS,
  );
  const traceValue = positiveInteger(
    'OBSERVABILITY_TRACE_RETENTION_HOURS',
    environment.OBSERVABILITY_TRACE_RETENTION_HOURS,
  );
  const issues = [
    typeof metricsValue === 'string' ? metricsValue : undefined,
    typeof traceValue === 'string' ? traceValue : undefined,
    exporterEnabled && typeof metricsValue !== 'number'
      ? 'OBSERVABILITY_METRICS_RETENTION_DAYS is required when TRACE_EXPORTER_URL is set'
      : undefined,
    exporterEnabled && typeof traceValue !== 'number'
      ? 'OBSERVABILITY_TRACE_RETENTION_HOURS is required when TRACE_EXPORTER_URL is set'
      : undefined,
  ].filter((issue): issue is string => Boolean(issue));

  return {
    exporterEnabled,
    configured: issues.length === 0 && (!exporterEnabled || (typeof metricsValue === 'number' && typeof traceValue === 'number')),
    ...(typeof metricsValue === 'number' ? { metricsRetentionDays: metricsValue } : {}),
    ...(typeof traceValue === 'number' ? { traceRetentionHours: traceValue } : {}),
    issues,
  };
}
