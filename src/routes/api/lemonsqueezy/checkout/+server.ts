import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { captureServerEvent, flushServerAnalytics } from '$lib/server/analytics';
import { getLemonSqueezyEnv, lemonSqueezyFetch, variantIdForPlan } from '$lib/server/lemonsqueezy';

export const POST: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('Authorization');
	const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!token) {
		return json({ error: 'Sign in to subscribe' }, { status: 401 });
	}

	let body: { plan?: string; skipTrial?: boolean };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const plan = body?.plan;
	if (plan !== 'monthly' && plan !== 'yearly') {
		return json({ error: 'Invalid plan. Use "monthly" or "yearly".' }, { status: 400 });
	}

	const ls = getLemonSqueezyEnv();
	if (!ls) {
		console.error('Missing Lemon Squeezy env vars');
		return json({ error: 'Checkout not configured' }, { status: 500 });
	}

	const supabaseUrl = env.VITE_SUPABASE_URL;
	const supabaseAnonKey = env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
	if (!supabaseUrl || !supabaseAnonKey) {
		return json({ error: 'Auth not configured' }, { status: 500 });
	}

	const supabase = createClient(supabaseUrl, supabaseAnonKey);
	const {
		data: { user },
		error: authError
	} = await supabase.auth.getUser(token);
	if (authError || !user) {
		return json({ error: 'Invalid or expired session. Please sign in again.' }, { status: 401 });
	}

	const variantId = variantIdForPlan(ls, plan);
	const origin =
		request.headers.get('origin') || request.url.replace(/\/api\/lemonsqueezy\/checkout.*$/, '');
	const redirectUrl = `${origin}/?subscription=success`;

	const payload = {
		data: {
			type: 'checkouts',
			attributes: {
				product_options: {
					redirect_url: redirectUrl
				},
				...(body.skipTrial === true ? { checkout_options: { skip_trial: true } } : {}),
				checkout_data: {
					custom: {
						user_id: user.id
					}
				}
			},
			relationships: {
				store: { data: { type: 'stores', id: ls.storeId } },
				variant: { data: { type: 'variants', id: variantId } }
			}
		}
	};

	const res = await lemonSqueezyFetch(ls.apiKey, '/checkouts', {
		method: 'POST',
		body: JSON.stringify(payload)
	});

	if (!res.ok) {
		const errText = await res.text();
		console.error('Lemon Squeezy checkout error:', res.status, errText);
		return json({ error: 'Failed to create checkout' }, { status: 502 });
	}

	const data = (await res.json()) as { data?: { attributes?: { url?: string } } };
	const url = data?.data?.attributes?.url;
	if (!url) {
		return json({ error: 'No checkout URL returned' }, { status: 502 });
	}

	captureServerEvent(user.id, 'checkout_session_created', {
		plan,
		$set: { email: user.email }
	});
	await flushServerAnalytics();

	return json({ url });
};
