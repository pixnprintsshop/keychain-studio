<script lang="ts">
	import type { PaletteColor } from '$lib/colorPalette';
	import FontSelect from '$lib/components/FontSelect.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import { notifyExportEvent } from '$lib/exportNotify';
	import { runOpenScad } from '$lib/openscad';
	import { ensureExportAccess, getExportTitle, type SubscriptionStatus } from '$lib/subscription';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import {
		centerGeometryXY,
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		FONT_OPTIONS,
		frameCameraToObject,
		getFont,
		measureWorldAabbSizeMm,
		stlToBufferGeometry
	} from '$lib/utils-3d';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
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

	const STORAGE_KEY = 'keychain-idnametag-settings';

	/** Z amount each text line is sunk into the base so they overlap (avoids non-manifold contact). */
	const TEXT_BASE_EMBED = 0.2;
	/** Embed for the border so it isn't exactly coplanar with the base in exports. */
	const BORDER_BASE_EMBED = 0.05;
	/** Width of the raised border frame around the inner rounded rectangle (mm). */
	const BORDER_WIDTH_MM = 3;
	/** Arc segments per rounded corner. Straight edges are NOT subdivided
	 * (we emit only their endpoints) so Earcut's bridge edge never lands on
	 * a collinear midpoint and create zero-area sliver triangles. */
	const CORNER_ARC_SEGMENTS = 12;
	/** Tolerance (mm) for welding near-duplicate vertices in extruded base/border geometry. */
	const WELD_TOL_MM = 1e-3;
	/** Slight scale on the lace-hole subtraction brush so its faces never sit
	 * exactly coplanar with the base/border (avoids CSG z-fighting slivers). */
	const HOLE_EPSILON_SCALE = 1.005;
	/** Hard cap on text width as a fraction of the tag's base width. Lines that
	 * exceed this are uniformly scaled down (preserving aspect) to fit. */
	const TEXT_MAX_WIDTH_RATIO = 0.93;
	/** Extra horizontal padding (mm) added to each side of the lace-hole's
	 * x-range when computing the flat band on the top wavy edge — keeps a clean
	 * strip of straight border directly above the lace hole. */
	const LACE_TOP_FLAT_PAD = 2;

	/** Sliders' allowed range for the wavy outline. Amplitude is the bump height
	 * (mm) and wavelength is the period (mm/wave); the wave count per edge is
	 * derived from the tag dimensions so the look stays consistent across sizes. */
	const WAVE_AMP_MIN = 0;
	const WAVE_AMP_MAX = 5;
	const WAVELENGTH_MIN = 6;
	const WAVELENGTH_MAX = 30;

	type IdTagLine = {
		content: string;
		fontKey: string;
		size: number;
		depth: number;
	};

	interface Settings {
		baseWidth: number;
		baseHeight: number;
		cornerRadius: number;
		baseDepth: number;
		topBorderDepth: number;
		baseColor: string;
		accentColor: string;
		lines: IdTagLine[];
		/** Vertical gap (mm) between adjacent text lines. */
		lineSpacing: number;
		/** Through-tag lanyard slot at top center (rounded-rectangle / stadium). */
		laceHole: boolean;
		laceHoleWidth: number;
		laceHoleHeight: number;
		/** Distance (mm) from the top edge of the tag to the top of the slot. */
		laceHoleMargin: number;
		/** Wavy outline amplitude (mm) — peak deviation from the rect edge. */
		waveAmplitude: number;
		/** Wavy outline wavelength (mm) — period along each edge. */
		waveLength: number;
	}

	const DEFAULT_FONT_KEY = FONT_OPTIONS[0]?.key ?? 'Titan One_Regular';

	const defaults: Settings = {
		baseWidth: 150,
		baseHeight: 75,
		cornerRadius: 8,
		baseDepth: 2.5,
		topBorderDepth: 1.2,
		baseColor: '#ffffff',
		accentColor: '#1f2937',
		lines: [
			{ content: 'YOUR NAME', fontKey: DEFAULT_FONT_KEY, size: 18, depth: 1 },
			{ content: 'Title / Role', fontKey: DEFAULT_FONT_KEY, size: 9, depth: 1 }
		],
		lineSpacing: 5,
		laceHole: true,
		laceHoleWidth: 25,
		laceHoleHeight: 4,
		laceHoleMargin: 2,
		waveAmplitude: 0,
		waveLength: 12
	};

	function clamp(v: number, lo: number, hi: number): number {
		return Math.min(hi, Math.max(lo, v));
	}

	function isFiniteNumber(v: unknown): v is number {
		return typeof v === 'number' && Number.isFinite(v);
	}

	function sanitizeLine(raw: unknown): IdTagLine | null {
		if (!raw || typeof raw !== 'object') return null;
		const r = raw as Partial<IdTagLine>;
		if (typeof r.content !== 'string') return null;
		const fontKey =
			typeof r.fontKey === 'string' && FONT_OPTIONS.some((o) => o.key === r.fontKey)
				? r.fontKey
				: DEFAULT_FONT_KEY;
		const size = isFiniteNumber(r.size) ? Math.min(80, Math.max(2, r.size)) : 12;
		const depth = isFiniteNumber(r.depth) ? Math.min(5, Math.max(0.1, r.depth)) : 1;
		return { content: r.content, fontKey, size, depth };
	}

	function loadSettings(): Settings {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (!stored) return { ...defaults, lines: defaults.lines.map((l) => ({ ...l })) };
			const parsed = JSON.parse(stored);
			if (!parsed || typeof parsed !== 'object') {
				return { ...defaults, lines: defaults.lines.map((l) => ({ ...l })) };
			}
			const merged: Settings = { ...defaults, ...parsed };
			const rawLines: unknown[] | null = Array.isArray(parsed.lines)
				? (parsed.lines as unknown[])
				: null;
			merged.lines = rawLines
				? rawLines
						.map(sanitizeLine)
						.filter((l: IdTagLine | null): l is IdTagLine => l !== null)
				: defaults.lines.map((l) => ({ ...l }));
			if (merged.lines.length === 0) merged.lines = defaults.lines.map((l) => ({ ...l }));
			merged.lineSpacing = isFiniteNumber(parsed.lineSpacing)
				? parsed.lineSpacing
				: defaults.lineSpacing;
			merged.laceHole = typeof parsed.laceHole === 'boolean' ? parsed.laceHole : defaults.laceHole;
			merged.laceHoleWidth = isFiniteNumber(parsed.laceHoleWidth)
				? parsed.laceHoleWidth
				: defaults.laceHoleWidth;
			merged.laceHoleHeight = isFiniteNumber(parsed.laceHoleHeight)
				? parsed.laceHoleHeight
				: defaults.laceHoleHeight;
			merged.laceHoleMargin = isFiniteNumber(parsed.laceHoleMargin)
				? parsed.laceHoleMargin
				: defaults.laceHoleMargin;
			merged.waveAmplitude = isFiniteNumber(parsed.waveAmplitude)
				? clamp(parsed.waveAmplitude, WAVE_AMP_MIN, WAVE_AMP_MAX)
				: defaults.waveAmplitude;
			merged.waveLength = isFiniteNumber(parsed.waveLength)
				? clamp(parsed.waveLength, WAVELENGTH_MIN, WAVELENGTH_MAX)
				: defaults.waveLength;
			return merged;
		} catch {
			return { ...defaults, lines: defaults.lines.map((l) => ({ ...l })) };
		}
	}

	const initial = loadSettings();

	let baseWidth = $state(initial.baseWidth);
	let baseHeight = $state(initial.baseHeight);
	let cornerRadius = $state(initial.cornerRadius);
	let baseDepth = $state(initial.baseDepth);
	let topBorderDepth = $state(initial.topBorderDepth);
	let baseColor = $state(initial.baseColor);
	let accentColor = $state(initial.accentColor);
	let lines = $state<IdTagLine[]>(initial.lines.map((l) => ({ ...l })));
	let lineSpacing = $state(initial.lineSpacing);
	let laceHole = $state(initial.laceHole);
	let laceHoleWidth = $state(initial.laceHoleWidth);
	let laceHoleHeight = $state(initial.laceHoleHeight);
	let laceHoleMargin = $state(initial.laceHoleMargin);
	let waveAmplitude = $state(initial.waveAmplitude);
	let waveLength = $state(initial.waveLength);

	let hostEl: HTMLDivElement | null = null;
	let renderer: THREE.WebGLRenderer | null = null;
	let scene: THREE.Scene | null = null;
	let camera: THREE.PerspectiveCamera | null = null;
	let controls: InstanceType<typeof OrbitControls> | null = null;
	let group: THREE.Group | null = null;
	let keyLight: THREE.DirectionalLight | null = null;
	let rafId = 0;
	let ro: ResizeObserver | null = null;
	let didInitFrame = false;
	let exportLoading = $state(false);
	let exportError = $state<string | null>(null);
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
				baseWidth,
				baseHeight,
				cornerRadius,
				baseDepth,
				topBorderDepth,
				baseColor,
				accentColor,
				lines,
				lineSpacing,
				laceHole,
				laceHoleWidth,
				laceHoleHeight,
				laceHoleMargin,
				waveAmplitude,
				waveLength
			};
			localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
		} catch {
			/* localStorage may be unavailable (private mode); ignore */
		}
	}

	/**
	 * Centered horizontal stadium-shaped slot near the top edge for a lanyard.
	 * Returns null when disabled or when the slot would not fit inside the tag.
	 * `cy` is the slot center Y in tag-local coordinates (origin at tag center).
	 */
	function laceHoleGeometry(): { halfW: number; halfH: number; cornerR: number; cy: number } | null {
		if (!laceHole) return null;
		const halfTagW = Math.max(1, baseWidth / 2);
		const halfTagH = Math.max(1, baseHeight / 2);
		const safeMaxW = Math.max(2, baseWidth - 2 * Math.max(2, BORDER_WIDTH_MM));
		const halfW = Math.max(1, Math.min(laceHoleWidth, safeMaxW)) / 2;
		const halfH = Math.max(0.5, laceHoleHeight) / 2;
		if (halfH <= 0 || halfW <= 0) return null;
		const cornerR = Math.min(halfH, halfW);
		const cy = halfTagH - Math.max(0.5, laceHoleMargin+3) - halfH;
		// Make sure the slot stays inside the tag (top of slot below top edge).
		if (cy + halfH >= halfTagH || cy - halfH <= -halfTagH) return null;
		return { halfW, halfH, cornerR, cy };
	}

	/**
	 * Minimal rounded-rectangle outline: corner endpoints + true arc samples only —
	 * NO subdivision of straight edges. Avoids Earcut bridging through collinear
	 * vertices, which is what causes black sliver-triangle artifacts on the top face.
	 */
	function roundedRectPoints(
		halfW: number,
		halfH: number,
		cornerR: number,
		cx = 0,
		cy = 0,
		arcSegs = CORNER_ARC_SEGMENTS
	): THREE.Vector2[] {
		const w = Math.max(0.01, halfW);
		const h = Math.max(0.01, halfH);
		const r = Math.max(0, Math.min(cornerR, w, h));
		const out: THREE.Vector2[] = [];
		const push = (x: number, y: number) => out.push(new THREE.Vector2(x + cx, y + cy));
		const arc = (acx: number, acy: number, a0: number, a1: number) => {
			for (let i = 1; i <= arcSegs; i++) {
				const t = i / arcSegs;
				const a = a0 + t * (a1 - a0);
				push(acx + r * Math.cos(a), acy + r * Math.sin(a));
			}
		};
		// Counter-clockwise: top-left → top-right → bottom-right → bottom-left.
		push(-w, h - r);
		if (r > 0) arc(-w + r, h - r, Math.PI, Math.PI / 2);
		push(w - r, h);
		if (r > 0) arc(w - r, h - r, Math.PI / 2, 0);
		push(w, -h + r);
		if (r > 0) arc(w - r, -h + r, 0, -Math.PI / 2);
		push(-w + r, -h);
		if (r > 0) arc(-w + r, -h + r, -Math.PI / 2, -Math.PI);
		return out;
	}

	/**
	 * Build a rounded rectangle path with winding suitable for use as a hole inside `outerWindingClockwise`.
	 * Three.js ExtrudeGeometry expects holes to wind opposite to their containing shape.
	 * Optional `cx`/`cy` translates the hole center (defaults to origin).
	 */
	function roundedRectHolePath(
		halfW: number,
		halfH: number,
		cornerR: number,
		outerWindingClockwise: boolean,
		cx = 0,
		cy = 0
	): THREE.Path {
		const pts = roundedRectPoints(halfW, halfH, cornerR, cx, cy);
		const isCW = THREE.ShapeUtils.isClockWise(pts);
		if (isCW === outerWindingClockwise) pts.reverse();
		return new THREE.Path(pts);
	}

	// ── Wavy outline generator ──────────────────────────────────────────────────
	// Returns a CCW point list walking the outer perimeter of the tag, centered
	// on the origin. The runtime preview wraps the result in a THREE.Shape; the
	// SCAD export emits it as a polygon literal.

	/** Wavy rounded-rectangle outline (CCW). Corner arcs stay clean (no waves —
	 * `sin` is forced to 0 at edge endpoints by walking the straight portions
	 * with `t ∈ [0, 1]` and integer wave counts). When `cornerR == 0` the corners
	 * are sharp; the wave count is derived from the straight-edge length so the
	 * inner / outer outlines line up perfectly when the inset is uniform on both
	 * `halfW` and `cornerR` (which it is by construction in `rebuildMeshes`).
	 *
	 * `flatTopHalfW` (mm) — when > 0, suppresses the wave on the top edge inside
	 * `|x| ≤ flatTopHalfW` (snapped OUTWARD to the nearest sin zero-crossing so
	 * the wave naturally tapers to 0 at the boundary). Used to keep the area
	 * directly above the lace hole flat: ^^^^---^^^^. */
	function wavyOutline(
		halfW: number,
		halfH: number,
		cornerR: number,
		amp: number,
		wavelength: number,
		patternStraightTop = 2 * Math.max(0, halfW - cornerR),
		patternStraightSide = 2 * Math.max(0, halfH - cornerR),
		flatTopHalfW = 0
	): THREE.Vector2[] {
		const r = Math.max(0, Math.min(cornerR, Math.min(halfW, halfH)));
		const straightTop = Math.max(0, 2 * (halfW - r));
		const straightSide = Math.max(0, 2 * (halfH - r));
		const wl = Math.max(1, wavelength);
		const wavesTop = Math.max(2, Math.round(patternStraightTop / wl));
		const wavesSide = Math.max(2, Math.round(patternStraightSide / wl));
		const samplesPerWave = 12;
		const arcSamples = 18;
		const out: THREE.Vector2[] = [];
		const hasArcs = r > 1e-3;

		// Top-edge flat region (in `t`-space, where `t ∈ [0, 1]` walks the top
		// straight edge right→left). Snap OUTWARD to the nearest zero-crossings
		// of `sin(2π·wavesTop·t)` (which sit at `t = k / (2·wavesTop)`) so the
		// wave is exactly 0 at the flat boundary — no kinks.
		let flatTop_min = -1;
		let flatTop_max = -1;
		if (flatTopHalfW > 0 && flatTopHalfW < halfW - r && straightTop > 0) {
			const tR = (halfW - r - flatTopHalfW) / straightTop;
			const tL = (halfW - r + flatTopHalfW) / straightTop;
			const denom = 2 * wavesTop;
			flatTop_min = Math.max(0, Math.floor(tR * denom) / denom);
			flatTop_max = Math.min(1, Math.ceil(tL * denom) / denom);
			if (flatTop_max - flatTop_min < 1 / denom + 1e-9) {
				flatTop_min = -1;
				flatTop_max = -1;
			}
		}

		// Walking CCW starting at the top-right end of the top edge:
		//   top straight (right→left) → top-left arc → left straight (top→bottom)
		//   → bottom-left arc → bottom straight (left→right) → bottom-right arc
		//   → right straight (bottom→top) → top-right arc → close.

		// Top straight: y bumps outward (+y), with optional flat band over the lace hole.
		const Nt = wavesTop * samplesPerWave;
		for (let i = 0; i < Nt; i++) {
			const t = i / Nt;
			const x = halfW - r - straightTop * t;
			const inFlat = flatTop_min >= 0 && t >= flatTop_min && t <= flatTop_max;
			const y = inFlat ? halfH : halfH + amp * Math.sin(2 * Math.PI * wavesTop * t);
			out.push(new THREE.Vector2(x, y));
		}
		// Top-left corner arc.
		if (hasArcs) {
			const cx = -halfW + r;
			const cy = halfH - r;
			for (let i = 0; i <= arcSamples; i++) {
				const a = Math.PI / 2 + (i / arcSamples) * (Math.PI / 2);
				out.push(new THREE.Vector2(cx + r * Math.cos(a), cy + r * Math.sin(a)));
			}
		}
		// Left straight: x bumps outward (-x).
		const Ns = wavesSide * samplesPerWave;
		for (let i = 0; i < Ns; i++) {
			const t = i / Ns;
			const y = halfH - r - straightSide * t;
			const x = -halfW - amp * Math.sin(2 * Math.PI * wavesSide * t);
			out.push(new THREE.Vector2(x, y));
		}
		// Bottom-left corner arc.
		if (hasArcs) {
			const cx = -halfW + r;
			const cy = -halfH + r;
			for (let i = 0; i <= arcSamples; i++) {
				const a = Math.PI + (i / arcSamples) * (Math.PI / 2);
				out.push(new THREE.Vector2(cx + r * Math.cos(a), cy + r * Math.sin(a)));
			}
		}
		// Bottom straight: y bumps outward (-y).
		for (let i = 0; i < Nt; i++) {
			const t = i / Nt;
			const x = -halfW + r + straightTop * t;
			const y = -halfH - amp * Math.sin(2 * Math.PI * wavesTop * t);
			out.push(new THREE.Vector2(x, y));
		}
		// Bottom-right corner arc.
		if (hasArcs) {
			const cx = halfW - r;
			const cy = -halfH + r;
			for (let i = 0; i <= arcSamples; i++) {
				const a = -Math.PI / 2 + (i / arcSamples) * (Math.PI / 2);
				out.push(new THREE.Vector2(cx + r * Math.cos(a), cy + r * Math.sin(a)));
			}
		}
		// Right straight: x bumps outward (+x).
		for (let i = 0; i < Ns; i++) {
			const t = i / Ns;
			const y = -halfH + r + straightSide * t;
			const x = halfW + amp * Math.sin(2 * Math.PI * wavesSide * t);
			out.push(new THREE.Vector2(x, y));
		}
		// Top-right corner arc.
		if (hasArcs) {
			const cx = halfW - r;
			const cy = halfH - r;
			for (let i = 0; i <= arcSamples; i++) {
				const a = (i / arcSamples) * (Math.PI / 2);
				out.push(new THREE.Vector2(cx + r * Math.cos(a), cy + r * Math.sin(a)));
			}
		}
		return out;
	}

	/** Stringify a CCW point list as a SCAD `polygon(points = [...])` argument. */
	function pointsToScadList(pts: THREE.Vector2[]): string {
		return (
			'[' +
			pts.map((p) => `[${p.x.toFixed(4)}, ${p.y.toFixed(4)}]`).join(', ') +
			']'
		);
	}

	function rebuildMeshes() {
		if (!scene || !group) return;
		disposeObject3D(group);
		group.clear();
		group.position.set(0, 0, 0);
		modelAabbMm = null;

		const halfW = Math.max(1, baseWidth / 2);
		const halfH = Math.max(1, baseHeight / 2);
		const lace = laceHoleGeometry();

		const baseDepthSafe = Math.max(0.1, baseDepth);
		const borderDepthSafe = Math.max(0.1, topBorderDepth);
		const borderZ = baseDepthSafe - BORDER_BASE_EMBED;

		// ── Base: wavy rounded-rect outline (no 2D hole; lace slot is cut via CSG below)
		// Top edge: flatten the wave directly above the lace hole so the lanyard
		// slot sits under a clean straight band (^^^^---^^^^).
		const laceFlatHalfW = lace ? lace.halfW + LACE_TOP_FLAT_PAD : 0;
		const outerPts = wavyOutline(
			halfW,
			halfH,
			cornerRadius,
			waveAmplitude,
			waveLength,
			undefined,
			undefined,
			laceFlatHalfW
		);
		const outerCcw = outerPts.slice();
		if (THREE.ShapeUtils.isClockWise(outerCcw)) outerCcw.reverse();
		const baseShape = new THREE.Shape(outerCcw.slice());
		let baseGeo: THREE.BufferGeometry = new THREE.ExtrudeGeometry([baseShape], {
			depth: baseDepthSafe,
			bevelEnabled: false,
			curveSegments: 12,
			steps: 1
		});
		baseGeo.computeBoundingBox();
		const baseBb0 = baseGeo.boundingBox!;
		baseGeo.translate(0, 0, -baseBb0.min.z);

		// ── Top border: wavy outer outline with a wavy inner panel hole.
		// Lace slot is subtracted via CSG so the slot's straight edges never become
		// Earcut bridge candidates (which produced the "black point" sliver artifact).
		const innerHalfW = Math.max(0.5, halfW - BORDER_WIDTH_MM);
		const innerHalfH = Math.max(0.5, halfH - BORDER_WIDTH_MM);
		const innerCornerR = Math.max(0, cornerRadius - BORDER_WIDTH_MM);

		// Border inner outline reuses the OUTER straight-edge length as the wave
		// pattern source. With BORDER_WIDTH_MM uniformly subtracted from both
		// halfW/halfH and cornerR, the inner straight-edge length equals the outer
		// straight-edge length → outer & inner share the same integer wave count
		// and the waves run in parallel for a constant-width wavy frame.
		const outerStraightTop = 2 * Math.max(0, halfW - cornerRadius);
		const outerStraightSide = 2 * Math.max(0, halfH - cornerRadius);
		const borderShape = new THREE.Shape(outerCcw.slice());
		const innerOutlinePts = wavyOutline(
			innerHalfW,
			innerHalfH,
			innerCornerR,
			waveAmplitude,
			waveLength,
			outerStraightTop,
			outerStraightSide,
			laceFlatHalfW
		);
		// Three.Shape holes must wind opposite to the outer (CCW outer → CW hole).
		const innerHolePts = innerOutlinePts.slice();
		if (!THREE.ShapeUtils.isClockWise(innerHolePts)) innerHolePts.reverse();
		borderShape.holes.push(new THREE.Path(innerHolePts));

		let borderGeo: THREE.BufferGeometry = new THREE.ExtrudeGeometry([borderShape], {
			depth: borderDepthSafe,
			bevelEnabled: false,
			curveSegments: 12,
			steps: 1
		});
		borderGeo.computeBoundingBox();
		const borderBb0 = borderGeo.boundingBox!;
		// Move border so its base sits at z = borderZ (matching the previous mesh.position.z).
		borderGeo.translate(0, 0, -borderBb0.min.z + borderZ);

		const baseMat = new THREE.MeshStandardMaterial({
			color: baseColor,
			roughness: 0.85,
			metalness: 0.05
		});
		const borderMat = new THREE.MeshStandardMaterial({
			color: accentColor,
			roughness: 0.85,
			metalness: 0.05
		});

		// ── Lace slot: build a 3D "plug" and SUBTRACT it from the base via three-bvh-csg.
		// Same pattern as PencilTopperDesigner / NamePuzzleDesigner.
		// We only subtract from the border when the slot actually overlaps the
		// border frame material (i.e. the slot reaches above the inner-panel top).
		// A no-op CSG on a non-intersecting solid produces phantom seam edges
		// that flag as non-manifold in 3MF exports.
		if (lace) {
			const slotShape = new THREE.Shape(
				roundedRectPoints(lace.halfW, lace.halfH, lace.cornerR, 0, lace.cy)
			);
			const totalHeight = baseDepthSafe + borderDepthSafe + 2; // pad above & below for clean cut
			const plugGeo = new THREE.ExtrudeGeometry([slotShape], {
				depth: totalHeight,
				bevelEnabled: false,
				curveSegments: 12,
				steps: 1
			});
			plugGeo.translate(0, 0, -1); // sink 1mm below base for full pierce

			const dummyMat = new THREE.MeshBasicMaterial({ color: 0x808080 });
			const holeBrush = new Brush(plugGeo, dummyMat);
			holeBrush.scale.set(HOLE_EPSILON_SCALE, HOLE_EPSILON_SCALE, 1);
			holeBrush.updateMatrixWorld(true);

			const evaluator = new Evaluator();

			// Always cut the base — the slot intersects the base solid by definition.
			const baseBrush = new Brush(baseGeo, baseMat);
			baseBrush.updateMatrixWorld(true);
			const baseResult = new Brush(new THREE.BufferGeometry(), baseMat);
			try {
				evaluator.evaluate(baseBrush, holeBrush, SUBTRACTION, baseResult);
				baseGeo.dispose();
				baseGeo = baseResult.geometry;
			} catch (err) {
				console.error('IdNameTag CSG base lace-hole subtract failed:', err);
				baseResult.geometry.dispose();
			}

			// Only cut the border if the slot's top reaches above the inner-panel
			// hole's top edge — otherwise the slot lives entirely inside the inner
			// panel hole and the border needs no modification.
			const slotTouchesBorderFrame = lace.cy + lace.halfH > innerHalfH;
			if (slotTouchesBorderFrame) {
				const borderBrush = new Brush(borderGeo, borderMat);
				borderBrush.updateMatrixWorld(true);
				const borderResult = new Brush(new THREE.BufferGeometry(), borderMat);
				try {
					evaluator.evaluate(borderBrush, holeBrush, SUBTRACTION, borderResult);
					borderGeo.dispose();
					borderGeo = borderResult.geometry;
				} catch (err) {
					console.error('IdNameTag CSG border lace-hole subtract failed:', err);
					borderResult.geometry.dispose();
				}
			}

			holeBrush.geometry.dispose();
			dummyMat.dispose();
		}

		baseGeo = BufferGeometryUtils.mergeVertices(baseGeo, WELD_TOL_MM);
		baseGeo.computeVertexNormals();
		baseGeo.computeBoundingBox();

		borderGeo = BufferGeometryUtils.mergeVertices(borderGeo, WELD_TOL_MM);
		borderGeo.computeVertexNormals();
		borderGeo.computeBoundingBox();

		const baseMesh = new THREE.Mesh(baseGeo, baseMat);
		baseMesh.name = 'base';
		baseMesh.castShadow = true;
		baseMesh.receiveShadow = true;
		baseMesh.position.z = 0;
		group.add(baseMesh);

		const borderMesh = new THREE.Mesh(borderGeo, borderMat);
		borderMesh.name = 'border';
		borderMesh.castShadow = true;
		borderMesh.receiveShadow = true;
		// borderGeo already lives at z = borderZ
		borderMesh.position.z = 0;
		group.add(borderMesh);

		// ── Multi-line text inside the inner panel ───────────────────────────
		type LineEntry = { geo: THREE.BufferGeometry; height: number; line: IdTagLine };
		const lineEntries: LineEntry[] = [];
		const maxTextWidth = baseWidth * TEXT_MAX_WIDTH_RATIO;
		for (const line of lines) {
			const content = (line.content ?? '').trim();
			if (!content) continue;
			const font = getFont(line.fontKey);
			if (!font) continue;
			let shapes: THREE.Shape[];
			try {
				shapes = font.generateShapes(content, Math.max(1, line.size));
			} catch (e) {
				console.error('IdNameTag generateShapes failed for line:', content, e);
				continue;
			}
			if (!shapes || shapes.length === 0) continue;
			const geo = new THREE.ExtrudeGeometry(shapes, {
				depth: Math.max(0.05, line.depth),
				bevelEnabled: false,
				curveSegments: 8,
				steps: 1
			});
			centerGeometryXY(geo);
			geo.computeBoundingBox();
			let bb = geo.boundingBox!;
			const w = Math.max(0.001, bb.max.x - bb.min.x);
			// Uniformly scale X+Y (depth untouched) so lines that would overflow
			// the tag are clamped to 95% of the base width.
			if (w > maxTextWidth) {
				const s = maxTextWidth / w;
				geo.scale(s, s, 1);
				geo.computeBoundingBox();
				bb = geo.boundingBox!;
			}
			const h = Math.max(0.001, bb.max.y - bb.min.y);
			lineEntries.push({ geo, height: h, line });
		}

		if (lineEntries.length > 0) {
			const gap = Math.max(0, lineSpacing);
			const totalHeight =
				lineEntries.reduce((acc, e) => acc + e.height, 0) +
				Math.max(0, lineEntries.length - 1) * gap;
			// Center the text block on the base's vertical midline (y = 0) so the
			// block is symmetric about the tag's center regardless of lace slot.
			let yCursor = totalHeight / 2;
			for (const entry of lineEntries) {
				const yCenter = yCursor - entry.height / 2;
				yCursor -= entry.height + gap;
				const textMat = new THREE.MeshStandardMaterial({
					color: accentColor,
					roughness: 0.35,
					metalness: 0.1
				});
				const textMesh = new THREE.Mesh(entry.geo, textMat);
				textMesh.name = 'text';
				textMesh.castShadow = true;
				textMesh.receiveShadow = true;
				textMesh.position.set(0, yCenter, baseDepth - TEXT_BASE_EMBED);
				group.add(textMesh);
			}
		}

		group.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(group);
		if (keyLight?.shadow?.camera) {
			const sizeVec = new THREE.Vector3();
			box.getSize(sizeVec);
			const center = new THREE.Vector3();
			box.getCenter(center);
			const r = Math.max(sizeVec.x, sizeVec.y, sizeVec.z) * 0.75 + 10;
			const cam = keyLight.shadow.camera;
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

	function addLine() {
		const last = lines[lines.length - 1];
		const seed: IdTagLine = last
			? { ...last, content: '' }
			: { content: '', fontKey: DEFAULT_FONT_KEY, size: 12, depth: 1 };
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

	/**
	 * OpenSCAD script that produces a manifold base — rounded-rect plate with
	 * the lace slot subtracted via SCAD `difference()`. Used at export time so
	 * slicers don't flag the runtime three-bvh-csg result as non-manifold.
	 * Returns a single solid (the base only).
	 */
	function getIdNameTagBaseOpenScadScript(params: {
		baseT: number;
		outlineScad: string;
		laceW: number | null;
		laceH: number | null;
		laceCy: number | null;
		laceR: number | null;
	}): string {
		const { baseT, outlineScad, laceW, laceH, laceCy, laceR } = params;
		const slotBlock =
			laceW != null && laceH != null && laceCy != null && laceR != null
				? `
  translate([0, ${laceCy.toFixed(4)}, -1]) {
    linear_extrude(height = ${(baseT + 2).toFixed(4)}) {
      rounded_rect_2d(${laceW.toFixed(4)}, ${laceH.toFixed(4)}, ${laceR.toFixed(4)});
    }
  }`
				: '';
		return `
$fn = 96;
base_t = ${baseT.toFixed(4)};
base_outline = ${outlineScad};

// Robust rounded rectangle via hull of four corner circles. Handles every
// radius from 0 up to min(w,h)/2 (stadium) without producing degenerate
// geometry — unlike offset(delta=-r) which collapses to nothing when r >= h/2.
module rounded_rect_2d(w, h, r) {
  rr = min(max(0, r), min(w, h) / 2);
  if (rr <= 0.001) {
    square([w, h], center = true);
  } else {
    hx = w/2 - rr;
    hy = h/2 - rr;
    hull() {
      translate([-hx, -hy]) circle(r = rr);
      translate([ hx, -hy]) circle(r = rr);
      translate([ hx,  hy]) circle(r = rr);
      translate([-hx,  hy]) circle(r = rr);
    }
  }
}

difference() {
  linear_extrude(height = base_t) {
    polygon(points = base_outline);
  }
${slotBlock}
}
`;
	}

	/** OpenSCAD script for the border (frame) — styled outer outline minus the
	 * styled inner outline (so the inner edge mirrors the outer style for a
	 * "wavy frame" look). Lace slot is subtracted only when it overlaps the
	 * frame strip (matches the runtime `slotTouchesBorderFrame` guard). */
	function getIdNameTagBorderOpenScadScript(params: {
		borderT: number;
		outerOutlineScad: string;
		innerOutlineScad: string;
		laceW: number | null;
		laceH: number | null;
		laceCy: number | null;
		laceR: number | null;
	}): string {
		const { borderT, outerOutlineScad, innerOutlineScad, laceW, laceH, laceCy, laceR } = params;
		const slotBlock =
			laceW != null && laceH != null && laceCy != null && laceR != null
				? `
  translate([0, ${laceCy.toFixed(4)}, -1]) {
    linear_extrude(height = ${(borderT + 2).toFixed(4)}) {
      rounded_rect_2d(${laceW.toFixed(4)}, ${laceH.toFixed(4)}, ${laceR.toFixed(4)});
    }
  }`
				: '';
		return `
$fn = 96;
border_t = ${borderT.toFixed(4)};
outer_outline = ${outerOutlineScad};
inner_outline = ${innerOutlineScad};

// Robust rounded rectangle via hull of four corner circles (used by lace slot).
module rounded_rect_2d(w, h, r) {
  rr = min(max(0, r), min(w, h) / 2);
  if (rr <= 0.001) {
    square([w, h], center = true);
  } else {
    hx = w/2 - rr;
    hy = h/2 - rr;
    hull() {
      translate([-hx, -hy]) circle(r = rr);
      translate([ hx, -hy]) circle(r = rr);
      translate([ hx,  hy]) circle(r = rr);
      translate([-hx,  hy]) circle(r = rr);
    }
  }
}

difference() {
  linear_extrude(height = border_t) {
    difference() {
      polygon(points = outer_outline);
      polygon(points = inner_outline);
    }
  }
${slotBlock}
}
`;
	}

	/** Compute the SCAD lace-slot params, or `null` when disabled / out of bounds. */
	function laceSlotForScad(): {
		laceW: number;
		laceH: number;
		laceCy: number;
		laceR: number;
	} | null {
		const lace = laceHoleGeometry();
		if (!lace) return null;
		return {
			laceW: lace.halfW * 2,
			laceH: lace.halfH * 2,
			laceCy: lace.cy,
			laceR: lace.cornerR
		};
	}

	/** Build a manifold base mesh (with lace cut) via OpenSCAD WASM, positioned
	 * exactly like the runtime preview base (z = 0..baseDepth, centered on XY). */
	async function buildOpenScadBaseGeometry(): Promise<THREE.BufferGeometry> {
		const baseDepthSafe = Math.max(0.1, baseDepth);
		const slot = laceSlotForScad();
		const halfW = Math.max(1, baseWidth / 2);
		const halfH = Math.max(1, baseHeight / 2);
		const laceFlatHalfW = slot ? slot.laceW / 2 + LACE_TOP_FLAT_PAD : 0;
		const outline = wavyOutline(
			halfW,
			halfH,
			Math.max(0, cornerRadius),
			waveAmplitude,
			waveLength,
			undefined,
			undefined,
			laceFlatHalfW
		);
		if (THREE.ShapeUtils.isClockWise(outline)) outline.reverse();
		const source = getIdNameTagBaseOpenScadScript({
			baseT: baseDepthSafe,
			outlineScad: pointsToScadList(outline),
			laceW: slot?.laceW ?? null,
			laceH: slot?.laceH ?? null,
			laceCy: slot?.laceCy ?? null,
			laceR: slot?.laceR ?? null
		});
		const stlBytes = await runOpenScad(source);
		let geo = stlToBufferGeometry(stlBytes);
		geo = BufferGeometryUtils.mergeVertices(geo, WELD_TOL_MM);
		geo.computeVertexNormals();
		geo.computeBoundingBox();
		const bb = geo.boundingBox!;
		geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
		return geo;
	}

	/** Build a manifold border mesh (with lace cut when applicable) via OpenSCAD,
	 * positioned to sit on top of the base at z = borderZ (matching preview). */
	async function buildOpenScadBorderGeometry(): Promise<THREE.BufferGeometry> {
		const baseDepthSafe = Math.max(0.1, baseDepth);
		const borderDepthSafe = Math.max(0.1, topBorderDepth);
		const borderZ = baseDepthSafe - BORDER_BASE_EMBED;
		const slot = laceSlotForScad();
		const halfW = Math.max(1, baseWidth / 2);
		const halfH = Math.max(1, baseHeight / 2);
		const innerHalfW = Math.max(0.5, halfW - BORDER_WIDTH_MM);
		const innerHalfH = Math.max(0.5, halfH - BORDER_WIDTH_MM);
		const innerCornerR = Math.max(0, cornerRadius - BORDER_WIDTH_MM);
		const slotTouchesFrame = slot ? slot.laceCy + slot.laceH / 2 > innerHalfH : false;
		const laceFlatHalfW = slot ? slot.laceW / 2 + LACE_TOP_FLAT_PAD : 0;
		// Outer outline (CCW) — drives the integer wave count.
		const outerOutline = wavyOutline(
			halfW,
			halfH,
			Math.max(0, cornerRadius),
			waveAmplitude,
			waveLength,
			undefined,
			undefined,
			laceFlatHalfW
		);
		if (THREE.ShapeUtils.isClockWise(outerOutline)) outerOutline.reverse();
		// Inner outline shares the OUTER straight-edge length as the wave pattern
		// source → identical wave counts → parallel inner/outer waves.
		const outerStraightTop = 2 * Math.max(0, halfW - cornerRadius);
		const outerStraightSide = 2 * Math.max(0, halfH - cornerRadius);
		const innerOutline = wavyOutline(
			innerHalfW,
			innerHalfH,
			innerCornerR,
			waveAmplitude,
			waveLength,
			outerStraightTop,
			outerStraightSide,
			laceFlatHalfW
		);
		if (THREE.ShapeUtils.isClockWise(innerOutline)) innerOutline.reverse();
		const source = getIdNameTagBorderOpenScadScript({
			borderT: borderDepthSafe,
			outerOutlineScad: pointsToScadList(outerOutline),
			innerOutlineScad: pointsToScadList(innerOutline),
			laceW: slotTouchesFrame ? (slot?.laceW ?? null) : null,
			laceH: slotTouchesFrame ? (slot?.laceH ?? null) : null,
			laceCy: slotTouchesFrame ? (slot?.laceCy ?? null) : null,
			laceR: slotTouchesFrame ? (slot?.laceR ?? null) : null
		});
		const stlBytes = await runOpenScad(source);
		let geo = stlToBufferGeometry(stlBytes);
		geo = BufferGeometryUtils.mergeVertices(geo, WELD_TOL_MM);
		geo.computeVertexNormals();
		geo.computeBoundingBox();
		const bb = geo.boundingBox!;
		geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z + borderZ);
		return geo;
	}

	/**
	 * Build an export-ready group: manifold base + border (from OpenSCAD) plus
	 * text meshes lifted out of their preview embed by `TEXT_BASE_EMBED`.
	 * Mirrors the established pattern from PencilTopperDesigner / NamePuzzleDesigner.
	 */
	async function buildExportGroup(): Promise<THREE.Group> {
		if (!group || !scene) throw new Error('Scene not ready');
		rebuildMeshes();
		group.updateWorldMatrix(true, true);

		const exportGroup = new THREE.Group();

		const [baseGeo, borderGeo] = await Promise.all([
			buildOpenScadBaseGeometry(),
			buildOpenScadBorderGeometry()
		]);
		exportGroup.add(
			new THREE.Mesh(baseGeo, new THREE.MeshStandardMaterial({ color: baseColor }))
		);
		exportGroup.add(
			new THREE.Mesh(borderGeo, new THREE.MeshStandardMaterial({ color: accentColor }))
		);

		// Re-add text meshes, lifted out of the preview embed so they sit cleanly
		// on top of the base (no overlap into the SCAD-built solid).
		for (const child of group.children) {
			const mesh = child as THREE.Mesh;
			if (!(mesh as unknown as { isMesh?: boolean }).isMesh || !mesh.geometry) continue;
			if (mesh.name !== 'text') continue;
			const cloneGeo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
			cloneGeo.translate(0, 0, TEXT_BASE_EMBED);
			const sceneMat = (
				Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
			) as THREE.MeshStandardMaterial;
			const color = sceneMat?.color != null ? sceneMat.color.clone() : new THREE.Color(0xffffff);
			exportGroup.add(new THREE.Mesh(cloneGeo, new THREE.MeshStandardMaterial({ color })));
		}

		exportGroup.updateWorldMatrix(true, true);
		return exportGroup;
	}

	async function exportSTL() {
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = await buildExportGroup();
			const geometries: THREE.BufferGeometry[] = [];
			for (const child of exportGroup.children) {
				const mesh = child as THREE.Mesh;
				if (!(mesh as unknown as { isMesh?: boolean }).isMesh) continue;
				geometries.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
			}
			if (geometries.length === 0) throw new Error('No geometry to export');
			const merged = BufferGeometryUtils.mergeGeometries(geometries);
			geometries.forEach((g) => g.dispose());
			if (!merged) throw new Error('Failed to merge geometry');
			const singleMesh = new THREE.Mesh(merged);
			const exporter = new STLExporter();
			const result = exporter.parse(singleMesh, { binary: true });
			merged.dispose();
			disposeObject3D(exportGroup);
			const buffer = result instanceof DataView ? result.buffer : result;
			if (!buffer || buffer.byteLength < 84) throw new Error('Export produced no geometry');
			const blob = new Blob([buffer], { type: 'model/stl' });
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`id-name-tag-${timestamp}.stl`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'ID Name Tag',
				format: 'stl'
			});
			onShowThankYou();
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exportLoading = false;
		}
	}

	async function export3MF() {
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = await buildExportGroup();
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) throw new Error('Export produced no geometry');
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`id-name-tag-${timestamp}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'ID Name Tag',
				format: '3mf'
			});
			onShowThankYou();
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exportLoading = false;
		}
	}

	async function openWithBambuStudio() {
		if (!group || !scene) return;
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		openBambuStudioLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = await buildExportGroup();
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'id-name-tag');
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'ID Name Tag',
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (err) {
			console.error('Open with Bambu Studio failed:', err);
		} finally {
			openBambuStudioLoading = false;
		}
	}

	onMount(() => {
		if (!hostEl) return;
		scene = new THREE.Scene();
		scene.background = new THREE.Color(0xffffff);
		camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
		camera.up.set(0, 0, 1);
		renderer = new THREE.WebGLRenderer({
			antialias: true,
			preserveDrawingBuffer: true
		});
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
		controls.minDistance = 10;
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

		const shadowPlane = new THREE.Mesh(
			new THREE.PlaneGeometry(800, 800),
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

	$effect(() => {
		void baseWidth;
		void baseHeight;
		void cornerRadius;
		void baseDepth;
		void topBorderDepth;
		void baseColor;
		void accentColor;
		void lines;
		void lineSpacing;
		void laceHole;
		void laceHoleWidth;
		void laceHoleHeight;
		void laceHoleMargin;
		void waveAmplitude;
		void waveLength;
		saveSettings();
	});

	$effect(() => {
		void baseWidth;
		void baseHeight;
		void cornerRadius;
		void baseDepth;
		void topBorderDepth;
		void baseColor;
		void accentColor;
		void lines;
		void lineSpacing;
		void laceHole;
		void laceHoleWidth;
		void laceHoleHeight;
		void laceHoleMargin;
		void waveAmplitude;
		void waveLength;
		if (!scene || !group) return;
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
	<div class="mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full max-w-[380px] min-w-[320px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">ID Name Tag</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden p-4 pt-0">
				<!-- Lines (multi-line, each configurable) -->
				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="flex items-center justify-between">
						<div class="text-xs font-semibold tracking-tight text-slate-700">Lines</div>
						<span class="text-xs text-slate-500">{lines.length} of 8</span>
					</div>

					{#each lines as line, i (i)}
						<div class="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
							<div class="mb-2 flex items-center justify-between">
								<span class="text-[11px] font-semibold tracking-wide text-slate-500 uppercase"
									>Line {i + 1}</span
								>
								<div class="flex items-center gap-1">
									<Button
										variant="outline"
										size="xs"
										class="h-7 w-7 p-0"
										title="Move up"
										aria-label="Move line up"
										disabled={i === 0}
										onclick={() => moveLine(i, -1)}
									>
										↑
									</Button>
									<Button
										variant="outline"
										size="xs"
										class="h-7 w-7 p-0"
										title="Move down"
										aria-label="Move line down"
										disabled={i === lines.length - 1}
										onclick={() => moveLine(i, 1)}
									>
										↓
									</Button>
									<Button
										variant="outline"
										size="xs"
										class="h-7 w-7 p-0 text-red-600 hover:bg-red-50 hover:text-red-700"
										title="Remove line"
										aria-label="Remove line"
										disabled={lines.length <= 1}
										onclick={() => removeLine(i)}
									>
										✕
									</Button>
								</div>
							</div>

							<label class="grid gap-1.5">
								<span class="text-xs font-medium text-slate-700">Content</span>
								<input
									class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
									type="text"
									bind:value={line.content}
									placeholder={i === 0 ? 'Name' : 'Subtitle'}
								/>
							</label>

							<label class="mt-2 grid gap-1.5">
								<span class="text-xs font-medium text-slate-700">Font</span>
								<FontSelect bind:value={line.fontKey} />
							</label>

							<div class="mt-2 grid grid-cols-2 gap-3">
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Size</span>
										<span class="text-xs tabular-nums text-slate-600">{line.size}</span>
									</div>
									<Slider
										type="single"
										bind:value={line.size}
										min={4}
										max={30}
										step={0.5}
										class="w-full"
									/>
								</label>
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Depth</span>
										<span class="text-xs tabular-nums text-slate-600">{line.depth}</span>
									</div>
									<Slider
										type="single"
										bind:value={line.depth}
										min={0.2}
										max={3}
										step={0.1}
										class="w-full"
									/>
								</label>
							</div>
						</div>
					{/each}

					<Button
						variant="outline"
						size="sm"
						class="w-full"
						onclick={addLine}
						disabled={lines.length >= 8}
					>
						+ Add line
					</Button>

					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Line spacing</span>
							<span class="text-xs tabular-nums text-slate-600">{lineSpacing}</span>
						</div>
						<Slider
							type="single"
							bind:value={lineSpacing}
							min={0}
							max={20}
							step={0.5}
							class="w-full"
						/>
					</label>

					<ColorPalettePicker bind:value={accentColor} {palette} label="Border & text color" />
				</div>

				<!-- Lace hole -->
				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="flex items-center justify-between">
						<div class="text-xs font-semibold tracking-tight text-slate-700">Lace hole</div>
						<label class="flex items-center gap-2 text-xs text-slate-600">
							<input
								type="checkbox"
								bind:checked={laceHole}
								class="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
							/>
							Enabled
						</label>
					</div>

					{#if laceHole}
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Width</span>
								<span class="text-xs tabular-nums text-slate-600">{laceHoleWidth} mm</span>
							</div>
							<Slider
								type="single"
								bind:value={laceHoleWidth}
								min={6}
								max={Math.max(8, baseWidth - 2 * BORDER_WIDTH_MM)}
								step={1}
								class="w-full"
							/>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Height</span>
								<span class="text-xs tabular-nums text-slate-600">{laceHoleHeight} mm</span>
							</div>
							<Slider
								type="single"
								bind:value={laceHoleHeight}
								min={2}
								max={20}
								step={0.5}
								class="w-full"
							/>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Top margin</span>
								<span class="text-xs tabular-nums text-slate-600">{laceHoleMargin} mm</span>
							</div>
							<Slider
								type="single"
								bind:value={laceHoleMargin}
								min={1}
								max={5}
								step={0.5}
								class="w-full"
							/>
						</label>
					{/if}
				</div>

				<!-- Shape -->
				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="text-xs font-semibold tracking-tight text-slate-700">Shape</div>

					<ColorPalettePicker bind:value={baseColor} {palette} label="Color" />

					<!-- Size subgroup -->
					<div class="grid gap-3 border-t border-slate-200/70 pt-3">
						<div
							class="text-[10px] font-semibold uppercase tracking-wider text-slate-500"
						>
							Size
						</div>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Width</span>
								<span class="text-xs tabular-nums text-slate-600">{baseWidth} mm</span>
							</div>
							<Slider
								type="single"
								bind:value={baseWidth}
								min={60}
								max={220}
								step={1}
								class="w-full"
							/>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Height</span>
								<span class="text-xs tabular-nums text-slate-600">{baseHeight} mm</span>
							</div>
							<Slider
								type="single"
								bind:value={baseHeight}
								min={30}
								max={140}
								step={1}
								class="w-full"
							/>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Corner radius</span>
								<span class="text-xs tabular-nums text-slate-600">{cornerRadius} mm</span>
							</div>
							<Slider
								type="single"
								bind:value={cornerRadius}
								min={0}
								max={Math.min(baseWidth, baseHeight) / 2}
								step={0.2}
								class="w-full"
							/>
						</label>
					</div>

					<!-- Waves subgroup -->
					<div class="grid gap-3 border-t border-slate-200/70 pt-3">
						<div
							class="text-[10px] font-semibold uppercase tracking-wider text-slate-500"
						>
							Waves
						</div>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Amplitude</span>
								<span class="text-xs tabular-nums text-slate-600">{waveAmplitude} mm</span>
							</div>
							<Slider
								type="single"
								bind:value={waveAmplitude}
								min={WAVE_AMP_MIN}
								max={WAVE_AMP_MAX}
								step={0.1}
								class="w-full"
							/>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Wavelength</span>
								<span class="text-xs tabular-nums text-slate-600">{waveLength} mm</span>
							</div>
							<Slider
								type="single"
								bind:value={waveLength}
								min={WAVELENGTH_MIN}
								max={WAVELENGTH_MAX}
								step={1}
								class="w-full"
							/>
						</label>
					</div>

					<!-- Depth subgroup -->
					<div class="grid gap-3 border-t border-slate-200/70 pt-3">
						<div
							class="text-[10px] font-semibold uppercase tracking-wider text-slate-500"
						>
							Depth
						</div>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Base</span>
								<span class="text-xs tabular-nums text-slate-600">{baseDepth} mm</span>
							</div>
							<Slider
								type="single"
								bind:value={baseDepth}
								min={0.4}
								max={10}
								step={0.1}
								class="w-full"
							/>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Top border</span>
								<span class="text-xs tabular-nums text-slate-600">{topBorderDepth} mm</span>
							</div>
							<Slider
								type="single"
								bind:value={topBorderDepth}
								min={0.2}
								max={3}
								step={0.1}
								class="w-full"
							/>
						</label>
					</div>
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
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, 'id-name-tag')}
					onExport={() =>
						user && subscriptionStatus?.isActive ? exportSTL() : onShowPricing?.()}
					onExport3MF={() =>
						user && subscriptionStatus?.isActive ? export3MF() : onShowPricing?.()}
					onOpenWithBambuStudio={() =>
						user && subscriptionStatus?.isActive ? openWithBambuStudio() : onShowPricing?.()}
					{openBambuStudioLoading}
					exportDisabled={exportLoading}
					exportTitle={getExportTitle(
						user,
						subscriptionStatus,
						'Export STL (single mesh) or 3MF (multipart) for 3D print'
					)}
					{exportLoading}
					showLockIcon={!user || !subscriptionStatus?.isActive}
				/>
				{#if exportError}
					<p
						class="absolute right-4 bottom-14 max-w-[200px] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-lg"
					>
						{exportError}
					</p>
				{/if}
			</div>
		</section>
	</div>
</main>
