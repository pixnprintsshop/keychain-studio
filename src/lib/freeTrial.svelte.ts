/**
 * Reactive free-trial state, backed by Supabase.
 *
 * Every signed-in user gets `FREE_TRIAL_INITIAL_CREDITS` trial-mode exports
 * before the paywall kicks in. Usage is persisted server-side in the
 * `trial_usage` table and the cap is enforced atomically in the
 * `consume_trial_credit` RPC, so the limit cannot be bypassed by clearing
 * localStorage. Guest users have no trial — they must sign in first.
 *
 * Browser fingerprinting limits each device to 2 distinct trial accounts (emails).
 */

import { getBrowserFingerprintHash } from './browserFingerprint';
import { getSession } from './auth';
import { COMMUNITY_JOIN_BONUS_CREDITS } from './messengerCommunity';
import { supabase } from './supabase';

const DEFAULT_FREE_TRIAL_CREDITS = 10;

export const TRIAL_MAX_ACCOUNTS_PER_FINGERPRINT = 2;

/**
 * How many free downloads each signed-in user gets before the paywall.
 * Configurable via the `VITE_FREE_TRIAL_CREDITS` env var (positive integer).
 * Falls back to {@link DEFAULT_FREE_TRIAL_CREDITS} when unset/invalid.
 *
 * The value is also passed as `p_base` / `p_max` to the server-side RPCs;
 * effective cap = base + per-user `bonus_credits`.
 */
export const FREE_TRIAL_INITIAL_CREDITS: number = (() => {
	const raw = import.meta.env.VITE_FREE_TRIAL_CREDITS as string | undefined;
	if (raw == null || raw === '') return DEFAULT_FREE_TRIAL_CREDITS;
	const parsed = parseInt(String(raw), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FREE_TRIAL_CREDITS;
})();

/** Share promo: credits granted manually after user posts and messages support. */
export const SHARE_PROMO_BONUS_CREDITS = 20;

export { COMMUNITY_JOIN_BONUS_CREDITS } from './messengerCommunity';

let userId = $state<string | null>(null);
let used = $state<number>(0);
let bonusCredits = $state<number>(0);
let communityBonusClaimed = $state<boolean>(false);
let effectiveMax = $state<number>(FREE_TRIAL_INITIAL_CREDITS);
let fingerprintAllowed = $state(true);
let fingerprintLinkedAccounts = $state(0);
let fingerprintMaxAccounts = $state(TRIAL_MAX_ACCOUNTS_PER_FINGERPRINT);
let loaded = $state(false);

/**
 * Reactive snapshot of the free-trial state. Reads from this object inside a
 * reactive context (template, `$derived`, `$effect`) automatically track the
 * underlying `$state` cells.
 */
export const freeTrial = {
	get credits(): number {
		if (!loaded || !fingerprintAllowed) return 0;
		return Math.max(0, effectiveMax - used);
	},
	get hasCredits(): boolean {
		return this.credits > 0;
	},
	get totalCredits(): number {
		return loaded ? effectiveMax : FREE_TRIAL_INITIAL_CREDITS;
	},
	get baseCredits(): number {
		return FREE_TRIAL_INITIAL_CREDITS;
	},
	get bonusCredits(): number {
		return bonusCredits;
	},
	get communityBonusClaimed(): boolean {
		return communityBonusClaimed;
	},
	get loaded(): boolean {
		return loaded;
	},
	get isSignedIn(): boolean {
		return userId !== null;
	},
	get fingerprintAllowed(): boolean {
		return fingerprintAllowed;
	},
	get fingerprintBlocked(): boolean {
		return loaded && !fingerprintAllowed;
	},
	get fingerprintLinkedAccounts(): number {
		return fingerprintLinkedAccounts;
	},
	get fingerprintMaxAccounts(): number {
		return fingerprintMaxAccounts;
	}
};

function applyFingerprintFields(row: Record<string, unknown> | undefined) {
	fingerprintAllowed = row?.fingerprint_allowed !== false;
	fingerprintLinkedAccounts =
		typeof row?.fingerprint_linked_accounts === 'number'
			? Math.max(0, row.fingerprint_linked_accounts)
			: 0;
	fingerprintMaxAccounts =
		typeof row?.fingerprint_max_accounts === 'number'
			? Math.max(1, row.fingerprint_max_accounts)
			: TRIAL_MAX_ACCOUNTS_PER_FINGERPRINT;
}

/**
 * Synchronise the trial state with the currently signed-in user.
 * Pass `null` (e.g. on sign-out) to clear local state. Safe to call on every
 * auth change; the RPC is small and side-effect free.
 */
export async function loadFreeTrialForUser(
	uid: string | null,
	options?: { force?: boolean }
): Promise<void> {
	if (uid === userId && loaded && !options?.force) return;

	if (uid === null) {
		userId = null;
		used = 0;
		bonusCredits = 0;
		communityBonusClaimed = false;
		effectiveMax = FREE_TRIAL_INITIAL_CREDITS;
		fingerprintAllowed = true;
		fingerprintLinkedAccounts = 0;
		fingerprintMaxAccounts = TRIAL_MAX_ACCOUNTS_PER_FINGERPRINT;
		loaded = false;
		return;
	}
	userId = uid;
	loaded = false;
	try {
		const fingerprintHash = await getBrowserFingerprintHash();
		const { data, error } = await supabase.rpc('get_trial_credit_status', {
			p_base: FREE_TRIAL_INITIAL_CREDITS,
			p_fingerprint_hash: fingerprintHash
		});
		if (error) {
			// Rollout: fall back until migration is applied.
			const legacy = await supabase.rpc('get_trial_usage');
			if (legacy.error) throw error;
			used = typeof legacy.data === 'number' ? Math.max(0, legacy.data) : 0;
			bonusCredits = 0;
			communityBonusClaimed = false;
			effectiveMax = FREE_TRIAL_INITIAL_CREDITS;
			fingerprintAllowed = true;
			fingerprintLinkedAccounts = 0;
		} else {
			const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
			used = typeof row?.used === 'number' ? Math.max(0, row.used) : 0;
			bonusCredits = typeof row?.bonus_credits === 'number' ? Math.max(0, row.bonus_credits) : 0;
			communityBonusClaimed = row?.community_bonus_claimed === true;
			effectiveMax =
				typeof row?.effective_max === 'number'
					? Math.max(FREE_TRIAL_INITIAL_CREDITS, row.effective_max)
					: FREE_TRIAL_INITIAL_CREDITS + bonusCredits;
			applyFingerprintFields(row);
		}
	} catch (e) {
		console.error('[freeTrial] failed to load trial usage:', e);
		used = FREE_TRIAL_INITIAL_CREDITS;
		bonusCredits = 0;
		communityBonusClaimed = false;
		effectiveMax = FREE_TRIAL_INITIAL_CREDITS;
		fingerprintAllowed = true;
	} finally {
		loaded = true;
	}
}

export interface CommunityBonusClaimResult {
	granted: boolean;
	bonusCredits: number;
	error?:
		| 'invalid_code'
		| 'already_claimed'
		| 'not_signed_in'
		| 'code_required'
		| 'not_configured'
		| 'server_error'
		| 'unknown';
}

/**
 * Redeem the pinned Messenger community code for a one-time download credit bonus.
 */
export async function claimCommunityJoinBonus(code: string): Promise<CommunityBonusClaimResult> {
	if (!userId) return { granted: false, bonusCredits: 0, error: 'not_signed_in' };

	const trimmed = code.trim();
	if (!trimmed) return { granted: false, bonusCredits: 0, error: 'code_required' };

	try {
		const session = await getSession();
		if (!session?.access_token) {
			return { granted: false, bonusCredits: 0, error: 'not_signed_in' };
		}

		const res = await fetch('/api/community/claim', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${session.access_token}`
			},
			body: JSON.stringify({ code: trimmed })
		});

		const data = (await res.json()) as {
			granted?: boolean;
			bonus_credits?: number;
			error?: CommunityBonusClaimResult['error'];
		};

		if (data.granted) {
			await loadFreeTrialForUser(userId, { force: true });
			return { granted: true, bonusCredits: freeTrial.bonusCredits };
		}

		const error = data.error ?? (res.ok ? 'unknown' : 'server_error');
		return { granted: false, bonusCredits: freeTrial.bonusCredits, error };
	} catch (e) {
		console.error('[freeTrial] failed to claim community bonus:', e);
		return { granted: false, bonusCredits: freeTrial.bonusCredits, error: 'unknown' };
	}
}

export interface ConsumeResult {
	allowed: boolean;
	remaining: number;
	fingerprintAllowed: boolean;
}

/**
 * Atomically attempt to consume one trial credit on the server. Updates local
 * reactive state with the authoritative response, so the UI reflects the new
 * count immediately. Returns `{ allowed: false }` for guests or transient errors.
 */
export async function tryConsumeFreeTrialCredit(): Promise<ConsumeResult> {
	if (!userId) return { allowed: false, remaining: 0, fingerprintAllowed: false };
	if (!fingerprintAllowed) {
		return { allowed: false, remaining: 0, fingerprintAllowed: false };
	}
	try {
		const fingerprintHash = await getBrowserFingerprintHash();
		const { data, error } = await supabase.rpc('consume_trial_credit', {
			p_max: FREE_TRIAL_INITIAL_CREDITS,
			p_fingerprint_hash: fingerprintHash
		});
		if (error) throw error;
		const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
		const fpAllowed = row?.fingerprint_allowed !== false;
		fingerprintAllowed = fpAllowed;
		const allowed = fpAllowed && Boolean(row?.allowed);
		const remaining = typeof row?.remaining === 'number' ? row.remaining : 0;
		used = Math.max(0, effectiveMax - remaining);
		loaded = true;
		return { allowed, remaining, fingerprintAllowed: fpAllowed };
	} catch (e) {
		console.error('[freeTrial] failed to consume trial credit:', e);
		return { allowed: false, remaining: freeTrial.credits, fingerprintAllowed };
	}
}

export function getFingerprintBlockedMessage(): string {
	return `This device already has ${fingerprintMaxAccounts} free trial accounts. Sign in with an account that was used here before, or subscribe for unlimited exports.`;
}
