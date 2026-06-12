import ClipperLib from 'clipper-lib';
import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const CLIPPER_SCALE = 100;
const CURVE_DIVISIONS = 12;
export const HOOPTAG_UNIT_LAYER_DEPTH_MM = 1;

type ClipperPath = { X: number; Y: number }[];

export interface HoopTagDecorLayerUnit {
	id: string;
	geometry: THREE.BufferGeometry;
}

export interface HoopTagPreparedGeometries {
	baseUnit: THREE.BufferGeometry;
	decorLayers: HoopTagDecorLayerUnit[];
	nativeHeightMm: number;
}

export interface HoopTagSvgInputs {
	baseSvg: string;
	decorLayers: { id: string; svg: string }[];
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

function parseSvgToShapes(svgRaw: string): THREE.Shape[] {
	const parsed = new SVGLoader().parse(svgRaw);
	const shapes: THREE.Shape[] = [];
	for (const p of parsed.paths) {
		for (const s of SVGLoader.createShapes(p)) {
			shapes.push(flipShapeY(s));
		}
	}
	return shapes;
}

function getShapesBbox(shapes: THREE.Shape[]) {
	let minX = Infinity,
		maxX = -Infinity,
		minY = Infinity,
		maxY = -Infinity;
	for (const shape of shapes) {
		const visit = (pts: THREE.Vector2[]) => {
			for (const p of pts) {
				minX = Math.min(minX, p.x);
				maxX = Math.max(maxX, p.x);
				minY = Math.min(minY, p.y);
				maxY = Math.max(maxY, p.y);
			}
		};
		visit(shape.getPoints(CURVE_DIVISIONS));
		for (const hole of shape.holes) visit(hole.getPoints(CURVE_DIVISIONS));
	}
	return { minX, maxX, minY, maxY };
}

function shapeToClipperPaths(shape: THREE.Shape): ClipperPath[] {
	const toPath = (pts: THREE.Vector2[]) => {
		const out: ClipperPath = [];
		for (const p of pts) {
			out.push({
				X: Math.round(p.x * CLIPPER_SCALE),
				Y: Math.round(p.y * CLIPPER_SCALE)
			});
		}
		if (out.length > 2) {
			const a = out[0];
			const b = out[out.length - 1];
			if (a.X === b.X && a.Y === b.Y) out.pop();
		}
		return out;
	};
	const ensureCW = (path: ClipperPath, clockwise: boolean) => {
		const isCW = ClipperLib.Clipper.Orientation(path);
		if (isCW !== clockwise) path.reverse();
	};
	const outer = toPath(shape.getPoints(CURVE_DIVISIONS));
	if (outer.length < 3) return [];
	ensureCW(outer, true);
	const paths: ClipperPath[] = [outer];
	for (const h of shape.holes) {
		const hp = toPath(h.getPoints(CURVE_DIVISIONS));
		if (hp.length < 3) continue;
		ensureCW(hp, false);
		paths.push(hp);
	}
	return paths;
}

function unionPaths(paths: ClipperPath[]): unknown {
	const tree = new ClipperLib.PolyTree();
	if (paths.length === 0) return tree;
	const c = new ClipperLib.Clipper();
	c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
	c.Execute(
		ClipperLib.ClipType.ctUnion,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	return tree;
}

function polyTreeToThreeShapes(tree: unknown, scale2d: number): THREE.Shape[] {
	const out: THREE.Shape[] = [];
	const toVec2 = (pt: { X: number; Y: number }) =>
		new THREE.Vector2((pt.X / CLIPPER_SCALE) * scale2d, (pt.Y / CLIPPER_SCALE) * scale2d);
	const buildFromOuter = (outerNode: {
		Contour?: () => ClipperPath;
		m_polygon?: ClipperPath;
		Childs?: () => unknown[];
		m_Childs?: unknown[];
	}): THREE.Shape | null => {
		const contour = outerNode.Contour?.() ?? outerNode.m_polygon ?? [];
		if (!contour || contour.length < 3) return null;
		const outerPts = contour.map(toVec2);
		if (THREE.ShapeUtils.isClockWise(outerPts)) outerPts.reverse();
		const shape = new THREE.Shape(outerPts);
		const children = outerNode.Childs?.() ?? outerNode.m_Childs ?? [];
		for (const ch of children) {
			const node = ch as {
				IsHole?: () => boolean;
				m_IsHole?: boolean;
				Contour?: () => ClipperPath;
				m_polygon?: ClipperPath;
				Childs?: () => unknown[];
				m_Childs?: unknown[];
			};
			const isHole = node.IsHole?.() ?? node.m_IsHole;
			if (!isHole) continue;
			const holeContour = node.Contour?.() ?? node.m_polygon ?? [];
			if (holeContour.length >= 3) {
				const holePts = holeContour.map(toVec2);
				if (!THREE.ShapeUtils.isClockWise(holePts)) holePts.reverse();
				shape.holes.push(new THREE.Path(holePts));
			}
			const holeKids = node.Childs?.() ?? node.m_Childs ?? [];
			for (const hk of holeKids) {
				const hkNode = hk as { IsHole?: () => boolean; m_IsHole?: boolean };
				const hkIsHole = hkNode.IsHole?.() ?? hkNode.m_IsHole;
				if (!hkIsHole) {
					const nested = buildFromOuter(
						hk as {
							Contour?: () => ClipperPath;
							m_polygon?: ClipperPath;
							Childs?: () => unknown[];
							m_Childs?: unknown[];
						}
					);
					if (nested) out.push(nested);
				}
			}
		}
		return shape;
	};
	const roots =
		(tree as { Childs?: () => unknown[]; m_Childs?: unknown[] }).Childs?.() ??
		(tree as { m_Childs?: unknown[] }).m_Childs ??
		[];
	for (const n of roots) {
		const node = n as { IsHole?: () => boolean; m_IsHole?: boolean };
		const isHole = node.IsHole?.() ?? node.m_IsHole;
		if (isHole) continue;
		const s = buildFromOuter(
			n as {
				Contour?: () => ClipperPath;
				m_polygon?: ClipperPath;
				Childs?: () => unknown[];
				m_Childs?: unknown[];
			}
		);
		if (s) out.push(s);
	}
	return out;
}

function fontShapesToClipperPaths(sourceShapes: THREE.Shape[]): ClipperPath[] {
	const paths: ClipperPath[] = [];
	for (const shape of sourceShapes) {
		paths.push(...shapeToClipperPaths(shape));
	}
	return paths;
}

/** Union font paths through Clipper so counters (D, O, B, …) become proper holes. */
export function unionFontShapesToThree(sourceShapes: THREE.Shape[]): THREE.Shape[] {
	const paths = fontShapesToClipperPaths(sourceShapes);
	if (paths.length === 0) return [];
	return polyTreeToThreeShapes(unionPaths(paths), 1);
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
	const welded = BufferGeometryUtils.mergeVertices(merged, 1e-4);
	if (welded !== merged) merged.dispose();
	return welded;
}

/** Union SVG shapes through Clipper, extrude, and center like the base layer. */
function buildUnionedLayerGeometry(
	shapes: THREE.Shape[],
	shapeScaleMm: number,
	centerX: number,
	centerY: number,
	depth: number
): THREE.BufferGeometry | null {
	const paths: ClipperPath[] = [];
	for (const shape of shapes) {
		paths.push(...shapeToClipperPaths(shape));
	}
	if (paths.length === 0) return null;
	const unionShapes = polyTreeToThreeShapes(unionPaths(paths), shapeScaleMm);
	if (unionShapes.length === 0) return null;
	const geo = extrudeShapes(unionShapes, depth);
	if (!geo) return null;
	alignGeometryToOrigin(geo, centerX, centerY);
	return geo;
}

function alignGeometryToOrigin(
	geo: THREE.BufferGeometry,
	centerX: number,
	centerY: number
): THREE.BufferGeometry {
	geo.computeBoundingBox();
	const bb = geo.boundingBox;
	if (!bb) return geo;
	geo.translate(-centerX, -centerY, -bb.min.z);
	return geo;
}

/** Build base from `base.svg` and per-file decor layers. */
export function prepareHoopTagGeometries(
	inputs: HoopTagSvgInputs,
	options: { targetNativeHeightMm?: number } = {}
): HoopTagPreparedGeometries {
	const targetNativeHeightMm = options.targetNativeHeightMm ?? 50;

	const baseShapes = parseSvgToShapes(inputs.baseSvg);
	if (baseShapes.length === 0) throw new Error('No extrudable paths in base SVG');

	const decorShapeSets = inputs.decorLayers.map((layer) => {
		const shapes = parseSvgToShapes(layer.svg);
		if (shapes.length === 0) throw new Error(`No extrudable paths in ${layer.id} SVG`);
		return { ...layer, shapes };
	});

	const allShapes = [...baseShapes, ...decorShapeSets.flatMap((l) => l.shapes)];
	const svgBbox = getShapesBbox(allShapes);
	const centerSvgX = (svgBbox.minX + svgBbox.maxX) / 2;
	const centerSvgY = (svgBbox.minY + svgBbox.maxY) / 2;
	const maxExtentNorm = Math.max(
		0.001,
		svgBbox.maxX - svgBbox.minX,
		svgBbox.maxY - svgBbox.minY
	);
	const shapeScaleMm = targetNativeHeightMm / maxExtentNorm;
	const centerX = centerSvgX * shapeScaleMm;
	const centerY = centerSvgY * shapeScaleMm;

	const basePaths: ClipperPath[] = [];
	for (const shape of baseShapes) {
		basePaths.push(...shapeToClipperPaths(shape));
	}
	if (basePaths.length === 0) throw new Error('Failed to build base silhouette paths');

	const baseTree = unionPaths(basePaths);

	const baseThreeShapes = polyTreeToThreeShapes(baseTree, shapeScaleMm);
	if (baseThreeShapes.length === 0) throw new Error('Failed to build base silhouette');

	const baseGeo = extrudeShapes(baseThreeShapes, HOOPTAG_UNIT_LAYER_DEPTH_MM);
	if (!baseGeo) throw new Error('Failed to extrude base silhouette');
	alignGeometryToOrigin(baseGeo, centerX, centerY);

	const decorLayers: HoopTagDecorLayerUnit[] = [];
	for (const layer of decorShapeSets) {
		const decorGeo = buildUnionedLayerGeometry(
			layer.shapes,
			shapeScaleMm,
			centerX,
			centerY,
			HOOPTAG_UNIT_LAYER_DEPTH_MM
		);
		if (!decorGeo) continue;
		decorLayers.push({
			id: layer.id,
			geometry: decorGeo
		});
	}

	if (decorLayers.length === 0) throw new Error('Failed to build decor layers');

	baseGeo.computeBoundingBox();
	const fitted = baseGeo.boundingBox;
	const nativeHeightMm = Math.max(1e-6, (fitted?.max.y ?? 0) - (fitted?.min.y ?? 0));

	return { baseUnit: baseGeo, decorLayers, nativeHeightMm };
}

/** Offset font shapes outward for a text outline (outlineMm in final mm, meshScale = mesh XY scale). */
export function buildOffsetFontTextShapes(
	sourceShapes: THREE.Shape[],
	outlineMm: number,
	meshScale: number
): THREE.Shape[] {
	const paths = fontShapesToClipperPaths(sourceShapes);
	if (paths.length === 0) return [];
	if (outlineMm <= 0) return unionFontShapesToThree(sourceShapes);

	const outlineFont = outlineMm / Math.max(0.001, meshScale);

	const co = new ClipperLib.ClipperOffset(2, 2);
	co.AddPaths(
		paths,
		ClipperLib.JoinType.jtRound,
		ClipperLib.EndType.etClosedPolygon
	);
	const offsetPaths: ClipperPath[] = [];
	co.Execute(offsetPaths, outlineFont * CLIPPER_SCALE);
	const outlineTree = unionPaths(offsetPaths.length > 0 ? offsetPaths : paths);
	return polyTreeToThreeShapes(outlineTree, 1);
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
