/** Mirrors access rules from `src/lib/subscription.ts` (server-side checks). */

const ACTIVE_STATUSES = new Set(['active', 'on_trial']);

export function subscriptionRowGrantsAccess(status, endsAt) {
	const s = String(status ?? '').toLowerCase();
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

export function buildSubscriptionStatus(subRow) {
	if (!subRow) return { isActive: false };

	const status = subRow.status;
	const endsAt = subRow.ends_at ?? null;
	const st = String(status ?? '').toLowerCase();
	const ends = endsAt ? new Date(endsAt) : null;
	const now = new Date();
	const isActive = subscriptionRowGrantsAccess(status, endsAt);

	if (!isActive) return { isActive: false, subscriptionRow: subRow };

	const cancelledPendingEnd =
		(st === 'cancelled' || st === 'canceled') && ends !== null && ends > now;

	return {
		isActive: true,
		source: 'subscription',
		plan: subRow.plan ?? undefined,
		endsAt: endsAt ?? undefined,
		renewsAt: subRow.renews_at ?? undefined,
		onTrial: st === 'on_trial',
		cancelledPendingEnd,
		subscriptionRow: subRow
	};
}

export function parseFreeTrialBaseCredits() {
	const raw = process.env.VITE_FREE_TRIAL_CREDITS;
	if (raw == null || raw === '') return 10;
	const parsed = parseInt(String(raw), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

export function parseSubscriptionTrialExportsPerDesign() {
	const raw = process.env.VITE_SUBSCRIPTION_TRIAL_EXPORTS_PER_DESIGN;
	if (raw == null || raw === '') return 10;
	const parsed = parseInt(String(raw), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

export function hasUnlimitedExportAccess(subscriptionStatus) {
	return Boolean(subscriptionStatus?.isActive && !subscriptionStatus?.onTrial);
}

export function buildSubscriptionTrialDesignerStatus(rows, designerId, maxPerDesign) {
	const row = rows?.find((r) => r.designer_id === designerId);
	const used = row?.count ?? 0;
	const remaining = Math.max(0, maxPerDesign - used);
	return { designerId, used, remaining, maxPerDesign };
}

export function buildTrialStatus(trialRow, baseCredits) {
	const used = trialRow?.count ?? 0;
	const bonusCredits = trialRow?.bonus_credits ?? 0;
	const effectiveMax = baseCredits + bonusCredits;
	const remaining = Math.max(0, effectiveMax - used);
	return { used, bonusCredits, effectiveMax, remaining, baseCredits };
}

/**
 * Same resolution order as `ensureExportAccess` (without UI callbacks).
 * `fingerprintAllowed` — pass false when fingerprint cap is exceeded on device.
 * `subscriptionTrialRemaining` — per-designer LS trial credits when `onTrial`.
 */
export function simulateExportAccess({
	subscriptionStatus,
	hasUser,
	trialRemaining,
	fingerprintAllowed,
	subscriptionTrialRemaining,
	designerId
}) {
	if (hasUnlimitedExportAccess(subscriptionStatus)) {
		const plan = subscriptionStatus.plan ? ` · ${subscriptionStatus.plan}` : '';
		const until =
			subscriptionStatus.cancelledPendingEnd && subscriptionStatus.endsAt
				? ` until ${new Date(subscriptionStatus.endsAt).toISOString().slice(0, 10)}`
				: '';
		return {
			allowed: true,
			reason: subscriptionStatus.cancelledPendingEnd ? 'cancelled_pending_end' : 'paid',
			message: subscriptionStatus.cancelledPendingEnd
				? `Cancelled — paid access continues${until} (${subscriptionStatus.source}${plan})`
				: `Paid access (${subscriptionStatus.source}${plan})`
		};
	}
	if (!hasUser) {
		return {
			allowed: false,
			reason: 'sign_in_required',
			message: 'Not signed in — app requires login before free trial exports'
		};
	}
	if (subscriptionStatus?.onTrial) {
		const remaining = subscriptionTrialRemaining ?? 0;
		const label = designerId ? ` for ${designerId}` : ' for this design';
		if (remaining > 0) {
			return {
				allowed: true,
				reason: 'subscription_trial',
				message: `Subscription trial — ${remaining} export${remaining === 1 ? '' : 's'} remaining${label}`
			};
		}
		return {
			allowed: false,
			reason: 'subscription_trial_exhausted',
			message: `Subscription trial exhausted${label} — subscribe for unlimited exports`
		};
	}
	if (!fingerprintAllowed) {
		return {
			allowed: false,
			reason: 'fingerprint_blocked',
			message: 'Free trial blocked — this device already used the max number of trial accounts'
		};
	}
	if (trialRemaining > 0) {
		return {
			allowed: true,
			reason: 'free_trial',
			message: `Free trial — ${trialRemaining} export${trialRemaining === 1 ? '' : 's'} remaining`
		};
	}
	return {
		allowed: false,
		reason: 'paywall',
		message: 'No paid access and free trial exhausted — subscribe or activate a license'
	};
}

export function getExportTitleSimulation({
	subscriptionStatus,
	hasUser,
	trialRemaining,
	fingerprintBlocked,
	subscriptionTrialRemaining
}) {
	if (hasUnlimitedExportAccess(subscriptionStatus)) return 'Export STL or 3MF';
	if (subscriptionStatus?.licenseExpired) return 'License expired';
	if (!hasUser) return 'Sign in to start free trial';
	if (subscriptionStatus?.onTrial) {
		if ((subscriptionTrialRemaining ?? 0) > 0) {
			const left = subscriptionTrialRemaining;
			return `Trial — ${left} download${left === 1 ? '' : 's'} left (this design)`;
		}
		return 'Subscribe to continue exporting';
	}
	if (fingerprintBlocked) return 'Subscribe to export (device trial limit reached)';
	if (trialRemaining > 0) {
		return `Free trial — ${trialRemaining} download${trialRemaining === 1 ? '' : 's'} left`;
	}
	return 'Subscribe to export';
}
