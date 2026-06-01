import { PUBLIC_POSTHOG_PROJECT_TOKEN } from '$env/static/public';
import { initAnalytics, captureException } from '$lib/analytics';
import type { HandleClientError } from '@sveltejs/kit';

export async function init() {
	initAnalytics(PUBLIC_POSTHOG_PROJECT_TOKEN, {
		api_host: '/ingest',
		ui_host: 'https://us.posthog.com',
		defaults: '2026-01-30',
		capture_exceptions: true
	});
}

export const handleError: HandleClientError = async ({ error, status, message }) => {
	captureException(error);

	return {
		message,
		status
	};
};
