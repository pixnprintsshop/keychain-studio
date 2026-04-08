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
	/** True when subscription status is 'on_trial' (Lemon Squeezy) */
	onTrial?: boolean;
	/** True when user had a license that has expired */
	licenseExpired?: boolean;
	/** True when the subscription is cancelled but paid access continues until `endsAt` */
	cancelledPendingEnd?: boolean;
}

const ACTIVE_STATUSES = new Set(['active', 'on_trial']);

/**
 * Lemon Squeezy: `active` / `on_trial` are entitled until `ends_at` (if set).
 * `cancelled` / `canceled` still grants access until the end of the current billing period (`ends_at`).
 */
function subscriptionRowGrantsAccess(status: string, endsAt: string | null): boolean {
	const s = status.toLowerCase();
	const ends = endsAt ? new Date(endsAt) : null;
	const now = new Date();

	if (ACTIVE_STATUSES.has(s)) {
		return !ends || ends > now;
	}
	if ((s === 'cancelled' || s === 'canceled') && ends && ends > now) {
		return true;
	}
	return false;
}

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
		const st = status.toLowerCase();
		const ends = endsAt ? new Date(endsAt) : null;
		const now = new Date();
		const isActive = subscriptionRowGrantsAccess(status, endsAt);
		if (isActive) {
			const cancelledPendingEnd =
				(st === 'cancelled' || st === 'canceled') && ends !== null && ends > now;
			return {
				isActive: true,
				source: 'subscription',
				plan: subData.plan as 'monthly' | 'yearly' | undefined,
				endsAt: endsAt ?? undefined,
				renewsAt: (subData.renews_at as string | null) ?? undefined,
				onTrial: st === 'on_trial',
				cancelledPendingEnd
			};
		}
	}

	// 2. Check license activation via RPC (never use cache for license - always verify expiration on each session)
	const { data: hasLicenseAccess, error: rpcError } = await supabase.rpc('get_user_export_access', {
		p_user_id: userId
	});

	if (!rpcError && hasLicenseAccess === true) {
		return { isActive: true, source: 'license' };
	}

	// 3. If no access, check if user had an expired license (so we can show "License expired")
	const { data: { session } } = await supabase.auth.getSession();
	if (session?.access_token) {
		try {
			const res = await fetch('/api/license/status', {
				headers: { Authorization: `Bearer ${session.access_token}` }
			});
			if (res.ok) {
				const data = (await res.json()) as { activated?: boolean; expires_at?: string | null };
				if (data.activated && data.expires_at && new Date(data.expires_at) <= new Date()) {
					return { isActive: false, source: 'license', licenseExpired: true };
				}
			}
		} catch {
			// ignore
		}
	}

	return { isActive: false };
}

/** Returns the export button title based on user and subscription status. */
export function getExportTitle(
	user: { id: string } | null,
	subscriptionStatus: SubscriptionStatus | null,
	activeTitle: string = 'Export STL or 3MF'
): string {
	if (!user) return 'Sign in to export';
	if (subscriptionStatus?.licenseExpired) return 'License expired';
	if (!subscriptionStatus?.isActive) return 'Subscribe to export';
	return activeTitle;
}

/**
 * Guards STL/3MF/Bambu export paths: require signed-in user and active subscription or license.
 * When blocked, calls `onShowPricing` (typically navigate to pricing). Use at the start of export handlers.
 */
export function ensureExportAccess(
	user: { id: string } | null,
	subscriptionStatus: SubscriptionStatus | null,
	onShowPricing?: () => void
): boolean {
	if (!user || !subscriptionStatus?.isActive) {
		onShowPricing?.();
		return false;
	}
	return true;
}
