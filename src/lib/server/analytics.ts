import type { PostHog } from 'posthog-node';
import { getPostHogClient } from '$lib/server/posthog';
import { isAnalyticsEnabled } from '$lib/server/opsInDev';

export function captureServerEvent(
	distinctId: string,
	event: string,
	properties?: Record<string, unknown>
): void {
	if (!isAnalyticsEnabled()) return;
	getPostHogClient().capture({ distinctId, event, properties });
}

export async function flushServerAnalytics(): Promise<void> {
	if (!isAnalyticsEnabled()) return;
	await getPostHogClient().flush();
}
