/**
 * Monogram Insert — large letter with tolerance pocket + separate name insert.
 */
import ClipperLib, { type PolyTree } from 'clipper-lib';
import * as THREE from 'three';
import type { Shape } from 'three';
import { runOpenScad } from '$lib/openscad';
import { centerGeometryXY, stlToBufferGeometry } from '$lib/utils-3d';

const SCALE = 1000;
const CLIPPER_DIVISIONS_EXPORT = 6;
const CLIPPER_DIVISIONS_PREVIEW = 10;
const BOOLEAN_Z_SLOP_MM = 0.02;
export const EXTRA_CUT_MM = 0.2;

export const DESIGN_NAME = 'Monogram Insert';
export const STORAGE_KEY = 'initial-and-name-settings-v1';
export const DEFAULT_INITIAL_FONT_KEY = 'Varsity Relaxa Slab';
export const DEFAULT_NAME_FONT_KEY = 'Pacifico_Regular';
export const DEFAULT_NAME_TEXT = 'Name';

export const DEFAULT_INITIAL_SIZE_MM = 200;
export const DEFAULT_NAME_SIZE_MM = 50;
export const DEFAULT_LETTER_THICKNESS_MM = 40;
export const DEFAULT_NAME_THICKNESS_MM = 20;
export const DEFAULT_POCKET_DEPTH_MM = 10;
export const DEFAULT_TOLERANCE_MM = 0.26;
export const DEFAULT_NAME_OFFSET_X_MM = 0;
export const DEFAULT_NAME_OFFSET_Y_MM = -10;

export type InitialAndNameFont = {
	generateShapes(text: string, size: number): Shape[];
};

export type InitialAndNameParams = {
	initialFontKey: string;
	nameFontKey: string;
	nameText: string;
	initialChar: string;
	initialSizeMm: number;
	nameSizeMm: number;
	letterThicknessMm: number;
	nameThicknessMm: number;
	pocketDepthMm: number;
	toleranceMm: number;
	nameOffsetXMm: number;
	nameOffsetYMm: number;
};

export function effectiveLargeInitial(letterOverride: string, bodyText: string): string {
	const trimmed = letterOverride.trim();
	if (trimmed) return trimmed.slice(0, 1).toUpperCase();
	const fromText = (bodyText || '').trim();
	if (fromText) return fromText.slice(0, 1).toUpperCase();
	return 'A';
}

function ensureCW(path: { X: number; Y: number }[], clockwise: boolean) {
	if (ClipperLib.Clipper.Orientation(path) !== clockwise) path.reverse();
}

function shapeToPaths(shape: Shape, divisions: number) {
	const pts = shape.getPoints(divisions);
	const outer: { X: number; Y: number }[] = [];
	for (const p of pts) outer.push({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) });
	const holes: { X: number; Y: number }[][] = [];
	for (const hole of shape.holes) {
		const hpts = hole.getPoints(divisions);
		const h: { X: number; Y: number }[] = [];
		for (const p of hpts) h.push({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) });
		if (h.length >= 3) holes.push(h);
	}
	return { outer, holes };
}

function pathsFromShapes(shapes: Shape[], divisions: number): { X: number; Y: number }[][] {
	const paths: { X: number; Y: number }[][] = [];
	for (const s of shapes) {
		const { outer, holes } = shapeToPaths(s, divisions);
		if (outer.length < 3) continue;
		ensureCW(outer, true);
		paths.push(outer);
		for (const h of holes) {
			if (h.length < 3) continue;
			ensureCW(h, false);
			paths.push(h);
		}
	}
	return paths;
}

function unionPaths(paths: { X: number; Y: number }[][], divisions: number): PolyTree {
	const tree = new ClipperLib.PolyTree();
	if (!paths.length) return tree;
	const c = new ClipperLib.Clipper();
	c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
	c.Execute(
		ClipperLib.ClipType.ctUnion,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	void divisions;
	return tree;
}

function polyTreeToThreeShapes(tree: PolyTree): Shape[] {
	const shapesOut: Shape[] = [];
	const toVec2 = (pt: { X: number; Y: number }) => new THREE.Vector2(pt.X / SCALE, pt.Y / SCALE);
	const buildFromOuter = (outerNode: {
		Contour?: () => { X: number; Y: number }[];
		m_polygon?: { X: number; Y: number }[];
		Childs?: () => unknown[];
		m_Childs?: unknown[];
		IsHole?: () => boolean;
		m_IsHole?: boolean;
	}): Shape | undefined => {
		const contour = outerNode.Contour?.() ?? outerNode.m_polygon ?? [];
		if (!contour || contour.length < 3) return undefined;
		const shape = new THREE.Shape(contour.map(toVec2));
		const children = outerNode.Childs?.() ?? outerNode.m_Childs ?? [];
		for (const ch of children) {
			const node = ch as typeof outerNode;
			const isHole = node.IsHole?.() ?? node.m_IsHole;
			if (!isHole) continue;
			const holeContour = node.Contour?.() ?? node.m_polygon ?? [];
			if (holeContour.length >= 3) shape.holes.push(new THREE.Path(holeContour.map(toVec2)));
		}
		return shape;
	};
	const roots = tree.Childs?.() ?? (tree as { m_Childs?: unknown[] }).m_Childs ?? [];
	for (const n of roots) {
		const node = n as Parameters<typeof buildFromOuter>[0];
		const isHole = node.IsHole?.() ?? node.m_IsHole;
		if (isHole) continue;
		const s = buildFromOuter(node);
		if (s) shapesOut.push(s);
	}
	return shapesOut;
}

function bboxPolyTreeMm(tree: PolyTree): {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
} {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	const walk = (node: {
		Contour?: () => { X: number; Y: number }[];
		m_polygon?: { X: number; Y: number }[];
		Childs?: () => unknown[];
		m_Childs?: unknown[];
	}) => {
		const contour = node.Contour?.() ?? node.m_polygon ?? [];
		for (const p of contour) {
			const x = p.X / SCALE;
			const y = p.Y / SCALE;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
		const childs = node.Childs?.() ?? node.m_Childs ?? [];
		for (const ch of childs) walk(ch as typeof node);
	};
	const roots = tree.Childs?.() ?? (tree as { m_Childs?: unknown[] }).m_Childs ?? [];
	for (const r of roots) walk(r as Parameters<typeof walk>[0]);
	return { minX, maxX, minY, maxY };
}

function addOuterWithHolesToSvgParts(
	outerNode: {
		Contour?: () => { X: number; Y: number }[];
		m_polygon?: { X: number; Y: number }[];
		Childs?: () => unknown[];
		m_Childs?: unknown[];
		IsHole?: () => boolean;
		m_IsHole?: boolean;
	},
	minX: number,
	maxY: number,
	parts: string[]
) {
	const contour = outerNode.Contour?.() ?? outerNode.m_polygon ?? [];
	if (contour.length < 3) return;
	const toPt = (pt: { X: number; Y: number }) =>
		`${(pt.X / SCALE - minX).toFixed(4)},${(maxY - pt.Y / SCALE).toFixed(4)}`;
	parts.push(`M ${contour.map(toPt).join(' L ')} Z`);
	const children = outerNode.Childs?.() ?? outerNode.m_Childs ?? [];
	for (const ch of children) {
		const node = ch as typeof outerNode;
		const isHole = node.IsHole?.() ?? node.m_IsHole;
		if (!isHole) continue;
		const holeContour = node.Contour?.() ?? node.m_polygon ?? [];
		if (holeContour.length >= 3) parts.push(`M ${holeContour.map(toPt).join(' L ')} Z`);
	}
}

function polyTreeToSvg(
	tree: PolyTree,
	bbox: { minX: number; maxX: number; minY: number; maxY: number }
): string | null {
	const w = bbox.maxX - bbox.minX;
	const h = bbox.maxY - bbox.minY;
	if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
	const parts: string[] = [];
	const roots = tree.Childs?.() ?? (tree as { m_Childs?: unknown[] }).m_Childs ?? [];
	for (const n of roots) {
		const node = n as Parameters<typeof addOuterWithHolesToSvgParts>[0];
		const isHole = node.IsHole?.() ?? node.m_IsHole;
		if (isHole) continue;
		addOuterWithHolesToSvgParts(node, bbox.minX, bbox.maxY, parts);
	}
	if (!parts.length) return null;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(4)} ${h.toFixed(4)}"><path fill-rule="evenodd" d="${parts.join(' ')}" fill="black"/></svg>`;
}

function centerPolyTree(tree: PolyTree): PolyTree {
	const bb = bboxPolyTreeMm(tree);
	if (!Number.isFinite(bb.minX)) return tree;
	const cx = (bb.minX + bb.maxX) / 2;
	const cy = (bb.minY + bb.maxY) / 2;
	const shift = (paths: { X: number; Y: number }[][]) => {
		for (const path of paths) {
			for (const p of path) {
				p.X = Math.round((p.X / SCALE - cx) * SCALE);
				p.Y = Math.round((p.Y / SCALE - cy) * SCALE);
			}
		}
	};
	const allPaths: { X: number; Y: number }[][] = [];
	const collect = (node: {
		Contour?: () => { X: number; Y: number }[];
		m_polygon?: { X: number; Y: number }[];
		Childs?: () => unknown[];
		m_Childs?: unknown[];
	}) => {
		const contour = node.Contour?.() ?? node.m_polygon ?? [];
		if (contour.length >= 3) allPaths.push(contour.map((p) => ({ X: p.X, Y: p.Y })));
		const childs = node.Childs?.() ?? node.m_Childs ?? [];
		for (const ch of childs) collect(ch as typeof node);
	};
	const roots = tree.Childs?.() ?? (tree as { m_Childs?: unknown[] }).m_Childs ?? [];
	for (const r of roots) collect(r as Parameters<typeof collect>[0]);
	shift(allPaths);
	const out = unionPaths(allPaths, CLIPPER_DIVISIONS_EXPORT);
	return out;
}

function buildNameTree(
	font: InitialAndNameFont,
	text: string,
	sizeMm: number,
	divisions: number,
	toleranceMm = 0
): PolyTree {
	const content = (text || ' ').trim() || ' ';
	const shapes = font.generateShapes(content, Math.max(1, sizeMm));
	const paths = pathsFromShapes(shapes, divisions);
	if (!paths.length) return new ClipperLib.PolyTree();
	let tree = unionPaths(paths, divisions);
	if (toleranceMm > 0) {
		const tol = toleranceMm * SCALE;
		const co = new ClipperLib.ClipperOffset(2, 2);
		co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
		const offsetPaths: { X: number; Y: number }[][] = [];
		co.Execute(offsetPaths, tol);
		tree = unionPaths(offsetPaths, divisions);
	}
	return centerPolyTree(tree);
}

function buildInitialTree(
	font: InitialAndNameFont,
	char: string,
	sizeMm: number,
	divisions: number
): PolyTree {
	const letter = (char || 'A').slice(0, 1).toUpperCase();
	const shapes = font.generateShapes(letter, Math.max(1, sizeMm));
	const paths = pathsFromShapes(shapes, divisions);
	if (!paths.length) return new ClipperLib.PolyTree();
	return centerPolyTree(unionPaths(paths, divisions));
}

export function buildInitialAndNameOpenScadSvgs(
	initialFont: InitialAndNameFont,
	nameFont: InitialAndNameFont,
	p: InitialAndNameParams,
	divisions = CLIPPER_DIVISIONS_EXPORT
): { initialSvg: string; nameSvg: string } | null {
	const initialTree = buildInitialTree(initialFont, p.initialChar, p.initialSizeMm, divisions);
	const nameTree = buildNameTree(nameFont, p.nameText, p.nameSizeMm, divisions, 0);
	const initialRoots =
		initialTree.Childs?.() ?? (initialTree as { m_Childs?: unknown[] }).m_Childs ?? [];
	if (!initialRoots.length) return null;
	const initialBb = bboxPolyTreeMm(initialTree);
	const nameBb = bboxPolyTreeMm(nameTree);
	const initialSvg = polyTreeToSvg(initialTree, initialBb);
	const nameSvg = polyTreeToSvg(nameTree, nameBb);
	if (!initialSvg || !nameSvg) return null;
	return { initialSvg, nameSvg };
}

export function getInitialAndNameOpenScadSource(dim: {
	letterThickness: number;
	pocketDepth: number;
	tolerance: number;
	nameOffsetX: number;
	nameOffsetY: number;
}): string {
	const { letterThickness, pocketDepth, tolerance, nameOffsetX, nameOffsetY } = dim;
	return `
$fn = 48;
letter_thickness = ${letterThickness};
pocket_depth = ${pocketDepth};
tolerance = ${tolerance};
name_offset_x = ${nameOffsetX};
name_offset_y = ${nameOffsetY};
extra_cut = ${EXTRA_CUT_MM};
boolean_z_slop = ${BOOLEAN_Z_SLOP_MM};

difference() {
  linear_extrude(height = letter_thickness, convexity = 16) {
    import("/initial.svg", center = true, dpi = 25.4);
  }
  translate([name_offset_x, name_offset_y, letter_thickness - pocket_depth - boolean_z_slop]) {
    linear_extrude(height = pocket_depth + extra_cut + boolean_z_slop, convexity = 16) {
      offset(delta = tolerance)
        import("/name.svg", center = true, dpi = 25.4);
    }
  }
}
`;
}

export async function buildPocketedInitialGeometry(
	initialFont: InitialAndNameFont,
	nameFont: InitialAndNameFont,
	p: InitialAndNameParams
): Promise<THREE.BufferGeometry> {
	const svgs = buildInitialAndNameOpenScadSvgs(initialFont, nameFont, p);
	if (!svgs) throw new Error('Could not build initial OpenSCAD input');
	const letterThickness = Math.max(0.2, p.letterThicknessMm);
	const pocketDepth = Math.min(
		Math.max(0.2, p.pocketDepthMm),
		Math.max(0.2, letterThickness - 0.05)
	);
	const source = getInitialAndNameOpenScadSource({
		letterThickness,
		pocketDepth,
		tolerance: Math.max(0, p.toleranceMm),
		nameOffsetX: p.nameOffsetXMm,
		nameOffsetY: p.nameOffsetYMm
	});
	const stlBytes = await runOpenScad(source, {
		svgPath: '/initial.svg',
		svgContent: svgs.initialSvg,
		extraFiles: [{ path: '/name.svg', content: svgs.nameSvg }]
	});
	let geo = stlToBufferGeometry(stlBytes);
	geo.computeVertexNormals();
	geo.computeBoundingBox();
	const bb = geo.boundingBox;
	if (!bb) {
		geo.dispose();
		throw new Error('OpenSCAD initial: empty geometry');
	}
	geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
	return geo;
}

export function buildSolidInitialGeometry(
	initialFont: InitialAndNameFont,
	p: Pick<InitialAndNameParams, 'initialChar' | 'initialSizeMm' | 'letterThicknessMm'>,
	divisions = CLIPPER_DIVISIONS_PREVIEW
): THREE.BufferGeometry | null {
	const tree = buildInitialTree(initialFont, p.initialChar, p.initialSizeMm, divisions);
	const shapes = polyTreeToThreeShapes(tree);
	if (!shapes.length) return null;
	const geo = new THREE.ExtrudeGeometry(shapes, {
		depth: Math.max(0.2, p.letterThicknessMm),
		bevelEnabled: false,
		curveSegments: divisions
	});
	centerGeometryXY(geo);
	geo.computeBoundingBox();
	const bb = geo.boundingBox;
	if (bb) geo.translate(0, 0, -bb.min.z);
	return geo;
}

export function buildNameInsertGeometry(
	nameFont: InitialAndNameFont,
	p: Pick<
		InitialAndNameParams,
		| 'nameText'
		| 'nameSizeMm'
		| 'nameThicknessMm'
		| 'letterThicknessMm'
		| 'pocketDepthMm'
		| 'nameOffsetXMm'
		| 'nameOffsetYMm'
	>,
	divisions = CLIPPER_DIVISIONS_PREVIEW
): THREE.BufferGeometry | null {
	const geo = buildNameInsertGeometryStandalone(nameFont, p, divisions);
	if (!geo) return null;
	const letterThickness = Math.max(0.2, p.letterThicknessMm);
	const pocketDepth = Math.min(
		Math.max(0.2, p.pocketDepthMm),
		Math.max(0.2, letterThickness - 0.05)
	);
	geo.translate(p.nameOffsetXMm, p.nameOffsetYMm, letterThickness - pocketDepth);
	return geo;
}

/** Flat name insert for export — centered XY, bottom at z = 0 (not placed in pocket). */
export function buildNameInsertGeometryStandalone(
	nameFont: InitialAndNameFont,
	p: Pick<InitialAndNameParams, 'nameText' | 'nameSizeMm' | 'nameThicknessMm'>,
	divisions = CLIPPER_DIVISIONS_EXPORT
): THREE.BufferGeometry | null {
	const tree = buildNameTree(nameFont, p.nameText, p.nameSizeMm, divisions, 0);
	const shapes = polyTreeToThreeShapes(tree);
	if (!shapes.length) return null;
	const geo = new THREE.ExtrudeGeometry(shapes, {
		depth: Math.max(0.2, p.nameThicknessMm),
		bevelEnabled: false,
		curveSegments: divisions
	});
	centerGeometryXY(geo);
	geo.computeBoundingBox();
	const bb = geo.boundingBox;
	if (bb) geo.translate(0, 0, -bb.min.z);
	return geo;
}

export function paramsFromInputs(input: {
	initialFontKey: string;
	nameFontKey: string;
	nameText: string;
	largeInitialChar: string;
	initialSizeMm: number;
	nameSizeMm: number;
	letterThicknessMm: number;
	nameThicknessMm: number;
	pocketDepthMm: number;
	toleranceMm: number;
	nameOffsetXMm: number;
	nameOffsetYMm: number;
}): InitialAndNameParams {
	return {
		initialFontKey: input.initialFontKey,
		nameFontKey: input.nameFontKey,
		nameText: input.nameText,
		initialChar: effectiveLargeInitial(input.largeInitialChar, input.nameText),
		initialSizeMm: input.initialSizeMm,
		nameSizeMm: input.nameSizeMm,
		letterThicknessMm: input.letterThicknessMm,
		nameThicknessMm: input.nameThicknessMm,
		pocketDepthMm: input.pocketDepthMm,
		toleranceMm: input.toleranceMm,
		nameOffsetXMm: input.nameOffsetXMm,
		nameOffsetYMm: input.nameOffsetYMm
	};
}
