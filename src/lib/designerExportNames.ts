import type { DesignerId } from '$lib/designers/ids';
import { isDesignerId } from '$lib/designers/ids';
import { getCurrentDesignerId } from '$lib/currentDesigner.svelte';
import { getDesignerIdFromDisplayName } from '$lib/designerDisplayNames';

export function resolveDesignerIdForExport(
	designName: string,
	explicitId?: string | null
): DesignerId | null {
	if (explicitId && isDesignerId(explicitId)) return explicitId;

	const fromRoute = getCurrentDesignerId();
	if (fromRoute) return fromRoute;

	return getDesignerIdFromDisplayName(designName);
}
