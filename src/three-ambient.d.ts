declare module 'three/examples/jsm/controls/OrbitControls';
declare module 'three/examples/jsm/loaders/FontLoader';
declare module 'three/examples/jsm/geometries/TextGeometry';
declare module 'three/examples/fonts/*.typeface.json';
declare module '$lib/assets/fonts/*.json';
declare module 'clipper-lib' {
	type ClipperPath = { X: number; Y: number }[];

	export interface PolyNode {
		Contour?(): ClipperPath;
		m_polygon?: ClipperPath;
		Childs?(): PolyNode[];
		m_Childs?: PolyNode[];
		IsHole?(): boolean;
		m_IsHole?: boolean;
	}

	export interface PolyTree {
		Childs?(): PolyNode[];
		m_Childs?: PolyNode[];
	}

	export interface ClipperInstance {
		AddPaths(paths: ClipperPath[], polyType: number, closed: boolean): void;
		AddPath(path: ClipperPath, polyType: number, closed: boolean): void;
		Execute(
			clipType: number,
			polyTree: PolyTree,
			subjFillType: number,
			clipFillType: number
		): void;
	}

	export interface ClipperConstructor {
		new (): ClipperInstance;
		Orientation(path: ClipperPath): boolean;
	}

	export interface ClipperOffsetInstance {
		AddPaths(paths: ClipperPath[], joinType: number, endType: number): void;
		AddPath(path: ClipperPath, joinType: number, endType: number): void;
		Execute(out: ClipperPath[], delta: number): void;
	}

	interface ClipperLibStatic {
		PolyTree: new () => PolyTree;
		Clipper: ClipperConstructor;
		ClipperOffset: new (miterLimit?: number, arcTolerance?: number) => ClipperOffsetInstance;
		JoinType: { readonly jtRound: number };
		EndType: { readonly etClosedPolygon: number };
		PolyType: { readonly ptSubject: number; readonly ptClip: number };
		ClipType: { readonly ctUnion: number; readonly ctDifference: number };
		PolyFillType: { readonly pftNonZero: number };
	}

	const ClipperLib: ClipperLibStatic;
	export default ClipperLib;
}
declare module 'three/examples/jsm/exporters/STLExporter';
declare module 'three/examples/jsm/loaders/STLLoader';
declare module 'three-3mf-exporter';
