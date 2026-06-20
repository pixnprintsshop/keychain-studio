/**
 * Letter Rail — curved name layout + initial outline helpers.
 */
import ClipperLib, { type PolyTree } from 'clipper-lib';
import * as THREE from 'three';
import type { Shape } from 'three';
import { effectiveLargeInitial } from '$lib/utils-initial-and-name';
import letterRailDefaults from '$lib/assets/letter-rail-defaults.json';

export const DESIGN_NAME = 'Letter Rail';
export const STORAGE_KEY = 'letter-rail-settings-v1';
/** @deprecated Renamed with Letter Rail; read via {@link readLetterRailSettingsRaw}. */
export const LEGACY_STORAGE_KEY = 'path-layered-monogram-settings-v1';
export const INITIAL_FONT_KEY = 'Qilka_Bold';
export const NAME_FONT_KEY = 'Rounds Black_Regular';

export const CLIPPER_SCALE = 1000;
export const SHAPE_DIVISIONS = 18;

export const DEFAULT_NAME_TEXT = 'Name';
export const DEFAULT_INITIAL_SIZE = 45;
export const DEFAULT_NAME_SIZE = 6;
export const DEFAULT_INITIAL_DEPTH = 2;
export const DEFAULT_NAME_DEPTH = 1.2;
export const DEFAULT_OUTLINE_OFFSET_PX = 7;
export const DEFAULT_NAME_OFFSET_X = 0;
export const DEFAULT_NAME_OFFSET_Y = 0;
export const DEFAULT_NAME_ROTATION = 0;
export const DEFAULT_NAME_CURVE = 0;
export const DEFAULT_NAME_CHAR_SPACING = 0.5;
export const DEFAULT_BOX_WIDTH = 48;
export const DEFAULT_BOX_HEIGHT = 14;
export const DEFAULT_HOLE_DIAMETER = 6;
export const DEFAULT_HOLE_OFFSET_X = 0;
export const DEFAULT_HOLE_OFFSET_Y = 0;
export const DEFAULT_KEYRING_OUTER_SIZE = 8;
export const DEFAULT_KEYRING_HOLE_SIZE = 4;
export const DEFAULT_KEYRING_DEPTH = 4;
export const DEFAULT_KEYRING_OFFSET_X = 0;
export const DEFAULT_KEYRING_OFFSET_Y = 0;
export const DEFAULT_OVERALL_SCALE = 1;

/** Fixed design sizes — not user-editable; use {@link DEFAULT_OVERALL_SCALE} to resize XY. */
export const DESIGN_INITIAL_SIZE = letterRailDefaults.initialSize;
export const DESIGN_NAME_SIZE = letterRailDefaults.nameSize;

export type TextBoxJustify = 'left' | 'center' | 'right';
export type TextBoxAlign = 'bottom' | 'center' | 'top';

export type MountingMode = 'hole' | 'keyring';

export type MountingHoleSettings = {
	diameter: number;
	offsetX: number;
	offsetY: number;
};

export type MountingKeyringSettings = {
	outerSize: number;
	holeSize: number;
	depth: number;
	offsetX: number;
	offsetY: number;
};

/** Per-letter mounting: mode picks active option; hole + keyring settings persist independently. */
export type LetterMountingSettings = {
	mode: MountingMode;
	hole: MountingHoleSettings;
	keyring: MountingKeyringSettings;
};

export const DEFAULT_MOUNTING_HOLE: MountingHoleSettings = {
	diameter: DEFAULT_HOLE_DIAMETER,
	offsetX: DEFAULT_HOLE_OFFSET_X,
	offsetY: DEFAULT_HOLE_OFFSET_Y
};

export const DEFAULT_MOUNTING_KEYRING: MountingKeyringSettings = {
	outerSize: DEFAULT_KEYRING_OUTER_SIZE,
	holeSize: DEFAULT_KEYRING_HOLE_SIZE,
	depth: DEFAULT_KEYRING_DEPTH,
	offsetX: DEFAULT_KEYRING_OFFSET_X,
	offsetY: DEFAULT_KEYRING_OFFSET_Y
};

export const DEFAULT_LETTER_MOUNTING: LetterMountingSettings = {
	mode: 'keyring',
	hole: DEFAULT_MOUNTING_HOLE,
	keyring: DEFAULT_MOUNTING_KEYRING
};

export type MountingByInitial = Partial<Record<string, LetterMountingSettings>>;

/** @deprecated Use {@link MountingHoleSettings} without `enabled`. */
export type LegacyMountingHoleSettings = MountingHoleSettings & { enabled?: boolean };

export type NamePlacement = {
	offsetX: number;
	offsetY: number;
	rotationDeg: number;
	curve: number;
	charSpacing: number;
	boxWidth: number;
	boxHeight: number;
	boxJustify: TextBoxJustify;
	boxAlign: TextBoxAlign;
};

export const DEFAULT_NAME_PLACEMENT: NamePlacement = {
	offsetX: DEFAULT_NAME_OFFSET_X,
	offsetY: DEFAULT_NAME_OFFSET_Y,
	rotationDeg: DEFAULT_NAME_ROTATION,
	curve: DEFAULT_NAME_CURVE,
	charSpacing: DEFAULT_NAME_CHAR_SPACING,
	boxWidth: DEFAULT_BOX_WIDTH,
	boxHeight: DEFAULT_BOX_HEIGHT,
	boxJustify: 'left',
	boxAlign: 'center'
};

export const INITIAL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** Per-letter name placement for each mount type (hole vs keyring). */
export type LetterNamePlacementSettings = {
	hole: NamePlacement;
	keyring: NamePlacement;
};

/** Per-letter name placement overrides (A–Z). Missing letters use baked defaults. */
export type NamePlacementByInitial = Partial<Record<string, LetterNamePlacementSettings>>;

/** @deprecated Flat per-letter placement before mount-type split. */
export type LegacyFlatNamePlacement = NamePlacement;

function isFlatNamePlacement(value: unknown): value is NamePlacement {
	if (!value || typeof value !== 'object') return false;
	const o = value as Record<string, unknown>;
	return (
		'offsetX' in o &&
		!('hole' in o) &&
		!('keyring' in o)
	);
}

function mergeNamePlacement(
	...layers: (Partial<NamePlacement> | undefined)[]
): NamePlacement {
	let out: NamePlacement = { ...DEFAULT_NAME_PLACEMENT };
	for (const layer of layers) {
		if (layer) out = { ...out, ...layer };
	}
	return out;
}

export function getLetterNamePlacement(
	map: NamePlacementByInitial,
	letter: string
): LetterNamePlacementSettings {
	const key = normalizeInitialLetter(letter);
	const stored = map[key];
	const baked = DEFAULT_SETTINGS.namePlacementByInitial[key];

	if (isFlatNamePlacement(stored)) {
		const flat = stored;
		return {
			hole: mergeNamePlacement(baked?.hole, flat),
			keyring: mergeNamePlacement(baked?.keyring, flat)
		};
	}

	return {
		hole: mergeNamePlacement(baked?.hole, stored?.hole),
		keyring: mergeNamePlacement(baked?.keyring, stored?.keyring)
	};
}

export function getNamePlacementForInitial(
	map: NamePlacementByInitial,
	letter: string,
	mode: MountingMode
): NamePlacement {
	return getLetterNamePlacement(map, letter)[mode];
}

function migrateFlatNamePlacementByInitial(
	map: NamePlacementByInitial
): NamePlacementByInitial {
	const out: NamePlacementByInitial = {};
	for (const [letter, value] of Object.entries(map)) {
		if (!value) continue;
		if (isFlatNamePlacement(value)) {
			out[letter] = { hole: { ...value }, keyring: { ...value } };
		} else {
			out[letter] = structuredClone(value);
		}
	}
	return out;
}

/** Merge stored overrides onto baked defaults per letter and mount type. */
export function mergeNamePlacementByInitial(
	defaults: NamePlacementByInitial,
	overrides: NamePlacementByInitial
): NamePlacementByInitial {
	const letters = new Set([...Object.keys(defaults), ...Object.keys(overrides)]);
	const out: NamePlacementByInitial = {};
	for (const letter of letters) {
		const def = defaults[letter];
		const ovr = overrides[letter];
		if (!ovr) {
			if (def) out[letter] = structuredClone(def);
			continue;
		}
		if (isFlatNamePlacement(ovr)) {
			out[letter] = {
				hole: mergeNamePlacement(def?.hole, ovr),
				keyring: mergeNamePlacement(def?.keyring, ovr)
			};
		} else {
			out[letter] = {
				hole: mergeNamePlacement(def?.hole, ovr.hole),
				keyring: mergeNamePlacement(def?.keyring, ovr.keyring)
			};
		}
	}
	return out;
}

/** Ensure every entry is nested hole + keyring (never flat). */
export function normalizeNamePlacementByInitial(
	map: NamePlacementByInitial
): NamePlacementByInitial {
	const normalized = migrateFlatNamePlacementByInitial(map);
	const out: NamePlacementByInitial = {};
	for (const [letter, value] of Object.entries(normalized)) {
		if (!value) continue;
		out[letter] = {
			hole: mergeNamePlacement(undefined, value.hole),
			keyring: mergeNamePlacement(undefined, value.keyring)
		};
	}
	return out;
}

export interface LetterRailSettings {
	nameText: string;
	initialChar: string;
	overallScale: number;
	initialDepth: number;
	nameDepth: number;
	outlineOffsetPx: number;
	namePlacementByInitial: NamePlacementByInitial;
	outlineColor: string;
	initialColor: string;
	nameColor: string;
	mountingByInitial: MountingByInitial;
}

function buildDefaultNamePlacementByInitial(): NamePlacementByInitial {
	return structuredClone(
		mergeNamePlacementByInitial(
			{},
			migrateFlatNamePlacementByInitial(
				letterRailDefaults.namePlacementByInitial as NamePlacementByInitial
			)
		)
	);
}

function buildDefaultMountingByInitial(): MountingByInitial {
	return mergeLegacyHoleByInitial(
		(letterRailDefaults.mountingByInitial ?? {}) as MountingByInitial,
		(letterRailDefaults as LegacyLetterRailSettings).holeByInitial,
		DEFAULT_MOUNTING_KEYRING
	);
}

export const DEFAULT_SETTINGS: LetterRailSettings = {
	nameText: letterRailDefaults.nameText,
	initialChar: letterRailDefaults.initialChar ?? '',
	overallScale: letterRailDefaults.overallScale ?? DEFAULT_OVERALL_SCALE,
	initialDepth: letterRailDefaults.initialDepth,
	nameDepth: letterRailDefaults.nameDepth,
	outlineOffsetPx: letterRailDefaults.outlineOffsetPx,
	namePlacementByInitial: buildDefaultNamePlacementByInitial(),
	outlineColor: letterRailDefaults.outlineColor,
	initialColor: letterRailDefaults.initialColor,
	nameColor: letterRailDefaults.nameColor,
	mountingByInitial: buildDefaultMountingByInitial()
};

/** Fresh copy so runtime edits never mutate baked defaults. */
export function getDefaultLetterRailSettings(): LetterRailSettings {
	return structuredClone(DEFAULT_SETTINGS);
}

export function normalizeInitialLetter(char: string): string {
	const c = (char || 'A').trim().toUpperCase().charAt(0);
	return c >= 'A' && c <= 'Z' ? c : 'A';
}

export function getMountingForInitial(
	map: MountingByInitial,
	letter: string
): LetterMountingSettings {
	const key = normalizeInitialLetter(letter);
	const stored = map[key];
	const baked = DEFAULT_SETTINGS.mountingByInitial[key];
	return {
		mode: stored?.mode ?? baked?.mode ?? DEFAULT_LETTER_MOUNTING.mode,
		hole: { ...DEFAULT_MOUNTING_HOLE, ...baked?.hole, ...stored?.hole },
		keyring: { ...DEFAULT_MOUNTING_KEYRING, ...baked?.keyring, ...stored?.keyring }
	};
}

/** @deprecated */
export function getMountingHoleForInitial(
	map: MountingByInitial,
	letter: string
): MountingHoleSettings {
	return getMountingForInitial(map, letter).hole;
}

type LegacyLetterRailSettings = Partial<LetterRailSettings> & {
	initialSize?: number;
	nameSize?: number;
	nameOffsetX?: number;
	nameOffsetY?: number;
	nameRotation?: number;
	nameCurve?: number;
	nameCharSpacing?: number;
	keyringEnabled?: boolean;
	keyringDepth?: number;
	keyringOuterSize?: number;
	keyringHoleSize?: number;
	keyringOffsetX?: number;
	keyringOffsetY?: number;
	holeByInitial?: Partial<Record<string, LegacyMountingHoleSettings>>;
};

/** Legacy mirror persisted alongside mountingByInitial so hole mappings survive format changes. */
export function buildHoleByInitialSnapshot(
	map: MountingByInitial
): Partial<Record<string, LegacyMountingHoleSettings>> {
	const out: Partial<Record<string, LegacyMountingHoleSettings>> = {};
	for (const [letter, mounting] of Object.entries(map)) {
		if (!mounting) continue;
		out[normalizeInitialLetter(letter)] = {
			enabled: mounting.mode === 'hole',
			diameter: mounting.hole.diameter,
			offsetX: mounting.hole.offsetX,
			offsetY: mounting.hole.offsetY
		};
	}
	return out;
}

function mergeLegacyHoleByInitial(
	mounting: MountingByInitial,
	holeByInitial: Partial<Record<string, LegacyMountingHoleSettings>> | undefined,
	legacyKeyringDefaults: MountingKeyringSettings
): MountingByInitial {
	if (!holeByInitial) return mounting;
	const map: MountingByInitial = { ...mounting };
	for (const [letter, oldHole] of Object.entries(holeByInitial)) {
		if (!oldHole) continue;
		const key = normalizeInitialLetter(letter);
		const existing = map[key];
		const legacyHole: MountingHoleSettings = {
			diameter: oldHole.diameter ?? DEFAULT_HOLE_DIAMETER,
			offsetX: oldHole.offsetX ?? DEFAULT_HOLE_OFFSET_X,
			offsetY: oldHole.offsetY ?? DEFAULT_HOLE_OFFSET_Y
		};
		const legacyMode: MountingMode = oldHole.enabled === false ? 'keyring' : 'hole';
		map[key] = {
			mode: existing?.mode ?? legacyMode,
			hole: { ...DEFAULT_MOUNTING_HOLE, ...(existing?.hole ?? {}), ...legacyHole },
			keyring: existing?.keyring ?? { ...legacyKeyringDefaults }
		};
	}
	return map;
}

/** Read saved settings JSON, falling back to the pre-rename storage key. */
export function readLetterRailSettingsRaw(): string | null {
	if (typeof localStorage === 'undefined') return null;
	return localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
}

/** True when the primary Letter Rail storage key has saved settings. */
export function hasLetterRailStoredSettings(): boolean {
	if (typeof localStorage === 'undefined') return false;
	return localStorage.getItem(STORAGE_KEY) !== null;
}

/** Parse and migrate saved settings (v1 flat placement → per-letter map). */
export function parseLetterRailSettings(raw: string | null): LetterRailSettings {
	if (!raw) return getDefaultLetterRailSettings();
	try {
		const parsed = JSON.parse(raw) as LegacyLetterRailSettings;
		const base: LetterRailSettings = {
			...getDefaultLetterRailSettings(),
			...parsed,
			overallScale:
				typeof parsed.overallScale === 'number' && Number.isFinite(parsed.overallScale)
					? parsed.overallScale
					: DEFAULT_OVERALL_SCALE,
			namePlacementByInitial: mergeNamePlacementByInitial(
				DEFAULT_SETTINGS.namePlacementByInitial,
				parsed.namePlacementByInitial ?? {}
			),
			mountingByInitial: {
				...DEFAULT_SETTINGS.mountingByInitial,
				...(parsed.mountingByInitial ?? {})
			}
		};
		delete (base as LegacyLetterRailSettings).initialSize;
		delete (base as LegacyLetterRailSettings).nameSize;

		const legacyKeyringDefaults: MountingKeyringSettings = {
			outerSize: parsed.keyringOuterSize ?? DEFAULT_KEYRING_OUTER_SIZE,
			holeSize: parsed.keyringHoleSize ?? DEFAULT_KEYRING_HOLE_SIZE,
			depth: parsed.keyringDepth ?? DEFAULT_KEYRING_DEPTH,
			offsetX: parsed.keyringOffsetX ?? DEFAULT_KEYRING_OFFSET_X,
			offsetY: parsed.keyringOffsetY ?? DEFAULT_KEYRING_OFFSET_Y
		};

		base.mountingByInitial = mergeLegacyHoleByInitial(
			base.mountingByInitial,
			parsed.holeByInitial,
			legacyKeyringDefaults
		);

		if (
			Object.keys(base.mountingByInitial).length === 0 &&
			(parsed.keyringEnabled !== undefined ||
				parsed.keyringHoleSize !== undefined ||
				parsed.keyringOffsetX !== undefined ||
				parsed.keyringOffsetY !== undefined)
		) {
			const map: MountingByInitial = {};
			for (const ch of INITIAL_LETTERS) {
				map[ch] = {
					mode: parsed.keyringEnabled === false ? 'hole' : 'keyring',
					hole: { ...DEFAULT_MOUNTING_HOLE },
					keyring: { ...legacyKeyringDefaults }
				};
			}
			base.mountingByInitial = map;
		}

		const hasLegacyPlacement =
			parsed.nameOffsetX !== undefined ||
			parsed.nameOffsetY !== undefined ||
			parsed.nameRotation !== undefined ||
			parsed.nameCurve !== undefined ||
			parsed.nameCharSpacing !== undefined;

		if (Object.keys(base.namePlacementByInitial).length === 0 && hasLegacyPlacement) {
			const legacy: NamePlacement = {
				...DEFAULT_NAME_PLACEMENT,
				offsetX: parsed.nameOffsetX ?? DEFAULT_NAME_OFFSET_X,
				offsetY: parsed.nameOffsetY ?? DEFAULT_NAME_OFFSET_Y,
				rotationDeg: parsed.nameRotation ?? DEFAULT_NAME_ROTATION,
				curve: parsed.nameCurve ?? DEFAULT_NAME_CURVE,
				charSpacing: parsed.nameCharSpacing ?? DEFAULT_NAME_CHAR_SPACING
			};
			const map: NamePlacementByInitial = {};
			for (const ch of INITIAL_LETTERS) {
				map[ch] = { hole: { ...legacy }, keyring: { ...legacy } };
			}
			base.namePlacementByInitial = map;
		}

		return base;
	} catch {
		return getDefaultLetterRailSettings();
	}
}

/**
 * Name placement for component state.
 * With no saved settings, returns a deep copy of letter-rail-defaults.json (same as pasting that file).
 */
export function loadNamePlacementState(): NamePlacementByInitial {
	if (typeof localStorage === 'undefined') {
		return structuredClone(DEFAULT_SETTINGS.namePlacementByInitial);
	}
	const raw = localStorage.getItem(STORAGE_KEY);
	if (!raw) {
		return structuredClone(DEFAULT_SETTINGS.namePlacementByInitial);
	}
	try {
		const parsed = JSON.parse(raw) as LegacyLetterRailSettings;
		const stored = parsed.namePlacementByInitial;
		if (!stored || Object.keys(stored).length === 0) {
			return structuredClone(DEFAULT_SETTINGS.namePlacementByInitial);
		}
		return normalizeNamePlacementByInitial(
			mergeNamePlacementByInitial(
				DEFAULT_SETTINGS.namePlacementByInitial,
				migrateFlatNamePlacementByInitial(stored as NamePlacementByInitial)
			)
		);
	} catch {
		return structuredClone(DEFAULT_SETTINGS.namePlacementByInitial);
	}
}

/** Mounting for component state (defaults when nothing stored on primary key). */
export function loadMountingState(): MountingByInitial {
	if (typeof localStorage === 'undefined') {
		return structuredClone(DEFAULT_SETTINGS.mountingByInitial);
	}
	const raw = localStorage.getItem(STORAGE_KEY);
	if (!raw) {
		return structuredClone(DEFAULT_SETTINGS.mountingByInitial);
	}
	return parseLetterRailSettings(raw).mountingByInitial;
}

export { effectiveLargeInitial };

type ClipperPoint = { X: number; Y: number };
type PathFont = {
	generateShapes(text: string, size: number): Shape[];
	data?: { resolution?: number; glyphs?: Record<string, { ha?: number }> };
};

function ensureCW(path: ClipperPoint[], clockwise: boolean) {
	if (ClipperLib.Clipper.Orientation(path) !== clockwise) path.reverse();
}

export function shapeToClipperPaths(shape: Shape, divisions = SHAPE_DIVISIONS): ClipperPoint[][] {
	const toPath = (pts: THREE.Vector2[]) => {
		const out: ClipperPoint[] = [];
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
	const paths: ClipperPoint[][] = [];
	const outer = toPath(shape.getPoints(divisions));
	if (outer.length >= 3) {
		ensureCW(outer, true);
		paths.push(outer);
	}
	for (const hole of shape.holes ?? []) {
		const holePath = toPath(hole.getPoints(divisions));
		if (holePath.length >= 3) {
			ensureCW(holePath, false);
			paths.push(holePath);
		}
	}
	return paths;
}

export function pathsFromShapes(shapes: Shape[], divisions = SHAPE_DIVISIONS): ClipperPoint[][] {
	const paths: ClipperPoint[][] = [];
	for (const shape of shapes) {
		paths.push(...shapeToClipperPaths(shape, divisions));
	}
	return paths;
}

export function polyTreeToThreeShapes(tree: PolyTree): THREE.Shape[] {
	const shapesOut: THREE.Shape[] = [];
	const toVec2 = (pt: ClipperPoint) =>
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
		}
		return shape;
	};

	const roots = tree.Childs?.() ?? (tree as { m_Childs?: any[] }).m_Childs ?? [];
	for (const node of roots) {
		const isHole = node.IsHole?.() ?? node.m_IsHole;
		if (isHole) continue;
		const shape = buildFromOuter(node);
		if (shape) shapesOut.push(shape);
	}
	return shapesOut;
}

function unionPaths(paths: ClipperPoint[][]): PolyTree {
	const tree = new ClipperLib.PolyTree();
	if (paths.length === 0) return tree;
	const clipper = new ClipperLib.Clipper();
	clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
	clipper.Execute(
		ClipperLib.ClipType.ctUnion,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	return tree;
}

function offsetUnionTree(paths: ClipperPoint[][], offsetWorldMm: number): PolyTree {
	const tree = new ClipperLib.PolyTree();
	if (paths.length === 0) return tree;
	if (offsetWorldMm <= 0) {
		const clipper = new ClipperLib.Clipper();
		clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
		clipper.Execute(
			ClipperLib.ClipType.ctUnion,
			tree,
			ClipperLib.PolyFillType.pftNonZero,
			ClipperLib.PolyFillType.pftNonZero
		);
		return tree;
	}
	const co = new ClipperLib.ClipperOffset(2, 2);
	co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
	const offsetPaths: ClipperPoint[][] = [];
	co.Execute(offsetPaths, offsetWorldMm * CLIPPER_SCALE);
	const clipper = new ClipperLib.Clipper();
	clipper.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
	clipper.Execute(
		ClipperLib.ClipType.ctUnion,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	return tree;
}

function circleToClipperPath(
	cx: number,
	cy: number,
	radius: number,
	clockwise: boolean,
	segments = 48
): ClipperPoint[] {
	const path: ClipperPoint[] = [];
	for (let i = 0; i < segments; i++) {
		const t = (i / segments) * Math.PI * 2;
		path.push({
			X: Math.round((cx + radius * Math.cos(t)) * CLIPPER_SCALE),
			Y: Math.round((cy + radius * Math.sin(t)) * CLIPPER_SCALE)
		});
	}
	if (path.length >= 3) ensureCW(path, clockwise);
	return path;
}

/** Cut a circular mounting hole from shape paths (font-space coordinates). */
export function subtractCircleHoleFromShapes(
	shapes: THREE.Shape[],
	cx: number,
	cy: number,
	radiusMm: number
): THREE.Shape[] {
	const radius = Math.max(0.05, radiusMm);
	const subjectPaths = pathsFromShapes(shapes);
	if (subjectPaths.length === 0) return shapes;

	const holePath = circleToClipperPath(cx, cy, radius, false);
	if (holePath.length < 3) return shapes;

	const tree = new ClipperLib.PolyTree();
	const clipper = new ClipperLib.Clipper();
	clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true);
	clipper.AddPath(holePath, ClipperLib.PolyType.ptClip, true);
	clipper.Execute(
		ClipperLib.ClipType.ctDifference,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	const result = polyTreeToThreeShapes(tree);
	return result.length > 0 ? result : shapes;
}

export function applyMountingHoleToShapes(
	shapes: THREE.Shape[],
	refCx: number,
	refCy: number,
	hole: MountingHoleSettings
): THREE.Shape[] {
	if (hole.diameter <= 0) return shapes;
	return subtractCircleHoleFromShapes(
		shapes,
		refCx + hole.offsetX,
		refCy + hole.offsetY,
		hole.diameter / 2
	);
}

function circleGuidePoints(
	centerX: number,
	centerY: number,
	radius: number,
	segments = 48
): THREE.Vector3[] {
	if (radius <= 0) return [];
	const points: THREE.Vector3[] = [];
	for (let i = 0; i < segments; i++) {
		const t = (i / segments) * Math.PI * 2;
		points.push(
			new THREE.Vector3(centerX + radius * Math.cos(t), centerY + radius * Math.sin(t), 0)
		);
	}
	return points;
}

/** Circle points for mounting-hole preview guide (initial-centered XY). */
export function getMountingHoleGuidePoints(hole: MountingHoleSettings, segments = 48): THREE.Vector3[] {
	return circleGuidePoints(hole.offsetX, hole.offsetY, Math.max(0.05, hole.diameter / 2), segments);
}

/** Outer + inner circles for keyring preview guide (relative to outline top-left anchor). */
export function getMountingKeyringGuideLoops(
	keyring: MountingKeyringSettings,
	anchorX = 0,
	anchorY = 0,
	segments = 48
): { outer: THREE.Vector3[]; inner: THREE.Vector3[] } {
	const outerRadius = Math.max(0.1, keyring.outerSize / 2);
	const innerRadius = Math.min(
		Math.max(0.05, keyring.holeSize / 2),
		outerRadius - 0.1
	);
	const cx = anchorX + keyring.offsetX;
	const cy = anchorY + keyring.offsetY;
	return {
		outer: circleGuidePoints(cx, cy, outerRadius, segments),
		inner: circleGuidePoints(cx, cy, innerRadius, segments)
	};
}

function unionCircleWithShapes(
	shapes: THREE.Shape[],
	cx: number,
	cy: number,
	radiusMm: number,
	segments = 48
): THREE.Shape[] {
	const radius = Math.max(0.05, radiusMm);
	const subjectPaths = pathsFromShapes(shapes);
	if (subjectPaths.length === 0) return shapes;
	const circlePath = circleToClipperPath(cx, cy, radius, true, segments);
	if (circlePath.length < 3) return shapes;
	const tree = new ClipperLib.PolyTree();
	const clipper = new ClipperLib.Clipper();
	clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true);
	clipper.AddPath(circlePath, ClipperLib.PolyType.ptSubject, true);
	clipper.Execute(
		ClipperLib.ClipType.ctUnion,
		tree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);
	const result = polyTreeToThreeShapes(tree);
	return result.length > 0 ? result : shapes;
}

/**
 * Anchor on the actual outline silhouette (not bbox): leftmost point in the top band
 * of the outer contour, e.g. upper-left leg of "A".
 */
export function computeOutlineKeyringAnchor(
	shapes: THREE.Shape[],
	refCx: number,
	refCy: number,
	topBandRatio = 0.22,
	divisions = SHAPE_DIVISIONS
): { x: number; y: number } {
	const outerPts: THREE.Vector2[] = [];
	for (const shape of shapes) {
		outerPts.push(...shape.getPoints(divisions));
	}
	if (outerPts.length === 0) return { x: 0, y: 0 };

	let minX = Infinity;
	let maxY = -Infinity;
	let minY = Infinity;
	for (const p of outerPts) {
		minX = Math.min(minX, p.x);
		maxY = Math.max(maxY, p.y);
		minY = Math.min(minY, p.y);
	}
	const bandFloor = maxY - Math.max((maxY - minY) * topBandRatio, 1);

	let best: THREE.Vector2 | null = null;
	for (const p of outerPts) {
		if (p.y < bandFloor) continue;
		if (!best || p.x < best.x - 1e-6 || (Math.abs(p.x - best.x) <= 1e-6 && p.y > best.y)) {
			best = p;
		}
	}

	if (!best) {
		let bestDist = Infinity;
		for (const p of outerPts) {
			const dx = p.x - minX;
			const dy = maxY - p.y;
			const d = dx * dx + dy * dy;
			if (d < bestDist) {
				bestDist = d;
				best = p;
			}
		}
	}

	if (!best) return { x: 0, y: 0 };
	return { x: best.x - refCx, y: best.y - refCy };
}

/** @deprecated Use {@link computeOutlineKeyringAnchor}. */
export function computeOutlineTopLeftAnchor(
	shapes: THREE.Shape[],
	refCx: number,
	refCy: number,
	divisions = SHAPE_DIVISIONS
): { x: number; y: number } {
	return computeOutlineKeyringAnchor(shapes, refCx, refCy, 1, divisions);
}

/** Union keyring disc into outline shapes and cut the keyring hole (font-space mm). */
export function applyKeyringToOutlineShapes(
	shapes: THREE.Shape[],
	refCx: number,
	refCy: number,
	keyring: MountingKeyringSettings
): { shapes: THREE.Shape[]; anchor: { x: number; y: number } } {
	const anchor = computeOutlineKeyringAnchor(shapes, refCx, refCy);
	const outerR = Math.max(0.5, keyring.outerSize / 2);
	const innerR = Math.min(Math.max(0.05, keyring.holeSize / 2), outerR - 0.1);
	const cx = refCx + anchor.x + keyring.offsetX;
	const cy = refCy + anchor.y + keyring.offsetY;

	let merged = unionCircleWithShapes(shapes, cx, cy, outerR);
	merged = subtractCircleHoleFromShapes(merged, cx, cy, innerR);
	return { shapes: merged, anchor };
}

export function computeShapesXYCenter(shapes: THREE.Shape[]): { cx: number; cy: number } {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	const collect = (pts: THREE.Vector2[]) => {
		for (const p of pts) {
			minX = Math.min(minX, p.x);
			maxX = Math.max(maxX, p.x);
			minY = Math.min(minY, p.y);
			maxY = Math.max(maxY, p.y);
		}
	};
	for (const shape of shapes) {
		collect(shape.getPoints(SHAPE_DIVISIONS));
		for (const hole of shape.holes ?? []) {
			collect(hole.getPoints(SHAPE_DIVISIONS));
		}
	}
	if (!Number.isFinite(minX)) return { cx: 0, cy: 0 };
	return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

export function buildInitialLayerShapes(
	font: PathFont,
	initialChar: string,
	initialSize: number
): THREE.Shape[] {
	const shapes = font.generateShapes(initialChar || 'A', Math.max(1, initialSize));
	const tree = unionPaths(pathsFromShapes(shapes));
	return polyTreeToThreeShapes(tree);
}

export function buildInitialOutlineShapes(
	font: PathFont,
	initialChar: string,
	initialSize: number,
	outlineOffsetPx: number
): THREE.Shape[] {
	const shapes = font.generateShapes(initialChar || 'A', Math.max(1, initialSize));
	const paths = pathsFromShapes(shapes);
	const outlineWorld = Math.max(0, outlineOffsetPx) * (Math.max(1, initialSize) / 60);
	const tree = offsetUnionTree(paths, outlineWorld);
	return polyTreeToThreeShapes(tree);
}

type GlyphLayout = {
	shapes: Shape[];
	localCx: number;
	localBaselineY: number;
	advance: number;
};

function buildGlyphLayouts(
	font: PathFont,
	text: string,
	size: number,
	charSpacing: number
): GlyphLayout[] {
	const content = (text || ' ').toUpperCase();
	const data = font.data;
	const resolution = data?.resolution ?? 1000;
	const scale = Math.max(1, size) / resolution;
	const glyphs: GlyphLayout[] = [];
	let cursor = 0;

	for (const ch of content) {
		const glyph = data?.glyphs?.[ch];
		const advance = (glyph?.ha ?? resolution * 0.5) * scale;
		if (ch !== ' ' && ch !== '\t' && glyph) {
			try {
				const shapes = font.generateShapes(ch, Math.max(1, size));
				if (shapes.length > 0) {
					let minX = Infinity;
					let maxX = -Infinity;
					let minY = Infinity;
					let maxY = -Infinity;
					for (const shape of shapes) {
						for (const p of shape.getPoints(SHAPE_DIVISIONS)) {
							minX = Math.min(minX, p.x);
							maxX = Math.max(maxX, p.x);
							minY = Math.min(minY, p.y);
							maxY = Math.max(maxY, p.y);
						}
						for (const hole of shape.holes ?? []) {
							for (const p of hole.getPoints(SHAPE_DIVISIONS)) {
								minX = Math.min(minX, p.x);
								maxX = Math.max(maxX, p.x);
								minY = Math.min(minY, p.y);
								maxY = Math.max(maxY, p.y);
							}
						}
					}
					glyphs.push({
						shapes,
						localCx: (minX + maxX) / 2,
						localBaselineY: minY,
						advance
					});
				}
			} catch {
				/* skip bad glyph */
			}
		}
		cursor += advance + charSpacing;
	}
	return glyphs;
}

function rotatePoint(x: number, y: number, angleRad: number): { x: number; y: number } {
	const c = Math.cos(angleRad);
	const s = Math.sin(angleRad);
	return { x: x * c - y * s, y: x * s + y * c };
}

type ClipperBounds = { minX: number; minY: number; maxX: number; maxY: number };

function measureClipperPathsBounds(paths: ClipperPoint[][]): ClipperBounds | null {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const path of paths) {
		for (const pt of path) {
			const x = pt.X / CLIPPER_SCALE;
			const y = pt.Y / CLIPPER_SCALE;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
	}
	if (!Number.isFinite(minX)) return null;
	return { minX, minY, maxX, maxY };
}

function translateClipperPaths(paths: ClipperPoint[][], dx: number, dy: number): ClipperPoint[][] {
	const dX = Math.round(dx * CLIPPER_SCALE);
	const dY = Math.round(dy * CLIPPER_SCALE);
	return paths.map((path) =>
		path.map((pt) => ({ X: pt.X + dX, Y: pt.Y + dY }))
	);
}

function scaleClipperPathsAbout(
	paths: ClipperPoint[][],
	scale: number,
	originX: number,
	originY: number
): ClipperPoint[][] {
	return paths.map((path) =>
		path.map((pt) => {
			const x = pt.X / CLIPPER_SCALE;
			const y = pt.Y / CLIPPER_SCALE;
			return {
				X: Math.round((originX + (x - originX) * scale) * CLIPPER_SCALE),
				Y: Math.round((originY + (y - originY) * scale) * CLIPPER_SCALE)
			};
		})
	);
}

function rotateClipperPaths(paths: ClipperPoint[][], angleDeg: number): ClipperPoint[][] {
	const angleRad = (angleDeg * Math.PI) / 180;
	return paths.map((path) =>
		path.map((pt) => {
			const x = pt.X / CLIPPER_SCALE;
			const y = pt.Y / CLIPPER_SCALE;
			const r = rotatePoint(x, y, angleRad);
			return {
				X: Math.round(r.x * CLIPPER_SCALE),
				Y: Math.round(r.y * CLIPPER_SCALE)
			};
		})
	);
}

function computeBoxJustifyShift(
	bounds: ClipperBounds,
	boxWidth: number,
	boxHeight: number,
	justify: TextBoxJustify,
	align: TextBoxAlign
): { dx: number; dy: number } {
	const halfW = boxWidth / 2;
	const halfH = boxHeight / 2;
	let dx: number;
	if (justify === 'left') dx = -halfW - bounds.minX;
	else if (justify === 'right') dx = halfW - bounds.maxX;
	else dx = -(bounds.minX + bounds.maxX) / 2;

	let dy: number;
	if (align === 'bottom') dy = -halfH - bounds.minY;
	else if (align === 'top') dy = halfH - bounds.maxY;
	else dy = -(bounds.minY + bounds.maxY) / 2;

	return { dx, dy };
}

function fitPathsToTextBox(
	paths: ClipperPoint[][],
	placement: NamePlacement
): ClipperPoint[][] {
	if (paths.length === 0) return paths;

	const boxWidth = Math.max(0.1, placement.boxWidth);
	const boxHeight = Math.max(0.1, placement.boxHeight);
	let bounds = measureClipperPathsBounds(paths);
	if (!bounds) return paths;

	const contentW = bounds.maxX - bounds.minX;
	const contentH = bounds.maxY - bounds.minY;
	if (contentW > 0 && contentH > 0) {
		const fitScale = Math.min(boxWidth / contentW, boxHeight / contentH, 1);
		if (fitScale < 0.999) {
			const originX = (bounds.minX + bounds.maxX) / 2;
			const originY = (bounds.minY + bounds.maxY) / 2;
			paths = scaleClipperPathsAbout(paths, fitScale, originX, originY);
			bounds = measureClipperPathsBounds(paths);
			if (!bounds) return paths;
		}
	}

	const { dx, dy } = computeBoxJustifyShift(
		bounds,
		boxWidth,
		boxHeight,
		placement.boxJustify,
		placement.boxAlign
	);
	return translateClipperPaths(paths, dx, dy);
}

/** Corner points for the name text box guide (XY in initial-centered space). */
export function getNameTextBoxCornerPoints(
	placement: NamePlacement,
	refCx: number,
	refCy: number
): THREE.Vector3[] {
	const halfW = Math.max(0.1, placement.boxWidth) / 2;
	const halfH = Math.max(0.1, placement.boxHeight) / 2;
	const localCorners = [
		{ x: -halfW, y: -halfH },
		{ x: halfW, y: -halfH },
		{ x: halfW, y: halfH },
		{ x: -halfW, y: halfH }
	];
	const rotationRad = (placement.rotationDeg * Math.PI) / 180;
	return localCorners.map(({ x, y }) => {
		const rotated = rotatePoint(x, y, rotationRad);
		return new THREE.Vector3(
			rotated.x + placement.offsetX - refCx,
			rotated.y + placement.offsetY - refCy,
			0
		);
	});
}

function transformPaths(
	paths: ClipperPoint[][],
	localCx: number,
	localBaselineY: number,
	worldX: number,
	worldY: number,
	angleRad: number
): ClipperPoint[][] {
	return paths.map((path) =>
		path.map((pt) => {
			const x = pt.X / CLIPPER_SCALE - localCx;
			const y = pt.Y / CLIPPER_SCALE - localBaselineY;
			const r = rotatePoint(x, y, angleRad);
			return {
				X: Math.round((r.x + worldX) * CLIPPER_SCALE),
				Y: Math.round((r.y + worldY) * CLIPPER_SCALE)
			};
		})
	);
}

export function buildCurvedNamePaths(
	font: PathFont,
	text: string,
	size: number,
	placement: NamePlacement
): ClipperPoint[][] {
	let paths = buildCurvedNamePathsLocal(font, text, size, placement);
	if (paths.length === 0) return paths;

	paths = fitPathsToTextBox(paths, placement);
	paths = rotateClipperPaths(paths, placement.rotationDeg);
	paths = translateClipperPaths(paths, placement.offsetX, placement.offsetY);
	return paths;
}

function buildCurvedNamePathsLocal(
	font: PathFont,
	text: string,
	size: number,
	placement: Pick<NamePlacement, 'charSpacing' | 'curve'>
): ClipperPoint[][] {
	const glyphs = buildGlyphLayouts(font, text, size, placement.charSpacing);
	if (glyphs.length === 0) return [];

	const totalWidth = glyphs.reduce((acc, g, i) => {
		const spacing = i < glyphs.length - 1 ? placement.charSpacing : 0;
		return acc + g.advance + spacing;
	}, 0);

	const positions: { x: number; y: number; angle: number }[] = [];
	let cursor = -totalWidth / 2;

	if (Math.abs(placement.curve) < 0.01) {
		for (const glyph of glyphs) {
			const cx = cursor + glyph.advance / 2;
			positions.push({ x: cx, y: 0, angle: 0 });
			cursor += glyph.advance + placement.charSpacing;
		}
	} else {
		const radius = Math.abs(600 / placement.curve);
		const sign = placement.curve >= 0 ? 1 : -1;
		const arcLen = totalWidth;
		const centerY = -sign * radius;
		let arcCursor = -arcLen / 2;

		for (const glyph of glyphs) {
			const mid = arcCursor + glyph.advance / 2;
			const theta = mid / radius;
			const x = radius * Math.sin(theta);
			const y = centerY + sign * radius * Math.cos(theta);
			const tangent = sign > 0 ? -theta : theta;
			positions.push({ x, y, angle: tangent });
			arcCursor += glyph.advance + placement.charSpacing;
		}
	}

	const allPaths: ClipperPoint[][] = [];
	for (let i = 0; i < glyphs.length; i++) {
		const glyph = glyphs[i];
		const pos = positions[i];
		const localPaths = pathsFromShapes(glyph.shapes);
		allPaths.push(
			...transformPaths(
				localPaths,
				glyph.localCx,
				glyph.localBaselineY,
				pos.x,
				pos.y,
				pos.angle
			)
		);
	}
	return allPaths;
}

export function buildCurvedNameShapes(
	font: PathFont,
	text: string,
	size: number,
	placement: NamePlacement
): THREE.Shape[] {
	const paths = buildCurvedNamePaths(font, text, size, placement);
	if (paths.length === 0) return [];
	return polyTreeToThreeShapes(unionPaths(paths));
}
