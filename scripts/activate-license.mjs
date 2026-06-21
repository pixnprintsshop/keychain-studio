#!/usr/bin/env node
/**
 * Activate a license code for a user by email (admin / service role).
 * If the user has an active Lemon Squeezy subscription trial, cancels it first
 * so license access takes effect.
 *
 * Usage:
 *   pnpm activate-license user@example.com LICENSE-KEY-HERE
 *   pnpm activate-license user@example.com LICENSE-KEY-HERE --skip-subscription
 *
 * Requires in `.env`:
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional (recommended when ending LS trials):
 *   LEMONSQUEEZY_API_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { findUserByEmail, normalizeEmailArg } from './lib/find-user-by-email.mjs';
import { cancelLemonSqueezySubscription, getLemonSqueezyApiKey } from './lib/lemonsqueezy-admin.mjs';
import { loadEnv } from './lib/load-env.mjs';
import { subscriptionRowGrantsAccess } from './lib/subscription-access.mjs';

loadEnv();

function usage() {
	console.error(`Usage: pnpm activate-license <email> <license_code> [--skip-subscription]

Activates a paid license for the user. Ends Lemon Squeezy on_trial (and other
active subscriptions that block license access) unless --skip-subscription is set.`);
	process.exit(1);
}

function parseArgs(argv) {
	const args = argv.slice(2).filter((a) => a !== '--');
	const skipSubscription = args.includes('--skip-subscription');
	const positional = args.filter((a) => !a.startsWith('--'));
	return {
		email: normalizeEmailArg(positional[0]),
		licenseCode: positional[1]?.trim() ?? '',
		skipSubscription
	};
}

async function fetchSubscription(admin, userId) {
	const { data, error } = await admin
		.from('subscriptions')
		.select('status, plan, ends_at, renews_at, lemonsqueezy_subscription_id')
		.eq('user_id', userId)
		.maybeSingle();
	if (error) throw new Error(`subscriptions lookup failed: ${error.message}`);
	return data;
}

/**
 * End subscription so getSubscriptionStatus falls through to license RPC.
 * Cancels in Lemon Squeezy when an ID is present, then marks row expired locally.
 */
async function endSubscriptionForLicense(admin, userId, subRow) {
	if (!subRow) return { ended: false, reason: 'no_subscription_row' };

	const status = String(subRow.status ?? '').toLowerCase();
	if (!subscriptionRowGrantsAccess(subRow.status, subRow.ends_at)) {
		return { ended: false, reason: 'subscription_not_granting_access', status };
	}

	const lsId = subRow.lemonsqueezy_subscription_id
		? String(subRow.lemonsqueezy_subscription_id)
		: null;

	if (lsId && getLemonSqueezyApiKey()) {
		await cancelLemonSqueezySubscription(lsId);
	} else if (lsId) {
		console.warn(
			'Warning: LEMONSQUEEZY_API_KEY not set — updating Supabase only (LS subscription may still exist).'
		);
	}

	const now = new Date().toISOString();
	const { error } = await admin.from('subscriptions').upsert(
		{
			user_id: userId,
			lemonsqueezy_subscription_id: lsId,
			status: 'expired',
			plan: subRow.plan ?? null,
			ends_at: now,
			renews_at: null,
			updated_at: now
		},
		{ onConflict: 'user_id' }
	);
	if (error) throw new Error(`Failed to expire subscription row: ${error.message}`);

	return { ended: true, previousStatus: status, lemonsqueezyCancelled: Boolean(lsId && getLemonSqueezyApiKey()) };
}

async function activateLicense(admin, userId, licenseCode) {
	const { data: license, error: licenseError } = await admin
		.from('licenses')
		.select('id, is_active, expires_at, tier, license_key')
		.eq('license_key', licenseCode)
		.maybeSingle();

	if (licenseError) throw new Error(`License lookup failed: ${licenseError.message}`);
	if (!license) throw new Error('Invalid license key');
	if (!license.is_active) throw new Error('License is not active');
	if (license.tier !== 'paid') throw new Error('License tier does not grant export access');

	const now = new Date();
	if (license.expires_at && new Date(license.expires_at) <= now) {
		throw new Error('License has expired');
	}

	const { data: existingForLicense, error: existingError } = await admin
		.from('license_activations')
		.select('user_id')
		.eq('license_id', license.id)
		.maybeSingle();

	if (existingError) throw new Error(`Activation lookup failed: ${existingError.message}`);

	if (existingForLicense?.user_id === userId) {
		return { activated: true, alreadyActive: true, licenseId: license.id };
	}

	if (existingForLicense && existingForLicense.user_id !== userId) {
		throw new Error('License is already in use by another account');
	}

	const { error: upsertError } = await admin.from('license_activations').upsert(
		{
			user_id: userId,
			license_id: license.id,
			activated_at: new Date().toISOString()
		},
		{ onConflict: 'user_id' }
	);

	if (upsertError) throw new Error(`License activation failed: ${upsertError.message}`);

	return { activated: true, alreadyActive: false, licenseId: license.id };
}

async function main() {
	const { email, licenseCode, skipSubscription } = parseArgs(process.argv);
	if (!email || !licenseCode) usage();

	const supabaseUrl = process.env.VITE_SUPABASE_URL;
	const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!supabaseUrl || !serviceKey) {
		console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
		process.exit(1);
	}

	const admin = createClient(supabaseUrl, serviceKey, {
		auth: { autoRefreshToken: false, persistSession: false }
	});

	const user = await findUserByEmail(admin, email);
	if (!user) {
		console.error(`No user found for ${email}`);
		process.exit(2);
	}

	console.log(`User: ${user.email} (${user.id})`);

	const subRow = await fetchSubscription(admin, user.id);
	if (subRow) {
		console.log(`Subscription: status=${subRow.status}, plan=${subRow.plan ?? '—'}`);
	}

	let subscriptionResult = { ended: false, reason: 'skipped' };
	if (!skipSubscription && subRow && subscriptionRowGrantsAccess(subRow.status, subRow.ends_at)) {
		const status = String(subRow.status ?? '').toLowerCase();
		if (status === 'on_trial') {
			console.log('Ending Lemon Squeezy trial before license activation…');
		} else {
			console.log(`Ending active subscription (${status}) so license access applies…`);
		}
		subscriptionResult = await endSubscriptionForLicense(admin, user.id, subRow);
		if (subscriptionResult.ended) {
			console.log(
				`Subscription ended (was ${subscriptionResult.previousStatus})${
					subscriptionResult.lemonsqueezyCancelled ? ', cancelled in Lemon Squeezy' : ''
				}.`
			);
		}
	} else if (skipSubscription) {
		console.log('Skipping subscription changes (--skip-subscription).');
	}

	const result = await activateLicense(admin, user.id, licenseCode);
	if (result.alreadyActive) {
		console.log(`License already active for this user (license_id=${result.licenseId}).`);
	} else {
		console.log(`License activated (license_id=${result.licenseId}).`);
	}

	const { data: hasAccess } = await admin.rpc('get_user_export_access', { p_user_id: user.id });
	console.log(`get_user_export_access: ${hasAccess === true ? 'yes' : 'no'}`);

	if (!skipSubscription && subRow && subscriptionRowGrantsAccess(subRow.status, subRow.ends_at) && !subscriptionResult.ended) {
		console.warn(
			'Warning: subscription may still block license in the app until it is expired. Re-run without --skip-subscription.'
		);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
