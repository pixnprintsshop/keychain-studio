import type { User } from '@supabase/supabase-js';
import type { AppRatingSubmissionRow } from './app-rating';

/**
 * Notify backend of a submitted in-app rating (Telegram). Fire-and-forget; does not block UX.
 */
export function notifyRatingSubmitted(user: User, row: AppRatingSubmissionRow): void {
	const body = {
		email: user.email ?? undefined,
		userId: row.user_id,
		submissionId: row.id,
		stars: row.stars,
		comment: row.comment ?? undefined,
		appVersion: row.app_version ?? undefined,
		createdAt: row.created_at
	};

	fetch('/api/telegram/rating-notify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	}).catch((err) => console.warn('Rating Telegram notify failed:', err));
}
