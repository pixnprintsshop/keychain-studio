import { MESSENGER_COMMUNITY_URL } from '$lib/messengerCommunity';

export const LACE_BADGE_OFFER_STORAGE_KEY = 'idnametag-v2-lace-badge-offer-seen-v1';

export const LACE_BADGE_OFFER_PRICE_PHP = 800;

/** Set when a product video is ready; dialog shows a video block when non-null. */
export const LACE_BADGE_OFFER_VIDEO_SRC: string | null = null;

export { MESSENGER_COMMUNITY_URL };

export type LaceBadgeOfferImage = {
	src: string;
	alt: string;
};

export const LACE_BADGE_OFFER_IMAGES: LaceBadgeOfferImage[] = [
	{
		src: '/images/idnametag-v2-lace-badge-offer/hero-lanyards.png',
		alt: 'Custom ID lace badges on lanyards with character clips and names'
	},
	{
		src: '/images/idnametag-v2-lace-badge-offer/closeup-clip.png',
		alt: 'Close-up of lace clip holder attaching a name badge to a lanyard'
	},
	{
		src: '/images/idnametag-v2-lace-badge-offer/charms-grid.png',
		alt: 'Character charm options for ID lace badges'
	}
];

export function isLaceBadgeOfferSeen(): boolean {
	if (typeof window === 'undefined') return true;
	try {
		return localStorage.getItem(LACE_BADGE_OFFER_STORAGE_KEY) === '1';
	} catch {
		return false;
	}
}

export function markLaceBadgeOfferSeen(): void {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(LACE_BADGE_OFFER_STORAGE_KEY, '1');
	} catch {
		// localStorage can be unavailable in restricted browser contexts.
	}
}
