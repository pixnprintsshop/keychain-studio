import { supabase } from './supabase';
import type { SubscriptionStatus } from './subscription';
import { formatSubscriptionStatusForNotify } from './notifyFormat';

export interface FontRecommendationPayload {
	recommendation: string;
	subscriptionStatus?: SubscriptionStatus | null;
}

/** Save a font name/link suggestion and notify the operator (Telegram). */
export async function notifyFontRecommendation(
	payload: FontRecommendationPayload
): Promise<boolean> {
	const recommendation = payload.recommendation.trim();
	if (!recommendation) return false;

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };

	try {
		const {
			data: { session }
		} = await supabase.auth.getSession();
		if (session?.access_token) {
			headers.Authorization = `Bearer ${session.access_token}`;
		}
	} catch {
		// Continue without auth — guests can still submit.
	}

	try {
		const res = await fetch('/api/font-recommendation', {
			method: 'POST',
			headers,
			body: JSON.stringify({
				recommendation,
				subscriptionStatus: formatSubscriptionStatusForNotify(payload.subscriptionStatus)
			}),
			keepalive: true
		});
		return res.ok;
	} catch (err) {
		console.warn('Font recommendation submit failed:', err);
		return false;
	}
}
