import type { DesignerId } from '$lib/designers/ids';

/** Designers shown as "Coming soon" on the home grid. */
export const COMING_SOON_DESIGNER_IDS = [
	'roomSign'
] as const satisfies readonly DesignerId[];

export type ComingSoonDesignerId = (typeof COMING_SOON_DESIGNER_IDS)[number];

export function isComingSoonDesignerId(id: string): id is ComingSoonDesignerId {
	return (COMING_SOON_DESIGNER_IDS as readonly string[]).includes(id);
}
