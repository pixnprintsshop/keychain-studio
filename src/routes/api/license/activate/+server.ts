import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';

export const POST: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('Authorization');
	const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!token) {
		return json({ success: false, error: 'Sign in to activate a license' }, { status: 401 });
	}

	let body: { licenseKey?: string };
	try {
		body = await request.json();
	} catch {
		return json({ success: false, error: 'Invalid JSON' }, { status: 400 });
	}

	const licenseKey = typeof body?.licenseKey === 'string' ? body.licenseKey.trim() : '';
	if (!licenseKey) {
		return json({ success: false, error: 'License key is required' }, { status: 400 });
	}

	const supabaseUrl = env.VITE_SUPABASE_URL;
	const supabaseAnonKey = env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
	const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;

	if (!supabaseUrl || !supabaseAnonKey) {
		return json({ success: false, error: 'Auth not configured' }, { status: 500 });
	}

	const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);
	const {
		data: { user },
		error: authError
	} = await supabaseAnon.auth.getUser(token);
	if (authError || !user) {
		return json({ success: false, error: 'Invalid or expired session. Please sign in again.' }, { status: 401 });
	}

	if (!supabaseServiceKey) {
		console.error('SUPABASE_SERVICE_ROLE_KEY not set');
		return json({ success: false, error: 'License activation not configured' }, { status: 500 });
	}

	const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

	// Fetch license by key
	const { data: license, error: licenseError } = await supabaseAdmin
		.from('licenses')
		.select('id, is_active, expires_at, max_devices, tier')
		.eq('license_key', licenseKey)
		.maybeSingle();

	if (licenseError) {
		console.error('License lookup error:', licenseError);
		return json({ success: false, error: 'Failed to validate license' }, { status: 500 });
	}

	if (!license) {
		return json({ success: false, error: 'Invalid license key' }, { status: 400 });
	}

	if (!license.is_active) {
		return json({ success: false, error: 'This license is no longer active' }, { status: 400 });
	}

	if (license.tier !== 'paid') {
		return json({ success: false, error: 'This license does not grant export access' }, { status: 400 });
	}

	const now = new Date();
	if (license.expires_at && new Date(license.expires_at) <= now) {
		return json({ success: false, error: 'This license has expired' }, { status: 400 });
	}

	// Check if this license is already activated (one license = one user only)
	const { data: existingForLicense, error: existingError } = await supabaseAdmin
		.from('license_activations')
		.select('user_id')
		.eq('license_id', license.id)
		.maybeSingle();

	if (existingError) {
		console.error('Activation lookup error:', existingError);
		return json({ success: false, error: 'Failed to validate license' }, { status: 500 });
	}

	// Idempotent: user already has this license activated
	if (existingForLicense?.user_id === user.id) {
		return json({ success: true });
	}

	// License is already in use by another user
	if (existingForLicense) {
		return json(
			{ success: false, error: 'This license is already in use by another account' },
			{ status: 400 }
		);
	}

	// License is free; upsert (replace user's existing activation if they have one for a different license)
	const { error: upsertError } = await supabaseAdmin.from('license_activations').upsert(
		{
			user_id: user.id,
			license_id: license.id,
			activated_at: new Date().toISOString()
		},
		{ onConflict: 'user_id' }
	);

	if (upsertError) {
		console.error('License activation error:', upsertError);
		return json({ success: false, error: 'Failed to activate license' }, { status: 500 });
	}

	return json({ success: true });
};
