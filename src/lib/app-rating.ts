import { supabase } from './supabase';
import type { User } from '@supabase/supabase-js';

export interface AppRatingSubmissionRow {
	id: string;
	user_id: string;
	stars: number;
	comment: string | null;
	app_version: string | null;
	created_at: string;
}

export interface SubmitAppRatingInput {
	user: User;
	stars: number;
	comment?: string;
}

const COMMENT_MAX = 2000;

export async function submitAppRating(
	input: SubmitAppRatingInput
): Promise<{ success: true; row: AppRatingSubmissionRow } | { success: false; error: string }> {
	const { user, stars, comment } = input;

	if (!user) {
		return { success: false, error: 'You must be signed in to submit a rating.' };
	}

	const n = Math.round(Number(stars));
	if (!Number.isFinite(n) || n < 1 || n > 5) {
		return { success: false, error: 'Please choose a rating from 1 to 5 stars.' };
	}

	const trimmed = (comment ?? '').trim();
	if (trimmed.length > COMMENT_MAX) {
		return { success: false, error: `Comment must be at most ${COMMENT_MAX} characters.` };
	}

	const appVersion = String(import.meta.env.PUBLIC_APP_VERSION ?? '').trim() || null;

	const { data, error } = await supabase
		.from('app_rating_submissions')
		.insert({
			user_id: user.id,
			stars: n,
			comment: trimmed.length > 0 ? trimmed : null,
			app_version: appVersion
		})
		.select('*')
		.single<AppRatingSubmissionRow>();

	if (error || !data) {
		return {
			success: false,
			error: error?.message || 'Failed to submit your rating.'
		};
	}

	return { success: true, row: data };
}
