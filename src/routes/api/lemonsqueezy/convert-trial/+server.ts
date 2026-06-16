import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { captureServerEvent, flushServerAnalytics } from '$lib/server/analytics';
import {
	getLemonSqueezyEnv,
	lemonSqueezyFetch,
	portalUrlFromSubscription,
	variantIdForPlan
} from '$lib/server/lemonsqueezy';

export const POST: RequestHandler = async ({ request }) => {
	const authHeader = request.headers.get('Authorization');
	const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!token) {
		return json({ error: 'Sign in to upgrade' }, { status: 401 });
	}

	let body: { plan?: string };
	try {
		body = await request.json();
	} catch {
		body = {};
	}

	const plan = body?.plan;
	if (plan != null && plan !== 'monthly' && plan !== 'yearly') {
		return json({ error: 'Invalid plan. Use "monthly" or "yearly".' }, { status: 400 });
	}

	const ls = getLemonSqueezyEnv();
	if (!ls) {
		console.error('Missing Lemon Squeezy env vars');
		return json({ error: 'Billing not configured' }, { status: 500 });
	}

	const supabaseUrl = env.VITE_SUPABASE_URL;
	const supabaseAnonKey = env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
	const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!supabaseUrl || !supabaseAnonKey) {
		return json({ error: 'Auth not configured' }, { status: 500 });
	}
	if (!supabaseServiceKey) {
		console.error('SUPABASE_SERVICE_ROLE_KEY not set');
		return json({ error: 'Billing not configured' }, { status: 500 });
	}

	const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);
	const {
		data: { user },
		error: authError
	} = await supabaseAnon.auth.getUser(token);
	if (authError || !user) {
		return json({ error: 'Invalid or expired session. Please sign in again.' }, { status: 401 });
	}

	const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
	const { data: subRow, error: subError } = await supabaseAdmin
		.from('subscriptions')
		.select('status, plan, lemonsqueezy_subscription_id')
		.eq('user_id', user.id)
		.maybeSingle();

	if (subError) {
		console.error('Subscription lookup error:', subError);
		return json({ error: 'Could not load subscription' }, { status: 500 });
	}

	if (!subRow?.lemonsqueezy_subscription_id) {
		return json({ error: 'No subscription found. Start a trial from the pricing page.' }, { status: 400 });
	}

	const status = String(subRow.status ?? '').toLowerCase();
	if (status !== 'on_trial') {
		return json(
			{ error: status === 'active' ? 'You already have a paid subscription.' : 'Subscription is not on trial.' },
			{ status: 400 }
		);
	}

	const subscriptionId = String(subRow.lemonsqueezy_subscription_id);
	const attributes: Record<string, unknown> = {
		billing_anchor: 0,
		invoice_immediately: true
	};

	if (plan) {
		const targetVariantId = variantIdForPlan(ls, plan);
		const currentPlan = subRow.plan as string | null;
		if (currentPlan !== plan) {
			attributes.variant_id = Number.parseInt(targetVariantId, 10);
		}
	}

	const res = await lemonSqueezyFetch(ls.apiKey, `/subscriptions/${subscriptionId}`, {
		method: 'PATCH',
		body: JSON.stringify({
			data: {
				type: 'subscriptions',
				id: subscriptionId,
				attributes
			}
		})
	});

	const responseText = await res.text();
	let responseJson: { data?: { attributes?: { status?: string; urls?: Record<string, string> } } };
	try {
		responseJson = JSON.parse(responseText) as typeof responseJson;
	} catch {
		responseJson = {};
	}

	if (!res.ok) {
		const portalUrl = portalUrlFromSubscription(responseJson);
		if (portalUrl) {
			return json({
				requiresPortal: true,
				url: portalUrl,
				message: 'Complete your upgrade in the Lemon Squeezy customer portal.'
			});
		}
		console.error('Lemon Squeezy convert-trial error:', res.status, responseText);
		return json({ error: 'Failed to end trial and start billing' }, { status: 502 });
	}

	const portalUrl = portalUrlFromSubscription(responseJson);
	if (portalUrl) {
		return json({
			requiresPortal: true,
			url: portalUrl,
			message: 'Complete your upgrade in the Lemon Squeezy customer portal.'
		});
	}

	const newStatus = responseJson?.data?.attributes?.status ?? 'active';

	// Sync immediately so the app unlocks exports without waiting for the webhook.
	const { error: upsertError } = await supabaseAdmin.from('subscriptions').upsert(
		{
			user_id: user.id,
			lemonsqueezy_subscription_id: subscriptionId,
			status: newStatus,
			plan: plan ?? subRow.plan ?? 'monthly',
			updated_at: new Date().toISOString()
		},
		{ onConflict: 'user_id' }
	);
	if (upsertError) {
		console.warn('Subscription row sync after convert-trial:', upsertError.message);
	}

	captureServerEvent(user.id, 'subscription_trial_converted', {
		plan: plan ?? subRow.plan ?? 'monthly',
		previous_status: status,
		new_status: newStatus,
		$set: { email: user.email }
	});
	await flushServerAnalytics();

	return json({
		success: true,
		status: newStatus
	});
};
