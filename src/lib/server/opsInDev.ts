import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

function devOpsEnabled(raw: string | undefined): boolean {
	if (!raw) return false;
	const v = raw.trim().toLowerCase();
	return v === '1' || v === 'true' || v === 'yes';
}

/** Server-side Telegram sends. Off in dev unless ENABLE_DEV_TELEGRAM is set. */
export function isTelegramNotifyEnabled(): boolean {
	if (!dev) return true;
	return devOpsEnabled(env.ENABLE_DEV_TELEGRAM);
}

/** Server-side PostHog. Off in dev unless ENABLE_DEV_ANALYTICS is set. */
export function isAnalyticsEnabled(): boolean {
	if (!dev) return true;
	return devOpsEnabled(env.ENABLE_DEV_ANALYTICS);
}
