import type { SubscriptionStatus } from './subscription';
import { getBrowserFingerprintHash } from './browserFingerprint';
import { formatSubscriptionStatusForNotify } from './notifyFormat';
import { isTelegramNotifyEnabled } from './opsInDev';

/**
 * Sentinel set in `sessionStorage` after a visit notification has fired so we
 * only ping the operator once per browser session (per tab restore counts as
 * the same session). Server-side dedupe ensures repeat users never notify again.
 */
const SESSION_KEY = 'pixnprints-visit-notified';

export interface VisitNotifyPayload {
	email?: string | null;
	userId?: string | null;
	subscriptionStatus: SubscriptionStatus | null;
	/** Current view name (e.g. 'home', 'cakeTopper'). Server skips display for 'home'. */
	view?: string;
}

/**
 * Notify backend of a new visit (sends to Telegram). Fire-and-forget, gated by
 * `sessionStorage` so we only fire once per browser session. Country is resolved
 * server-side from request headers; the client only contributes user info.
 * Repeat visitors are skipped server-side via `visit_notify_sent`.
 */
export async function notifyVisit(payload: VisitNotifyPayload): Promise<void> {
	if (typeof window === 'undefined') return;
	if (!isTelegramNotifyEnabled()) return;
	try {
		if (sessionStorage.getItem(SESSION_KEY) === '1') return;
		sessionStorage.setItem(SESSION_KEY, '1');
	} catch {
		// sessionStorage may be unavailable (private mode); accept the rare double-fire
		// rather than block the request entirely.
	}

	const referrer =
		typeof document !== 'undefined' && document.referrer ? document.referrer : undefined;

	const guestKey = payload.userId ? undefined : await getBrowserFingerprintHash();

	const body = {
		email: payload.email ?? undefined,
		userId: payload.userId ?? undefined,
		guestKey,
		subscriptionStatus: formatSubscriptionStatusForNotify(payload.subscriptionStatus),
		referrer,
		view: payload.view
	};

	fetch('/api/telegram/visit-notify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		keepalive: true
	}).catch((err) => console.warn('Visit notify failed:', err));
}
