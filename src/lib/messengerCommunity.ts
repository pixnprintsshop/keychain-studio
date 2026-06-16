import { parseCommunityClaimCredits } from '$lib/communityClaimCredits';

/** Official Print Studio Messenger community group. */
export const MESSENGER_COMMUNITY_URL = 'https://m.me/cm/AbZRzg9rdPaH-vzH/';

/**
 * One-time bonus when a free-trial user joins the community group.
 * Set `VITE_COMMUNITY_CLAIM_CREDITS` in .env (same value the server uses).
 */
export const COMMUNITY_JOIN_BONUS_CREDITS = parseCommunityClaimCredits(
	import.meta.env.VITE_COMMUNITY_CLAIM_CREDITS as string | undefined
);

export type CommunityClaimErrorCode =
	| 'invalid_code'
	| 'already_claimed'
	| 'not_signed_in'
	| 'code_required'
	| 'not_configured'
	| 'server_error'
	| 'unknown';

export function getCommunityClaimErrorMessage(error: CommunityClaimErrorCode | undefined): string {
	switch (error) {
		case 'invalid_code':
			return 'That code is not correct. Copy the pinned code from our Messenger group.';
		case 'already_claimed':
			return 'You have already claimed the community bonus.';
		case 'code_required':
			return 'Enter the claim code from the pinned Messenger message.';
		case 'not_signed_in':
			return 'Sign in to claim your credits.';
		case 'not_configured':
			return 'Claiming is not available right now. Please try again later.';
		default:
			return 'Could not claim credits right now. Please try again in a moment.';
	}
}
