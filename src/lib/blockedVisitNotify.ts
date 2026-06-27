import type { SubscriptionStatus } from './subscription';
import { getBrowserFingerprintHash } from './browserFingerprint';
import { formatSubscriptionStatusForNotify } from './notifyFormat';
import { isTelegramNotifyEnabled } from './opsInDev';
import type { UserBlockKind } from './userBlock.svelte';

const SESSION_KEY_PREFIX = 'pixnprints-blocked-visit-notified:';

export interface BlockedVisitNotifyPayload {
	email?: string | null;
	userId: string;
	blockKind: UserBlockKind;
	reason?: string | null;
	subscriptionStatus: SubscriptionStatus | null;
	view?: string;
}

/**
 * Notify operator when a blocked/restricted user opens the app. Fire-and-forget;
 * once per browser session per user id.
 */
export async function notifyBlockedVisit(payload: BlockedVisitNotifyPayload): Promise<void> {
	if (typeof window === 'undefined') return;
	if (!isTelegramNotifyEnabled()) return;

	const sessionKey = `${SESSION_KEY_PREFIX}${payload.userId}`;
	try {
		if (sessionStorage.getItem(sessionKey) === '1') return;
		sessionStorage.setItem(sessionKey, '1');
	} catch {
		// sessionStorage unavailable — still send (rare double-fire acceptable)
	}

	const fingerprintHash = await getBrowserFingerprintHash();

	const body = {
		email: payload.email ?? undefined,
		userId: payload.userId,
		blockKind: payload.blockKind ?? undefined,
		reason: payload.reason ?? undefined,
		fingerprintHash,
		subscriptionStatus: formatSubscriptionStatusForNotify(payload.subscriptionStatus),
		view: payload.view
	};

	fetch('/api/telegram/blocked-visit-notify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		keepalive: true
	}).catch((err) => console.warn('Blocked visit notify failed:', err));
}
