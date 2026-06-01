/** True when VITE_ENABLE_DEV_TELEGRAM / VITE_ENABLE_DEV_ANALYTICS is set (local only). */
function devOpsEnabled(raw: string | undefined): boolean {
	if (!raw) return false;
	const v = raw.trim().toLowerCase();
	return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Telegram operator notifications (visit, export, contact, etc.).
 * Off in `import.meta.env.DEV` unless VITE_ENABLE_DEV_TELEGRAM is set.
 */
export function isTelegramNotifyEnabled(): boolean {
	if (!import.meta.env.DEV) return true;
	return devOpsEnabled(import.meta.env.VITE_ENABLE_DEV_TELEGRAM as string | undefined);
}

/**
 * PostHog client analytics.
 * Off in dev unless VITE_ENABLE_DEV_ANALYTICS is set.
 */
export function isAnalyticsEnabled(): boolean {
	if (!import.meta.env.DEV) return true;
	return devOpsEnabled(import.meta.env.VITE_ENABLE_DEV_ANALYTICS as string | undefined);
}
