import { PostHog } from 'posthog-node';
import { PUBLIC_POSTHOG_PROJECT_TOKEN, PUBLIC_POSTHOG_HOST } from '$env/static/public';
import { isAnalyticsEnabled } from '$lib/server/opsInDev';

let posthogClient: PostHog | null = null;

const noopPostHog = {
	capture: () => {},
	flush: async () => {},
	shutdown: async () => {}
} as unknown as PostHog;

export function getPostHogClient(): PostHog {
	if (!isAnalyticsEnabled()) return noopPostHog;
	if (!posthogClient) {
		posthogClient = new PostHog(PUBLIC_POSTHOG_PROJECT_TOKEN, {
			host: PUBLIC_POSTHOG_HOST,
			flushAt: 1,
			flushInterval: 0
		});
	}
	return posthogClient;
}

export async function shutdownPostHog() {
	if (posthogClient) {
		await posthogClient.shutdown();
	}
}
