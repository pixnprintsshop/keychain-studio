export type HomeFeatureDialogId = 'pickleballKeychain' | 'newFonts' | 'favorite';

const STORAGE_KEY_PENDING = 'pixnprints-pending-home-feature-dialog-v1';

export function getPendingHomeFeatureDialog(): HomeFeatureDialogId | null {
	if (typeof window === 'undefined') return null;
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY_PENDING);
		if (raw === 'pickleballKeychain' || raw === 'newFonts' || raw === 'favorite') return raw;
	} catch {
		/* sessionStorage unavailable */
	}
	return null;
}

export function setPendingHomeFeatureDialog(id: HomeFeatureDialogId): void {
	try {
		sessionStorage.setItem(STORAGE_KEY_PENDING, id);
	} catch {
		/* sessionStorage unavailable */
	}
}

export function clearPendingHomeFeatureDialog(): void {
	try {
		sessionStorage.removeItem(STORAGE_KEY_PENDING);
	} catch {
		/* sessionStorage unavailable */
	}
}

/** First eligible dialog to show, respecting pending queue and priority. */
export function resolveNextHomeFeatureDialog(options: {
	pending: HomeFeatureDialogId | null;
	shouldShowPickleballKeychain: boolean;
	shouldShowNewFonts: boolean;
	shouldShowFavorite: boolean;
}): HomeFeatureDialogId | null {
	const { pending, shouldShowPickleballKeychain, shouldShowNewFonts, shouldShowFavorite } =
		options;

	if (pending === 'pickleballKeychain' && shouldShowPickleballKeychain)
		return 'pickleballKeychain';
	if (pending === 'newFonts' && shouldShowNewFonts) return 'newFonts';
	if (pending === 'favorite' && shouldShowFavorite) return 'favorite';
	if (pending) clearPendingHomeFeatureDialog();

	if (shouldShowPickleballKeychain) return 'pickleballKeychain';
	if (shouldShowNewFonts) return 'newFonts';
	if (shouldShowFavorite) return 'favorite';
	return null;
}
