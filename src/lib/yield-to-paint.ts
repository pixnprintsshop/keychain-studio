import { tick } from 'svelte';

/**
 * Flush pending DOM updates, then wait until after the next paint.
 * Use after setting export loading flags so buttons disable / labels update before heavy sync work.
 */
export async function tickThenYieldToPaint(): Promise<void> {
	await tick();
	await new Promise<void>((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => resolve());
		});
	});
}
