/**
 * Reactive free-trial state, backed by Supabase.
 *
 * Every signed-in user gets `FREE_TRIAL_INITIAL_CREDITS` trial-mode exports
 * before the paywall kicks in. Usage is persisted server-side in the
 * `trial_usage` table and the cap is enforced atomically in the
 * `consume_trial_credit` RPC, so the limit cannot be bypassed by clearing
 * localStorage. Guest users have no trial — they must sign in first.
 *
 * Support can add `bonus_credits` on a user's row (e.g. share promo) — the
 * server includes those in the effective cap.
 */

import { supabase } from './supabase';

const DEFAULT_FREE_TRIAL_CREDITS = 10;

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

let userId = $state<string | null>(null);
let used = $state<number>(0);
let bonusCredits = $state<number>(0);
let effectiveMax = $state<number>(FREE_TRIAL_INITIAL_CREDITS);
let loaded = $state(false);

/**
 * Reactive snapshot of the free-trial state. Reads from this object inside a
 * reactive context (template, `$derived`, `$effect`) automatically track the
 * underlying `$state` cells.
 */
export const freeTrial = {
	get credits(): number {
		if (!loaded) return 0;
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
	get loaded(): boolean {
		return loaded;
	},
	get isSignedIn(): boolean {
		return userId !== null;
	}
};

/**
 * Synchronise the trial state with the currently signed-in user.
 * Pass `null` (e.g. on sign-out) to clear local state. Safe to call on every
 * auth change; the RPC is small and side-effect free.
 */
export async function loadFreeTrialForUser(uid: string | null): Promise<void> {
	if (uid === null) {
		userId = null;
		used = 0;
		bonusCredits = 0;
		effectiveMax = FREE_TRIAL_INITIAL_CREDITS;
		loaded = false;
		return;
	}
	userId = uid;
	loaded = false;
	try {
		const { data, error } = await supabase.rpc('get_trial_credit_status', {
			p_base: FREE_TRIAL_INITIAL_CREDITS
		});
		if (error) {
			// Rollout: fall back until migration is applied.
			const legacy = await supabase.rpc('get_trial_usage');
			if (legacy.error) throw error;
			used = typeof legacy.data === 'number' ? Math.max(0, legacy.data) : 0;
			bonusCredits = 0;
			effectiveMax = FREE_TRIAL_INITIAL_CREDITS;
		} else {
			const row = Array.isArray(data) ? data[0] : data;
			used = typeof row?.used === 'number' ? Math.max(0, row.used) : 0;
			bonusCredits = typeof row?.bonus_credits === 'number' ? Math.max(0, row.bonus_credits) : 0;
			effectiveMax =
				typeof row?.effective_max === 'number'
					? Math.max(FREE_TRIAL_INITIAL_CREDITS, row.effective_max)
					: FREE_TRIAL_INITIAL_CREDITS + bonusCredits;
		}
	} catch (e) {
		console.error('[freeTrial] failed to load trial usage:', e);
		used = FREE_TRIAL_INITIAL_CREDITS;
		bonusCredits = 0;
		effectiveMax = FREE_TRIAL_INITIAL_CREDITS;
	} finally {
		loaded = true;
	}
}

export interface ConsumeResult {
	allowed: boolean;
	remaining: number;
}

/**
 * Atomically attempt to consume one trial credit on the server. Updates local
 * reactive state with the authoritative response, so the UI reflects the new
 * count immediately. Returns `{ allowed: false }` for guests or transient errors.
 */
export async function tryConsumeFreeTrialCredit(): Promise<ConsumeResult> {
	if (!userId) return { allowed: false, remaining: 0 };
	try {
		const { data, error } = await supabase.rpc('consume_trial_credit', {
			p_max: FREE_TRIAL_INITIAL_CREDITS
		});
		if (error) throw error;
		const row = Array.isArray(data) ? data[0] : data;
		const allowed = Boolean(row?.allowed);
		const remaining = typeof row?.remaining === 'number' ? row.remaining : 0;
		used = Math.max(0, effectiveMax - remaining);
		loaded = true;
		return { allowed, remaining };
	} catch (e) {
		console.error('[freeTrial] failed to consume trial credit:', e);
		return { allowed: false, remaining: freeTrial.credits };
	}
}
