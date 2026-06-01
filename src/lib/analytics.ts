import posthog from 'posthog-js';
import { isAnalyticsEnabled } from '$lib/opsInDev';

export function initAnalytics(
	token: string,
	options: Parameters<typeof posthog.init>[1]
): void {
	if (!isAnalyticsEnabled()) return;
	posthog.init(token, options);
}

export function capture(event: string, properties?: Record<string, unknown>): void {
	if (!isAnalyticsEnabled()) return;
	posthog.capture(event, properties);
}

export function identify(distinctId: string, properties?: Record<string, unknown>): void {
	if (!isAnalyticsEnabled()) return;
	posthog.identify(distinctId, properties);
}

export function reset(): void {
	if (!isAnalyticsEnabled()) return;
	posthog.reset();
}

export function captureException(error: unknown): void {
	if (!isAnalyticsEnabled()) return;
	posthog.captureException(error);
}
