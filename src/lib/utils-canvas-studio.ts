/**
 * Shared helpers for the Canvas Studio designer: types, defaults, and 2D
 * path utilities for converting element silhouettes into Clipper paths
 * (used for outline / base-shape derivation) and the 2D→3D pipeline.
 */

import ClipperLib from 'clipper-lib';
import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { getFont, FONT_OPTIONS } from './utils-3d';
import { getShape } from './assets/svg/shapes/index';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BaseElement {
	id: string;
	/** Center position in mm, artboard space (origin = artboard center, Y-up). */
	x: number;
	y: number;
	/** Rotation in radians, CCW. */
	rotation: number;
	scaleX: number;
	scaleY: number;
	color: string;
	/** Extrusion thickness in mm, used in phase 2. */
	depth: number;
	/** @deprecated Plate badge always renders a base-colored outline frame in 3D. */
	outlineEnabled?: boolean;
	/** @deprecated Plate badge outline width is a global plate setting. */
	outlineThickness?: number;
}

export interface TextElement extends BaseElement {
	kind: 'text';
	content: string;
	fontKey: string;
	/** Cap-height in mm. */
	size: number;
}

export interface ShapeElement extends BaseElement {
	kind: 'shape';
	shapeId: string;
	/** Bounding-box width target in mm (height follows aspect ratio). */
	size: number;
}

export type CanvasElement = TextElement | ShapeElement;

export type BaseMode = 'none' | 'outline' | 'rectangle' | 'circle';

export interface BaseParams {
	padding: number;
	cornerRadius: number;
	outlineThickness: number;
	baseDepth: number;
	baseColor: string;
}

/** Where on the base bbox the keyring's (offsetX, offsetY) is measured *from*.
 *  Two-letter code: first letter is vertical (`t`/`m`/`b`), second is
 *  horizontal (`l`/`c`/`r`). `mc` = bbox center. */
export type KeyringOrigin =
	| 'tl'
	| 'tc'
	| 'tr'
	| 'ml'
	| 'mc'
	| 'mr'
	| 'bl'
	| 'bc'
	| 'br';

export const KEYRING_ORIGINS: readonly KeyringOrigin[] = [
	'tl',
	'tc',
	'tr',
	'ml',
	'mc',
	'mr',
	'bl',
	'bc',
	'br'
] as const;

export interface KeyringParams {
	enabled: boolean;
	/** Outer ring diameter in mm. In `outline` base mode the outer ring is
	 *  unioned into the 2D shape so the keyring has material around it. In
	 *  rectangle/circle modes the outer ring is ignored (the base itself
	 *  already supplies material). */
	outerSize: number;
	/** Hole diameter in mm – drilled through the base in every mode. */
	holeSize: number;
	/** Where the keyring offset is anchored on the base bbox (e.g. 'tc' =
	 *  top-center, 'br' = bottom-right). */
	origin: KeyringOrigin;
	/** Offset of the keyring center from the anchor, in mm. Positive X = right,
	 *  positive Y = up (matching the canvas-studio Y-up convention). */
	offsetX: number;
	offsetY: number;
}

/** Resolve the world-space anchor point for a keyring origin code, given a
 *  bbox in mm. */
export function keyringAnchorMm(
	bbox: { minX: number; maxX: number; minY: number; maxY: number },
	origin: KeyringOrigin
): { x: number; y: number } {
	const cx = (bbox.minX + bbox.maxX) / 2;
	const cy = (bbox.minY + bbox.maxY) / 2;
	const halfW = (bbox.maxX - bbox.minX) / 2;
	const halfH = (bbox.maxY - bbox.minY) / 2;
	const horiz = origin[1];
	const vert = origin[0];
	const x = horiz === 'l' ? cx - halfW : horiz === 'r' ? cx + halfW : cx;
	const y = vert === 't' ? cy + halfH : vert === 'b' ? cy - halfH : cy;
	return { x, y };
}

/** Persisted 2D canvas viewport — Konva stage scale + screen-pixel offset.
 *  Allows pan/zoom to survive phase changes (3D ↔ layout) and page reloads. */
export interface CanvasStudioViewport {
	scale: number;
	x: number;
	y: number;
}

export interface CanvasStudioSettings {
	artboard: { width: number; height: number };
	elements: CanvasElement[];
	baseMode: BaseMode;
	baseParams: BaseParams;
	keyring: KeyringParams;
	scale: number;
	phase: 'layout' | 'threeD';
	viewport?: CanvasStudioViewport;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_ARTBOARD = { width: 80, height: 50 };

export const DEFAULT_BASE_PARAMS: BaseParams = {
	padding: 4,
	cornerRadius: 6,
	outlineThickness: 2,
	baseDepth: 2,
	baseColor: '#ec4899'
};

/** Matches Canvas Studio outline-base slider range (mm). */
export const ELEMENT_OUTLINE_THICKNESS_MIN_MM = 0.5;
export const ELEMENT_OUTLINE_THICKNESS_MAX_MM = 10;

export function clampElementOutlineThicknessMm(mm: number): number {
	const n = Number(mm);
	const base = Number.isFinite(n) ? n : DEFAULT_BASE_PARAMS.outlineThickness;
	return Math.min(
		ELEMENT_OUTLINE_THICKNESS_MAX_MM,
		Math.max(ELEMENT_OUTLINE_THICKNESS_MIN_MM, base)
	);
}

/** Plan-view rim width for a plate-badge element outline frame. */
export function effectiveElementOutlineThicknessMm(
	el: CanvasElement,
	fallbackMm = DEFAULT_BASE_PARAMS.outlineThickness
): number {
	const raw = el.outlineThickness ?? fallbackMm;
	return clampElementOutlineThicknessMm(raw);
}

/** Plate badge: outline offset and extrusion height both match base plate depth (mm). */
export function plateBadgeOutlineThicknessMm(baseDepthMm: number): number {
	return Math.max(0.1, baseDepthMm);
}

export const DEFAULT_KEYRING: KeyringParams = {
	enabled: true,
	outerSize: 10,
	holeSize: 5,
	origin: 'tc',
	offsetX: 0,
	offsetY: 0
};

export const DEFAULT_ELEMENT_COLORS = ['#ffffff', '#ec4899', '#3b82f6', '#22c55e', '#eab308'];

export function defaultSettings(): CanvasStudioSettings {
	return {
		artboard: { ...DEFAULT_ARTBOARD },
		elements: [
			{
				id: makeId(),
				kind: 'text',
				content: 'Name',
				fontKey: 'Titan One_Regular',
				size: 14,
				x: 0,
				y: 0,
				rotation: 0,
				scaleX: 1,
				scaleY: 1,
				color: '#ffffff',
				depth: 1.5
			}
		],
		// 'outline' matches how TextOutlineDesigner / CustomSVGDesigner derive a
		// hugging base around the geometry – feels like the most natural default
		// for an open canvas (no fixed artboard rectangle to fall back on).
		baseMode: 'outline',
		baseParams: { ...DEFAULT_BASE_PARAMS },
		keyring: { ...DEFAULT_KEYRING },
		scale: 1,
		phase: 'layout'
	};
}

// ── Misc ─────────────────────────────────────────────────────────────────────

export function makeId(): string {
	return `el_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

export function isTextElement(el: CanvasElement): el is TextElement {
	return el.kind === 'text';
}

export function isShapeElement(el: CanvasElement): el is ShapeElement {
	return el.kind === 'shape';
}

export function elementLabel(el: CanvasElement): string {
	if (el.kind === 'text') return (el.content || 'Text').trim().slice(0, 20) || 'Text';
	const def = getShape(el.shapeId);
	return def ? def.label : 'Shape';
}

export function isValidFontKey(key: string): boolean {
	return FONT_OPTIONS.some((o) => o.key === key);
}

// ── Clipper helpers ──────────────────────────────────────────────────────────

export const CLIPPER_SCALE = 1000;

export type ClipperPath = { X: number; Y: number }[];
export type ClipperPaths = ClipperPath[];

function ensureCW(path: ClipperPath, clockwise: boolean): void {
	if (path.length < 3) return;
	const isCW = ClipperLib.Clipper.Orientation(path);
	if (isCW !== clockwise) path.reverse();
}

/** Convert a single `THREE.Shape` (with optional holes) to oriented Clipper paths. */
function shapeToClipperPaths(shape: THREE.Shape, divisions: number, flipY: boolean): ClipperPaths {
	const sign = flipY ? -1 : 1;
	const toPath = (pts: THREE.Vector2[]): ClipperPath => {
		const out: ClipperPath = [];
		for (const p of pts) {
			out.push({
				X: Math.round(p.x * CLIPPER_SCALE),
				Y: Math.round(p.y * sign * CLIPPER_SCALE)
			});
		}
		if (out.length > 2) {
			const a = out[0];
			const b = out[out.length - 1];
			if (a.X === b.X && a.Y === b.Y) out.pop();
		}
		return out;
	};
	const outer = toPath(shape.getPoints(divisions));
	const result: ClipperPaths = [];
	if (outer.length >= 3) {
		ensureCW(outer, true);
		result.push(outer);
	}
	for (const h of shape.holes || []) {
		const hp = toPath(h.getPoints(divisions));
		if (hp.length >= 3) {
			ensureCW(hp, false);
			result.push(hp);
		}
	}
	return result;
}

/** Affine-transform Clipper paths by translation/rotation/scale (mm units / radians). */
export function transformClipperPaths(
	paths: ClipperPaths,
	tx: number,
	ty: number,
	rotation: number,
	scaleX: number,
	scaleY: number
): ClipperPaths {
	const c = Math.cos(rotation);
	const s = Math.sin(rotation);
	const txInt = tx * CLIPPER_SCALE;
	const tyInt = ty * CLIPPER_SCALE;
	const out: ClipperPaths = [];
	for (const path of paths) {
		const newPath: ClipperPath = path.map((p) => {
			const x = p.X * scaleX;
			const y = p.Y * scaleY;
			const xr = x * c - y * s;
			const yr = x * s + y * c;
			return { X: Math.round(xr + txInt), Y: Math.round(yr + tyInt) };
		});
		if (scaleX * scaleY < 0) newPath.reverse();
		out.push(newPath);
	}
	return out;
}

/** Generate Clipper paths in local element coordinates (centered on origin, mm units). */
export function getLocalPathsForElement(el: CanvasElement): ClipperPaths {
	if (el.kind === 'text') {
		const font = getFont(el.fontKey);
		if (!font) return [];
		let shapes: THREE.Shape[] = [];
		try {
			shapes = font.generateShapes(el.content || ' ', Math.max(1, el.size));
		} catch (e) {
			console.error('canvas-studio: text generateShapes failed', e);
			return [];
		}
		const paths: ClipperPaths = [];
		for (const s of shapes) paths.push(...shapeToClipperPaths(s, 18, false));
		return centerPathsXY(paths);
	}
	// Shape element
	const def = getShape(el.shapeId);
	if (!def) return [];
	let parsed;
	try {
		parsed = new SVGLoader().parse(def.rawSvg);
	} catch (e) {
		console.error('canvas-studio: SVG parse failed', e);
		return [];
	}
	const shapes: THREE.Shape[] = [];
	for (const p of parsed.paths) {
		// Skip decorator / invisible paths (e.g. MingCute icons inherit
		// `fill="none"` from a wrapper `<g>` for a hidden bbox path that
		// would otherwise poison the extruded geometry + bbox-based sizing).
		const style = (p.userData as { style?: { fill?: string; fillOpacity?: number } } | undefined)
			?.style;
		if (style && (style.fill === 'none' || style.fillOpacity === 0)) continue;
		const ps = SVGLoader.createShapes(p);
		for (const s of ps) shapes.push(s);
	}
	const raw: ClipperPaths = [];
	for (const s of shapes) raw.push(...shapeToClipperPaths(s, 20, true));
	if (raw.length === 0) return [];

	// Normalize to el.size = target width (mm) and recenter
	const bbox = pathsBbox(raw);
	const w = (bbox.maxX - bbox.minX) / CLIPPER_SCALE;
	if (w <= 0.001) return [];
	const targetWidth = Math.max(0.5, el.size);
	const scale = targetWidth / w;
	const centered = centerPathsXY(raw);
	return scaleClipperPaths(centered, scale, scale);
}

/** Clipper paths in artboard space (mm), with the element's transform applied. */
export function getWorldPathsForElement(el: CanvasElement): ClipperPaths {
	const local = getLocalPathsForElement(el);
	return transformClipperPaths(local, el.x, el.y, el.rotation, el.scaleX, el.scaleY);
}

function pathsBbox(paths: ClipperPaths): {
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
			if (p.X < minX) minX = p.X;
			if (p.X > maxX) maxX = p.X;
			if (p.Y < minY) minY = p.Y;
			if (p.Y > maxY) maxY = p.Y;
		}
	}
	if (!isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
	return { minX, maxX, minY, maxY };
}

function centerPathsXY(paths: ClipperPaths): ClipperPaths {
	const b = pathsBbox(paths);
	const cx = (b.minX + b.maxX) / 2;
	const cy = (b.minY + b.maxY) / 2;
	return paths.map((p) => p.map((pt) => ({ X: pt.X - cx, Y: pt.Y - cy })));
}

function scaleClipperPaths(paths: ClipperPaths, sx: number, sy: number): ClipperPaths {
	const out: ClipperPaths = paths.map((path) =>
		path.map((p) => ({ X: Math.round(p.X * sx), Y: Math.round(p.Y * sy) }))
	);
	if (sx * sy < 0) out.forEach((p) => p.reverse());
	return out;
}

/** Union all element silhouettes into a single PolyTree (artboard-space, mm). */
export function unionOfElementPaths(elements: CanvasElement[]): unknown {
	const subject: ClipperPaths = [];
	for (const el of elements) {
		const paths = getWorldPathsForElement(el);
		subject.push(...paths);
	}
	const tree = new ClipperLib.PolyTree();
	if (subject.length === 0) return tree;
	const c = new ClipperLib.Clipper();
	c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
	c.Execute(
		ClipperLib.ClipType.ctUnion,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	return tree;
}

/** Apply ClipperOffset to the union of element paths and return the resulting PolyTree. */
export function offsetUnionPaths(elements: CanvasElement[], offsetMm: number): unknown {
	const inputPaths: ClipperPaths = [];
	for (const el of elements) {
		const paths = getWorldPathsForElement(el);
		inputPaths.push(...paths);
	}
	const tree = new ClipperLib.PolyTree();
	if (inputPaths.length === 0) return tree;
	if (offsetMm <= 0) {
		const c = new ClipperLib.Clipper();
		c.AddPaths(inputPaths, ClipperLib.PolyType.ptSubject, true);
		c.Execute(
			ClipperLib.ClipType.ctUnion,
			tree,
			ClipperLib.PolyFillType.pftNonZero,
			ClipperLib.PolyFillType.pftNonZero
		);
		return tree;
	}
	const co = new ClipperLib.ClipperOffset(2, 2);
	co.AddPaths(inputPaths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
	const offsetPaths: ClipperPaths = [];
	co.Execute(offsetPaths, offsetMm * CLIPPER_SCALE);
	const c2 = new ClipperLib.Clipper();
	c2.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
	c2.Execute(
		ClipperLib.ClipType.ctUnion,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	return tree;
}

/** Compute the bounding box (in mm) of all contours in a PolyTree.
 *  Returns null when the tree is empty. */
export function polyTreeBboxMm(
	tree: unknown
): { minX: number; maxX: number; minY: number; maxY: number } | null {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	const collect = (node: any) => {
		const contour = node.Contour?.() ?? node.m_polygon ?? [];
		for (const p of contour) {
			if (p.X < minX) minX = p.X;
			if (p.X > maxX) maxX = p.X;
			if (p.Y < minY) minY = p.Y;
			if (p.Y > maxY) maxY = p.Y;
		}
		const childs = node.Childs?.() ?? node.m_Childs ?? [];
		childs.forEach(collect);
	};
	const t = tree as any;
	const roots = t.Childs?.() ?? t.m_Childs ?? [];
	roots.forEach(collect);
	if (!isFinite(minX)) return null;
	return {
		minX: minX / CLIPPER_SCALE,
		maxX: maxX / CLIPPER_SCALE,
		minY: minY / CLIPPER_SCALE,
		maxY: maxY / CLIPPER_SCALE
	};
}

/** Build a Clipper path approximating a circle. `clockwise` selects winding. */
function clipperCirclePath(
	cx: number,
	cy: number,
	r: number,
	clockwise: boolean,
	segs = 64
): ClipperPath {
	const path: ClipperPath = [];
	for (let i = 0; i < segs; i++) {
		const t = (i / segs) * Math.PI * 2;
		path.push({
			X: Math.round((cx + r * Math.cos(t)) * CLIPPER_SCALE),
			Y: Math.round((cy + r * Math.sin(t)) * CLIPPER_SCALE)
		});
	}
	if (path.length < 3) return path;
	const isCW = ClipperLib.Clipper.Orientation(path);
	if (isCW !== clockwise) path.reverse();
	return path;
}

/** Sample a THREE.Shape's outer contour into a single Clipper path. Holes on
 *  the shape are ignored (the base shapes we use for keyring unioning are
 *  always solid: rectangle / circle / outline). */
export function threeShapeToClipperTree(shape: THREE.Shape, segs = 64): unknown {
	const pts = shape.getPoints(segs);
	if (pts.length < 3) return new ClipperLib.PolyTree();
	const path: ClipperPath = pts.map((p) => ({
		X: Math.round(p.x * CLIPPER_SCALE),
		Y: Math.round(p.y * CLIPPER_SCALE)
	}));
	const tree = new ClipperLib.PolyTree();
	const c = new ClipperLib.Clipper();
	c.AddPath(path, ClipperLib.PolyType.ptSubject, true);
	c.Execute(
		ClipperLib.ClipType.ctUnion,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	return tree;
}

/** Walk a PolyTree and collect every outer (non-hole) contour into a flat list. */
export function collectPolyTreeOuterPaths(tree: unknown): ClipperPaths {
	const out: ClipperPaths = [];
	const walk = (node: any) => {
		const isHole = node.IsHole?.() ?? node.m_IsHole;
		if (!isHole) {
			const contour = node.Contour?.() ?? node.m_polygon ?? [];
			if (contour.length >= 3) out.push(contour);
		}
		const childs = node.Childs?.() ?? node.m_Childs ?? [];
		childs.forEach(walk);
	};
	const t = tree as any;
	const roots = t.Childs?.() ?? t.m_Childs ?? [];
	roots.forEach(walk);
	return out;
}

/** Union a circle (the keyring outer ring) into an existing PolyTree.
 *  Returns a new PolyTree containing the merged shape. */
export function unionTreeWithCircle(
	tree: unknown,
	cx: number,
	cy: number,
	r: number,
	segs = 64
): unknown {
	if (r <= 0) return tree;
	const outerPaths = collectPolyTreeOuterPaths(tree);
	const ring = clipperCirclePath(cx, cy, r, true, segs);
	const out = new ClipperLib.PolyTree();
	const c = new ClipperLib.Clipper();
	for (const p of outerPaths) c.AddPath(p, ClipperLib.PolyType.ptSubject, true);
	c.AddPath(ring, ClipperLib.PolyType.ptSubject, true);
	c.Execute(
		ClipperLib.ClipType.ctUnion,
		out,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	return out;
}

/**
 * Expanded outline silhouette for one element (TextOutline / Cake Topper recipe):
 * offset all contours, union — not a ring/difference. Extrude this as the frame; put the fill mesh on top.
 */
export function getElementOutlinePolyTree(el: CanvasElement, outlineWidthMm: number) {
	return offsetUnionPaths([el], Math.max(0, outlineWidthMm));
}

/** Convert a Clipper PolyTree to an array of `THREE.Shape` objects (with holes). */
export function polyTreeToThreeShapes(tree: unknown): THREE.Shape[] {
	const shapesOut: THREE.Shape[] = [];
	const toVec2 = (pt: { X: number; Y: number }) =>
		new THREE.Vector2(pt.X / CLIPPER_SCALE, pt.Y / CLIPPER_SCALE);

	const buildFromOuter = (outerNode: any): THREE.Shape | null => {
		const contour = outerNode.Contour?.() ?? outerNode.m_polygon ?? [];
		if (!contour || contour.length < 3) return null;
		const outerPts = contour.map(toVec2);
		if (THREE.ShapeUtils.isClockWise(outerPts)) outerPts.reverse();
		const shape = new THREE.Shape(outerPts);
		const children = outerNode.Childs?.() ?? outerNode.m_Childs ?? [];
		for (const ch of children) {
			const isHole = ch.IsHole?.() ?? ch.m_IsHole;
			if (!isHole) continue;
			const holeContour = ch.Contour?.() ?? ch.m_polygon ?? [];
			if (holeContour.length >= 3) {
				const holePts = holeContour.map(toVec2);
				if (!THREE.ShapeUtils.isClockWise(holePts)) holePts.reverse();
				shape.holes.push(new THREE.Path(holePts));
			}
			const holeKids = ch.Childs?.() ?? ch.m_Childs ?? [];
			for (const hk of holeKids) {
				const hkIsHole = hk.IsHole?.() ?? hk.m_IsHole;
				if (!hkIsHole) {
					const inner = buildFromOuter(hk);
					if (inner) shapesOut.push(inner);
				}
			}
		}
		return shape;
	};

	const shapeFromContour = (contour: { X: number; Y: number }[]): THREE.Shape | null => {
		if (!contour || contour.length < 3) return null;
		const pts = contour.map(toVec2);
		if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
		return new THREE.Shape(pts);
	};

	const roots = (tree as any).Childs?.() ?? (tree as any).m_Childs ?? [];
	for (const n of roots) {
		const isHole = n.IsHole?.() ?? n.m_IsHole;
		if (!isHole) {
			const s = buildFromOuter(n);
			if (s) shapesOut.push(s);
			continue;
		}
		// Difference rings for text can surface as hole-flagged root loops; still extrude them.
		const contour = n.Contour?.() ?? n.m_polygon ?? [];
		const s = shapeFromContour(contour);
		if (s) shapesOut.push(s);
	}
	return shapesOut;
}

/** AABB in mm of all element world paths. Returns null when there are no elements. */
export function elementsBoundsMm(elements: CanvasElement[]): {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
} | null {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const el of elements) {
		const paths = getWorldPathsForElement(el);
		const b = pathsBbox(paths);
		if (b.maxX - b.minX === 0 && b.maxY - b.minY === 0) continue;
		const mnx = b.minX / CLIPPER_SCALE;
		const mxx = b.maxX / CLIPPER_SCALE;
		const mny = b.minY / CLIPPER_SCALE;
		const mxy = b.maxY / CLIPPER_SCALE;
		if (mnx < minX) minX = mnx;
		if (mxx > maxX) maxX = mxx;
		if (mny < minY) minY = mny;
		if (mxy > maxY) maxY = mxy;
	}
	if (!isFinite(minX)) return null;
	return { minX, maxX, minY, maxY };
}
