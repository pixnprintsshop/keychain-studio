import type { SubscriptionStatus } from './subscription';

export function formatSubscriptionStatusForNotify(
	s: SubscriptionStatus | null | undefined
): string | undefined {
	if (!s) return undefined;
	if (!s.isActive) return s.licenseExpired ? 'license expired' : 'inactive';
	if (s.source === 'subscription') {
		const trial = s.onTrial ? ' [on trial]' : '';
		const pending = s.cancelledPendingEnd ? ' [cancelled, access until period end]' : '';
		return `subscription (${s.plan ?? '—'})${trial}${pending}`;
	}
	if (s.source === 'license') return 'license';
	return 'active';
}
