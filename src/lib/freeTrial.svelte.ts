/**
 * Reactive free-trial state, backed by Supabase.
 *
 * Every signed-in user gets `FREE_TRIAL_INITIAL_CREDITS` trial-mode exports
 * before the paywall kicks in. Usage is persisted server-side in the
 * `trial_usage` table and the cap is enforced atomically in the
 * `consume_trial_credit` RPC, so the limit cannot be bypassed by clearing
 * localStorage. Guest users have no trial — they must sign in first.
 */

import { supabase } from './supabase';

const DEFAULT_FREE_TRIAL_CREDITS = 10;

/**
 * How many free downloads each signed-in user gets before the paywall.
 * Configurable via the `VITE_FREE_TRIAL_CREDITS` env var (positive integer).
 * Falls back to {@link DEFAULT_FREE_TRIAL_CREDITS} when unset/invalid.
 *
 * The value is also passed as `p_max` to the server-side `consume_trial_credit`
 * RPC, so changing it lets users with prior usage immediately access additional
 * credits (the server only checks `count < p_max`).
 */
export const FREE_TRIAL_INITIAL_CREDITS: number = (() => {
	const raw = import.meta.env.VITE_FREE_TRIAL_CREDITS as string | undefined;
	if (raw == null || raw === '') return DEFAULT_FREE_TRIAL_CREDITS;
	const parsed = parseInt(String(raw), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FREE_TRIAL_CREDITS;
})();

let userId = $state<string | null>(null);
let used = $state<number>(0);
let loaded = $state(false);

/**
 * Reactive snapshot of the free-trial state. Reads from this object inside a
 * reactive context (template, `$derived`, `$effect`) automatically track the
 * underlying `$state` cells.
 */
export const freeTrial = {
	/**
	 * Remaining trial downloads. Returns 0 for guests and before the first load
	 * resolves, so UI consumers can use a single `> 0` predicate to decide
	 * whether to render the trial chip.
	 */
	get credits(): number {
		if (!loaded) return 0;
		return Math.max(0, FREE_TRIAL_INITIAL_CREDITS - used);
	},
	get hasCredits(): boolean {
		return this.credits > 0;
	},
	get totalCredits(): number {
		return FREE_TRIAL_INITIAL_CREDITS;
	},
	/** True once the per-user trial usage has been fetched at least once. */
	get loaded(): boolean {
		return loaded;
	},
	/** True when a user is signed in (i.e. trial logic applies). */
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
		loaded = false;
		return;
	}
	userId = uid;
	loaded = false;
	try {
		const { data, error } = await supabase.rpc('get_trial_usage');
		if (error) throw error;
		used = typeof data === 'number' ? Math.max(0, data) : 0;
	} catch (e) {
		console.error('[freeTrial] failed to load trial usage:', e);
		// Fail closed: assume exhausted so we don't grant exports we can't verify.
		used = FREE_TRIAL_INITIAL_CREDITS;
	} finally {
		loaded = true;
	}
}

export interface ConsumeResult {
	/** True iff the server granted a trial-mode export. */
	allowed: boolean;
	/** Remaining credits after the call (0 when exhausted). */
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
		used = Math.max(0, FREE_TRIAL_INITIAL_CREDITS - remaining);
		loaded = true;
		return { allowed, remaining };
	} catch (e) {
		console.error('[freeTrial] failed to consume trial credit:', e);
		return { allowed: false, remaining: freeTrial.credits };
	}
}
