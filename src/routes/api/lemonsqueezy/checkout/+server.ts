import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { getPostHogClient } from '$lib/server/posthog';

const LEMONSQUEEZY_API = 'https://api.lemonsqueezy.com/v1/checkouts';

export const POST: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('Authorization');
	const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!token) {
		return json({ error: 'Sign in to subscribe' }, { status: 401 });
	}

	let body: { plan?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const plan = body?.plan;
	if (plan !== 'monthly' && plan !== 'yearly') {
		return json({ error: 'Invalid plan. Use "monthly" or "yearly".' }, { status: 400 });
	}

	const storeId = env.LEMONSQUEEZY_STORE_ID;
	const apiKey = env.LEMONSQUEEZY_API_KEY;
	const variantMonthlyId = env.LEMONSQUEEZY_VARIANT_MONTHLY_ID;
	const variantYearlyId = env.LEMONSQUEEZY_VARIANT_YEARLY_ID;

	if (!storeId || !apiKey || !variantMonthlyId || !variantYearlyId) {
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

	const variantId = plan === 'monthly' ? variantMonthlyId : variantYearlyId;
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
				checkout_data: {
					custom: {
						user_id: user.id
					}
				}
			},
			relationships: {
				store: { data: { type: 'stores', id: storeId } },
				variant: { data: { type: 'variants', id: variantId } }
			}
		}
	};

	const res = await fetch(LEMONSQUEEZY_API, {
		method: 'POST',
		headers: {
			Accept: 'application/vnd.api+json',
			'Content-Type': 'application/vnd.api+json',
			Authorization: `Bearer ${apiKey}`
		},
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

	const posthog = getPostHogClient();
	posthog.capture({
		distinctId: user.id,
		event: 'checkout_session_created',
		properties: { plan, $set: { email: user.email } }
	});
	await posthog.flush();

	return json({ url });
};
