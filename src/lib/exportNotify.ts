import { resolveDesignerIdForExport } from './designerExportNames';
import { recordExport } from './exportStats.svelte';
import { isTelegramNotifyEnabled } from './opsInDev';
import { freeTrial } from './freeTrial.svelte';
import { subscriptionTrial } from './subscriptionTrial.svelte';
import type { SubscriptionStatus } from './subscription';
import type { DesignerId } from './designers/ids';

export interface ExportNotifyPayload {
	email: string | undefined;
	name: string | undefined;
	subscriptionStatus: SubscriptionStatus | null;
	designName: string;
	/** Route designer id (e.g. `basicName`). Resolved from designName when omitted. */
	designerId?: DesignerId | null;
	format: 'stl' | '3mf' | 'bambu_studio';
}

export type ExportAccessVia = 'none' | 'subscription' | 'license' | 'free_trial';

/** How this export was allowed — used for Telegram status text. */
function resolveExportAccess(subscriptionStatus: SubscriptionStatus | null): {
	statusLabel: string;
	accessVia: ExportAccessVia;
	freeTrialRemaining?: number;
	freeTrialTotal?: number;
	subscriptionTrialRemaining?: number;
	subscriptionTrialTotal?: number;
} {
	if (!subscriptionStatus) {
		return { statusLabel: 'none', accessVia: 'none' };
	}
	if (subscriptionStatus.isActive) {
		if (subscriptionStatus.onTrial) {
			const remaining = subscriptionTrial.remaining;
			const total = subscriptionTrial.maxPerDesign;
			return {
				statusLabel: `subscription trial (${remaining} of ${total} remaining for this design)`,
				accessVia: 'subscription',
				subscriptionTrialRemaining: remaining,
				subscriptionTrialTotal: total
			};
		}
		if (subscriptionStatus.source === 'subscription') {
			const pending = subscriptionStatus.cancelledPendingEnd
				? ' [cancelled, access until period end]'
				: '';
			return {
				statusLabel: `subscription (${subscriptionStatus.plan ?? '—'})${pending}`,
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
		subscriptionTrialRemaining: access.subscriptionTrialRemaining,
		subscriptionTrialTotal: access.subscriptionTrialTotal,
		onTrial: subscriptionStatus?.onTrial ?? false,
		designName,
		format
	};

	recordExport(resolveDesignerIdForExport(designName, payload.designerId), format);

	if (!isTelegramNotifyEnabled()) return;

	fetch('/api/telegram/export-notify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	}).catch((err) => console.warn('Export notify failed:', err));
}
