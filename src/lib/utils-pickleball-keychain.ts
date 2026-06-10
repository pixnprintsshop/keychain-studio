import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const CURVE_DIVISIONS = 24;
const SQRT1_2 = Math.SQRT1_2;
/** Unit extrusion depth (mm) before user thickness scaling. */
export const PICKLEBALL_UNIT_LAYER_DEPTH_MM = 1;

/**
 * Paddle face is ~45° from world axes. User offset X runs top-left ↔ bottom-right;
 * offset Y runs top-right ↔ bottom-left (Z-up, XY plane).
 */
export function iconOffsetToWorld(
	offsetX: number,
	offsetY: number
): { x: number; y: number } {
	return {
		x: (offsetX + offsetY) * SQRT1_2,
		y: (-offsetX + offsetY) * SQRT1_2
	};
}

/** Inverse of {@link iconOffsetToWorld} — for migrating stored world-space offsets. */
export function iconOffsetFromWorld(worldX: number, worldY: number): { x: number; y: number } {
	return {
		x: (worldX - worldY) * SQRT1_2,
		y: (worldX + worldY) * SQRT1_2
	};
}

export interface PickleballUnitGeometries {
	baseUnit: THREE.BufferGeometry;
	decorUnit: THREE.BufferGeometry;
	/** Silhouette height of the centered base unit (mm). */
	nativeHeightMm: number;
}

function flipShapeY(shape: THREE.Shape): THREE.Shape {
	const flipped = new THREE.Shape();
	const outer = shape.getPoints(CURVE_DIVISIONS);
	if (outer.length > 0) {
		flipped.moveTo(outer[0].x, -outer[0].y);
		for (let i = 1; i < outer.length; i++) flipped.lineTo(outer[i].x, -outer[i].y);
	}
	for (const hole of shape.holes) {
		const holePts = hole.getPoints(CURVE_DIVISIONS);
		if (holePts.length === 0) continue;
		const holePath = new THREE.Path();
		holePath.moveTo(holePts[0].x, -holePts[0].y);
		for (let i = 1; i < holePts.length; i++) holePath.lineTo(holePts[i].x, -holePts[i].y);
		flipped.holes.push(holePath);
	}
	return flipped;
}

function parseSvgToShapes(svgRaw: string, flipY = false): THREE.Shape[] {
	const loader = new SVGLoader();
	const parsed = loader.parse(svgRaw);
	const shapes: THREE.Shape[] = [];
	for (const p of parsed.paths) {
		for (const s of SVGLoader.createShapes(p)) {
			shapes.push(flipY ? flipShapeY(s) : s);
		}
	}
	return shapes;
}

function extrudeShapes(shapes: THREE.Shape[], depth: number): THREE.BufferGeometry | null {
	if (shapes.length === 0) return null;
	const geos: THREE.BufferGeometry[] = [];
	for (const s of shapes) {
		geos.push(
			new THREE.ExtrudeGeometry(s, {
				depth: Math.max(0.05, depth),
				bevelEnabled: false,
				curveSegments: CURVE_DIVISIONS
			})
		);
	}
	const merged =
		geos.length === 1 ? geos[0] : BufferGeometryUtils.mergeGeometries(geos, true);
	if (!merged) return null;
	if (geos.length > 1) geos.forEach((g) => g !== merged && g.dispose());
	return merged;
}

/** Extrude bundled paddle SVG paths to a unit-depth layer (large SVG coords → mm via prepare step). */
export function buildExtrudedLayerFromSvg(
	svgRaw: string,
	depth = PICKLEBALL_UNIT_LAYER_DEPTH_MM
): THREE.BufferGeometry | null {
	const shapes = parseSvgToShapes(svgRaw, true);
	if (shapes.length === 0) return null;
	const geo = extrudeShapes(shapes, depth);
	if (!geo) return null;
	geo.computeVertexNormals();
	geo.computeBoundingBox();
	return geo;
}

/** Center base and decor on the same XY origin; both sit on z = 0. */
export function preparePickleballUnitGeometries(
	baseSrc: THREE.BufferGeometry,
	decorSrc: THREE.BufferGeometry,
	/** When set, scales SVG path units down to millimeters (silhouette height matches this value). */
	targetNativeHeightMm?: number
): PickleballUnitGeometries {
	baseSrc.computeBoundingBox();
	decorSrc.computeBoundingBox();
	const bb = baseSrc.boundingBox;
	const dbb = decorSrc.boundingBox;
	if (!bb || !dbb) throw new Error('Pickleball layer missing bounding box');

	const cx = (bb.min.x + bb.max.x) / 2;
	const cy = (bb.min.y + bb.max.y) / 2;

	const baseUnit = baseSrc.clone();
	baseUnit.translate(-cx, -cy, -bb.min.z);

	const decorUnit = decorSrc.clone();
	decorUnit.translate(-cx, -cy, -dbb.min.z);

	baseUnit.computeBoundingBox();
	const fitted = baseUnit.boundingBox;
	let nativeHeightMm = Math.max(1e-6, (fitted?.max.y ?? 0) - (fitted?.min.y ?? 0));

	if (targetNativeHeightMm && targetNativeHeightMm > 0) {
		const xyScale = targetNativeHeightMm / nativeHeightMm;
		baseUnit.scale(xyScale, xyScale, xyScale);
		decorUnit.scale(xyScale, xyScale, xyScale);
		baseUnit.computeBoundingBox();
		decorUnit.computeBoundingBox();
		const baseBottom = baseUnit.boundingBox?.min.z ?? 0;
		const decorBottom = decorUnit.boundingBox?.min.z ?? 0;
		baseUnit.translate(0, 0, -baseBottom);
		decorUnit.translate(0, 0, -decorBottom);
		nativeHeightMm = targetNativeHeightMm;
	}

	return { baseUnit, decorUnit, nativeHeightMm };
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
	geo.computeBoundingBox();
	return geo;
}

/** Build a raised icon layer from an Iconify SVG string. */
export function buildIconGeometryFromSvg(
	svgRaw: string,
	targetWidth: number,
	depth: number
): THREE.BufferGeometry | null {
	const shapes = parseSvgToShapes(svgRaw, true);
	if (shapes.length === 0) return null;
	const geo = extrudeShapes(shapes, depth);
	if (!geo) return null;
	geo.computeBoundingBox();
	const bb = geo.boundingBox;
	if (!bb) return null;
	const width = bb.max.x - bb.min.x;
	if (width <= 1e-6) {
		geo.dispose();
		return null;
	}
	const scale = targetWidth / width;
	geo.scale(scale, scale, 1);
	geo.computeBoundingBox();
	const bb2 = geo.boundingBox;
	if (bb2) {
		const cx = (bb2.min.x + bb2.max.x) / 2;
		const cy = (bb2.min.y + bb2.max.y) / 2;
		geo.translate(-cx, -cy, -bb2.min.z);
	}
	geo.computeVertexNormals();
	geo.computeBoundingBox();
	return geo;
}
