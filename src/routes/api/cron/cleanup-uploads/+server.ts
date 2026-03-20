import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';

const UPLOADS_BUCKET = 'uploads';
/** Delete 3MF files older than this (ms). 1 hour - Bambu Studio fetches immediately. */
const MAX_AGE_MS = 60 * 60 * 1000;

/** GET /api/cron/cleanup-uploads - Deletes old 3MF files from uploads bucket. Called by Vercel Cron. */
export const GET: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('Authorization');
	const expected = env.CRON_SECRET;
	if (!expected || authHeader !== `Bearer ${expected}`) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const supabaseUrl = env.VITE_SUPABASE_URL;
	const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!supabaseUrl || !supabaseServiceKey) {
		return json({ error: 'Storage not configured' }, { status: 500 });
	}

	const supabase = createClient(supabaseUrl, supabaseServiceKey);
	const cutoff = new Date(Date.now() - MAX_AGE_MS);

	let deleted = 0;
	let offset = 0;
	const limit = 500;

	try {
		while (true) {
			const { data: files, error: listError } = await supabase.storage
				.from(UPLOADS_BUCKET)
				.list('', { limit, offset, sortBy: { column: 'created_at', order: 'asc' } });

			if (listError) {
				console.error('cleanup-uploads list error:', listError);
				return json({ error: listError.message, deleted }, { status: 500 });
			}

			const toDelete = (files ?? [])
				.filter((f) => f.id != null && f.created_at != null)
				.filter((f) => new Date(f.created_at ?? '') < cutoff)
				.map((f) => f.name);

			if (toDelete.length > 0) {
				const { error: removeError } = await supabase.storage
					.from(UPLOADS_BUCKET)
					.remove(toDelete);
				if (removeError) {
					console.error('cleanup-uploads remove error:', removeError);
					return json({ error: removeError.message, deleted }, { status: 500 });
				}
				deleted += toDelete.length;
			}

			if (!files || files.length < limit) break;
			offset += limit;
		}

		return json({ ok: true, deleted });
	} catch (err) {
		console.error('cleanup-uploads error:', err);
		return json({ error: String(err), deleted }, { status: 500 });
	}
};
