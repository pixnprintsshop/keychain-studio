/**
 * OpenSCAD WASM load + render (no Worker). Used on the main thread as fallback and inside the dedicated worker.
 */
import { createOpenSCAD, type OpenSCADInstance } from 'openscad-wasm';

let cachedInstance: OpenSCADInstance | null = null;

/** Browser window or a dedicated worker (both can load WASM); not Node SSR. */
function canRunOpenScadWasm(): boolean {
	if (typeof globalThis === 'undefined') return false;
	if (typeof (globalThis as { window?: unknown }).window !== 'undefined') return true;
	try {
		return (
			typeof self !== 'undefined' &&
			(self as { constructor?: { name?: string } }).constructor?.name === 'DedicatedWorkerGlobalScope'
		);
	} catch {
		return false;
	}
}

export async function getOpenScadInstance(forceNew = false): Promise<OpenSCADInstance> {
	if (!canRunOpenScadWasm()) {
		throw new Error('OpenSCAD WASM is only available in the browser or a Web Worker');
	}
	if (cachedInstance && !forceNew) return cachedInstance;
	cachedInstance = await createOpenSCAD({ noInitialRun: true });
	return cachedInstance;
}

export function clearOpenScadCache(): void {
	cachedInstance = null;
}

const DEFAULT_SVG_PATH = '/input.svg';
const DEFAULT_STL_PATH = '/base.stl';

export type OpenScadRenderOptions = {
	svgPath?: string;
	svgContent?: string;
	stlPath?: string;
	stlContent?: ArrayBuffer;
	extraFiles?: { path: string; content: string }[];
};

export async function renderOpenScadToStlBuffer(
	instance: OpenSCADInstance,
	source: string,
	options?: OpenScadRenderOptions
): Promise<ArrayBuffer> {
	const fs = instance.getInstance().FS;
	if (options?.svgContent != null) {
		const path = options.svgPath ?? DEFAULT_SVG_PATH;
		try {
			fs.unlink(path);
		} catch {
			// File may not exist on first run
		}
		fs.writeFile(path, options.svgContent);
	}
	if (options?.extraFiles?.length) {
		for (const { path, content } of options.extraFiles) {
			try {
				fs.unlink(path);
			} catch {
				// File may not exist on first run
			}
			fs.writeFile(path, content);
		}
	}
	if (options?.stlContent != null) {
		const path = options.stlPath ?? DEFAULT_STL_PATH;
		try {
			fs.unlink(path);
		} catch {
			// File may not exist on first run
		}
		fs.writeFile(path, new Uint8Array(options.stlContent));
	}
	const stlString = await instance.renderToStl(source);
	return new TextEncoder().encode(stlString).buffer;
}

export async function runOpenScadOnMainThread(
	source: string,
	options?: OpenScadRenderOptions
): Promise<ArrayBuffer> {
	async function once(instance: OpenSCADInstance): Promise<ArrayBuffer> {
		return renderOpenScadToStlBuffer(instance, source, options);
	}
	try {
		const instance = await getOpenScadInstance();
		return await once(instance);
	} catch {
		clearOpenScadCache();
		const instance = await getOpenScadInstance(true);
		return await once(instance);
	}
}
