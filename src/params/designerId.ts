import { DESIGNER_IDS, resolveDesignerId } from '$lib/designers/ids';

export function match(param: string) {
	return resolveDesignerId(param) !== null;
}

export function validate(param: string) {
	const resolved = resolveDesignerId(param);
	if (!resolved) {
		return { valid: false as const, message: `Unknown designer: ${param}` };
	}
	return { valid: true as const, data: resolved };
}

export const designerIds = DESIGNER_IDS;
