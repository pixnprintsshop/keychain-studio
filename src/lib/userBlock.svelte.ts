/**
 * Account and device restriction state (`blocked_users`, `blocked_fingerprints`,
 * and the 2-account-per-fingerprint trial cap).
 */
import { getBrowserFingerprintHash } from '$lib/browserFingerprint';
import { supabase } from '$lib/supabase';

export type UserBlockKind = 'account' | 'fingerprint' | 'device_limit' | null;

let userId = $state<string | null>(null);
let blocked = $state(false);
let blockKind = $state<UserBlockKind>(null);
let reason = $state<string | null>(null);
let loaded = $state(false);
let showDialog = $state(false);

export const userBlock = {
	get loaded(): boolean {
		return loaded;
	},
	get blocked(): boolean {
		return blocked;
	},
	get blockKind(): UserBlockKind {
		return blockKind;
	},
	get reason(): string | null {
		return reason;
	},
	get showDialog(): boolean {
		return showDialog;
	}
};

export function requestAccountBlockedDialog(): void {
	if (blocked) showDialog = true;
}

export function closeAccountBlockedDialog(): void {
	showDialog = false;
}

export async function loadUserBlockForUser(uid: string | null): Promise<void> {
	if (uid === null) {
		userId = null;
		blocked = false;
		blockKind = null;
		reason = null;
		loaded = true;
		showDialog = false;
		return;
	}

	if (uid === userId && loaded) return;

	userId = uid;
	loaded = false;
	try {
		const fingerprintHash = await getBrowserFingerprintHash();
		const { data, error } = await supabase.rpc('get_user_block_status', {
			p_fingerprint_hash: fingerprintHash
		});
		if (error) throw error;
		const row = Array.isArray(data) ? data[0] : data;
		blocked = Boolean(row && typeof row === 'object' && 'blocked' in row && row.blocked);
		const kind = row && typeof row === 'object' && 'block_kind' in row ? row.block_kind : null;
		blockKind =
			kind === 'account' || kind === 'fingerprint' || kind === 'device_limit' ? kind : null;
		reason =
			row && typeof row === 'object' && 'reason' in row && typeof row.reason === 'string'
				? row.reason
				: null;
		if (blocked) showDialog = true;
	} catch (e) {
		console.error('[userBlock] failed to load:', e);
		blocked = false;
		blockKind = null;
		reason = null;
	} finally {
		loaded = true;
	}
}

/** Ensure block status is fresh before export checks. */
export async function ensureUserBlockLoaded(uid: string): Promise<void> {
	if (uid === userId && loaded) return;
	await loadUserBlockForUser(uid);
}
