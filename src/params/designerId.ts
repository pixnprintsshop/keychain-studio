import { DESIGNER_IDS, isDesignerId } from '$lib/designers/ids';

export function match(param: string) {
	return isDesignerId(param);
}

export function validate(param: string) {
	if (!isDesignerId(param)) {
		return { valid: false as const, message: `Unknown designer: ${param}` };
	}
	return { valid: true as const, data: param };
}

export const designerIds = DESIGNER_IDS;
