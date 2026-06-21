import type { DesignerId } from '$lib/designers/ids';

/** Designers that require a per-user feature flag (`designer_<id>`) to open. */
export const EXCLUSIVE_DESIGNER_IDS = ['textBlocks'] as const satisfies readonly DesignerId[];

export type ExclusiveDesignerId = (typeof EXCLUSIVE_DESIGNER_IDS)[number];

const EXCLUSIVE_SET = new Set<string>(EXCLUSIVE_DESIGNER_IDS);

/** Feature flag key stored in `user_feature_flags`. */
export function exclusiveDesignerFeatureKey(id: string): string {
	return `designer_${id}`;
}

export function isExclusiveDesigner(id: string): id is ExclusiveDesignerId {
	return EXCLUSIVE_SET.has(id);
}

function getDevAccessDesignerIds(): Set<string> {
	const raw = import.meta.env.VITE_EXCLUSIVE_DESIGNER_DEV_ACCESS as string | undefined;
	if (!raw) return new Set();
	return new Set(
		raw
			.split(',')
			.map((x) => x.trim())
			.filter(Boolean)
	);
}

const DEV_ACCESS_IDS = getDevAccessDesignerIds();

/** True when the user may open this designer (non-exclusive always allowed). */
export function canAccessExclusiveDesigner(
	id: string,
	hasFeature: (key: string) => boolean
): boolean {
	if (!isExclusiveDesigner(id)) return true;
	if (DEV_ACCESS_IDS.has(id)) return true;
	return hasFeature(exclusiveDesignerFeatureKey(id));
}
