import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

export const ROOM_SIGN_VIEWBOX = { width: 2970, height: 2228 };
/** Plaque width the bundled STL assets were exported at (mm). */
export const ROOM_SIGN_REFERENCE_WIDTH_MM = 150;

export function loadStlGeometry(
	loader: STLLoader,
	url: string
): Promise<THREE.BufferGeometry> {
	return new Promise((resolve, reject) => {
		loader.load(url, (geometry) => resolve(geometry), undefined, reject);
	});
}

function centerGeometryOnFloor(geo: THREE.BufferGeometry): THREE.BufferGeometry {
	const g = geo.clone();
	g.computeBoundingBox();
	const bb = g.boundingBox;
	if (!bb) return g;
	const cx = (bb.min.x + bb.max.x) / 2;
	const cy = (bb.min.y + bb.max.y) / 2;
	g.translate(-cx, -cy, -bb.min.z);
	g.computeBoundingBox();
	return g;
}

function scaleGeometryToTargetWidth(
	srcGeo: THREE.BufferGeometry,
	targetWidthMm: number
): THREE.BufferGeometry {
	const geo = centerGeometryOnFloor(srcGeo);
	const scale = targetWidthMm / ROOM_SIGN_REFERENCE_WIDTH_MM;
	geo.scale(scale, scale, 1);
	geo.computeBoundingBox();
	const bb = geo.boundingBox;
	if (bb) geo.translate(0, 0, -bb.min.z);
	geo.computeBoundingBox();
	return geo;
}

/** Scale bundled STL meshes to the requested plaque width; depth stays at 1 mm unit. */
export function buildAlignedRoomSignLayers(options: {
	baseStl: THREE.BufferGeometry;
	decorStl: THREE.BufferGeometry | null;
	targetWidthMm: number;
}): { baseUnit: THREE.BufferGeometry | null; decorUnit: THREE.BufferGeometry | null } {
	const baseUnit = scaleGeometryToTargetWidth(options.baseStl, options.targetWidthMm);
	const decorUnit = options.decorStl
		? scaleGeometryToTargetWidth(options.decorStl, options.targetWidthMm)
		: null;
	return { baseUnit, decorUnit };
}

export function scaleGeometryToDepth(
	srcGeo: THREE.BufferGeometry,
	targetDepth: number
): THREE.BufferGeometry {
	const geo = srcGeo.clone();
	geo.computeBoundingBox();
	const bb = geo.boundingBox;
	if (bb) {
		const currentDepth = bb.max.z - bb.min.z;
		if (currentDepth > 0.001) {
			const scale = Math.max(0.01, targetDepth) / currentDepth;
			geo.scale(1, 1, scale);
		}
	}
	geo.computeBoundingBox();
	const bb2 = geo.boundingBox;
	if (bb2) geo.translate(0, 0, -bb2.min.z);
	return geo;
}
