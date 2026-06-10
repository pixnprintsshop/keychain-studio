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
	collectPolyTreeContours,
	getElementOutlinePolyTree,
	getLocalPathsForElement,
	polyTreeToKonvaPathD,
	polyTreeToThreeShapes,
	transformClipperPaths,
	type CanvasElement,
	type ClipperPath,
	type ClipperPaths
} from '$lib/utils-canvas-studio';
import { createRoundedRectShape, disposeObject3D, stlToBufferGeometry } from '$lib/utils-3d';

/** Extra Z on slot cutters in OpenSCAD so booleans stay clean through the plate. */
const OPENSCAD_SLOT_Z_SLOP_MM = 0.08;

export const PLATE_SPEC = {
	/** Half-length along X (bar length = 2 × this, mm). */
	halfLengthMm: 75,
	/** Half-height along Y (total height = 2 × this). */
	halfHeightMm: 10,
	/** Corner radius for the long bar (typically = halfHeight for stadium ends). */
	cornerRadiusMm: 15,
	/** Default mounting slot half-size: 15 mm along X × 7 mm along Y (elongated along the bar). */
	slotHalfLongMm: 7,
	slotHalfShortMm: 4,
	/** Default distance from origin to each slot center on ±X (center-to-center = 2 × this = 105 mm). */
	slotCenterXMm: 59,
	/** Suggested “keep art here” box in mm (artboard coords, Y-up); Konva uses negated Y for drawing. */
	designZone: { minX: -41, maxX: 41, minY: -11, maxY: 11 }
} as const;

/** Full mounting-hole size in mm (elongated along the bar = width, across = height). */
export type PlateSlotDimensions = {
	widthMm: number;
	heightMm: number;
};

export const PLATE_SLOT_WIDTH_DEFAULT_MM = PLATE_SPEC.slotHalfLongMm * 2;
export const PLATE_SLOT_HEIGHT_DEFAULT_MM = PLATE_SPEC.slotHalfShortMm * 2;
export const PLATE_SLOT_WIDTH_MIN_MM = 8;
export const PLATE_SLOT_WIDTH_MAX_MM = 24;
export const PLATE_SLOT_HEIGHT_MIN_MM = 4;
export const PLATE_SLOT_HEIGHT_MAX_MM = 14;

export function defaultPlateSlotDimensions(): PlateSlotDimensions {
	return {
		widthMm: PLATE_SLOT_WIDTH_DEFAULT_MM,
		heightMm: PLATE_SLOT_HEIGHT_DEFAULT_MM
	};
}

export function clampPlateSlotWidthMm(mm: number): number {
	const n = Number(mm);
	const v = Number.isFinite(n) ? n : PLATE_SLOT_WIDTH_DEFAULT_MM;
	return Math.min(PLATE_SLOT_WIDTH_MAX_MM, Math.max(PLATE_SLOT_WIDTH_MIN_MM, v));
}

export function clampPlateSlotHeightMm(mm: number): number {
	const n = Number(mm);
	const v = Number.isFinite(n) ? n : PLATE_SLOT_HEIGHT_DEFAULT_MM;
	return Math.min(PLATE_SLOT_HEIGHT_MAX_MM, Math.max(PLATE_SLOT_HEIGHT_MIN_MM, v));
}

export function normalizePlateSlotDimensions(
	partial?: Partial<PlateSlotDimensions>
): PlateSlotDimensions {
	const d = defaultPlateSlotDimensions();
	return {
		widthMm: clampPlateSlotWidthMm(partial?.widthMm ?? d.widthMm),
		heightMm: clampPlateSlotHeightMm(partial?.heightMm ?? d.heightMm)
	};
}

function slotHalfDims(dims: PlateSlotDimensions): { halfLongMm: number; halfShortMm: number } {
	return { halfLongMm: dims.widthMm / 2, halfShortMm: dims.heightMm / 2 };
}

/** Bar footprint: hole spacing + end padding drive auto-computed base length. */
export type PlateBarParams = {
	holeSpacingMm: number;
	/** Distance from each bar end to the outer edge of the mounting slot (along X). */
	endPaddingMm: number;
	/** Full bar height across Y (stadium short side). */
	baseHeightMm: number;
	/** Derived: holeSpacing + slotWidth + 2 × endPadding. */
	baseLengthMm: number;
};

export const PLATE_BASE_HEIGHT_DEFAULT_MM = PLATE_SPEC.halfHeightMm * 2;
export const PLATE_BASE_HEIGHT_MIN_MM = 16;
export const PLATE_BASE_HEIGHT_MAX_MM = 40;

export const PLATE_BASE_THICKNESS_DEFAULT_MM = 2;
export const PLATE_BASE_THICKNESS_MIN_MM = 0.8;
export const PLATE_BASE_THICKNESS_MAX_MM = 6;

export function clampPlateBaseHeightMm(mm: number): number {
	const n = Number(mm);
	const v = Number.isFinite(n) ? n : PLATE_BASE_HEIGHT_DEFAULT_MM;
	return Math.min(PLATE_BASE_HEIGHT_MAX_MM, Math.max(PLATE_BASE_HEIGHT_MIN_MM, v));
}

export function clampPlateBaseThicknessMm(mm: number): number {
	const n = Number(mm);
	const v = Number.isFinite(n) ? n : PLATE_BASE_THICKNESS_DEFAULT_MM;
	return Math.min(PLATE_BASE_THICKNESS_MAX_MM, Math.max(PLATE_BASE_THICKNESS_MIN_MM, v));
}

export const PLATE_BASE_LENGTH_MIN_MM = 100;
export const PLATE_BASE_LENGTH_MAX_MM = 220;
export const PLATE_HOLE_SPACING_DEFAULT_MM = PLATE_SPEC.slotCenterXMm * 2;
export const PLATE_HOLE_SPACING_MIN_MM = 60;
export const PLATE_END_PADDING_MIN_MM = 4;
export const PLATE_END_PADDING_MAX_MM = 50;
/** Matches legacy 160 mm bar with 105 mm hole spacing and 15 mm slots. */
export const PLATE_END_PADDING_DEFAULT_MM =
	(PLATE_SPEC.halfLengthMm * 2 -
		PLATE_HOLE_SPACING_DEFAULT_MM -
		PLATE_SLOT_WIDTH_DEFAULT_MM) /
	2;

export function computePlateBaseLengthMm(
	holeSpacingMm: number,
	slotWidthMm: number,
	endPaddingMm: number
): number {
	return holeSpacingMm + slotWidthMm + 2 * endPaddingMm;
}

export function maxPlateHoleSpacingMm(endPaddingMm: number, slotWidthMm: number): number {
	return PLATE_BASE_LENGTH_MAX_MM - slotWidthMm - 2 * endPaddingMm;
}

export function maxPlateEndPaddingMm(holeSpacingMm: number, slotWidthMm: number): number {
	return (PLATE_BASE_LENGTH_MAX_MM - holeSpacingMm - slotWidthMm) / 2;
}

export function minPlateEndPaddingMm(holeSpacingMm: number, slotWidthMm: number): number {
	const neededForMinLen = (PLATE_BASE_LENGTH_MIN_MM - holeSpacingMm - slotWidthMm) / 2;
	return Math.max(PLATE_END_PADDING_MIN_MM, neededForMinLen);
}

export function defaultPlateBarParams(
	slot: PlateSlotDimensions = defaultPlateSlotDimensions()
): PlateBarParams {
	const holeSpacingMm = PLATE_HOLE_SPACING_DEFAULT_MM;
	const endPaddingMm = PLATE_END_PADDING_DEFAULT_MM;
	const baseHeightMm = PLATE_BASE_HEIGHT_DEFAULT_MM;
	return {
		holeSpacingMm,
		endPaddingMm,
		baseHeightMm,
		baseLengthMm: computePlateBaseLengthMm(holeSpacingMm, slot.widthMm, endPaddingMm)
	};
}

export function clampPlateHoleSpacingMm(
	mm: number,
	endPaddingMm: number,
	slotWidthMm: number
): number {
	const n = Number(mm);
	const v = Number.isFinite(n) ? n : PLATE_HOLE_SPACING_DEFAULT_MM;
	const minSpacing = Math.max(PLATE_HOLE_SPACING_MIN_MM, slotWidthMm + 8);
	const maxSpacing = maxPlateHoleSpacingMm(endPaddingMm, slotWidthMm);
	return Math.min(maxSpacing, Math.max(minSpacing, v));
}

export function clampPlateEndPaddingMm(
	mm: number,
	holeSpacingMm: number,
	slotWidthMm: number
): number {
	const n = Number(mm);
	const v = Number.isFinite(n) ? n : PLATE_END_PADDING_DEFAULT_MM;
	const minPad = minPlateEndPaddingMm(holeSpacingMm, slotWidthMm);
	const maxPad = maxPlateEndPaddingMm(holeSpacingMm, slotWidthMm);
	return Math.min(maxPad, Math.max(minPad, v));
}

/** Derive end padding from a legacy saved base length (pre-padding control). */
export function plateEndPaddingFromLegacyBaseLengthMm(
	baseLengthMm: number,
	holeSpacingMm: number,
	slotWidthMm: number
): number {
	return clampPlateEndPaddingMm(
		(baseLengthMm - holeSpacingMm - slotWidthMm) / 2,
		holeSpacingMm,
		slotWidthMm
	);
}

/** Clamp hole spacing and end padding; base length is always computed. */
export function normalizePlateBarParams(
	partial?: Partial<PlateBarParams> & { baseLengthMm?: number },
	slot?: PlateSlotDimensions
): PlateBarParams {
	const slotDims = normalizePlateSlotDimensions(slot);
	let endPadding =
		partial?.endPaddingMm ??
		(partial?.baseLengthMm != null
			? plateEndPaddingFromLegacyBaseLengthMm(
					partial.baseLengthMm,
					partial.holeSpacingMm ?? PLATE_HOLE_SPACING_DEFAULT_MM,
					slotDims.widthMm
				)
			: PLATE_END_PADDING_DEFAULT_MM);
	let holeSpacing = clampPlateHoleSpacingMm(
		partial?.holeSpacingMm ?? PLATE_HOLE_SPACING_DEFAULT_MM,
		endPadding,
		slotDims.widthMm
	);
	endPadding = clampPlateEndPaddingMm(endPadding, holeSpacing, slotDims.widthMm);
	holeSpacing = clampPlateHoleSpacingMm(holeSpacing, endPadding, slotDims.widthMm);
	const baseHeightMm = clampPlateBaseHeightMm(
		partial?.baseHeightMm ?? PLATE_BASE_HEIGHT_DEFAULT_MM
	);
	return {
		holeSpacingMm: holeSpacing,
		endPaddingMm: endPadding,
		baseHeightMm,
		baseLengthMm: computePlateBaseLengthMm(holeSpacing, slotDims.widthMm, endPadding)
	};
}

type ResolvedPlateFootprint = {
	halfLengthMm: number;
	halfHeightMm: number;
	cornerRadiusMm: number;
	slotCenterXMm: number;
};

function resolvePlateFootprint(bar: PlateBarParams = defaultPlateBarParams()): ResolvedPlateFootprint {
	const normalized = normalizePlateBarParams(bar);
	const halfHeightMm = normalized.baseHeightMm / 2;
	return {
		halfLengthMm: normalized.baseLengthMm / 2,
		halfHeightMm,
		cornerRadiusMm: Math.min(PLATE_SPEC.cornerRadiusMm, halfHeightMm),
		slotCenterXMm: normalized.holeSpacingMm / 2
	};
}

/** Suggested keep-art box in mm (scales with bar length). */
export function plateDesignZone(bar: PlateBarParams = defaultPlateBarParams()): {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
} {
	const { halfLengthMm, halfHeightMm } = resolvePlateFootprint(bar);
	const scaleX = halfLengthMm / PLATE_SPEC.halfLengthMm;
	const scaleY = halfHeightMm / PLATE_SPEC.halfHeightMm;
	const dz = PLATE_SPEC.designZone;
	return {
		minX: dz.minX * scaleX,
		maxX: dz.maxX * scaleX,
		minY: dz.minY * scaleY,
		maxY: dz.maxY * scaleY
	};
}

/** Small Z gap so raised elements sit above the base stack without coplanar faces. */
export const PLATE_ELEMENT_ABOVE_BASE_GAP_MM = 0.05;

export const PLATE_ELEMENT_DEPTH_MIN_MM = 0.2;
export const PLATE_ELEMENT_DEPTH_MAX_MM = 8;

export function clampPlateElementDepthMm(mm: number): number {
	const n = Number(mm);
	const v = Number.isFinite(n) ? n : 3;
	return Math.min(PLATE_ELEMENT_DEPTH_MAX_MM, Math.max(PLATE_ELEMENT_DEPTH_MIN_MM, v));
}

/** Extrusion height and bottom Z for raised element meshes — always above the base/outline stack. */
export function plateBadgeElementLayer3D(
	baseThicknessMm: number,
	elementDepthMm: number
): { extrudeDepthMm: number; bottomZMm: number } {
	const baseTopZ = Math.max(0.1, baseThicknessMm);
	return {
		extrudeDepthMm: clampPlateElementDepthMm(elementDepthMm),
		bottomZMm: baseTopZ + PLATE_ELEMENT_ABOVE_BASE_GAP_MM
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
export function getPlateMountingSlotClipperPaths(
	dims: PlateSlotDimensions = defaultPlateSlotDimensions(),
	bar: PlateBarParams = defaultPlateBarParams()
): ClipperPaths {
	const { halfLongMm: slotHalfLongMm, halfShortMm: slotHalfShortMm } = slotHalfDims(
		normalizePlateSlotDimensions(dims)
	);
	const { slotCenterXMm } = resolvePlateFootprint(bar);
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
export function subtractPlateMountingSlotsFromPolyTree(
	tree: unknown,
	dims: PlateSlotDimensions = defaultPlateSlotDimensions(),
	bar: PlateBarParams = defaultPlateBarParams()
): unknown {
	let slotClip = getPlateMountingSlotClipperPaths(dims, bar);
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

/** Minimum overlap between an element footprint and the plate bar (mm). */
export const PLATE_ELEMENT_MIN_ATTACHMENT_MM = 3;

function clipperPathsBboxMm(paths: ClipperPaths): {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
} {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const path of paths) {
		for (const p of path) {
			const px = p.X / CLIPPER_SCALE;
			const py = p.Y / CLIPPER_SCALE;
			if (px < minX) minX = px;
			if (px > maxX) maxX = px;
			if (py < minY) minY = py;
			if (py > maxY) maxY = py;
		}
	}
	if (!Number.isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
	return { minX, maxX, minY, maxY };
}

function clampBetween(n: number, min: number, max: number): number {
	if (min > max) return (min + max) / 2;
	return Math.min(max, Math.max(min, n));
}

/** Allowed center range so the element keeps at least `PLATE_ELEMENT_MIN_ATTACHMENT_MM` on the plate. */
export function plateElementCenterLimits(
	el: CanvasElement,
	bar: PlateBarParams = defaultPlateBarParams()
): { xMin: number; xMax: number; yMin: number; yMax: number } {
	const { halfLengthMm: hw, halfHeightMm: hh } = resolvePlateFootprint(bar);
	const attach = PLATE_ELEMENT_MIN_ATTACHMENT_MM;
	const local = getLocalPathsForElement(el);
	if (local.length === 0) {
		return { xMin: -hw, xMax: hw, yMin: -hh, yMax: hh };
	}
	const atOrigin = transformClipperPaths(local, 0, 0, el.rotation, el.scaleX, el.scaleY);
	const b = clipperPathsBboxMm(atOrigin);
	return {
		xMin: -hw + attach - b.maxX,
		xMax: hw - attach - b.minX,
		yMin: -hh + attach - b.maxY,
		yMax: hh - attach - b.minY
	};
}

/** Clamp element center — allows extending past the bar if a few mm still overlap the plate. */
export function clampElementCenterToPlate(
	x: number,
	y: number,
	bar: PlateBarParams = defaultPlateBarParams(),
	element?: CanvasElement
): { x: number; y: number } {
	if (!element) {
		const { halfLengthMm: hw, halfHeightMm: hh } = resolvePlateFootprint(bar);
		return {
			x: Math.max(-hw, Math.min(hw, x)),
			y: Math.max(-hh, Math.min(hh, y))
		};
	}
	const { xMin, xMax, yMin, yMax } = plateElementCenterLimits(element, bar);
	return {
		x: clampBetween(x, xMin, xMax),
		y: clampBetween(y, yMin, yMax)
	};
}

function shapePolygonPointsList2D(shape: THREE.Shape, divisions: number): string {
	const pts = shape.getPoints(divisions).map((p) => ({ x: p.x, y: p.y }));
	const v2 = pts.map((p) => new THREE.Vector2(p.x, p.y));
	if (THREE.ShapeUtils.isClockWise(v2)) pts.reverse();
	return '[' + pts.map((p) => `[${p.x.toFixed(5)}, ${p.y.toFixed(5)}]`).join(', ') + ']';
}

/** OpenSCAD source: stadium plate with two through-slots (manifold `difference`). */
export function getPlateBaseOpenScadSource(
	depthMm: number,
	dims: PlateSlotDimensions = defaultPlateSlotDimensions(),
	bar: PlateBarParams = defaultPlateBarParams()
): string {
	const { halfLengthMm: HW, halfHeightMm: HH, cornerRadiusMm: CR, slotCenterXMm: scx } =
		resolvePlateFootprint(bar);
	const { halfLongMm: sL, halfShortMm: sW } = slotHalfDims(normalizePlateSlotDimensions(dims));
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

function unionClipperPolyTrees(trees: unknown[]): unknown {
	const subject: ClipperPaths = [];
	for (const tree of trees) subject.push(...collectPolyTreeContours(tree));
	const result = new ClipperLib.PolyTree();
	if (subject.length === 0) return result;
	const c = new ClipperLib.Clipper();
	c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
	c.Execute(
		ClipperLib.ClipType.ctUnion,
		result,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	return result;
}

/** Plate bar footprint with mounting slots cut (2D plan view, mm). */
export function plateBarWithSlotsPolyTree(
	dims: PlateSlotDimensions = defaultPlateSlotDimensions(),
	bar: PlateBarParams = defaultPlateBarParams()
): unknown {
	const outer = stadiumOuterClipperPath(bar);
	const tree = new ClipperLib.PolyTree();
	if (outer.length < 3) return tree;
	const c = new ClipperLib.Clipper();
	c.AddPath(outer, ClipperLib.PolyType.ptSubject, true);
	const slots = getPlateMountingSlotClipperPaths(dims, bar);
	if (slots.length > 0) c.AddPaths(slots, ClipperLib.PolyType.ptClip, true);
	c.Execute(
		ClipperLib.ClipType.ctDifference,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	return tree;
}

/**
 * Plan-view silhouette of the merged 3D base: plate bar (slots cut) ∪ element outline frames.
 */
export function plateBaseSilhouettePolyTree(
	elements: CanvasElement[],
	outlineWidthMm: number,
	dims: PlateSlotDimensions = defaultPlateSlotDimensions(),
	bar: PlateBarParams = defaultPlateBarParams()
): unknown {
	const trees: unknown[] = [plateBarWithSlotsPolyTree(dims, bar)];
	const w = Math.max(0, outlineWidthMm);
	if (w > 0) {
		for (const el of elements) {
			trees.push(
				subtractPlateMountingSlotsFromPolyTree(getElementOutlinePolyTree(el, w), dims, bar)
			);
		}
	}
	return unionClipperPolyTrees(trees);
}

export function plateBaseSilhouetteKonvaPathD(
	elements: CanvasElement[],
	outlineWidthMm: number,
	dims: PlateSlotDimensions = defaultPlateSlotDimensions(),
	bar: PlateBarParams = defaultPlateBarParams()
): string {
	return polyTreeToKonvaPathD(plateBaseSilhouettePolyTree(elements, outlineWidthMm, dims, bar));
}

function stadiumOuterClipperPath(bar: PlateBarParams = defaultPlateBarParams()): ClipperPath {
	const { halfLengthMm: HW, halfHeightMm: HH, cornerRadiusMm: CR } = resolvePlateFootprint(bar);
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
export function buildPlateBaseMeshPreview(
	depthMm: number,
	color: string,
	dims: PlateSlotDimensions = defaultPlateSlotDimensions(),
	bar: PlateBarParams = defaultPlateBarParams()
): THREE.Mesh {
	const d = Math.max(0.1, depthMm);
	const tree = plateBarWithSlotsPolyTree(dims, bar);
	const shapes = polyTreeToThreeShapes(tree);
	if (shapes.length === 0) return buildPlateOuterMeshPreview(depthMm, color, bar);

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
export function buildPlateOuterMeshPreview(
	depthMm: number,
	color: string,
	bar: PlateBarParams = defaultPlateBarParams()
): THREE.Mesh {
	const d = Math.max(0.1, depthMm);
	const { halfLengthMm: HW, halfHeightMm: HH, cornerRadiusMm: CR } = resolvePlateFootprint(bar);
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
	color: string,
	dims: PlateSlotDimensions = defaultPlateSlotDimensions(),
	bar: PlateBarParams = defaultPlateBarParams()
): Promise<THREE.Mesh> {
	const source = getPlateBaseOpenScadSource(depthMm, dims, bar);
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
	outlineMeshes: THREE.Mesh[],
	dims: PlateSlotDimensions = defaultPlateSlotDimensions(),
	bar: PlateBarParams = defaultPlateBarParams()
): Promise<THREE.Mesh> {
	const baseMesh = await buildPlateBaseMeshFromOpenScad(depthMm, color, dims, bar);
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

export function plateOuterKonvaPathD(bar: PlateBarParams = defaultPlateBarParams()): string {
	const { halfLengthMm, halfHeightMm, cornerRadiusMm } = resolvePlateFootprint(bar);
	const corner = Math.min(cornerRadiusMm, halfLengthMm, halfHeightMm);
	const outer = createRoundedRectShape(halfLengthMm, halfHeightMm, corner);
	return shapeToKonvaPathD(outer, true);
}

export function plateSlotKonvaPathD(
	sign: -1 | 1,
	dims: PlateSlotDimensions = defaultPlateSlotDimensions(),
	bar: PlateBarParams = defaultPlateBarParams()
): string {
	const { halfLongMm: slotHalfLongMm, halfShortMm: slotHalfShortMm } = slotHalfDims(
		normalizePlateSlotDimensions(dims)
	);
	const { slotCenterXMm } = resolvePlateFootprint(bar);
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
