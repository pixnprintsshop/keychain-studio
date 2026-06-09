import type { SubscriptionStatus } from './subscription';
import { formatSubscriptionStatusForNotify } from './notifyFormat';
import { isTelegramNotifyEnabled } from './opsInDev';

export type FavoriteNotifyAction = 'added' | 'removed';

export interface FavoriteNotifyPayload {
	designerId: string;
	designerTitle: string;
	action: FavoriteNotifyAction;
	email?: string | null;
	userId?: string | null;
	subscriptionStatus?: SubscriptionStatus | null;
}

/** Fire-and-forget Telegram ping when a user favorites or unfavorites a designer. */
export function notifyFavoriteAction(payload: FavoriteNotifyPayload): void {
	if (!isTelegramNotifyEnabled()) return;

	fetch('/api/telegram/favorite-notify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			designerId: payload.designerId,
			designerTitle: payload.designerTitle,
			action: payload.action,
			email: payload.email ?? undefined,
			userId: payload.userId ?? undefined,
			subscriptionStatus: formatSubscriptionStatusForNotify(payload.subscriptionStatus)
		}),
		keepalive: true
	}).catch((err) => console.warn('Favorite notify failed:', err));
}
