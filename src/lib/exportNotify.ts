import type { SubscriptionStatus } from './subscription';

export interface ExportNotifyPayload {
	email: string | undefined;
	name: string | undefined;
	subscriptionStatus: SubscriptionStatus | null;
	designName: string;
	format: 'stl' | '3mf';
}

function formatSubscriptionStatus(s: SubscriptionStatus | null): string {
	if (!s) return 'none';
	if (!s.isActive) return 'inactive';
	if (s.source === 'subscription') return `subscription (${s.plan ?? '—'})`;
	if (s.source === 'license') return 'license';
	return 'active';
}

/**
 * Notify backend of an export event (sends to Telegram). Fire-and-forget; does not block.
 */
export function notifyExportEvent(payload: ExportNotifyPayload): void {
	const { email, name, subscriptionStatus, designName, format } = payload;
	const body = {
		email: email ?? undefined,
		name: name ?? undefined,
		subscriptionStatus: formatSubscriptionStatus(subscriptionStatus),
		designName,
		format
	};

	fetch('/api/telegram/export-notify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	}).catch((err) => console.warn('Export notify failed:', err));
}
