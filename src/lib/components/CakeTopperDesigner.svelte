<script lang="ts">
	import type { PaletteColor } from '$lib/colorPalette';
	import FontSelect from '$lib/components/FontSelect.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import { notifyExportEvent } from '$lib/exportNotify';
	import { ensureExportAccess, getExportTitle, type SubscriptionStatus } from '$lib/subscription';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import {
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		FONT_OPTIONS,
		frameCameraToObject,
		getFont,
		measureWorldAabbSizeMm
	} from '$lib/utils-3d';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import type { Session, User } from '@supabase/supabase-js';
	import ClipperLib from 'clipper-lib';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';

	interface Props {
		user: User | null;
		session: Session | null;
		subscriptionStatus: SubscriptionStatus | null;
		palette: PaletteColor[];
		onBack: () => void;
		onRequestLogin: () => void;
		onShowThankYou: () => void;
		onShowPricing?: () => void;
	}
	let {
		user,
		session,
		subscriptionStatus,
		palette,
		onBack,
		onRequestLogin,
		onShowThankYou,
		onShowPricing
	}: Props = $props();

	const STORAGE_KEY = 'keychain-cake-topper-settings';

	/** Z amount each text line is sunk into the base so they overlap (avoids non-manifold contact). */
	const TEXT_BASE_EMBED = 0.2;
	/** Curve subdivisions when sampling glyph shape outlines for Clipper. */
	const CURVE_DIVISIONS = 18;
	/** Clipper integer scaling factor (mm × SCALE → integer coordinates). */
	const CLIPPER_SCALE = 1000;
	/** Vertical overlap between each stick's top and the text bottom (mm) so the
	 *  union/offset bridges them cleanly with no gap or hairline crack. */
	const STICK_OVERLAP_MM = 1.5;

	type StickTipStyle = 'flat' | 'rounded' | 'pointy';

	/** Arc segments per rounded stick tip (more = smoother semicircle). */
	const STICK_TIP_ARC_SEGMENTS = 24;

	type CakeLine = {
		content: string;
		fontKey: string;
		size: number;
		depth: number;
		/** Fill color for this line of text (the colored letters above the outline). */
		color: string;
	};

	interface Settings {
		lines: CakeLine[];
		/** Vertical gap between adjacent lines (mm). Negative values overlap lines. */
		lineSpacing: number;
		/** Extra horizontal spacing between characters within a line (mm). */
		charSpacing: number;
		/** Outline (frame) offset radius in mm. Bridges lines + sticks into one base. */
		outlineThickness: number;
		/** Outline / base mesh color (the white frame in the reference). */
		outlineColor: string;
		/** Base extrusion depth (mm). */
		baseDepth: number;
		/** Number of sticks (1 = center, 2 = symmetric pair). */
		stickCount: 1 | 2;
		/** Stick width in mm. */
		stickWidth: number;
		/** Stick length below text (mm). */
		stickLength: number;
		/** For 2-stick mode: distance between stick centers (mm). */
		stickSpacing: number;
		/** Bottom-end shape of each stick. */
		stickTipStyle: StickTipStyle;
	}

	const DEFAULT_FONT_KEY = FONT_OPTIONS[0]?.key ?? 'Titan One_Regular';

	const defaults: Settings = {
		lines: [
			{ content: 'Cake', fontKey: DEFAULT_FONT_KEY, size: 22, depth: 1.6, color: '#dc2626' },
			{ content: 'Topper', fontKey: DEFAULT_FONT_KEY, size: 22, depth: 1.6, color: '#dc2626' },
			{ content: 'Generator', fontKey: DEFAULT_FONT_KEY, size: 18, depth: 1.6, color: '#0f172a' }
		],
		lineSpacing: 0,
		charSpacing: 0,
		outlineThickness: 3,
		outlineColor: '#ffffff',
		baseDepth: 2.5,
		stickCount: 2,
		stickWidth: 6,
		stickLength: 80,
		stickSpacing: 50,
		stickTipStyle: 'pointy'
	};

	function clamp(v: number, lo: number, hi: number): number {
		return Math.min(hi, Math.max(lo, v));
	}

	function isFiniteNumber(v: unknown): v is number {
		return typeof v === 'number' && Number.isFinite(v);
	}

	function sanitizeLine(raw: unknown): CakeLine | null {
		if (!raw || typeof raw !== 'object') return null;
		const r = raw as Partial<CakeLine>;
		if (typeof r.content !== 'string') return null;
		const fontKey =
			typeof r.fontKey === 'string' && FONT_OPTIONS.some((o) => o.key === r.fontKey)
				? r.fontKey
				: DEFAULT_FONT_KEY;
		const size = isFiniteNumber(r.size) ? clamp(r.size, 6, 80) : 18;
		const depth = isFiniteNumber(r.depth) ? clamp(r.depth, 0.1, 5) : 1.6;
		const color = typeof r.color === 'string' && /^#?[0-9a-f]{3,8}$/i.test(r.color)
			? (r.color.startsWith('#') ? r.color : `#${r.color}`)
			: defaults.lines[0].color;
		return { content: r.content, fontKey, size, depth, color };
	}

	function loadSettings(): Settings {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (!stored) return cloneDefaults();
			const parsed = JSON.parse(stored);
			if (!parsed || typeof parsed !== 'object') return cloneDefaults();
			const merged: Settings = { ...defaults, ...parsed };
			const rawLines: unknown[] | null = Array.isArray(parsed.lines) ? parsed.lines : null;
			merged.lines = rawLines
				? rawLines.map(sanitizeLine).filter((l: CakeLine | null): l is CakeLine => l !== null)
				: defaults.lines.map((l) => ({ ...l }));
			if (merged.lines.length === 0) merged.lines = defaults.lines.map((l) => ({ ...l }));
			merged.lineSpacing = isFiniteNumber(parsed.lineSpacing)
				? clamp(parsed.lineSpacing, -20, 40)
				: defaults.lineSpacing;
			merged.charSpacing = isFiniteNumber(parsed.charSpacing)
				? clamp(parsed.charSpacing, -5, 15)
				: defaults.charSpacing;
			merged.outlineThickness = isFiniteNumber(parsed.outlineThickness)
				? clamp(parsed.outlineThickness, 0.5, 10)
				: defaults.outlineThickness;
			merged.outlineColor =
				typeof parsed.outlineColor === 'string' ? parsed.outlineColor : defaults.outlineColor;
			merged.baseDepth = isFiniteNumber(parsed.baseDepth)
				? clamp(parsed.baseDepth, 0.4, 8)
				: defaults.baseDepth;
			merged.stickCount = parsed.stickCount === 1 || parsed.stickCount === 2
				? parsed.stickCount
				: defaults.stickCount;
			merged.stickWidth = isFiniteNumber(parsed.stickWidth)
				? clamp(parsed.stickWidth, 2, 30)
				: defaults.stickWidth;
			merged.stickLength = isFiniteNumber(parsed.stickLength)
				? clamp(parsed.stickLength, 10, 150)
				: defaults.stickLength;
			merged.stickSpacing = isFiniteNumber(parsed.stickSpacing)
				? clamp(parsed.stickSpacing, 10, 200)
				: defaults.stickSpacing;
			merged.stickTipStyle =
				parsed.stickTipStyle === 'flat' ||
				parsed.stickTipStyle === 'rounded' ||
				parsed.stickTipStyle === 'pointy'
					? parsed.stickTipStyle
					: defaults.stickTipStyle;
			return merged;
		} catch {
			return cloneDefaults();
		}
	}

	function cloneDefaults(): Settings {
		return { ...defaults, lines: defaults.lines.map((l) => ({ ...l })) };
	}

	const initial = loadSettings();

	let lines = $state<CakeLine[]>(initial.lines.map((l) => ({ ...l })));
	let lineSpacing = $state(initial.lineSpacing);
	let charSpacing = $state(initial.charSpacing);
	let outlineThickness = $state(initial.outlineThickness);
	let outlineColor = $state(initial.outlineColor);
	let baseDepth = $state(initial.baseDepth);
	let stickCount = $state<1 | 2>(initial.stickCount);
	let stickWidth = $state(initial.stickWidth);
	let stickLength = $state(initial.stickLength);
	let stickSpacing = $state(initial.stickSpacing);
	let stickTipStyle = $state<StickTipStyle>(initial.stickTipStyle);

	let hostEl: HTMLDivElement | null = null;
	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.PerspectiveCamera | null = null;
	let controls: InstanceType<typeof OrbitControls> | null = null;
	let group: THREE.Group | null = null;
	let keyLight: THREE.DirectionalLight | null = null;
	let shadowPlane: THREE.Mesh | null = null;
	let rafId = 0;
	let ro: ResizeObserver | null = null;
	let didInitFrame = false;
	let openBambuStudioLoading = $state(false);
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);

	function resize() {
		if (!renderer || !camera || !hostEl) return;
		const rect = hostEl.getBoundingClientRect();
		const width = Math.max(1, Math.floor(rect.width));
		const height = Math.max(1, Math.floor(rect.height));
		renderer.setSize(width, height, true);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
	}

	function saveSettings() {
		try {
			const payload: Settings = {
				lines,
				lineSpacing,
				charSpacing,
				outlineThickness,
				outlineColor,
				baseDepth,
				stickCount,
				stickWidth,
				stickLength,
				stickSpacing,
				stickTipStyle
			};
			localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
		} catch {
			/* localStorage may be unavailable (private mode); ignore */
		}
	}

	// ── Per-line layout (custom char spacing) ────────────────────────────────
	type CharGroup = {
		shapes: THREE.Shape[];
		xOffset: number;
	};
	type LineLayout = {
		line: CakeLine;
		chars: CharGroup[];
		minX: number;
		maxX: number;
		minY: number;
		maxY: number;
	};

	/** Build per-character shape groups for a line, applying explicit char spacing
	 * (atop the font's default kerning/advance). Skips characters with missing
	 * glyphs so a stray symbol doesn't break the rest of the line. */
	function buildLineLayout(line: CakeLine): LineLayout | null {
		const content = line.content ?? '';
		if (!content) return null;
		const font = getFont(line.fontKey);
		if (!font) return null;
		const data = (font as { data?: { resolution?: number; glyphs?: Record<string, { ha?: number }> } }).data;
		const resolution = data?.resolution ?? 1000;
		const size = Math.max(1, line.size);
		const scale = size / resolution;
		const chars: CharGroup[] = [];
		let cursor = 0;
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		const samplePoints = (sh: THREE.Shape, xo: number) => {
			try {
				const pts = sh.getPoints(CURVE_DIVISIONS);
				for (const p of pts) {
					if (p.x + xo < minX) minX = p.x + xo;
					if (p.x + xo > maxX) maxX = p.x + xo;
					if (p.y < minY) minY = p.y;
					if (p.y > maxY) maxY = p.y;
				}
				for (const h of sh.holes ?? []) {
					const hpts = h.getPoints(CURVE_DIVISIONS);
					for (const p of hpts) {
						if (p.x + xo < minX) minX = p.x + xo;
						if (p.x + xo > maxX) maxX = p.x + xo;
						if (p.y < minY) minY = p.y;
						if (p.y > maxY) maxY = p.y;
					}
				}
			} catch {
				/* ignore degenerate curve sampling */
			}
		};
		for (const ch of content) {
			const glyph = data?.glyphs?.[ch];
			const advance = (glyph?.ha ?? resolution * 0.5) * scale;
			if (ch !== ' ' && ch !== '\t' && glyph) {
				try {
					const shapes = font.generateShapes(ch, size) as THREE.Shape[];
					if (shapes && shapes.length > 0) {
						chars.push({ shapes, xOffset: cursor });
						for (const sh of shapes) samplePoints(sh, cursor);
					}
				} catch {
					/* skip degenerate glyph */
				}
			}
			cursor += advance;
			// Apply extra char spacing after every visible char (and after spaces too,
			// so user-controlled negative values can tighten/loosen uniformly).
			cursor += charSpacing;
		}
		if (chars.length === 0) return null;
		// Fall back to cursor extents when sampling missed everything (e.g. all spaces).
		if (!Number.isFinite(minX)) {
			minX = 0;
			maxX = Math.max(0, cursor - charSpacing);
			minY = 0;
			maxY = size;
		}
		return { line, chars, minX, maxX, minY, maxY };
	}

	// ── Mesh rebuild ─────────────────────────────────────────────────────────
	function rebuildMeshes() {
		if (!scene || !group) return;
		disposeObject3D(group);
		group.clear();
		group.position.set(0, 0, 0);
		modelAabbMm = null;

		// 1) Build layouts (per-line char positions) and stack them vertically.
		const rawLayouts = lines
			.map((line) => buildLineLayout(line))
			.filter((l: LineLayout | null): l is LineLayout => l !== null);
		if (rawLayouts.length === 0) return;

		type PositionedLayout = LineLayout & { tx: number; ty: number };
		const positioned: PositionedLayout[] = [];
		const gap = lineSpacing;
		// Stack from top to bottom. Each line is centered on x=0; first line top at y=0.
		let yTop = 0;
		for (const lo of rawLayouts) {
			const tx = -(lo.minX + lo.maxX) / 2;
			const ty = yTop - lo.maxY;
			positioned.push({ ...lo, tx, ty });
			yTop = ty + lo.minY - gap;
		}

		// 2) Center the stacked text block vertically about y=0.
		let blockMinX = Infinity;
		let blockMaxX = -Infinity;
		let blockMinY = Infinity;
		let blockMaxY = -Infinity;
		for (const p of positioned) {
			const lminX = p.minX + p.tx;
			const lmaxX = p.maxX + p.tx;
			const lminY = p.minY + p.ty;
			const lmaxY = p.maxY + p.ty;
			if (lminX < blockMinX) blockMinX = lminX;
			if (lmaxX > blockMaxX) blockMaxX = lmaxX;
			if (lminY < blockMinY) blockMinY = lminY;
			if (lmaxY > blockMaxY) blockMaxY = lmaxY;
		}
		if (!Number.isFinite(blockMinX)) {
			// No text but possibly sticks — anchor block bbox to the stick top.
			blockMinX = -1;
			blockMaxX = 1;
			blockMinY = 0;
			blockMaxY = 0;
		}
		const blockCenterY = (blockMinY + blockMaxY) / 2;
		for (const p of positioned) p.ty -= blockCenterY;
		const textBottom = blockMinY - blockCenterY;

		// 3) Convert all positioned glyphs into Clipper input paths (CW outers / CCW holes).
		// Sticks are kept in a separate path list so the outline offset only inflates
		// the text — the sticks stay exactly `stickWidth × stickLength` regardless of
		// the outline thickness slider.
		const SCALE = CLIPPER_SCALE;
		const textPaths: { X: number; Y: number }[][] = [];
		const ensureCW = (path: { X: number; Y: number }[], clockwise: boolean) => {
			const isCW = ClipperLib.Clipper.Orientation(path);
			if (isCW !== clockwise) path.reverse();
		};
		const shapeToPaths = (
			sh: THREE.Shape,
			dx: number,
			dy: number,
			out: { X: number; Y: number }[][]
		) => {
			const toPath = (pts: { x: number; y: number }[]) => {
				const arr: { X: number; Y: number }[] = [];
				for (const p of pts) {
					arr.push({
						X: Math.round((p.x + dx) * SCALE),
						Y: Math.round((p.y + dy) * SCALE)
					});
				}
				if (arr.length > 2) {
					const a = arr[0];
					const b = arr[arr.length - 1];
					if (a.X === b.X && a.Y === b.Y) arr.pop();
				}
				return arr;
			};
			const outer = toPath(sh.getPoints(CURVE_DIVISIONS));
			if (outer.length >= 3) {
				ensureCW(outer, true);
				out.push(outer);
			}
			for (const h of sh.holes ?? []) {
				const holePath = toPath(h.getPoints(CURVE_DIVISIONS));
				if (holePath.length >= 3) {
					ensureCW(holePath, false);
					out.push(holePath);
				}
			}
		};
		for (const p of positioned) {
			for (const c of p.chars) {
				for (const sh of c.shapes) {
					shapeToPaths(sh, p.tx + c.xOffset, p.ty, textPaths);
				}
			}
		}

		// 4) Build literal stick rectangles (no offset will be applied).
		const stickPaths: { X: number; Y: number }[][] = [];
		const stickW = Math.max(0.1, stickWidth);
		const stickH = Math.max(0.1, stickLength);
		const stickTop = textBottom + STICK_OVERLAP_MM;
		const stickBottom = stickTop - stickH - STICK_OVERLAP_MM;
		const stickXs: number[] =
			stickCount === 2
				? [-Math.max(0.5, stickSpacing) / 2, Math.max(0.5, stickSpacing) / 2]
				: [0];
		for (const sx of stickXs) {
			const x0 = sx - stickW / 2;
			const x1 = sx + stickW / 2;
			const cx = sx;
			// Shoulder = vertical position where the side walls transition into the tip.
			// Setting it at half the stick width gives a 45° pointy wedge or a true
			// hemispherical rounded tip (and keeps the lowest point at `stickBottom`,
			// so the visible stick length always equals the user's slider value).
			const tipLen = stickW / 2;
			const shoulder = stickBottom + tipLen;
			const path: { X: number; Y: number }[] = [];
			// Top edge (overlaps into the text union).
			path.push({ X: Math.round(x0 * SCALE), Y: Math.round(stickTop * SCALE) });
			path.push({ X: Math.round(x1 * SCALE), Y: Math.round(stickTop * SCALE) });
			if (stickTipStyle === 'pointy') {
				// Right shoulder → point (tip) → left shoulder.
				path.push({ X: Math.round(x1 * SCALE), Y: Math.round(shoulder * SCALE) });
				path.push({ X: Math.round(cx * SCALE), Y: Math.round(stickBottom * SCALE) });
				path.push({ X: Math.round(x0 * SCALE), Y: Math.round(shoulder * SCALE) });
			} else if (stickTipStyle === 'rounded') {
				// Half-circle from right shoulder, sweeping down through the tip,
				// back up to the left shoulder. Center sits at (cx, shoulder); radius
				// = tipLen so the lowest arc point lands on `stickBottom`.
				for (let i = 0; i <= STICK_TIP_ARC_SEGMENTS; i++) {
					const t = i / STICK_TIP_ARC_SEGMENTS;
					const angle = -t * Math.PI;
					const ax = cx + tipLen * Math.cos(angle);
					const ay = shoulder + tipLen * Math.sin(angle);
					path.push({ X: Math.round(ax * SCALE), Y: Math.round(ay * SCALE) });
				}
			} else {
				// Flat — plain rectangle.
				path.push({ X: Math.round(x1 * SCALE), Y: Math.round(stickBottom * SCALE) });
				path.push({ X: Math.round(x0 * SCALE), Y: Math.round(stickBottom * SCALE) });
			}
			ensureCW(path, true);
			stickPaths.push(path);
		}

		if (textPaths.length === 0 && stickPaths.length === 0) return;

		// 5) Inflate text only by `outlineThickness` (the white frame), then union with
		// the raw stick rectangles to form the final base outline. The sticks therefore
		// keep their literal user-set dimensions regardless of frame thickness.
		const outlineWorld = Math.max(0, outlineThickness);
		let outlinedTextPaths: { X: number; Y: number }[][];
		if (outlineWorld > 0 && textPaths.length > 0) {
			outlinedTextPaths = [];
			const co = new ClipperLib.ClipperOffset(2, 2);
			co.AddPaths(
				textPaths,
				ClipperLib.JoinType.jtRound,
				ClipperLib.EndType.etClosedPolygon
			);
			co.Execute(outlinedTextPaths, outlineWorld * SCALE);
		} else {
			outlinedTextPaths = textPaths;
		}

		const outlineTree = new ClipperLib.PolyTree();
		const c2 = new ClipperLib.Clipper();
		if (outlinedTextPaths.length > 0)
			c2.AddPaths(outlinedTextPaths, ClipperLib.PolyType.ptSubject, true);
		if (stickPaths.length > 0)
			c2.AddPaths(stickPaths, ClipperLib.PolyType.ptSubject, true);
		c2.Execute(
			ClipperLib.ClipType.ctUnion,
			outlineTree,
			ClipperLib.PolyFillType.pftNonZero,
			ClipperLib.PolyFillType.pftNonZero
		);

		// 6) PolyTree → THREE.Shape[] for extrusion.
		const polyTreeToThreeShapes = (tree: unknown) => {
			const shapesOut: THREE.Shape[] = [];
			const toVec2 = (pt: { X: number; Y: number }) =>
				new THREE.Vector2(pt.X / SCALE, pt.Y / SCALE);
			type PolyNode = {
				IsHole?: () => boolean;
				m_IsHole?: boolean;
				Contour?: () => { X: number; Y: number }[];
				m_polygon?: { X: number; Y: number }[];
				Childs?: () => PolyNode[];
				m_Childs?: PolyNode[];
			};
			const buildFromOuter = (outerNode: PolyNode): THREE.Shape | null => {
				const contour = outerNode.Contour?.() ?? outerNode.m_polygon ?? [];
				if (!contour || contour.length < 3) return null;
				// Three.js ExtrudeGeometry expects outer CCW + holes CW.
				const outerPts = contour.map(toVec2);
				if (THREE.ShapeUtils.isClockWise(outerPts)) outerPts.reverse();
				const shape = new THREE.Shape(outerPts);
				const children = outerNode.Childs?.() ?? outerNode.m_Childs ?? [];
				for (const ch of children) {
					const isHole = ch.IsHole?.() ?? ch.m_IsHole;
					if (isHole) {
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
								const nested = buildFromOuter(hk);
								if (nested) shapesOut.push(nested);
							}
						}
					}
				}
				return shape;
			};
			const roots = (tree as unknown as PolyNode).Childs?.() ?? (tree as unknown as PolyNode).m_Childs ?? [];
			for (const n of roots) {
				const isHole = n.IsHole?.() ?? n.m_IsHole;
				if (isHole) continue;
				const s = buildFromOuter(n);
				if (s) shapesOut.push(s);
			}
			return shapesOut;
		};

		const baseShapes = polyTreeToThreeShapes(outlineTree);
		if (baseShapes.length === 0) return;

		// 7) Extrude the base outline (white frame).
		const baseMat = new THREE.MeshStandardMaterial({
			color: outlineColor,
			roughness: 0.85,
			metalness: 0.05
		});
		const baseGeo = new THREE.ExtrudeGeometry(baseShapes, {
			depth: Math.max(0.1, baseDepth),
			bevelEnabled: false,
			curveSegments: 12
		});
		const baseMesh = new THREE.Mesh(baseGeo, baseMat);
		baseMesh.name = 'base';
		baseMesh.castShadow = true;
		baseMesh.receiveShadow = true;
		baseMesh.position.z = 0;
		group.add(baseMesh);

		// 8) Per-line colored text meshes (extruded individually so each line has its own color).
		for (const p of positioned) {
			const linePaths: { X: number; Y: number }[][] = [];
			for (const c of p.chars) {
				for (const sh of c.shapes) {
					const dx = p.tx + c.xOffset;
					const dy = p.ty;
					const toPath = (pts: { x: number; y: number }[]) => {
						const out: { X: number; Y: number }[] = [];
						for (const pt of pts) {
							out.push({
								X: Math.round((pt.x + dx) * SCALE),
								Y: Math.round((pt.y + dy) * SCALE)
							});
						}
						if (out.length > 2) {
							const a = out[0];
							const b = out[out.length - 1];
							if (a.X === b.X && a.Y === b.Y) out.pop();
						}
						return out;
					};
					const outer = toPath(sh.getPoints(CURVE_DIVISIONS));
					if (outer.length < 3) continue;
					ensureCW(outer, true);
					linePaths.push(outer);
					for (const h of sh.holes ?? []) {
						const hp = toPath(h.getPoints(CURVE_DIVISIONS));
						if (hp.length < 3) continue;
						ensureCW(hp, false);
						linePaths.push(hp);
					}
				}
			}
			if (linePaths.length === 0) continue;
			const lineTree = new ClipperLib.PolyTree();
			const lc = new ClipperLib.Clipper();
			lc.AddPaths(linePaths, ClipperLib.PolyType.ptSubject, true);
			lc.Execute(
				ClipperLib.ClipType.ctUnion,
				lineTree,
				ClipperLib.PolyFillType.pftNonZero,
				ClipperLib.PolyFillType.pftNonZero
			);
			const lineShapes = polyTreeToThreeShapes(lineTree);
			if (lineShapes.length === 0) continue;
			const textMat = new THREE.MeshStandardMaterial({
				color: p.line.color,
				roughness: 0.35,
				metalness: 0.1
			});
			const textGeo = new THREE.ExtrudeGeometry(lineShapes, {
				depth: Math.max(0.05, p.line.depth),
				bevelEnabled: false,
				curveSegments: 12
			});
			const textMesh = new THREE.Mesh(textGeo, textMat);
			textMesh.name = 'text';
			textMesh.castShadow = true;
			textMesh.receiveShadow = true;
			// Embed text into base so they overlap (avoids non-manifold at contact)
			textMesh.position.z = Math.max(0.1, baseDepth) - TEXT_BASE_EMBED;
			group.add(textMesh);
		}

		// 9) Center the entire model (text + outline + sticks) on the build plate
		// in XY. Z is left alone so the base still sits on the bed at z = 0.
		group.updateWorldMatrix(true, true);
		const rawBox = new THREE.Box3().setFromObject(group);
		const rawCenter = new THREE.Vector3();
		rawBox.getCenter(rawCenter);
		group.position.x -= rawCenter.x;
		group.position.y -= rawCenter.y;
		group.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(group);

		// 10) Shadow camera + initial framing + dimensions HUD.
		if (keyLight?.shadow?.camera) {
			const sizeVec = new THREE.Vector3();
			box.getSize(sizeVec);
			const center = new THREE.Vector3();
			box.getCenter(center);
			const r = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) * 0.75 + 10;
			const cam = keyLight.shadow.camera as THREE.OrthographicCamera;
			cam.left = -r;
			cam.right = r;
			cam.top = r;
			cam.bottom = -r;
			cam.near = 0.1;
			cam.far = Math.max(300, r * 6);
			cam.updateProjectionMatrix();
			keyLight.target.position.copy(center);
			keyLight.target.updateWorldMatrix(true, true);
		}
		if (!didInitFrame && camera && controls) {
			frameCameraToObject(box, camera, controls);
			didInitFrame = true;
		}
		const s = measureWorldAabbSizeMm(group);
		modelAabbMm = s ? { x: s.x, y: s.y, z: s.z } : null;
	}

	// ── Line manipulation ────────────────────────────────────────────────────
	function addLine() {
		const last = lines[lines.length - 1];
		const seed: CakeLine = last
			? { ...last, content: '' }
			: { content: '', fontKey: DEFAULT_FONT_KEY, size: 18, depth: 1.6, color: '#dc2626' };
		lines = [...lines, seed];
	}

	function removeLine(index: number) {
		if (lines.length <= 1) return;
		lines = lines.filter((_, i) => i !== index);
	}

	function moveLine(index: number, delta: -1 | 1) {
		const target = index + delta;
		if (target < 0 || target >= lines.length) return;
		const next = [...lines];
		const [item] = next.splice(index, 1);
		next.splice(target, 0, item);
		lines = next;
	}

	// ── Export ───────────────────────────────────────────────────────────────
	async function exportSTL() {
		if (!group || !scene) return;
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		rebuildMeshes();
		group.updateWorldMatrix(true, true);
		const geometries: THREE.BufferGeometry[] = [];
		for (const child of group.children) {
			if ((child as THREE.Mesh).isMesh) {
				const mesh = child as THREE.Mesh;
				const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
				geometries.push(geo);
			}
		}
		if (geometries.length === 0) return;
		const merged = BufferGeometryUtils.mergeGeometries(geometries);
		if (!merged) return;
		geometries.forEach((g) => g.dispose());
		const welded = BufferGeometryUtils.mergeVertices(merged, 1e-3);
		merged.dispose();
		const singleMesh = new THREE.Mesh(welded);
		const exporter = new STLExporter();
		const result = exporter.parse(singleMesh, { binary: true });
		welded.dispose();
		const buffer = result instanceof DataView ? result.buffer : result;
		if (buffer && buffer.byteLength >= 84) {
			const blob = new Blob([buffer], { type: 'model/stl' });
			const filename = filenameStem();
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${filename}-${timestamp}.stl`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Cake Topper',
				format: 'stl'
			});
		}
		onShowThankYou();
	}

	async function export3MF() {
		if (!group || !scene) return;
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		rebuildMeshes();
		group.updateWorldMatrix(true, true);
		const exportGroup = group.clone(true);
		exportGroup.traverse((obj: THREE.Object3D) => {
			if (obj instanceof THREE.Mesh && obj.name === 'text') {
				obj.position.z += TEXT_BASE_EMBED;
			}
		});
		exportGroup.updateWorldMatrix(true, true);
		const blob = await exportTo3MF(exportGroup);
		if (!blob || blob.size === 0) return;
		const filename = filenameStem();
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		downloadBlob(`${filename}-multipart-${timestamp}.3mf`, blob);
		notifyExportEvent({
			email: user?.email,
			name:
				(user?.user_metadata?.full_name as string) ??
				(user?.user_metadata?.name as string),
			subscriptionStatus,
			designName: 'Cake Topper',
			format: '3mf'
		});
		onShowThankYou();
	}

	async function openWithBambuStudio() {
		if (!group || !scene) return;
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		openBambuStudioLoading = true;
		await tickThenYieldToPaint();
		try {
			rebuildMeshes();
			group.updateWorldMatrix(true, true);
			const exportGroup = group.clone(true);
			exportGroup.traverse((obj: THREE.Object3D) => {
				if (obj instanceof THREE.Mesh && obj.name === 'text') {
					obj.position.z += TEXT_BASE_EMBED;
				}
			});
			exportGroup.updateWorldMatrix(true, true);
			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'caketopper');
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Cake Topper',
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (err) {
			console.error('Open with Bambu Studio failed:', err);
		} finally {
			openBambuStudioLoading = false;
		}
	}

	function filenameStem(): string {
		const joined = lines
			.map((l) => l.content)
			.join(' ')
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '');
		return joined || 'cake-topper';
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────
	onMount(() => {
		if (!hostEl) return;
		scene = new THREE.Scene();
		scene.background = new THREE.Color(0xffffff);
		camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
		camera.up.set(0, 0, 1);
		renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
		renderer.setPixelRatio(Math.max(1, window.devicePixelRatio || 1));
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.05;
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		hostEl.appendChild(renderer.domElement);
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		renderer.domElement.style.display = 'block';
		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.screenSpacePanning = false;
		controls.minDistance = 50;
		controls.maxDistance = 800;
		controls.update();

		const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.25);
		scene.add(hemi);
		keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
		keyLight.position.set(80, -120, 140);
		keyLight.castShadow = true;
		keyLight.shadow.mapSize.width = 2048;
		keyLight.shadow.mapSize.height = 2048;
		keyLight.shadow.bias = -0.0002;
		keyLight.shadow.normalBias = 0.02;
		scene.add(keyLight);
		scene.add(keyLight.target);
		const rim = new THREE.DirectionalLight(0xffffff, 0.7);
		rim.position.set(-120, 90, 80);
		scene.add(rim);
		const fill = new THREE.DirectionalLight(0xffffff, 0.45);
		fill.position.set(40, 120, 60);
		scene.add(fill);
		const grid = new THREE.GridHelper(250, 25, 0xcbd5e1, 0xe2e8f0);
		grid.rotation.x = Math.PI / 2;
		grid.position.z = -0.01;
		scene.add(grid);
		shadowPlane = new THREE.Mesh(
			new THREE.PlaneGeometry(1200, 1200),
			new THREE.ShadowMaterial({ opacity: 0.18 })
		);
		shadowPlane.position.z = -0.015;
		shadowPlane.receiveShadow = true;
		scene.add(shadowPlane);

		group = new THREE.Group();
		scene.add(group);
		ro = new ResizeObserver(() => resize());
		ro.observe(hostEl);
		resize();
		rebuildMeshes();
		const tick = () => {
			rafId = requestAnimationFrame(tick);
			controls?.update();
			if (renderer && scene && camera) renderer.render(scene, camera);
		};
		tick();
		return () => {
			ro?.disconnect();
			ro = null;
		};
	});

	// ── Reactive effects ─────────────────────────────────────────────────────
	$effect(() => {
		// Track every persisted setting so any change is saved.
		void lines;
		void lineSpacing;
		void charSpacing;
		void outlineThickness;
		void outlineColor;
		void baseDepth;
		void stickCount;
		void stickWidth;
		void stickLength;
		void stickSpacing;
		void stickTipStyle;
		saveSettings();
	});

	$effect(() => {
		void lines;
		void lineSpacing;
		void charSpacing;
		void outlineThickness;
		void outlineColor;
		void baseDepth;
		void stickCount;
		void stickWidth;
		void stickLength;
		void stickSpacing;
		void stickTipStyle;
		if (!scene) return;
		rebuildMeshes();
	});

	onDestroy(() => {
		cancelAnimationFrame(rafId);
		rafId = 0;
		ro?.disconnect();
		ro = null;
		if (group) {
			disposeObject3D(group);
			group.clear();
		}
		controls?.dispose();
		controls = null;
		if (renderer && hostEl && renderer.domElement.parentElement === hostEl) {
			hostEl.removeChild(renderer.domElement);
		}
		renderer?.dispose();
		renderer = null;
		scene = null;
		camera = null;
		group = null;
	});
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
	<div
		class="mx-auto flex h-full w-full max-w-[1600px] min-h-0 flex-col gap-4 lg:flex-row"
	>
		<aside
			class="flex min-h-0 w-full max-w-[380px] min-w-[320px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Cake Topper</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div
				class="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto p-4 pt-0"
			>
				<!-- Lines panel -->
				<div class="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="flex items-center justify-between">
						<div class="text-xs font-semibold tracking-tight text-slate-700">Lines</div>
						<Button variant="secondary" size="xs" onclick={addLine}>+ Add line</Button>
					</div>
					{#each lines as line, idx (idx)}
						<div class="grid gap-2 rounded-xl border border-slate-200 bg-white p-3">
							<div class="flex items-center justify-between gap-2">
								<span class="text-[11px] font-medium uppercase tracking-wider text-slate-500"
									>Line {idx + 1}</span
								>
								<div class="flex items-center gap-1">
									<Button
										variant="outline"
										size="xs"
										disabled={idx === 0}
										onclick={() => moveLine(idx, -1)}
										title="Move up">↑</Button
									>
									<Button
										variant="outline"
										size="xs"
										disabled={idx === lines.length - 1}
										onclick={() => moveLine(idx, 1)}
										title="Move down">↓</Button
									>
									<Button
										variant="outline"
										size="xs"
										disabled={lines.length <= 1}
										onclick={() => removeLine(idx)}
										title="Remove">×</Button
									>
								</div>
							</div>
							<input
								class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2"
								type="text"
								placeholder="Line {idx + 1}"
								bind:value={line.content}
							/>
							<FontSelect bind:value={line.fontKey} />
							<div class="grid grid-cols-2 gap-2">
								<label class="grid gap-1">
									<div class="flex items-center justify-between">
										<span class="text-[11px] font-medium text-slate-600">Size</span>
										<span class="text-[11px] tabular-nums text-slate-500"
											>{line.size}mm</span
										>
									</div>
									<Slider
										type="single"
										bind:value={line.size}
										min={6}
										max={60}
										step={1}
										class="w-full"
									/>
								</label>
								<label class="grid gap-1">
									<div class="flex items-center justify-between">
										<span class="text-[11px] font-medium text-slate-600">Depth</span>
										<span class="text-[11px] tabular-nums text-slate-500"
											>{line.depth.toFixed(1)}mm</span
										>
									</div>
									<Slider
										type="single"
										bind:value={line.depth}
										min={0.4}
										max={5}
										step={0.1}
										class="w-full"
									/>
								</label>
							</div>
							<ColorPalettePicker
								bind:value={line.color}
								{palette}
								label="Text color"
							/>
						</div>
					{/each}
				</div>

				<!-- Spacing panel -->
				<div class="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="text-xs font-semibold tracking-tight text-slate-700">Spacing</div>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Line spacing</span>
							<span class="text-xs tabular-nums text-slate-600"
								>{lineSpacing.toFixed(1)}mm</span
							>
						</div>
						<Slider
							type="single"
							bind:value={lineSpacing}
							min={-20}
							max={40}
							step={0.5}
							class="w-full"
						/>
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Character spacing</span>
							<span class="text-xs tabular-nums text-slate-600"
								>{charSpacing.toFixed(1)}mm</span
							>
						</div>
						<Slider
							type="single"
							bind:value={charSpacing}
							min={-3}
							max={10}
							step={0.1}
							class="w-full"
						/>
					</label>
				</div>

				<!-- Outline panel -->
				<div class="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="text-xs font-semibold tracking-tight text-slate-700">Outline</div>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Thickness</span>
							<span class="text-xs tabular-nums text-slate-600"
								>{outlineThickness.toFixed(1)}mm</span
							>
						</div>
						<Slider
							type="single"
							bind:value={outlineThickness}
							min={0.5}
							max={10}
							step={0.1}
							class="w-full"
						/>
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Base depth</span>
							<span class="text-xs tabular-nums text-slate-600"
								>{baseDepth.toFixed(1)}mm</span
							>
						</div>
						<Slider
							type="single"
							bind:value={baseDepth}
							min={0.4}
							max={8}
							step={0.1}
							class="w-full"
						/>
					</label>
					<ColorPalettePicker
						bind:value={outlineColor}
						{palette}
						label="Outline color"
					/>
				</div>

				<!-- Sticks panel -->
				<div class="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="text-xs font-semibold tracking-tight text-slate-700">Sticks</div>
					<div class="grid grid-cols-2 gap-2">
						<button
							type="button"
							class={[
								'rounded-lg border px-3 py-2 text-xs font-medium transition',
								stickCount === 1
									? 'border-indigo-400 bg-indigo-50 text-indigo-700'
									: 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
							].join(' ')}
							onclick={() => (stickCount = 1)}
						>
							1 stick (center)
						</button>
						<button
							type="button"
							class={[
								'rounded-lg border px-3 py-2 text-xs font-medium transition',
								stickCount === 2
									? 'border-indigo-400 bg-indigo-50 text-indigo-700'
									: 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
							].join(' ')}
							onclick={() => (stickCount = 2)}
						>
							2 sticks
						</button>
					</div>
					<div class="grid gap-1.5">
						<span class="text-[11px] font-medium uppercase tracking-wider text-slate-500"
							>Tip shape</span
						>
						<div class="grid grid-cols-3 gap-2">
							{#each [{ value: 'flat', label: 'Flat' }, { value: 'rounded', label: 'Rounded' }, { value: 'pointy', label: 'Pointy' }] as opt (opt.value)}
								<button
									type="button"
									class={[
										'rounded-lg border px-2 py-2 text-xs font-medium transition',
										stickTipStyle === opt.value
											? 'border-indigo-400 bg-indigo-50 text-indigo-700'
											: 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
									].join(' ')}
									onclick={() => (stickTipStyle = opt.value as StickTipStyle)}
								>
									{opt.label}
								</button>
							{/each}
						</div>
					</div>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Stick width</span>
							<span class="text-xs tabular-nums text-slate-600"
								>{stickWidth.toFixed(1)}mm</span
							>
						</div>
						<Slider
							type="single"
							bind:value={stickWidth}
							min={2}
							max={30}
							step={0.5}
							class="w-full"
						/>
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Stick length</span>
							<span class="text-xs tabular-nums text-slate-600"
								>{stickLength.toFixed(0)}mm</span
							>
						</div>
						<Slider
							type="single"
							bind:value={stickLength}
							min={10}
							max={150}
							step={1}
							class="w-full"
						/>
					</label>
					{#if stickCount === 2}
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Stick spacing</span>
								<span class="text-xs tabular-nums text-slate-600"
									>{stickSpacing.toFixed(0)}mm</span
								>
							</div>
							<Slider
								type="single"
								bind:value={stickSpacing}
								min={10}
								max={200}
								step={1}
								class="w-full"
							/>
						</label>
					{/if}
				</div>
			</div>
		</aside>

		<section
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<DesignerModelDimensionsHud sizes={modelAabbMm} />
			<div bind:this={hostEl} class="absolute inset-0"></div>
			<div class="absolute right-4 bottom-4">
				<DesignerExportToolbar
					onSnapshot={() =>
						downloadSnapshot(renderer, scene, camera, 'cake-topper')}
					onExport={() =>
						user && subscriptionStatus?.isActive ? exportSTL() : onShowPricing?.()}
					onExport3MF={() =>
						user && subscriptionStatus?.isActive ? export3MF() : onShowPricing?.()}
					onOpenWithBambuStudio={() =>
						user && subscriptionStatus?.isActive
							? openWithBambuStudio()
							: onShowPricing?.()}
					{openBambuStudioLoading}
					exportDisabled={false}
					exportTitle={getExportTitle(user, subscriptionStatus, 'Export STL or 3MF (multipart)')}
					showLockIcon={!user || !subscriptionStatus?.isActive}
				/>
			</div>
		</section>
	</div>
</main>
