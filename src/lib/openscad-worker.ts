/**
 * Dedicated worker: runs OpenSCAD so the main thread stays responsive during WASM render.
 */
/// <reference lib="webworker" />

import {
	clearOpenScadCache,
	getOpenScadInstance,
	renderOpenScadToStlBuffer,
	type OpenScadRenderOptions
} from './openscad-runner';

type WorkerRequest = {
	id: number;
	source: string;
	options?: OpenScadRenderOptions;
};

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
	const { id, source, options } = e.data;
	try {
		const instance = await getOpenScadInstance();
		const buffer = await renderOpenScadToStlBuffer(instance, source, options);
		(self as DedicatedWorkerGlobalScope).postMessage({ id, ok: true as const, buffer }, [buffer]);
	} catch {
		try {
			clearOpenScadCache();
			const instance = await getOpenScadInstance(true);
			const buffer = await renderOpenScadToStlBuffer(instance, source, options);
			(self as DedicatedWorkerGlobalScope).postMessage({ id, ok: true as const, buffer }, [buffer]);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			(self as DedicatedWorkerGlobalScope).postMessage({
				id,
				ok: false as const,
				error: message
			});
		}
	}
};
