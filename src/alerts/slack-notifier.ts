import { appConfig } from '../config.js';

export type AlertLevel = 'error' | 'fatal';

type DedupeKey = string;

// In-memory deduplication: same alert within 15 minutes is sent only once.
const DEDUP_WINDOW_MS = 15 * 60 * 1000;
const sentAlerts = new Map<DedupeKey, number>();

function dedupKey(level: AlertLevel, message: string): DedupeKey {
  return `${level}::${message}`;
}

function isWithinDedupWindow(key: DedupeKey): boolean {
  const lastSent = sentAlerts.get(key);
  if (lastSent === undefined) return false;
  return Date.now() - lastSent < DEDUP_WINDOW_MS;
}

export async function sendAlert(
  level: AlertLevel,
  message: string,
  context?: Record<string, unknown>
): Promise<void> {
  if (!appConfig.ALERTING_ENABLED || !appConfig.ALERT_SLACK_WEBHOOK_URL) {
    return;
  }

  const key = dedupKey(level, message);
  if (isWithinDedupWindow(key)) {
    return;
  }

  sentAlerts.set(key, Date.now());

  const emoji = level === 'fatal' ? ':red_circle:' : ':warning:';
  const text = [
    `${emoji} *[${level.toUpperCase()}]* ${message}`,
    context ? `\`\`\`${JSON.stringify(context, null, 2)}\`\`\`` : null
  ]
    .filter(Boolean)
    .join('\n');

  fetch(appConfig.ALERT_SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  }).catch((err: unknown) => {
    console.error('[slack-notifier] Failed to send alert:', err);
  });
}

/** Exposed for testing only — clears the in-memory dedup state. */
export function _resetDedupState(): void {
  sentAlerts.clear();
}
