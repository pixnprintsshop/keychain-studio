/**
 * Lazy OpenSCAD WASM loader. Use only in browser (typeof window !== 'undefined').
 * Exposes runOpenScad(source) which returns STL bytes (ASCII STL as ArrayBuffer).
 */
import { createOpenSCAD, type OpenSCADInstance } from "openscad-wasm";

let cachedInstance: OpenSCADInstance | null = null;

export async function getOpenScadInstance(): Promise<OpenSCADInstance> {
	if (typeof window === "undefined") {
		throw new Error("OpenSCAD WASM is only available in the browser");
	}
	if (cachedInstance) return cachedInstance;
	cachedInstance = await createOpenSCAD({ noInitialRun: true });
	return cachedInstance;
}

const DEFAULT_SVG_PATH = "/input.svg";

/**
 * Run OpenSCAD source and return STL file contents as bytes.
 * If options.svgContent is provided, it is written to the WASM FS at options.svgPath (default /input.svg) before rendering, so the script can import() it.
 */
export async function runOpenScad(
	source: string,
	options?: { svgPath?: string; svgContent?: string },
): Promise<ArrayBuffer> {
	const instance = await getOpenScadInstance();
	if (options?.svgContent != null) {
		const path = options.svgPath ?? DEFAULT_SVG_PATH;
		instance.getInstance().FS.writeFile(path, options.svgContent);
	}
	const stlString = await instance.renderToStl(source);
	return new TextEncoder().encode(stlString).buffer;
}
