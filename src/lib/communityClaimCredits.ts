const DEFAULT_COMMUNITY_CLAIM_CREDITS = 30;

/** Parse community bonus credits from env (1–100). */
export function parseCommunityClaimCredits(raw: string | undefined | null): number {
	if (raw == null || raw === '') return DEFAULT_COMMUNITY_CLAIM_CREDITS;
	const parsed = parseInt(String(raw), 10);
	return Number.isFinite(parsed) && parsed > 0 && parsed <= 100
		? parsed
		: DEFAULT_COMMUNITY_CLAIM_CREDITS;
}
