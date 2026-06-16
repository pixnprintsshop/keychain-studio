#!/usr/bin/env node
/**
 * Grant or revoke a per-user feature flag (admin / service role).
 *
 * Usage:
 *   pnpm grant-feature user@example.com idNameTagV2_backprint
 *   pnpm grant-feature user@example.com idNameTagV2_backprint --revoke
 *   pnpm grant-feature user@example.com idNameTagV2_backprint --note "beta tester"
 *
 * Requires in `.env`:
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/load-env.mjs';

loadEnv();

function usage() {
	console.error(`Usage: pnpm grant-feature <email> <feature_key> [--revoke] [--note "text"]`);
	process.exit(1);
}

async function findUserByEmail(admin, email) {
	const target = email.trim().toLowerCase();
	let page = 1;
	while (page <= 50) {
		const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
		if (error) throw new Error(`Auth listUsers failed: ${error.message}`);
		const user = data.users.find((u) => u.email?.toLowerCase() === target);
		if (user) return user;
		if (data.users.length < 1000) break;
		page += 1;
	}
	return null;
}

function normalizeEmailArg(raw) {
	return String(raw ?? '')
		.trim()
		.replace(/\\@/g, '@');
}

function parseArgs(argv) {
	const args = argv.slice(2).filter((a) => a !== '--');
	const revoke = args.includes('--revoke');
	const noteIdx = args.indexOf('--note');
	const note = noteIdx >= 0 ? args[noteIdx + 1] : null;
	const positional = args.filter((a, i) => {
		if (a.startsWith('--')) return false;
		if (noteIdx >= 0 && i === noteIdx + 1) return false;
		return true;
	});
	return {
		email: normalizeEmailArg(positional[0]),
		featureKey: positional[1],
		revoke,
		note
	};
}

async function main() {
	const { email, featureKey, revoke, note } = parseArgs(process.argv);

	if (!email || !featureKey) usage();

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

	if (revoke) {
		const { error } = await admin
			.from('user_feature_flags')
			.delete()
			.eq('user_id', user.id)
			.eq('feature_key', featureKey);
		if (error) {
			console.error('Revoke failed:', error.message);
			process.exit(1);
		}
		console.log(`Revoked ${featureKey} for ${user.email} (${user.id})`);
		return;
	}

	const { error } = await admin.from('user_feature_flags').upsert(
		{
			user_id: user.id,
			feature_key: featureKey,
			enabled: true,
			note: note ?? null,
			granted_at: new Date().toISOString()
		},
		{ onConflict: 'user_id,feature_key' }
	);
	if (error) {
		console.error('Grant failed:', error.message);
		process.exit(1);
	}
	console.log(`Granted ${featureKey} for ${user.email} (${user.id})`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
