/**
 * Per-user feature flags loaded from Supabase (`user_feature_flags`).
 * Grants are admin-managed (service role); users can only read their own flags.
 */
import type { FeatureFlagKey } from '$lib/featureFlags';
import { supabase } from '$lib/supabase';

let userId = $state<string | null>(null);
let enabledKeys = $state<Set<string>>(new Set());
let loaded = $state(false);

export const userFeatureFlags = {
	get loaded(): boolean {
		return loaded;
	},
	has(key: FeatureFlagKey | string): boolean {
		return enabledKeys.has(key);
	},
	get enabled(): readonly string[] {
		return [...enabledKeys];
	}
};

export async function loadUserFeatureFlagsForUser(uid: string | null): Promise<void> {
	if (uid === userId && loaded) return;

	if (uid === null) {
		userId = null;
		enabledKeys = new Set();
		loaded = false;
		return;
	}

	userId = uid;
	loaded = false;
	try {
		const { data, error } = await supabase.rpc('get_user_feature_flags');
		if (error) throw error;
		const keys = new Set<string>();
		if (Array.isArray(data)) {
			for (const row of data) {
				if (typeof row === 'string' && row) keys.add(row);
				else if (row && typeof row === 'object' && 'feature_key' in row) {
					const k = (row as { feature_key?: string }).feature_key;
					if (k) keys.add(k);
				}
			}
		}
		enabledKeys = keys;
	} catch (e) {
		console.error('[userFeatureFlags] failed to load:', e);
		enabledKeys = new Set();
	} finally {
		loaded = true;
	}
}
