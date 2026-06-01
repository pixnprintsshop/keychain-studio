import type { SubscriptionStatus } from './subscription';
import { formatSubscriptionStatusForNotify } from './notifyFormat';

const STORAGE_PREFIX = 'pixnprints-cs-interest-';

export function isComingSoonInterestRecorded(designerId: string): boolean {
	if (typeof window === 'undefined') return false;
	try {
		return sessionStorage.getItem(`${STORAGE_PREFIX}${designerId}`) === '1';
	} catch {
		return false;
	}
}

export function markComingSoonInterestRecorded(designerId: string): void {
	try {
		sessionStorage.setItem(`${STORAGE_PREFIX}${designerId}`, '1');
	} catch {
		// sessionStorage unavailable
	}
}

export interface ComingSoonInterestPayload {
	designerId: string;
	designerTitle: string;
	email?: string | null;
	userId?: string | null;
	subscriptionStatus?: SubscriptionStatus | null;
}

/**
 * Tell the operator a user is interested in a coming-soon designer (Telegram).
 * Returns false if the request failed; caller should only persist session flag on success.
 */
export async function notifyComingSoonInterest(
	payload: ComingSoonInterestPayload
): Promise<boolean> {
	try {
		const res = await fetch('/api/telegram/coming-soon-interest', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				designerId: payload.designerId,
				designerTitle: payload.designerTitle,
				email: payload.email ?? undefined,
				userId: payload.userId ?? undefined,
				subscriptionStatus: formatSubscriptionStatusForNotify(payload.subscriptionStatus)
			}),
			keepalive: true
		});
		return res.ok;
	} catch (err) {
		console.warn('Coming soon interest notify failed:', err);
		return false;
	}
}
