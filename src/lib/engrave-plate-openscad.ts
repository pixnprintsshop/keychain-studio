/**
 * Build engrave name-plate base geometry via OpenSCAD WASM (manifold STL),
 * matching the Clipper + pocket logic in EngraveNamePlateDesigner.svelte.
 */
import ClipperLib from 'clipper-lib';
import * as THREE from 'three';
import type { Shape, Vector2 } from 'three';
import { runOpenScad } from '$lib/openscad';
import { stlToBufferGeometry } from '$lib/utils-3d';

const SCALE = 1000;
/** Coarser than live preview: fewer Clipper points → faster OpenSCAD SVG import. */
/** Lower = faster OpenSCAD / smaller STL; live preview uses finer curves in the designer. */
const CLIPPER_DIVISIONS = 6;
const KEYRING_SEGS_EXPORT = 24;
const POCKET_FLOOR_MM = 1;
/** Must match OpenSCAD `boolean_z_slop` — reserves slab so the pocket cutter is not coplanar with the floor. */
const BOOLEAN_Z_SLOP_MM = 0.02;

export type EngravePlateOpenScadFont = {
	generateShapes(text: string, size: number): Shape[];
};

export type EngravePlateOpenScadPack = {
	baseSvg: string;
	cutoutSvg: string;
	plateW: number;
	plateH: number;
	baseT: number;
	pocketD: number;
};

export type EngravePlateOpenScadParams = {
	/** For export cache invalidation when the font changes. */
	fontKey: string;
	text: string;
	textSize: number;
	outlineOffsetPx: number;
	tolerance: number;
	pocketDepth: number;
	baseDepth: number;
	keyringEnabled: boolean;
	keyringOuterSize: number;
	keyringHoleSize: number;
	keyringOffsetX: number;
	keyringOffsetY: number;
};

const PACK_CACHE_MAX = 4;
const STL_CACHE_MAX = 4;
const packCache = new Map<string, EngravePlateOpenScadPack>();
const stlBytesCache = new Map<string, ArrayBuffer>();

function engraveOpenScadCacheKey(p: EngravePlateOpenScadParams): string {
	return JSON.stringify({
		fk: p.fontKey,
		t: p.text,
		ts: p.textSize,
		oop: p.outlineOffsetPx,
		tol: p.tolerance,
		pd: p.pocketDepth,
		bd: p.baseDepth,
		ke: p.keyringEnabled,
		kos: p.keyringOuterSize,
		khs: p.keyringHoleSize,
		kox: p.keyringOffsetX,
		koy: p.keyringOffsetY
	});
}

function touchLru<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number) {
	map.delete(key);
	map.set(key, value);
	while (map.size > maxSize) {
		const first = map.keys().next();
		if (first.done) break;
		map.delete(first.value);
	}
}

/**
 * Outer contours only (no letter holes), same idea as NamePuzzleDesigner `shapesToSolid`.
 * OpenSCAD pocket SVG stays simple like the puzzle cutout and triangulates reliably.
 */
function shapesToSolid(shapes: Shape[]): Shape[] {
	const solid: Shape[] = [];
	for (const shape of shapes) {
		const pts = shape.getPoints(CLIPPER_DIVISIONS);
		if (pts.length < 3) continue;
		const s = new THREE.Shape();
		s.moveTo(pts[0].x, pts[0].y);
		for (let i = 1; i < pts.length; i++) {
			s.lineTo(pts[i].x, pts[i].y);
		}
		solid.push(s);
	}
	return solid;
}

function ensureCW(path: { X: number; Y: number }[], clockwise: boolean) {
	if (ClipperLib.Clipper.Orientation(path) !== clockwise) path.reverse();
}

function bboxPolyTreeMm(tree: any): { minX: number; maxX: number; minY: number; maxY: number } {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	const walk = (node: any) => {
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
		for (const ch of childs) walk(ch);
	};
	const roots = tree.Childs?.() ?? tree.m_Childs ?? [];
	for (const r of roots) walk(r);
	return { minX, maxX, minY, maxY };
}

function unionBbox(
	a: { minX: number; maxX: number; minY: number; maxY: number },
	b: { minX: number; maxX: number; minY: number; maxY: number }
) {
	return {
		minX: Math.min(a.minX, b.minX),
		maxX: Math.max(a.maxX, b.maxX),
		minY: Math.min(a.minY, b.minY),
		maxY: Math.max(a.maxY, b.maxY)
	};
}

function addOuterWithHolesToSvgParts(
	outerNode: any,
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
		const isHole = ch.IsHole?.() ?? ch.m_IsHole;
		if (!isHole) continue;
		const holeContour = ch.Contour?.() ?? ch.m_polygon ?? [];
		if (holeContour.length >= 3) {
			parts.push(`M ${holeContour.map(toPt).join(' L ')} Z`);
		}
		const holeKids = ch.Childs?.() ?? ch.m_Childs ?? [];
		for (const hk of holeKids) {
			const hkIsHole = hk.IsHole?.() ?? hk.m_IsHole;
			if (!hkIsHole) {
				addOuterWithHolesToSvgParts(hk, minX, maxY, parts);
			}
		}
	}
}

function polyTreeToSvg(tree: any, bbox: { minX: number; maxX: number; minY: number; maxY: number }): string | null {
	const plateW = bbox.maxX - bbox.minX;
	const plateH = bbox.maxY - bbox.minY;
	if (!Number.isFinite(plateW) || !Number.isFinite(plateH) || plateW <= 0 || plateH <= 0) return null;
	const parts: string[] = [];
	const roots = tree.Childs?.() ?? tree.m_Childs ?? [];
	for (const n of roots) {
		const isHole = n.IsHole?.() ?? n.m_IsHole;
		if (isHole) continue;
		addOuterWithHolesToSvgParts(n, bbox.minX, bbox.maxY, parts);
	}
	if (parts.length === 0) return null;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${plateW.toFixed(4)} ${plateH.toFixed(4)}"><path fill-rule="evenodd" d="${parts.join(' ')}" fill="black"/></svg>`;
}

/**
 * Returns SVGs and dimensions for OpenSCAD, or null if text/font cannot build geometry.
 * Cached by font + geometry parameters so repeat exports are fast.
 */
export function buildEngravePlateOpenScadSvgs(
	font: EngravePlateOpenScadFont,
	p: EngravePlateOpenScadParams
): EngravePlateOpenScadPack | null {
	const ck = engraveOpenScadCacheKey(p);
	const cachedPack = packCache.get(ck);
	if (cachedPack !== undefined) {
		packCache.delete(ck);
		packCache.set(ck, cachedPack);
		return cachedPack;
	}

	const content = (p.text || ' ').trim() || ' ';
	const size = Math.max(1, Math.round(p.textSize));
	let shapes: Shape[];
	try {
		shapes = font.generateShapes(content, size);
	} catch {
		return null;
	}
	if (!shapes?.length) return null;

	const shapeToPaths = (shape: Shape) => {
		const toPath = (pts: Vector2[]) => {
			const out: { X: number; Y: number }[] = [];
			for (const pt of pts) out.push({ X: Math.round(pt.x * SCALE), Y: Math.round(pt.y * SCALE) });
			if (out.length > 2) {
				const a = out[0];
				const b = out[out.length - 1];
				if (a.X === b.X && a.Y === b.Y) out.pop();
			}
			return out;
		};
		const outer = toPath(shape.getPoints(CLIPPER_DIVISIONS));
		const holes = (shape.holes || []).map((h) => toPath(h.getPoints(CLIPPER_DIVISIONS)));
		return { outer, holes };
	};

	const inputPaths: { X: number; Y: number }[][] = [];
	for (const s of shapes) {
		const { outer, holes } = shapeToPaths(s);
		if (outer.length < 3) continue;
		ensureCW(outer, true);
		inputPaths.push(outer);
		for (const h of holes) {
			if (h.length < 3) continue;
			ensureCW(h, false);
			inputPaths.push(h);
		}
	}
	if (inputPaths.length === 0) return null;

	const outlineWorld = Math.max(0, p.outlineOffsetPx) * (size / 60);
	const outlineTree = new ClipperLib.PolyTree();
	if (outlineWorld > 0) {
		const co = new ClipperLib.ClipperOffset(2, 2);
		co.AddPaths(inputPaths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
		const offsetPaths: { X: number; Y: number }[][] = [];
		co.Execute(offsetPaths, outlineWorld * SCALE);
		const c2 = new ClipperLib.Clipper();
		c2.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
		c2.Execute(
			ClipperLib.ClipType.ctUnion,
			outlineTree,
			ClipperLib.PolyFillType.pftNonZero,
			ClipperLib.PolyFillType.pftNonZero
		);
	} else {
		const c2 = new ClipperLib.Clipper();
		c2.AddPaths(inputPaths, ClipperLib.PolyType.ptSubject, true);
		c2.Execute(
			ClipperLib.ClipType.ctUnion,
			outlineTree,
			ClipperLib.PolyFillType.pftNonZero,
			ClipperLib.PolyFillType.pftNonZero
		);
	}

	let baseTree: any = outlineTree;

	if (p.keyringEnabled) {
		const circleToPath = (
			cx: number,
			cy: number,
			r: number,
			clockwise: boolean,
			segs = KEYRING_SEGS_EXPORT
		) => {
			const path: { X: number; Y: number }[] = [];
			for (let i = 0; i < segs; i++) {
				const t = (i / segs) * Math.PI * 2;
				path.push({
					X: Math.round((cx + r * Math.cos(t)) * SCALE),
					Y: Math.round((cy + r * Math.sin(t)) * SCALE)
				});
			}
			if (path.length < 3) return null;
			if (ClipperLib.Clipper.Orientation(path) !== clockwise) path.reverse();
			return path;
		};
		const collectOuterPaths = (node: any, out: { X: number; Y: number }[][]) => {
			const isHole = node.IsHole?.() ?? node.m_IsHole;
			if (isHole) return;
			const contour = node.Contour?.() ?? node.m_polygon ?? [];
			if (contour.length >= 3) out.push(contour);
			const childs = node.Childs?.() ?? node.m_Childs ?? [];
			childs.forEach((ch: any) => collectOuterPaths(ch, out));
		};
		const getTreeBbox = (tree: any) => {
			let minX = Infinity,
				maxX = -Infinity,
				minY = Infinity,
				maxY = -Infinity;
			const collect = (node: any) => {
				const contour = node.Contour?.() ?? node.m_polygon ?? [];
				for (const pt of contour) {
					minX = Math.min(minX, pt.X);
					maxX = Math.max(maxX, pt.X);
					minY = Math.min(minY, pt.Y);
					maxY = Math.max(maxY, pt.Y);
				}
				const childs = node.Childs?.() ?? node.m_Childs ?? [];
				childs.forEach(collect);
			};
			const roots = tree.Childs?.() ?? tree.m_Childs ?? [];
			roots.forEach(collect);
			return { minX, maxX, minY, maxY };
		};
		const bbox = getTreeBbox(outlineTree);
		const cornerX = bbox.minX / SCALE;
		const cornerY = bbox.maxY / SCALE;
		const kx = cornerX + p.keyringOffsetX;
		const ky = cornerY + p.keyringOffsetY;
		const outerR = Math.max(0.1, p.keyringOuterSize / 2);
		const innerR = Math.min(Math.max(0.05, p.keyringHoleSize / 2), outerR - 0.1);
		const outerCircle = circleToPath(kx, ky, outerR, true);
		const innerCircle = circleToPath(kx, ky, innerR, false);
		if (outerCircle && innerCircle) {
			const outlinePaths: { X: number; Y: number }[][] = [];
			const roots = outlineTree.Childs?.() ?? outlineTree.m_Childs ?? [];
			roots.forEach((n: any) => collectOuterPaths(n, outlinePaths));
			const unionTree = new ClipperLib.PolyTree();
			const unionC = new ClipperLib.Clipper();
			outlinePaths.forEach((path) => unionC.AddPath(path, ClipperLib.PolyType.ptSubject, true));
			unionC.AddPath(outerCircle, ClipperLib.PolyType.ptSubject, true);
			unionC.Execute(
				ClipperLib.ClipType.ctUnion,
				unionTree,
				ClipperLib.PolyFillType.pftNonZero,
				ClipperLib.PolyFillType.pftNonZero
			);
			const diffTree = new ClipperLib.PolyTree();
			const diffPaths: { X: number; Y: number }[][] = [];
			const unionRoots = unionTree.Childs?.() ?? unionTree.m_Childs ?? [];
			unionRoots.forEach((n: any) => collectOuterPaths(n, diffPaths));
			const diffC = new ClipperLib.Clipper();
			diffPaths.forEach((path) => diffC.AddPath(path, ClipperLib.PolyType.ptSubject, true));
			diffC.AddPath(innerCircle, ClipperLib.PolyType.ptClip, true);
			diffC.Execute(
				ClipperLib.ClipType.ctDifference,
				diffTree,
				ClipperLib.PolyFillType.pftNonZero,
				ClipperLib.PolyFillType.pftNonZero
			);
			baseTree = diffTree;
		}
	}

	/** Pocket 2D for OpenSCAD: solid letter blobs (name puzzle–style), not counters as holes. */
	const solidShapes = shapesToSolid(shapes);
	const pocketInputPaths: { X: number; Y: number }[][] = [];
	for (const s of solidShapes) {
		const toPath = (pts: Vector2[]) => {
			const out: { X: number; Y: number }[] = [];
			for (const pt of pts) out.push({ X: Math.round(pt.x * SCALE), Y: Math.round(pt.y * SCALE) });
			if (out.length > 2) {
				const a = out[0];
				const b = out[out.length - 1];
				if (a.X === b.X && a.Y === b.Y) out.pop();
			}
			return out;
		};
		const outer = toPath(s.getPoints(CLIPPER_DIVISIONS));
		if (outer.length < 3) continue;
		ensureCW(outer, true);
		pocketInputPaths.push(outer);
	}
	if (pocketInputPaths.length === 0) return null;

	const cutoutTree = new ClipperLib.PolyTree();
	const tol = Math.max(0, p.tolerance) * SCALE;
	if (tol > 0) {
		const co = new ClipperLib.ClipperOffset(2, 2);
		co.AddPaths(pocketInputPaths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
		const offsetPaths: { X: number; Y: number }[][] = [];
		co.Execute(offsetPaths, tol);
		const c2 = new ClipperLib.Clipper();
		c2.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
		c2.Execute(
			ClipperLib.ClipType.ctUnion,
			cutoutTree,
			ClipperLib.PolyFillType.pftNonZero,
			ClipperLib.PolyFillType.pftNonZero
		);
	} else {
		const c2 = new ClipperLib.Clipper();
		c2.AddPaths(pocketInputPaths, ClipperLib.PolyType.ptSubject, true);
		c2.Execute(
			ClipperLib.ClipType.ctUnion,
			cutoutTree,
			ClipperLib.PolyFillType.pftNonZero,
			ClipperLib.PolyFillType.pftNonZero
		);
	}

	const baseDepthVal = Math.max(0.1, p.baseDepth);
	const maxPocket = Math.max(
		0.2,
		baseDepthVal - POCKET_FLOOR_MM - 0.05 - BOOLEAN_Z_SLOP_MM
	);
	const pocketD = Math.min(Math.max(0.2, p.pocketDepth), maxPocket);

	const bbBase = bboxPolyTreeMm(baseTree);
	const bbCut = bboxPolyTreeMm(cutoutTree);
	const bbox = unionBbox(bbBase, bbCut);

	const baseSvg = polyTreeToSvg(baseTree, bbox);
	const cutoutSvg = polyTreeToSvg(cutoutTree, bbox);
	if (!baseSvg || !cutoutSvg) return null;

	const pack: EngravePlateOpenScadPack = {
		baseSvg,
		cutoutSvg,
		plateW: bbox.maxX - bbox.minX,
		plateH: bbox.maxY - bbox.minY,
		baseT: baseDepthVal,
		pocketD
	};
	touchLru(packCache, ck, pack, PACK_CACHE_MAX);
	return pack;
}

export function getEngravePlateOpenScadSource(dim: {
	plateW: number;
	plateH: number;
	baseT: number;
	pocketD: number;
	pocketFloorMm: number;
}): string {
	const { plateW, plateH, baseT, pocketD, pocketFloorMm } = dim;
	const xyHeal = 0.02;
	const pocketInset = 0.03;
	/** 2D offset cleanup + slight pocket shrink reduces coplanar faces / non-manifold STL from SVG CSG. */
	return `
$fn = 36;
plate_w = ${plateW};
plate_h = ${plateH};
base_t = ${baseT};
pocket_d_req = ${pocketD};
pocket_floor = ${pocketFloorMm};
xy_heal = ${xyHeal};
pocket_inset = ${pocketInset};
boolean_z_slop = ${BOOLEAN_Z_SLOP_MM};

module base_2d() {
  translate([-plate_w / 2, -plate_h / 2, 0]) {
    offset(delta = xy_heal)
      offset(delta = -xy_heal)
        import("/base.svg", center = false, dpi = 25.4);
  }
}

module cutout_2d() {
  translate([-plate_w / 2, -plate_h / 2, 0]) {
    offset(delta = xy_heal)
      offset(delta = -xy_heal)
        offset(delta = -pocket_inset)
          import("/cutout.svg", center = false, dpi = 25.4);
  }
}

difference() {
  linear_extrude(height = base_t, convexity = 16) {
    base_2d();
  }
  cutout_depth = min(pocket_d_req, max(0.2, base_t - pocket_floor - 0.05));
  translate([0, 0, base_t - cutout_depth - boolean_z_slop]) {
    linear_extrude(height = cutout_depth + boolean_z_slop + 0.12, convexity = 16) {
      cutout_2d();
    }
  }
}
`;
}

export async function buildEngravePlateOpenScadStlBytes(
	font: EngravePlateOpenScadFont,
	p: EngravePlateOpenScadParams
): Promise<ArrayBuffer> {
	const ck = engraveOpenScadCacheKey(p);
	const stlHit = stlBytesCache.get(ck);
	if (stlHit !== undefined) {
		stlBytesCache.delete(ck);
		stlBytesCache.set(ck, stlHit);
		return stlHit.slice(0);
	}

	const pack = buildEngravePlateOpenScadSvgs(font, p);
	if (!pack) throw new Error('Could not build engrave plate OpenSCAD input from text');
	const source = getEngravePlateOpenScadSource({
		plateW: pack.plateW,
		plateH: pack.plateH,
		baseT: pack.baseT,
		pocketD: pack.pocketD,
		pocketFloorMm: POCKET_FLOOR_MM
	});
	const raw = await runOpenScad(source, {
		svgPath: '/base.svg',
		svgContent: pack.baseSvg,
		extraFiles: [{ path: '/cutout.svg', content: pack.cutoutSvg }]
	});
	const stored = raw.slice(0);
	touchLru(stlBytesCache, ck, stored, STL_CACHE_MAX);
	return stored;
}

/** Centered plate solid (Z bottom at 0); caller must dispose when done. */
export async function buildEngravePlateOpenScadBufferGeometry(
	font: EngravePlateOpenScadFont,
	p: EngravePlateOpenScadParams
): Promise<THREE.BufferGeometry> {
	const stlBytes = await buildEngravePlateOpenScadStlBytes(font, p);
	let geo = stlToBufferGeometry(stlBytes);
	geo.computeVertexNormals();
	geo.computeBoundingBox();
	const bb = geo.boundingBox;
	if (!bb) {
		geo.dispose();
		throw new Error('OpenSCAD plate: empty geometry');
	}
	geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
	return geo;
}
