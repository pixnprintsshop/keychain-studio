import { getNewFontOptions } from './utils-3d';

export { getNewFontOptions };

/** Changes when fonts are added or removed from the new-fonts dialog list. */
export function getNewFontsDialogFingerprint(): string {
	return getNewFontOptions()
		.map((font) => font.key)
		.sort()
		.join(',');
}
