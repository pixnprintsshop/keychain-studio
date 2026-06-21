import type { DesignerId } from '$lib/designers/ids';

/** Designers shown as "Coming soon" on the home grid. */
export const COMING_SOON_DESIGNER_IDS = [
	'letterRail',
	'monogramInsert'
] as const satisfies readonly DesignerId[];

export type ComingSoonDesignerId = (typeof COMING_SOON_DESIGNER_IDS)[number];

const COMING_SOON_SET = new Set<string>(COMING_SOON_DESIGNER_IDS);

export function isComingSoonDesignerId(id: string): id is ComingSoonDesignerId {
	return COMING_SOON_SET.has(id);
}

/** Feature flag key for early access (`user_feature_flags`). */
export function comingSoonEarlyAccessFeatureKey(id: string): string {
	return `comingSoon_${id}`;
}

function getDevAccessDesignerIds(): Set<string> {
	const raw = import.meta.env.VITE_COMING_SOON_DEV_ACCESS as string | undefined;
	if (!raw) return new Set();
	return new Set(
		raw
			.split(',')
			.map((x) => x.trim())
			.filter(Boolean)
	);
}

const DEV_ACCESS_IDS = getDevAccessDesignerIds();

/** True when the user may open this designer (non–coming-soon always allowed). */
export function canAccessComingSoonDesigner(
	id: string,
	hasFeature: (key: string) => boolean
): boolean {
	if (!isComingSoonDesignerId(id)) return true;
	if (DEV_ACCESS_IDS.has(id)) return true;
	return hasFeature(comingSoonEarlyAccessFeatureKey(id));
}

/** Coming soon and no early-access flag. */
export function isComingSoonLocked(
	id: string,
	hasFeature: (key: string) => boolean
): boolean {
	return isComingSoonDesignerId(id) && !canAccessComingSoonDesigner(id, hasFeature);
}
