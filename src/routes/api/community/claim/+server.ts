import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { parseCommunityClaimCredits } from '$lib/communityClaimCredits';

function normalizeClaimCode(value: string): string {
	return value.trim().toUpperCase().replace(/\s+/g, '');
}

export const POST: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('Authorization');
	const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!token) {
		return json({ granted: false, error: 'not_signed_in' }, { status: 401 });
	}

	let body: { code?: string };
	try {
		body = await request.json();
	} catch {
		return json({ granted: false, error: 'invalid_request' }, { status: 400 });
	}

	const submittedCode = typeof body?.code === 'string' ? body.code : '';
	if (!submittedCode.trim()) {
		return json({ granted: false, error: 'code_required' }, { status: 400 });
	}

	const expectedCode = env.COMMUNITY_CLAIM_CODE?.trim();
	if (!expectedCode) {
		console.error('COMMUNITY_CLAIM_CODE not set');
		return json({ granted: false, error: 'not_configured' }, { status: 503 });
	}

	if (normalizeClaimCode(submittedCode) !== normalizeClaimCode(expectedCode)) {
		return json({ granted: false, error: 'invalid_code' }, { status: 400 });
	}

	const supabaseUrl = env.VITE_SUPABASE_URL;
	const supabaseAnonKey = env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
	const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;

	if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
		return json({ granted: false, error: 'not_configured' }, { status: 503 });
	}

	const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);
	const {
		data: { user },
		error: authError
	} = await supabaseAnon.auth.getUser(token);
	if (authError || !user) {
		return json({ granted: false, error: 'not_signed_in' }, { status: 401 });
	}

	const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

	const { data: existing, error: existingError } = await supabaseAdmin
		.from('trial_usage')
		.select('community_bonus_claimed_at')
		.eq('user_id', user.id)
		.maybeSingle();

	if (existingError) {
		console.error('community claim lookup error:', existingError);
		return json({ granted: false, error: 'server_error' }, { status: 500 });
	}

	if (existing?.community_bonus_claimed_at) {
		return json({ granted: false, error: 'already_claimed' }, { status: 400 });
	}

	const bonusCredits = parseCommunityClaimCredits(
		env.VITE_COMMUNITY_CLAIM_CREDITS ?? env.COMMUNITY_CLAIM_CREDITS
	);

	const { data, error } = await supabaseAdmin.rpc('claim_community_join_bonus', {
		p_user_id: user.id,
		p_credits: bonusCredits
	});

	if (error) {
		console.error('community claim RPC error:', error);
		return json({ granted: false, error: 'server_error' }, { status: 500 });
	}

	const row = (Array.isArray(data) ? data[0] : data) as
		| { granted?: boolean; bonus_credits?: number }
		| undefined;

	if (!row?.granted) {
		return json({ granted: false, error: 'already_claimed' }, { status: 400 });
	}

	return json({
		granted: true,
		bonus_credits: typeof row.bonus_credits === 'number' ? row.bonus_credits : bonusCredits
	});
};
