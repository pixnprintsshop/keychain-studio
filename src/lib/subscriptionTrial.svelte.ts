/**
 * Per-designer export limits for Lemon Squeezy subscription trial (on_trial).
 * Enforced server-side via consume_subscription_trial_export RPC.
 */
import type { DesignerId } from '$lib/designers/ids';
import { supabase } from '$lib/supabase';

const DEFAULT_SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN = 10;

/**
 * Max exports per designer during LS subscription trial.
 * Configurable via VITE_SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN (positive integer).
 */
export const SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN: number = (() => {
	const raw = import.meta.env.VITE_SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN as string | undefined;
	if (raw == null || raw === '') return DEFAULT_SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN;
	const parsed = parseInt(String(raw), 10);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN;
})();

let loadedDesignerId = $state<DesignerId | null>(null);
let used = $state(0);
let remaining = $state(0);
let onTrial = $state(false);
let entitled = $state(false);
let loaded = $state(false);

export const subscriptionTrial = {
	get used(): number {
		return used;
	},
	get remaining(): number {
		return remaining;
	},
	get hasCredits(): boolean {
		return loaded && entitled && remaining > 0;
	},
	get onTrial(): boolean {
		return onTrial;
	},
	get entitled(): boolean {
		return entitled;
	},
	get loaded(): boolean {
		return loaded;
	},
	get maxPerDesign(): number {
		return SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN;
	}
};

function applyStatusRow(
	designerId: DesignerId,
	row: Record<string, unknown> | undefined
): void {
	loadedDesignerId = designerId;
	onTrial = Boolean(row?.on_trial);
	entitled = row?.entitled !== false && onTrial;
	used = typeof row?.used === 'number' ? Math.max(0, row.used) : 0;
	remaining =
		typeof row?.remaining === 'number'
			? Math.max(0, row.remaining)
			: entitled
				? Math.max(0, SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN - used)
				: 0;
	loaded = true;
}

export async function loadSubscriptionTrialForDesigner(designerId: DesignerId): Promise<void> {
	if (loadedDesignerId === designerId && loaded) return;
	loaded = false;
	try {
		const { data, error } = await supabase.rpc('get_subscription_trial_designer_status', {
			p_designer_id: designerId,
			p_max: SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN
		});
		if (error) throw error;
		const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
		applyStatusRow(designerId, row);
	} catch (e) {
		console.error('[subscriptionTrial] failed to load status:', e);
		loadedDesignerId = designerId;
		onTrial = false;
		entitled = false;
		used = SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN;
		remaining = 0;
		loaded = true;
	}
}

export function clearSubscriptionTrialState(): void {
	loadedDesignerId = null;
	used = 0;
	remaining = 0;
	onTrial = false;
	entitled = false;
	loaded = false;
}

export interface SubscriptionTrialConsumeResult {
	allowed: boolean;
	remaining: number;
	onTrial: boolean;
}

export async function tryConsumeSubscriptionTrialExport(
	designerId: DesignerId
): Promise<SubscriptionTrialConsumeResult> {
	try {
		const { data, error } = await supabase.rpc('consume_subscription_trial_export', {
			p_designer_id: designerId,
			p_max: SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN
		});
		if (error) throw error;
		const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
		const trial = Boolean(row?.on_trial);
		const allowed = Boolean(row?.allowed);
		const rem =
			typeof row?.remaining === 'number'
				? row.remaining
				: allowed
					? Math.max(0, SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN - 1)
					: 0;
		if (trial) {
			loadedDesignerId = designerId;
			onTrial = true;
			entitled = true;
			used =
				typeof row?.used === 'number'
					? Math.max(0, row.used)
					: Math.max(0, SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN - rem);
			remaining = rem < 0 ? SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN : Math.max(0, rem);
			loaded = true;
		}
		return { allowed, remaining: rem < 0 ? SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN : rem, onTrial: trial };
	} catch (e) {
		console.error('[subscriptionTrial] failed to consume export:', e);
		return { allowed: false, remaining: subscriptionTrial.remaining, onTrial: subscriptionTrial.onTrial };
	}
}
