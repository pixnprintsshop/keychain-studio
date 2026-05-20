/**
 * Fixed geometry for the motorcycle plate accessory badge designer:
 * rounded-end bar with two mounting slots, in millimeters (artboard XY, Z extrusion).
 * **Preview / export**: OpenSCAD `difference()` cuts the two mounting slots (manifold).
 * Element outline meshes are slot-cut in 2D (Clipper) before extrusion.
 */

import ClipperLib from 'clipper-lib';
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { runOpenScad } from '$lib/openscad';
import {
	CLIPPER_SCALE,
	polyTreeToThreeShapes,
	type ClipperPath,
	type ClipperPaths
} from '$lib/utils-canvas-studio';
import { createRoundedRectShape, disposeObject3D, stlToBufferGeometry } from '$lib/utils-3d';

/** Extra Z on slot cutters in OpenSCAD so booleans stay clean through the plate. */
const OPENSCAD_SLOT_Z_SLOP_MM = 0.08;

export const PLATE_SPEC = {
	/** Half-length along X (bar length = 2 × this, mm). */
	halfLengthMm: 80,
	/** Half-height along Y (total height = 2 × this). */
	halfHeightMm: 12,
	/** Corner radius for the long bar (typically = halfHeight for stadium ends). */
	cornerRadiusMm: 15,
	/** Mounting slot half-size: 15 mm along X × 7 mm along Y (elongated along the bar). */
	slotHalfLongMm: 7.5,
	slotHalfShortMm: 3.5,
	/** Distance from origin to each slot center on ±X (center-to-center hole spacing = 2 × this = 103 mm). */
	slotCenterXMm: 51.5,
	/** Suggested “keep art here” box in mm (artboard coords, Y-up); Konva uses negated Y for drawing. */
	designZone: { minX: -41, maxX: 41, minY: -11, maxY: 11 }
} as const;

/** How text fill height is chosen in 3D / export. */
export type PlateBadgeTextEmbedMode = 'full' | 'cap';

/** Slight coplanar embed so text merges cleanly with the base in slicers. */
export const PLATE_TEXT_EMBED_INTO_BASE_MM = 0.2;

export const PLATE_TEXT_CAP_DEPTH_MIN_MM = 0.2;
export const PLATE_TEXT_CAP_DEPTH_DEFAULT_MM = 0.4;

export function maxPlateTextCapDepthMm(baseDepthMm: number): number {
	const base = Math.max(0.1, baseDepthMm);
	return Math.max(PLATE_TEXT_CAP_DEPTH_MIN_MM, base - PLATE_TEXT_EMBED_INTO_BASE_MM);
}

export function clampPlateTextCapDepthMm(mm: number, baseDepthMm: number): number {
	const max = maxPlateTextCapDepthMm(baseDepthMm);
	const n = Number(mm);
	const v = Number.isFinite(n) ? n : PLATE_TEXT_CAP_DEPTH_DEFAULT_MM;
	return Math.min(max, Math.max(PLATE_TEXT_CAP_DEPTH_MIN_MM, v));
}

export const PLATE_ELEMENT_DEPTH_MIN_MM = 0.2;
export const PLATE_ELEMENT_DEPTH_MAX_MM = 8;

export function clampPlateElementDepthMm(mm: number): number {
	const n = Number(mm);
	const v = Number.isFinite(n) ? n : 3;
	return Math.min(PLATE_ELEMENT_DEPTH_MAX_MM, Math.max(PLATE_ELEMENT_DEPTH_MIN_MM, v));
}

/** Extrusion height and bottom Z for letter fill meshes — always on top of the base/outline stack. */
export function plateBadgeTextLayer3D(
	baseDepthMm: number,
	mode: PlateBadgeTextEmbedMode,
	capDepthMm: number,
	elementDepthMm: number
): { extrudeDepthMm: number; bottomZMm: number } {
	const baseTopZ = Math.max(0.1, baseDepthMm);
	if (mode === 'cap') {
		const cap = clampPlateTextCapDepthMm(capDepthMm, baseTopZ);
		return { extrudeDepthMm: cap, bottomZMm: baseTopZ };
	}
	return {
		extrudeDepthMm: clampPlateElementDepthMm(elementDepthMm),
		bottomZMm: baseTopZ
	};
}

/** Slight expansion of slot cutters so outline frames clear the through-holes. */
const OUTLINE_SLOT_CLIP_MARGIN_MM = 0.15;

function ensureClipperCW(path: ClipperPath, clockwise: boolean): void {
	if (path.length < 3) return;
	const isCW = ClipperLib.Clipper.Orientation(path);
	if (isCW !== clockwise) path.reverse();
}

/** Clipper paths for both mounting slots (artboard mm, Y-up). */
export function getPlateMountingSlotClipperPaths(): ClipperPaths {
	const { slotHalfLongMm, slotHalfShortMm, slotCenterXMm } = PLATE_SPEC;
	const corner = Math.min(slotHalfLongMm, slotHalfShortMm);
	const slotShape = createRoundedRectShape(slotHalfLongMm, slotHalfShortMm, corner);
	const paths: ClipperPaths = [];
	for (const sign of [-1, 1] as const) {
		const pts = slotShape.getPoints(48);
		const path: ClipperPath = [];
		for (const p of pts) {
			path.push({
				X: Math.round((p.x + sign * slotCenterXMm) * CLIPPER_SCALE),
				Y: Math.round(p.y * CLIPPER_SCALE)
			});
		}
		if (path.length > 2) {
			const a = path[0];
			const b = path[path.length - 1];
			if (a.X === b.X && a.Y === b.Y) path.pop();
		}
		if (path.length >= 3) {
			ensureClipperCW(path, true);
			paths.push(path);
		}
	}
	return paths;
}

function collectPolyTreePaths(tree: unknown): ClipperPaths {
	const out: ClipperPaths = [];
	const walk = (node: {
		Contour?: () => ClipperPath;
		m_polygon?: ClipperPath;
		Childs?: () => unknown[];
		m_Childs?: unknown[];
	}) => {
		const contour = node.Contour?.() ?? node.m_polygon ?? [];
		if (contour.length >= 3) out.push(contour);
		const childs = node.Childs?.() ?? node.m_Childs ?? [];
		for (const ch of childs) walk(ch as typeof node);
	};
	const t = tree as { Childs?: () => unknown[]; m_Childs?: unknown[] };
	const roots = t.Childs?.() ?? t.m_Childs ?? [];
	for (const n of roots) walk(n as Parameters<typeof walk>[0]);
	return out;
}

/** Remove mounting-slot regions from an outline PolyTree (2D), keeping holes where applicable. */
export function subtractPlateMountingSlotsFromPolyTree(tree: unknown): unknown {
	let slotClip = getPlateMountingSlotClipperPaths();
	if (slotClip.length === 0) return tree;

	if (OUTLINE_SLOT_CLIP_MARGIN_MM > 0) {
		const co = new ClipperLib.ClipperOffset(2, 2);
		co.AddPaths(slotClip, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
		const grown: ClipperPaths = [];
		co.Execute(grown, OUTLINE_SLOT_CLIP_MARGIN_MM * CLIPPER_SCALE);
		if (grown.length > 0) slotClip = grown;
	}

	const subject = collectPolyTreePaths(tree);
	if (subject.length === 0) return tree;

	const result = new ClipperLib.PolyTree();
	const c = new ClipperLib.Clipper();
	c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
	c.AddPaths(slotClip, ClipperLib.PolyType.ptClip, true);
	c.Execute(
		ClipperLib.ClipType.ctDifference,
		result,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	return result;
}

/** Clamp element center (mm, artboard Y-up) to the plate’s top-down footprint. */
export function clampElementCenterToPlate(x: number, y: number): { x: number; y: number } {
	const { halfLengthMm: hw, halfHeightMm: hh } = PLATE_SPEC;
	return {
		x: Math.max(-hw, Math.min(hw, x)),
		y: Math.max(-hh, Math.min(hh, y))
	};
}

function shapePolygonPointsList2D(shape: THREE.Shape, divisions: number): string {
	const pts = shape.getPoints(divisions).map((p) => ({ x: p.x, y: p.y }));
	const v2 = pts.map((p) => new THREE.Vector2(p.x, p.y));
	if (THREE.ShapeUtils.isClockWise(v2)) pts.reverse();
	return '[' + pts.map((p) => `[${p.x.toFixed(5)}, ${p.y.toFixed(5)}]`).join(', ') + ']';
}

/** OpenSCAD source: stadium plate with two through-slots (manifold `difference`). */
export function getPlateBaseOpenScadSource(depthMm: number): string {
	const { halfLengthMm: HW, halfHeightMm: HH, cornerRadiusMm: CR, slotHalfLongMm: sL, slotHalfShortMm: sW, slotCenterXMm: scx } =
		PLATE_SPEC;
	const corner = Math.min(CR, HW, HH);
	const d = Math.max(0.1, depthMm);
	const h = d + 2;
	const outerShape = createRoundedRectShape(HW, HH, corner);
	const outerPts = shapePolygonPointsList2D(outerShape, 96);
	const slotCorner = Math.min(sL, sW);
	const slotShape = createRoundedRectShape(sL, sW, slotCorner);
	const slotPts = shapePolygonPointsList2D(slotShape, 48);

	const zSlop = OPENSCAD_SLOT_Z_SLOP_MM;
	const slotH = h + 2 * zSlop;

	return `
$fn = 96;
base_t = ${d.toFixed(5)};
slot_z_slop = ${zSlop.toFixed(5)};

module mounting_slot() {
  translate([0, 0, -slot_z_slop])
    linear_extrude(height = ${slotH.toFixed(5)}, convexity = 16) {
      polygon(points = ${slotPts});
    }
}

difference() {
  linear_extrude(height = base_t, convexity = 16) {
    polygon(points = ${outerPts});
  }
  translate([${scx.toFixed(5)}, 0, 0]) mounting_slot();
  translate([${(-scx).toFixed(5)}, 0, 0]) mounting_slot();
}
`;
}

function stadiumOuterClipperPath(): ClipperPath {
	const { halfLengthMm: HW, halfHeightMm: HH, cornerRadiusMm: CR } = PLATE_SPEC;
	const corner = Math.min(CR, HW, HH);
	const outerShape = createRoundedRectShape(HW, HH, corner);
	const path: ClipperPath = [];
	for (const p of outerShape.getPoints(64)) {
		path.push({
			X: Math.round(p.x * CLIPPER_SCALE),
			Y: Math.round(p.y * CLIPPER_SCALE)
		});
	}
	if (path.length > 2) {
		const a = path[0];
		const b = path[path.length - 1];
		if (a.X === b.X && a.Y === b.Y) path.pop();
	}
	if (path.length >= 3) ensureClipperCW(path, true);
	return path;
}

/**
 * Fast 3D preview plate with mounting slots (Clipper + extrude). Used for instant depth updates in the designer.
 */
export function buildPlateBaseMeshPreview(depthMm: number, color: string): THREE.Mesh {
	const d = Math.max(0.1, depthMm);
	const outer = stadiumOuterClipperPath();
	if (outer.length < 3) return buildPlateOuterMeshPreview(depthMm, color);

	const tree = new ClipperLib.PolyTree();
	const c = new ClipperLib.Clipper();
	c.AddPath(outer, ClipperLib.PolyType.ptSubject, true);
	const slots = getPlateMountingSlotClipperPaths();
	if (slots.length > 0) c.AddPaths(slots, ClipperLib.PolyType.ptClip, true);
	c.Execute(
		ClipperLib.ClipType.ctDifference,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);

	const shapes = polyTreeToThreeShapes(tree);
	if (shapes.length === 0) return buildPlateOuterMeshPreview(depthMm, color);

	const geo = new THREE.ExtrudeGeometry(shapes, {
		depth: d,
		bevelEnabled: false,
		curveSegments: 24
	});
	finalizePlateBaseGeometry(geo);
	const mat = new THREE.MeshStandardMaterial({
		color,
		roughness: 0.85,
		metalness: 0.05
	});
	const mesh = new THREE.Mesh(geo, mat);
	mesh.name = 'base';
	return mesh;
}

/**
 * Stadium plate outer solid only (no mounting slots). Fallback when slot-cut preview fails.
 */
export function buildPlateOuterMeshPreview(depthMm: number, color: string): THREE.Mesh {
	const d = Math.max(0.1, depthMm);
	const { halfLengthMm: HW, halfHeightMm: HH, cornerRadiusMm: CR } = PLATE_SPEC;
	const corner = Math.min(CR, HW, HH);
	const outerShape = createRoundedRectShape(HW, HH, corner);
	const baseGeo = new THREE.ExtrudeGeometry(outerShape, {
		depth: d,
		bevelEnabled: false,
		curveSegments: 24
	});
	const baseMat = new THREE.MeshStandardMaterial({
		color,
		roughness: 0.85,
		metalness: 0.05
	});
	BufferGeometryUtils.mergeVertices(baseGeo, 1e-3);
	baseGeo.computeVertexNormals();
	baseGeo.computeBoundingBox();
	const bb = baseGeo.boundingBox!;
	baseGeo.translate(0, 0, -bb.min.z);
	const mesh = new THREE.Mesh(baseGeo, baseMat);
	mesh.name = 'base';
	return mesh;
}

function geometryHasTriangles(geo: THREE.BufferGeometry | null | undefined): boolean {
	if (!geo) return false;
	const pos = geo.getAttribute('position');
	return pos != null && pos.count >= 3;
}

function finalizePlateBaseGeometry(geo: THREE.BufferGeometry): void {
	try {
		BufferGeometryUtils.mergeVertices(geo, 1e-3);
	} catch (err) {
		console.warn('Plate badge: mergeVertices skipped', err);
	}
	geo.computeVertexNormals();
	geo.computeBoundingBox();
	const bb = geo.boundingBox;
	if (bb && !bb.isEmpty()) geo.translate(0, 0, -bb.min.z);
}

/**
 * Merge OpenSCAD base (slots already cut) + rim meshes into **one** mesh (same material).
 */
export function unionPlateBaseWithOutlineMeshes(
	baseMesh: THREE.Mesh,
	outlineMeshes: THREE.Mesh[]
): THREE.Mesh {
	if (outlineMeshes.length === 0) return baseMesh;

	const baseMat =
		baseMesh.material instanceof THREE.MeshStandardMaterial
			? (baseMesh.material as THREE.MeshStandardMaterial).clone()
			: new THREE.MeshStandardMaterial({ color: 0x1e293b });

	const geos: THREE.BufferGeometry[] = [
		baseMesh.geometry.clone(),
		...outlineMeshes.map((m) => m.geometry.clone())
	];
	const merged = BufferGeometryUtils.mergeGeometries(geos, false);
	for (const g of geos) g.dispose();

	if (!merged || !geometryHasTriangles(merged)) {
		console.error('Plate badge: mergeGeometries(base + outlines) failed');
		merged?.dispose();
		for (const om of outlineMeshes) disposeObject3D(om);
		return baseMesh;
	}

	disposeObject3D(baseMesh);
	for (const om of outlineMeshes) disposeObject3D(om);

	finalizePlateBaseGeometry(merged);
	const mesh = new THREE.Mesh(merged, baseMat);
	mesh.name = 'base';
	return mesh;
}

/** Manifold plate bar with mounting slots from OpenSCAD; bottom normalized to Z = 0. */
export async function buildPlateBaseMeshFromOpenScad(
	depthMm: number,
	color: string
): Promise<THREE.Mesh> {
	const source = getPlateBaseOpenScadSource(depthMm);
	const stl = await runOpenScad(source);
	let geo = stlToBufferGeometry(stl);
	geo = BufferGeometryUtils.mergeVertices(geo, 1e-3);
	geo.computeVertexNormals();
	geo.computeBoundingBox();
	const bb = geo.boundingBox!;
	geo.translate(0, 0, -bb.min.z);
	const mat = new THREE.MeshStandardMaterial({
		color,
		roughness: 0.85,
		metalness: 0.05
	});
	const mesh = new THREE.Mesh(geo, mat);
	mesh.name = 'base';
	return mesh;
}

/**
 * Plate base with OpenSCAD bolt holes, merged with optional rim outline meshes (one combined base mesh).
 */
export async function buildPlateBaseWithOutlineMeshes(
	depthMm: number,
	color: string,
	outlineMeshes: THREE.Mesh[]
): Promise<THREE.Mesh> {
	const baseMesh = await buildPlateBaseMeshFromOpenScad(depthMm, color);
	return unionPlateBaseWithOutlineMeshes(baseMesh, outlineMeshes);
}

/** SVG path `d` for Konva (Y flipped to Konva space). */
function shapeToKonvaPathD(shape: THREE.Shape, close = true): string {
	const pts = shape.getPoints(48);
	if (pts.length < 2) return '';
	const parts: string[] = [];
	parts.push(`M ${pts[0].x.toFixed(3)} ${(-pts[0].y).toFixed(3)}`);
	for (let i = 1; i < pts.length; i++) {
		parts.push(`L ${pts[i].x.toFixed(3)} ${(-pts[i].y).toFixed(3)}`);
	}
	if (close) parts.push('Z');
	return parts.join(' ');
}

export function plateOuterKonvaPathD(): string {
	const { halfLengthMm, halfHeightMm, cornerRadiusMm } = PLATE_SPEC;
	const corner = Math.min(cornerRadiusMm, halfLengthMm, halfHeightMm);
	const outer = createRoundedRectShape(halfLengthMm, halfHeightMm, corner);
	return shapeToKonvaPathD(outer, true);
}

export function plateSlotKonvaPathD(sign: -1 | 1): string {
	const { slotHalfLongMm, slotHalfShortMm, slotCenterXMm } = PLATE_SPEC;
	const slotCorner = Math.min(slotHalfLongMm, slotHalfShortMm);
	const slotShape = createRoundedRectShape(slotHalfLongMm, slotHalfShortMm, slotCorner);
	const cx = sign * slotCenterXMm;
	const pts = slotShape.getPoints(16);
	if (pts.length < 2) return '';
	const parts: string[] = [];
	parts.push(`M ${(pts[0].x + cx).toFixed(3)} ${(-pts[0].y).toFixed(3)}`);
	for (let i = 1; i < pts.length; i++) {
		parts.push(`L ${(pts[i].x + cx).toFixed(3)} ${(-pts[i].y).toFixed(3)}`);
	}
	parts.push('Z');
	return parts.join(' ');
}
