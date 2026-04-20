/**
 * Wraps three-3mf-exporter and fixes Bambu-style model_settings: the upstream library
 * hardcodes `<metadata key="extruder" value="1"/>` on every `<object>`, so multi-body
 * 3MFs assign the wrong filament to objects after the first. We align object extruder
 * with the first `<part>` extruder inside each object.
 */
import JSZip from 'jszip';
import type { Object3D } from 'three';
import { exportTo3MF as exportTo3MFInternal } from 'three-3mf-exporter';

export { defaultPrintConfig } from 'three-3mf-exporter';

type PrintJobConfig = NonNullable<Parameters<typeof exportTo3MFInternal>[1]>;

/** First `<metadata key="extruder" value="…"/>` inside the first `<part>` of an object block. */
function patchModelSettingsObjectExtruders(xml: string): string {
	return xml.replace(/<object id="[^"]+">([\s\S]*?)<\/object>/g, (full) => {
		const partExtruder = full.match(
			/<part\b[^>]*>[\s\S]*?<metadata key="extruder" value="(\d+)"\/>/
		);
		if (!partExtruder) return full;
		const ex = partExtruder[1];
		return full.replace(
			/(<metadata key="name" value="[^"]*"\/>)\s*<metadata key="extruder" value="\d+"\/>/,
			`$1\n    <metadata key="extruder" value="${ex}"/>`
		);
	});
}

export async function exportTo3MF(
	object: Object3D,
	printJobConfig?: PrintJobConfig
): Promise<Blob> {
	const blob = await exportTo3MFInternal(object, printJobConfig);
	try {
		const zip = await JSZip.loadAsync(blob);
		const entry = zip.file('Metadata/model_settings.config');
		if (!entry) return blob;
		const xml = await entry.async('string');
		const patched = patchModelSettingsObjectExtruders(xml);
		if (patched === xml) return blob;
		zip.file('Metadata/model_settings.config', patched);
		return await zip.generateAsync({
			type: 'blob',
			mimeType: blob.type,
			compression: 'DEFLATE'
		});
	} catch {
		return blob;
	}
}
