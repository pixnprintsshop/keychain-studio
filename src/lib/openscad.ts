/**
 * Lazy OpenSCAD WASM loader. Use only in browser (typeof window !== 'undefined').
 * Exposes runOpenScad(source) which returns STL bytes (ASCII STL as ArrayBuffer).
 */
import { createOpenSCAD, type OpenSCADInstance } from "openscad-wasm";

let cachedInstance: OpenSCADInstance | null = null;

export async function getOpenScadInstance(forceNew = false): Promise<OpenSCADInstance> {
	if (typeof window === "undefined") {
		throw new Error("OpenSCAD WASM is only available in the browser");
	}
	if (cachedInstance && !forceNew) return cachedInstance;
	cachedInstance = await createOpenSCAD({ noInitialRun: true });
	return cachedInstance;
}

export function clearOpenScadCache(): void {
	cachedInstance = null;
}

const DEFAULT_SVG_PATH = "/input.svg";
const DEFAULT_STL_PATH = "/base.stl";

/**
 * Run OpenSCAD source and return STL file contents as bytes.
 * - options.svgContent: write to FS at options.svgPath (default /input.svg) so the script can import() it.
 * - options.stlContent: write binary STL to options.stlPath (default /base.stl) so the script can import() it (e.g. base mesh for difference with hole).
 */
export async function runOpenScad(
	source: string,
	options?: {
		svgPath?: string;
		svgContent?: string;
		stlPath?: string;
		stlContent?: ArrayBuffer;
	},
): Promise<ArrayBuffer> {
	async function run(instance: OpenSCADInstance): Promise<ArrayBuffer> {
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

	try {
		const instance = await getOpenScadInstance();
		return await run(instance);
	} catch (firstErr) {
		// Second and later runs can fail with a stale WASM instance; retry with a fresh one
		clearOpenScadCache();
		const instance = await getOpenScadInstance(true);
		return await run(instance);
	}
}
