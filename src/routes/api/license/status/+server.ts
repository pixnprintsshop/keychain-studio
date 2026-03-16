import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';

/** GET /api/license/status - Returns license details for the authenticated user. */
export const GET: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('Authorization');
	const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!token) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const supabaseUrl = env.VITE_SUPABASE_URL;
	const supabaseAnonKey = env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
	const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;

	if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
		return json({ error: 'Not configured' }, { status: 500 });
	}

	const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);
	const {
		data: { user },
		error: authError
	} = await supabaseAnon.auth.getUser(token);
	if (authError || !user) {
		return json({ error: 'Invalid session' }, { status: 401 });
	}

	const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

	const { data: activation, error: activationError } = await supabaseAdmin
		.from('license_activations')
		.select('license_id, activated_at')
		.eq('user_id', user.id)
		.maybeSingle();

	if (activationError || !activation) {
		return json({ activated: false });
	}

	const { data: license, error: licenseError } = await supabaseAdmin
		.from('licenses')
		.select('created_at, expires_at')
		.eq('id', activation.license_id)
		.maybeSingle();

	if (licenseError || !license) {
		return json({ activated: false });
	}

	return json({
		activated: true,
		activated_at: activation.activated_at,
		expires_at: license.expires_at,
		created_at: license.created_at
	});
};
