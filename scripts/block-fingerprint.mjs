#!/usr/bin/env node
/**
 * Block or unblock a browser fingerprint hash (admin / service role).
 *
 * Usage:
 *   pnpm block-fingerprint <hash>
 *   pnpm block-fingerprint <hash> --reason "Trial abuse"
 *   pnpm block-fingerprint <hash> --unblock
 *
 * Tip: list hashes for a user with `pnpm check-user user@example.com`
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/load-env.mjs';

loadEnv();

function usage() {
	console.error(`Usage: pnpm block-fingerprint <hash> [--reason "text"] [--blocked-by "admin"] [--unblock]`);
	process.exit(1);
}

function parseArgs(argv) {
	const args = argv.slice(2).filter((a) => a !== '--');
	const unblock = args.includes('--unblock');
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
	return { hash: positional[0]?.trim().toLowerCase(), reason, blockedBy, unblock };
}

async function main() {
	const { hash, reason, blockedBy, unblock } = parseArgs(process.argv);
	if (!hash || hash.length < 32) usage();

	const supabaseUrl = process.env.VITE_SUPABASE_URL;
	const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!supabaseUrl || !serviceKey) {
		console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
		process.exit(1);
	}

	const admin = createClient(supabaseUrl, serviceKey, {
		auth: { autoRefreshToken: false, persistSession: false }
	});

	if (unblock) {
		const { error } = await admin.from('blocked_fingerprints').delete().eq('fingerprint_hash', hash);
		if (error) {
			console.error('Unblock failed:', error.message);
			process.exit(1);
		}
		console.log(`Unblocked fingerprint ${hash}`);
		return;
	}

	const { error } = await admin.from('blocked_fingerprints').upsert(
		{
			fingerprint_hash: hash,
			reason:
				reason ??
				'Restricted for violating terms of service, including use of multiple free trial accounts.',
			blocked_at: new Date().toISOString(),
			blocked_by: blockedBy
		},
		{ onConflict: 'fingerprint_hash' }
	);
	if (error) {
		console.error('Block failed:', error.message);
		process.exit(1);
	}
	console.log(`Blocked fingerprint ${hash}`);
	if (reason) console.log(`Reason: ${reason}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
