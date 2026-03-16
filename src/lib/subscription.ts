import { supabase } from './supabase';

const LICENSE_CACHE_KEY_PREFIX = 'pixnprints-license-';
const LICENSE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getCachedLicenseStatus(userId: string): SubscriptionStatus | null {
	if (typeof sessionStorage === 'undefined') return null;
	try {
		const raw = sessionStorage.getItem(LICENSE_CACHE_KEY_PREFIX + userId);
		if (!raw) return null;
		const { data, timestamp } = JSON.parse(raw) as {
			data: SubscriptionStatus;
			timestamp: number;
		};
		if (Date.now() - timestamp > LICENSE_CACHE_TTL_MS) return null;
		return data;
	} catch {
		return null;
	}
}

function setCachedLicenseStatus(userId: string, status: SubscriptionStatus) {
	if (typeof sessionStorage === 'undefined') return;
	try {
		sessionStorage.setItem(
			LICENSE_CACHE_KEY_PREFIX + userId,
			JSON.stringify({ data: status, timestamp: Date.now() })
		);
	} catch {
		// ignore
	}
}

/** Store license status in cache (e.g. after successful activation). */
export function setLicenseCache(userId: string) {
	setCachedLicenseStatus(userId, { isActive: true, source: 'license' });
}

/** Clear cached license status (e.g. on sign out). Call with the user id that signed out. */
export function clearLicenseCache(userId: string | null) {
	if (typeof sessionStorage === 'undefined' || !userId) return;
	try {
		sessionStorage.removeItem(LICENSE_CACHE_KEY_PREFIX + userId);
	} catch {
		// ignore
	}
}

export interface SubscriptionStatus {
	isActive: boolean;
	/** How the user has access: subscription (Lemon Squeezy) or license (manual code) */
	source?: 'subscription' | 'license';
	plan?: 'monthly' | 'yearly';
	endsAt?: string;
	renewsAt?: string;
}

const ACTIVE_STATUSES = new Set(['active', 'on_trial']);

export async function getSubscriptionStatus(userId: string | null): Promise<SubscriptionStatus | null> {
	if (!userId) return null;

	// 1. Check Lemon Squeezy subscription first
	const { data: subData, error: subError } = await supabase
		.from('subscriptions')
		.select('status, plan, ends_at, renews_at')
		.eq('user_id', userId)
		.maybeSingle();

	if (!subError && subData) {
		const status = subData.status as string;
		const endsAt = subData.ends_at as string | null;
		const isActive = ACTIVE_STATUSES.has(status) && (!endsAt || new Date(endsAt) > new Date());
		if (isActive) {
			return {
				isActive: true,
				source: 'subscription',
				plan: subData.plan as 'monthly' | 'yearly' | undefined,
				endsAt: endsAt ?? undefined,
				renewsAt: (subData.renews_at as string | null) ?? undefined
			};
		}
	}

	// 2. Check legacy license activation (via RPC or cache)
	const cached = getCachedLicenseStatus(userId);
	if (cached?.source === 'license') {
		return cached;
	}

	const { data: hasLicenseAccess, error: rpcError } = await supabase.rpc('get_user_export_access', {
		p_user_id: userId
	});

	if (!rpcError && hasLicenseAccess === true) {
		const status: SubscriptionStatus = { isActive: true, source: 'license' };
		setCachedLicenseStatus(userId, status);
		return status;
	}

	return { isActive: false };
}
