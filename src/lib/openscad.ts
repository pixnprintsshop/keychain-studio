/**
 * OpenSCAD WASM: prefers a dedicated worker so exports do not freeze the UI; falls back to the main thread.
 */
import {
	clearOpenScadCache,
	getOpenScadInstance,
	renderOpenScadToStlBuffer,
	runOpenScadOnMainThread,
	type OpenScadRenderOptions
} from './openscad-runner';

export type { OpenScadRenderOptions };
export {
	clearOpenScadCache,
	getOpenScadInstance,
	renderOpenScadToStlBuffer,
	runOpenScadOnMainThread
};

type WorkerResponse =
	| { id: number; ok: true; buffer: ArrayBuffer }
	| { id: number; ok: false; error: string };

let openScadWorker: Worker | null = null;
let nextJobId = 1;
const pendingJobs = new Map<
	number,
	{ resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }
>();

/** Serialize OpenSCAD jobs (single WASM instance per realm). */
let runQueue: Promise<unknown> = Promise.resolve();

function getOpenScadWorker(): Worker {
	if (!openScadWorker) {
		openScadWorker = new Worker(new URL('./openscad-worker.ts', import.meta.url), { type: 'module' });
		openScadWorker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
			const msg = ev.data;
			const job = pendingJobs.get(msg.id);
			pendingJobs.delete(msg.id);
			if (!job) return;
			if (msg.ok) job.resolve(msg.buffer);
			else job.reject(new Error(msg.error));
		};
		openScadWorker.onerror = (ev) => {
			const err = new Error(ev.message || 'OpenSCAD worker error');
			for (const [, p] of pendingJobs) {
				p.reject(err);
			}
			pendingJobs.clear();
			openScadWorker?.terminate();
			openScadWorker = null;
		};
	}
	return openScadWorker;
}

async function runOpenScadViaWorker(source: string, options?: OpenScadRenderOptions): Promise<ArrayBuffer> {
	const w = getOpenScadWorker();
	const id = nextJobId++;
	return await new Promise<ArrayBuffer>((resolve, reject) => {
		pendingJobs.set(id, { resolve, reject });
		try {
			w.postMessage({ id, source, options });
		} catch (e) {
			pendingJobs.delete(id);
			reject(e instanceof Error ? e : new Error(String(e)));
		}
	});
}

/**
 * Run OpenSCAD and return STL bytes. Uses a Web Worker when available so the page stays responsive.
 */
export async function runOpenScad(
	source: string,
	options?: OpenScadRenderOptions
): Promise<ArrayBuffer> {
	const job = runQueue.then(async () => {
		if (typeof Worker !== 'undefined') {
			try {
				return await runOpenScadViaWorker(source, options);
			} catch (e) {
				console.warn('[OpenSCAD] worker run failed, using main thread', e);
			}
		}
		return runOpenScadOnMainThread(source, options);
	});
	runQueue = job.then(
		() => {},
		() => {}
	);
	return job as Promise<ArrayBuffer>;
}

/** Prime the OpenSCAD worker (or main path) during idle time so the first real export feels faster. */
export async function warmupOpenScadWorker(): Promise<void> {
	try {
		await runOpenScad('cube([1, 1, 1], center = true);', {});
	} catch {
		// Warmup is best-effort only.
	}
}
