#!/usr/bin/env node
/**
 * Block or unblock a user from using the service (admin / service role).
 * By default also blocks all browser fingerprints linked to that user.
 *
 * Usage:
 *   pnpm block-user ode4935@gmail.com
 *   pnpm block-user ode4935@gmail.com --reason "Multiple free trial accounts"
 *   pnpm block-user ode4935@gmail.com --unblock
 *   pnpm block-user ode4935@gmail.com --no-block-fingerprints
 *
 * Requires in `.env`:
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/load-env.mjs';

loadEnv();

function usage() {
	console.error(
		`Usage: pnpm block-user <email> [--reason "text"] [--blocked-by "admin"] [--unblock] [--no-block-fingerprints]`
	);
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

async function blockUserFingerprints(admin, userId, reason, blockedBy) {
	const { data: links, error } = await admin
		.from('trial_fingerprint_users')
		.select('fingerprint_hash')
		.eq('user_id', userId);
	if (error) throw new Error(`Fingerprint lookup failed: ${error.message}`);

	const hashes = [...new Set((links ?? []).map((r) => r.fingerprint_hash).filter(Boolean))];
	if (hashes.length === 0) {
		console.log('No linked fingerprints to block.');
		return;
	}

	const rows = hashes.map((fingerprint_hash) => ({
		fingerprint_hash,
		reason: reason ?? 'Blocked with linked account for trial abuse.',
		blocked_at: new Date().toISOString(),
		blocked_by: blockedBy
	}));

	const { error: upsertError } = await admin
		.from('blocked_fingerprints')
		.upsert(rows, { onConflict: 'fingerprint_hash' });
	if (upsertError) throw new Error(`Fingerprint block failed: ${upsertError.message}`);

	console.log(`Blocked ${hashes.length} fingerprint(s):`);
	for (const hash of hashes) console.log(`  ${hash}`);
}

async function unblockUserFingerprints(admin, userId) {
	const { data: links, error } = await admin
		.from('trial_fingerprint_users')
		.select('fingerprint_hash')
		.eq('user_id', userId);
	if (error) throw new Error(`Fingerprint lookup failed: ${error.message}`);

	const hashes = [...new Set((links ?? []).map((r) => r.fingerprint_hash).filter(Boolean))];
	if (hashes.length === 0) return;

	const { error: deleteError } = await admin
		.from('blocked_fingerprints')
		.delete()
		.in('fingerprint_hash', hashes);
	if (deleteError) throw new Error(`Fingerprint unblock failed: ${deleteError.message}`);

	console.log(`Unblocked ${hashes.length} linked fingerprint(s).`);
}

function normalizeEmailArg(raw) {
	return String(raw ?? '')
		.trim()
		.replace(/\\@/g, '@');
}

function parseArgs(argv) {
	const args = argv.slice(2).filter((a) => a !== '--');
	const unblock = args.includes('--unblock');
	const blockFingerprints = !args.includes('--no-block-fingerprints');
	const reasonIdx = args.indexOf('--reason');
	const blockedByIdx = args.indexOf('--blocked-by');
	const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : null;
	const blockedBy = blockedByIdx >= 0 ? args[blockedByIdx + 1] : 'admin';
	const positional = args.filter((a, i) => {
		if (a.startsWith('--')) return false;
		if (reasonIdx >= 0 && i === reasonIdx + 1) return false;
		if (blockedByIdx >= 0 && i === blockedByIdx + 1) return false;
		return true;
	});
	return { email: normalizeEmailArg(positional[0]), reason, blockedBy, unblock, blockFingerprints };
}

async function main() {
	const { email, reason, blockedBy, unblock, blockFingerprints } = parseArgs(process.argv);
	if (!email) usage();

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

	const defaultReason =
		reason ??
		'Restricted for violating terms of service, including use of multiple free trial accounts.';

	if (unblock) {
		const { error } = await admin.from('blocked_users').delete().eq('user_id', user.id);
		if (error) {
			console.error('Unblock failed:', error.message);
			process.exit(1);
		}
		console.log(`Unblocked ${user.email} (${user.id})`);
		if (blockFingerprints) await unblockUserFingerprints(admin, user.id);
		return;
	}

	const { error } = await admin.from('blocked_users').upsert(
		{
			user_id: user.id,
			email: user.email ?? email,
			reason: defaultReason,
			blocked_at: new Date().toISOString(),
			blocked_by: blockedBy
		},
		{ onConflict: 'user_id' }
	);
	if (error) {
		console.error('Block failed:', error.message);
		process.exit(1);
	}
	console.log(`Blocked ${user.email} (${user.id})`);
	if (reason) console.log(`Reason: ${reason}`);

	if (blockFingerprints) {
		await blockUserFingerprints(admin, user.id, defaultReason, blockedBy);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
