import type { DesignerId } from '$lib/designers/ids';

let currentDesignerId = $state<DesignerId | null>(null);

export function setCurrentDesignerId(id: DesignerId | null): void {
	currentDesignerId = id;
}

export function getCurrentDesignerId(): DesignerId | null {
	return currentDesignerId;
}
