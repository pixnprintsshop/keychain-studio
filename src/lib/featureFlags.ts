/** Known per-user feature flag keys (stored in `user_feature_flags`). */

export const FEATURE_FLAG_KEYS = {
	/** ID Name Tag v2 — back-side text inlay + underside preview. */
	ID_NAME_TAG_V2_BACKPRINT: 'idNameTagV2_backprint'
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[keyof typeof FEATURE_FLAG_KEYS];
