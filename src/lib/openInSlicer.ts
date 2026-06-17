export type OpenWithSlicerId = 'bambu_studio' | 'orca_slicer';

export function slicerDeepLinkUrl(publicUrl: string, slicer: OpenWithSlicerId): string {
	const encoded = encodeURIComponent(publicUrl);
	switch (slicer) {
		case 'bambu_studio':
			return `bambustudioopen://${encoded}`;
		case 'orca_slicer':
			return `orcaslicer://open?file=${encoded}`;
	}
}

export function openInSlicer(publicUrl: string, slicer: OpenWithSlicerId): void {
	window.location.href = slicerDeepLinkUrl(publicUrl, slicer);
}
