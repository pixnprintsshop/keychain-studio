import { freeTrial } from './freeTrial.svelte';
import type { SubscriptionStatus } from './subscription';

export interface ExportNotifyPayload {
	email: string | undefined;
	name: string | undefined;
	subscriptionStatus: SubscriptionStatus | null;
	designName: string;
	format: 'stl' | '3mf' | 'bambu_studio';
}

export type ExportAccessVia = 'none' | 'subscription' | 'license' | 'free_trial';

/** How this export was allowed — used for Telegram status text. */
function resolveExportAccess(subscriptionStatus: SubscriptionStatus | null): {
	statusLabel: string;
	accessVia: ExportAccessVia;
	freeTrialRemaining?: number;
	freeTrialTotal?: number;
} {
	if (!subscriptionStatus) {
		return { statusLabel: 'none', accessVia: 'none' };
	}
	if (subscriptionStatus.isActive) {
		if (subscriptionStatus.source === 'subscription') {
			const trial = subscriptionStatus.onTrial ? ' [on trial]' : '';
			const pending = subscriptionStatus.cancelledPendingEnd
				? ' [cancelled, access until period end]'
				: '';
			return {
				statusLabel: `subscription (${subscriptionStatus.plan ?? '—'})${trial}${pending}`,
				accessVia: 'subscription'
			};
		}
		if (subscriptionStatus.source === 'license') {
			return { statusLabel: 'license', accessVia: 'license' };
		}
		return { statusLabel: 'active', accessVia: 'subscription' };
	}
	if (subscriptionStatus.licenseExpired) {
		return { statusLabel: 'license expired', accessVia: 'none' };
	}
	// No paid access — exports only succeed via server-side free trial credits.
	if (freeTrial.isSignedIn) {
		const remaining = freeTrial.credits;
		const total = freeTrial.totalCredits;
		return {
			statusLabel: `free trial (${remaining} of ${total} remaining)`,
			accessVia: 'free_trial',
			freeTrialRemaining: remaining,
			freeTrialTotal: total
		};
	}
	return { statusLabel: 'inactive', accessVia: 'none' };
}

/**
 * Notify backend of an export event (sends to Telegram). Fire-and-forget; does not block.
 */
export function notifyExportEvent(payload: ExportNotifyPayload): void {
	const { email, name, subscriptionStatus, designName, format } = payload;
	const access = resolveExportAccess(subscriptionStatus);
	const body = {
		email: email ?? undefined,
		name: name ?? undefined,
		subscriptionStatus: access.statusLabel,
		accessVia: access.accessVia,
		freeTrialRemaining: access.freeTrialRemaining,
		freeTrialTotal: access.freeTrialTotal,
		onTrial: subscriptionStatus?.onTrial ?? false,
		designName,
		format
	};

	fetch('/api/telegram/export-notify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	}).catch((err) => console.warn('Export notify failed:', err));
}
