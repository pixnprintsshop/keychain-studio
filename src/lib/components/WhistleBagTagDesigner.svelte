<script lang="ts">
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import bagtagObjUrl from '$lib/assets/stl/whistle/bagtag.obj?url';
	import FontSelect from '$lib/components/FontSelect.svelte';
	import {
		centerGeometryXY,
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		FONT_OPTIONS,
		frameCameraToObject,
		getFont,
		measureWorldAabbSizeMm
	} from '$lib/utils-3d';
	import { notifyExportEvent } from '$lib/exportNotify';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import type { PaletteColor } from '$lib/colorPalette';
	import { ensureExportAccess, getExportTitle, type SubscriptionStatus } from '$lib/subscription';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';

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

	/** group_0 = border (top rim), group_1 = base plate */
	type BagTagPartKey = 'border' | 'base';
	const PART_ORDER: BagTagPartKey[] = ['border', 'base'];

	const FONT_SIZE_FOR_SHAPES = 12;
	const TEXT_DEPTH_MM = 0.8;
	/** Small preview lift above the plateau (viewer only). */
	const TEXT_PREVIEW_LIFT = 0.02;
	/** Export: seat letter walls on the plateau like Tinkercad (no bottom cap, no air gap). */
	const TEXT_PRINT_SEAT = 0.001;
	const TEXT_MAX_WIDTH_RATIO = 0.78;
	const MAX_LINES = 6;
	const DEFAULT_FONT_KEY = FONT_OPTIONS[0]?.key ?? 'Titan One_Regular';

	const STORAGE_KEY = 'keychain-whistle-bag-tag-settings';

	type BagTagLine = {
		content: string;
		sizeMm: number;
	};

	interface BagTagSettings {
		fontKey: string;
		baseColor: string;
		accentColor: string;
		lineSpacing: number;
		lines: BagTagLine[];
	}

	const defaults: BagTagSettings = {
		fontKey: DEFAULT_FONT_KEY,
		baseColor: '#f97316',
		accentColor: '#ffffff',
		lineSpacing: 1.2,
		lines: [{ content: 'Name', sizeMm: 11 }]
	};

	function clamp(n: number, lo: number, hi: number): number {
		return Math.min(hi, Math.max(lo, n));
	}

	function cloneDefaultLines(): BagTagLine[] {
		return defaults.lines.map((line) => ({ ...line }));
	}

	function parseLine(raw: unknown): BagTagLine | null {
		if (!raw || typeof raw !== 'object') return null;
		const line = raw as Partial<BagTagLine>;
		const content = typeof line.content === 'string' ? line.content : '';
		const sizeMm =
			typeof line.sizeMm === 'number' && Number.isFinite(line.sizeMm)
				? clamp(line.sizeMm, 3, 18)
				: 8;
		return { content, sizeMm };
	}

	function loadSettings(): BagTagSettings {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (!stored) return { ...defaults, lines: cloneDefaultLines() };
			const parsed = JSON.parse(stored) as Partial<BagTagSettings>;
			if (!parsed || typeof parsed !== 'object') {
				return { ...defaults, lines: cloneDefaultLines() };
			}
			const fontKey =
				typeof parsed.fontKey === 'string' &&
				FONT_OPTIONS.some((option) => option.key === parsed.fontKey)
					? parsed.fontKey
					: defaults.fontKey;
			const rawLines = Array.isArray(parsed.lines) ? parsed.lines : null;
			const lines = rawLines
				?.map(parseLine)
				.filter((line): line is BagTagLine => line !== null) ?? [];
			return {
				fontKey,
				baseColor:
					typeof parsed.baseColor === 'string' ? parsed.baseColor : defaults.baseColor,
				accentColor:
					typeof parsed.accentColor === 'string'
						? parsed.accentColor
						: defaults.accentColor,
				lineSpacing:
					typeof parsed.lineSpacing === 'number' && Number.isFinite(parsed.lineSpacing)
						? Math.max(0, parsed.lineSpacing)
						: defaults.lineSpacing,
				lines: lines.length > 0 ? lines.slice(0, MAX_LINES) : cloneDefaultLines()
			};
		} catch {
			return { ...defaults, lines: cloneDefaultLines() };
		}
	}

	const initial = loadSettings();

	function saveSettings() {
		try {
			const payload: BagTagSettings = {
				fontKey,
				baseColor,
				accentColor,
				lineSpacing,
				lines: lines.map((line) => ({ ...line }))
			};
			localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
		} catch {
			/* localStorage may be unavailable */
		}
	}

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
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);

	let partGeometries = $state<Record<BagTagPartKey, THREE.BufferGeometry> | null>(null);
	let loadError = $state<string | null>(null);
	let sceneReady = $state(false);

	let fontKey = $state(initial.fontKey);
	let baseColor = $state(initial.baseColor);
	let accentColor = $state(initial.accentColor);
	let lineSpacing = $state(initial.lineSpacing);
	let lines = $state<BagTagLine[]>(initial.lines.map((line) => ({ ...line })));

	let exportError = $state<string | null>(null);
	let exportLoading = $state(false);
	let openBambuStudioLoading = $state(false);

	function resize() {
		if (!renderer || !camera || !hostEl) return;
		const rect = hostEl.getBoundingClientRect();
		const w = Math.max(1, Math.floor(rect.width));
		const h = Math.max(1, Math.floor(rect.height));
		renderer.setSize(w, h, true);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}

	function meshToWorldGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
		const g = mesh.geometry.clone();
		mesh.updateWorldMatrix(true, false);
		g.applyMatrix4(mesh.matrixWorld);
		return g;
	}

	function extractPartGeometries(root: THREE.Object3D): Record<BagTagPartKey, THREE.BufferGeometry> | null {
		const meshes: THREE.Mesh[] = [];
		root.traverse((child) => {
			if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
		});
		if (meshes.length < 2) return null;

		const byIndex = new Map<number, THREE.Mesh>();
		for (const mesh of meshes) {
			const m = /^group_(\d+)_/i.exec(mesh.name);
			if (m) byIndex.set(Number(m[1]), mesh);
		}

		const parts = {} as Record<BagTagPartKey, THREE.BufferGeometry>;
		for (let i = 0; i < PART_ORDER.length; i++) {
			const key = PART_ORDER[i];
			const mesh = byIndex.get(i) ?? meshes[i];
			if (!mesh) return null;
			parts[key] = meshToWorldGeometry(mesh);
		}
		return parts;
	}

	function centerPartGeometries(parts: Record<BagTagPartKey, THREE.BufferGeometry>) {
		const box = new THREE.Box3();
		for (const geo of Object.values(parts)) {
			geo.computeBoundingBox();
			if (geo.boundingBox) box.union(geo.boundingBox);
		}
		const cx = (box.min.x + box.max.x) / 2;
		const cy = (box.min.y + box.max.y) / 2;
		const cz = box.min.z;
		for (const geo of Object.values(parts)) {
			geo.translate(-cx, -cy, -cz);
			geo.computeBoundingBox();
			geo.computeVertexNormals();
		}
	}

	function getAssemblyBounds(): THREE.Box3 | null {
		if (!partGeometries) return null;
		const box = new THREE.Box3();
		for (const geo of Object.values(partGeometries)) {
			geo.computeBoundingBox();
			if (geo.boundingBox) box.union(geo.boundingBox);
		}
		return box.isEmpty() ? null : box;
	}

	function getEmbossedTopSurface(baseGeo: THREE.BufferGeometry): {
		topZ: number;
		planWidth: number;
	} | null {
		baseGeo.computeBoundingBox();
		const bb = baseGeo.boundingBox;
		if (!bb) return null;

		if (!baseGeo.getAttribute('normal')) baseGeo.computeVertexNormals();
		const pos = baseGeo.getAttribute('position');
		const norm = baseGeo.getAttribute('normal');
		if (!pos || !norm) return null;

		const zSpan = Math.max(0.001, bb.max.z - bb.min.z);
		const topTolerance = Math.max(0.05, zSpan * 0.02);
		const minNormalZ = 0.65;

		const samples: { x: number; y: number; z: number }[] = [];
		for (let i = 0; i < pos.count; i++) {
			const z = pos.getZ(i);
			const nz = norm.getZ(i);
			if (z >= bb.max.z - topTolerance && nz > minNormalZ) {
				samples.push({ x: pos.getX(i), y: pos.getY(i), z });
			}
		}
		if (samples.length < 3) {
			for (let i = 0; i < pos.count; i++) {
				const z = pos.getZ(i);
				if (z >= bb.max.z - topTolerance) {
					samples.push({ x: pos.getX(i), y: pos.getY(i), z });
				}
			}
		}
		if (samples.length === 0) return null;

		let minX = Infinity;
		let maxX = -Infinity;
		let topZ = -Infinity;
		for (const s of samples) {
			minX = Math.min(minX, s.x);
			maxX = Math.max(maxX, s.x);
			topZ = Math.max(topZ, s.z);
		}
		return {
			topZ,
			planWidth: Math.max(0.01, maxX - minX)
		};
	}

	/**
	 * Rim bottom marks the flat text plateau. Base mesh alone is misleading in the
	 * embossed center (pocket floors read as local "tops").
	 */
	function resolveTextSurface(
		baseGeo: THREE.BufferGeometry,
		borderGeo: THREE.BufferGeometry | null
	): { topZ: number; planWidth: number } | null {
		const embossed = getEmbossedTopSurface(baseGeo);
		if (!embossed) return null;

		let topZ = embossed.topZ;
		if (borderGeo) {
			borderGeo.computeBoundingBox();
			const borderBb = borderGeo.boundingBox;
			if (borderBb) topZ = Math.max(topZ, borderBb.min.z);
		}
		return { topZ, planWidth: embossed.planWidth };
	}

	function bottomAlignGeometryZ(geo: THREE.BufferGeometry) {
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (!bb) return;
		geo.translate(0, 0, -bb.min.z);
		geo.computeBoundingBox();
	}

	type TextLineLayout = { geo: THREE.BufferGeometry; yCenter: number };

	function normalizeForMerge(geo: THREE.BufferGeometry): THREE.BufferGeometry {
		let g = geo.index ? geo.toNonIndexed() : geo.clone();
		if (g !== geo) geo.dispose();
		if (g.attributes.uv) g.deleteAttribute('uv');
		return g;
	}

	/** Drop extrusion bottom caps — base plate is the floor (matches Tinkercad-style placement). */
	function removeBottomCapFaces(geo: THREE.BufferGeometry, zTol = 0.015): THREE.BufferGeometry {
		const g = geo.index ? geo.toNonIndexed() : geo.clone();
		if (g !== geo) geo.dispose();
		g.computeBoundingBox();
		const floorZ = g.boundingBox?.min.z ?? 0;
		const pos = g.getAttribute('position') as THREE.BufferAttribute;
		const kept: number[] = [];

		for (let i = 0; i < pos.count; i += 3) {
			const z0 = pos.getZ(i);
			const z1 = pos.getZ(i + 1);
			const z2 = pos.getZ(i + 2);
			if (Math.max(z0, z1, z2) <= floorZ + zTol) continue;
			for (let j = 0; j < 3; j++) {
				kept.push(pos.getX(i + j), pos.getY(i + j), pos.getZ(i + j));
			}
		}

		const out = new THREE.BufferGeometry();
		out.setAttribute('position', new THREE.Float32BufferAttribute(kept, 3));
		out.computeVertexNormals();
		return out;
	}

	function seatTextOnSurface(geo: THREE.BufferGeometry, surfaceZ: number): THREE.BufferGeometry {
		geo.computeBoundingBox();
		const bottom = geo.boundingBox?.min.z ?? 0;
		geo.translate(0, 0, surfaceZ + TEXT_PRINT_SEAT - bottom);
		return geo;
	}

	/** Merge multiline text into one export mesh (letters only, no backing plate). */
	function buildMergedTextGeometry(
		layouts: TextLineLayout[],
		centerX: number,
		centerY: number
	): THREE.BufferGeometry | null {
		if (layouts.length === 0) return null;

		const pieces: THREE.BufferGeometry[] = [];

		for (const { geo, yCenter } of layouts) {
			const placed = geo.clone();
			placed.translate(centerX, centerY + yCenter, 0);
			pieces.push(normalizeForMerge(placed));
		}

		if (pieces.length === 0) return null;

		const merged =
			pieces.length === 1 ? pieces[0] : BufferGeometryUtils.mergeGeometries(pieces);
		for (const piece of pieces) {
			if (piece !== merged) piece.dispose();
		}
		if (!merged) return null;
		const capped = removeBottomCapFaces(merged);
		if (capped !== merged) merged.dispose();
		return capped;
	}

	function addLine(
		content = '',
		sizeMm = lines[lines.length - 1]?.sizeMm ?? 8
	) {
		if (lines.length >= MAX_LINES) return;
		lines = [...lines, { content, sizeMm: clamp(sizeMm, 3, 18) }];
	}

	function removeLine(index: number) {
		if (lines.length <= 1) return;
		lines = lines.filter((_, i) => i !== index);
	}

	function moveLine(index: number, direction: -1 | 1) {
		const target = index + direction;
		if (target < 0 || target >= lines.length) return;
		const next = [...lines];
		[next[index], next[target]] = [next[target], next[index]];
		lines = next;
	}

	function rebuildMeshes() {
		if (!group || !partGeometries) return;
		disposeObject3D(group);
		group.clear();
		modelAabbMm = null;

		const partColors: Record<BagTagPartKey, string> = {
			base: baseColor,
			border: accentColor
		};

		for (const key of PART_ORDER) {
			const geo = partGeometries[key].clone();
			geo.computeVertexNormals();
			const mat = new THREE.MeshStandardMaterial({
				color: partColors[key],
				roughness: 0.7,
				metalness: 0.12
			});
			const mesh = new THREE.Mesh(geo, mat);
			mesh.name = key;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			group.add(mesh);
		}

		const assemblyBox = getAssemblyBounds();
		const textSurface = partGeometries.base
			? resolveTextSurface(partGeometries.base, partGeometries.border)
			: null;
		const font = getFont(fontKey);
		const maxTextWidth = textSurface
			? textSurface.planWidth * TEXT_MAX_WIDTH_RATIO
			: assemblyBox
				? (assemblyBox.max.x - assemblyBox.min.x) * TEXT_MAX_WIDTH_RATIO
				: 50;

		type LineEntry = { geo: THREE.BufferGeometry; height: number };
		const lineEntries: LineEntry[] = [];

		if (font) {
			for (const line of lines) {
				const content = (line.content ?? '').trim();
				if (!content) continue;
				const shapes = font.generateShapes(content, FONT_SIZE_FOR_SHAPES);
				if (shapes.length === 0) continue;

				const textGeo = new THREE.ExtrudeGeometry(shapes, {
					depth: TEXT_DEPTH_MM,
					bevelEnabled: false,
					curveSegments: 12
				});
				centerGeometryXY(textGeo);
				bottomAlignGeometryZ(textGeo);
				textGeo.computeBoundingBox();
				const tb = textGeo.boundingBox;
				if (!tb) continue;

				const nativeH = Math.max(0.001, tb.max.y - tb.min.y);
				const scale = line.sizeMm / nativeH;
				textGeo.scale(scale, scale, 1);
				textGeo.computeBoundingBox();
				const scaled = textGeo.boundingBox!;
				const w = Math.max(0.001, scaled.max.x - scaled.min.x);
				if (w > maxTextWidth) {
					const fit = maxTextWidth / w;
					textGeo.scale(fit, fit, 1);
					textGeo.computeBoundingBox();
				}

				const finalBb = textGeo.boundingBox;
				if (!finalBb) continue;
				const h = Math.max(0.001, finalBb.max.y - finalBb.min.y);
				lineEntries.push({ geo: textGeo, height: h });
			}
		}

		if (lineEntries.length > 0 && textSurface && assemblyBox) {
			const gap = Math.max(0, lineSpacing);
			const totalHeight =
				lineEntries.reduce((acc, entry) => acc + entry.height, 0) +
				Math.max(0, lineEntries.length - 1) * gap;
			let yCursor = totalHeight / 2;
			const centerX = (assemblyBox.min.x + assemblyBox.max.x) / 2;
			const centerY = (assemblyBox.min.y + assemblyBox.max.y) / 2;

			const layouts: TextLineLayout[] = [];
			for (const entry of lineEntries) {
				const yCenter = yCursor - entry.height / 2;
				yCursor -= entry.height + gap;
				layouts.push({ geo: entry.geo, yCenter });
			}

			const combinedTextGeo = buildMergedTextGeometry(layouts, centerX, centerY);
			for (const entry of lineEntries) entry.geo.dispose();

			if (combinedTextGeo) {
				const textMat = new THREE.MeshStandardMaterial({
					color: accentColor,
					roughness: 0.4,
					metalness: 0.1
				});
				const textMesh = new THREE.Mesh(combinedTextGeo, textMat);
				textMesh.name = 'text';
				textMesh.castShadow = true;
				textMesh.receiveShadow = true;
				textMesh.position.z = textSurface.topZ + TEXT_PREVIEW_LIFT;
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

	function weldPartGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
		let g = geo;
		if (g.attributes.uv) g.deleteAttribute('uv');
		if (!g.attributes.normal) g.computeVertexNormals();
		if (g.index) {
			const nonIndexed = g.toNonIndexed();
			g.dispose();
			g = nonIndexed;
		}
		const welded = BufferGeometryUtils.mergeVertices(g, 1e-4);
		if (welded !== g) g.dispose();
		return welded;
	}

	function buildExportGroup(options: { forExport?: boolean } = {}): THREE.Group {
		if (!group || !partGeometries) throw new Error('Scene not ready');
		rebuildMeshes();
		group.updateWorldMatrix(true, true);
		const textSurface = resolveTextSurface(partGeometries.base, partGeometries.border);
		const exportGroup = new THREE.Group();
		const textGeometries: THREE.BufferGeometry[] = [];
		let textColor = new THREE.Color(accentColor);

		for (const child of group.children) {
			if (!(child as THREE.Mesh).isMesh) continue;
			const mesh = child as THREE.Mesh;
			const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
			const color = mat?.color?.clone() ?? new THREE.Color(0xffffff);

			if (mesh.name === 'text') {
				textColor = color;
				let geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
				if (options.forExport && textSurface) {
					geo = removeBottomCapFaces(geo);
					seatTextOnSurface(geo, textSurface.topZ);
					geo = weldPartGeometry(geo);
				}
				textGeometries.push(geo);
				continue;
			}

			let geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
			if (options.forExport) geo = weldPartGeometry(geo);
			const exportMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
			exportMesh.name = mesh.name;
			exportGroup.add(exportMesh);
		}

		if (textGeometries.length > 0) {
			const mergedText =
				textGeometries.length === 1
					? textGeometries[0]
					: BufferGeometryUtils.mergeGeometries(textGeometries);
			if (!mergedText) {
				textGeometries.forEach((g) => g.dispose());
				throw new Error('Failed to merge text geometry');
			}
			if (textGeometries.length > 1) textGeometries.forEach((g) => g.dispose());
			const textMesh = new THREE.Mesh(mergedText, new THREE.MeshBasicMaterial({ color: textColor }));
			textMesh.name = 'text';
			exportGroup.add(textMesh);
		}

		exportGroup.updateWorldMatrix(true, true);
		return exportGroup;
	}

	async function exportStl() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		if (!group || group.children.length === 0) {
			exportError = 'Nothing to export';
			return;
		}
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = buildExportGroup({ forExport: true });
			const geometries: THREE.BufferGeometry[] = [];
			for (const child of exportGroup.children) {
				if (!(child as THREE.Mesh).isMesh) continue;
				const mesh = child as THREE.Mesh;
				geometries.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
			}
			disposeObject3D(exportGroup);
			if (geometries.length === 0) {
				exportError = 'Nothing to export';
				return;
			}
			const merged =
				geometries.length === 1 ? geometries[0] : BufferGeometryUtils.mergeGeometries(geometries);
			if (!merged) {
				geometries.forEach((g) => g.dispose());
				exportError = 'Failed to merge geometry';
				return;
			}
			if (geometries.length > 1) geometries.forEach((g) => g.dispose());

			const exporter = new STLExporter();
			const result = exporter.parse(new THREE.Mesh(merged), { binary: true });
			merged.dispose();
			const buffer = result instanceof DataView ? result.buffer : result;
			if (!buffer || (buffer as ArrayBuffer).byteLength < 84) {
				exportError = 'Export produced empty geometry';
				return;
			}
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`whistle-bag-tag-${ts}.stl`, new Blob([buffer], { type: 'model/stl' }));
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Whistle Bag Tag',
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
		if (!group) return;
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = buildExportGroup({ forExport: true });
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) {
				exportError = 'Export produced empty geometry';
				return;
			}
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`whistle-bag-tag-${ts}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Whistle Bag Tag',
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
		if (!group) return;
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		openBambuStudioLoading = true;
		await tickThenYieldToPaint();
		try {
			const exportGroup = buildExportGroup({ forExport: true });
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'whistle-bag-tag');
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Whistle Bag Tag',
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (err) {
			console.error('Open with Bambu Studio failed:', err);
		} finally {
			openBambuStudioLoading = false;
		}
	}

	function disposePartGeometries() {
		if (!partGeometries) return;
		for (const geo of Object.values(partGeometries)) geo.dispose();
		partGeometries = null;
	}

	$effect(() => {
		void fontKey;
		void baseColor;
		void accentColor;
		void lineSpacing;
		void lines;
		saveSettings();
	});

	$effect(() => {
		void partGeometries;
		void fontKey;
		void baseColor;
		void accentColor;
		void lineSpacing;
		void lines;
		if (!scene || !group || !sceneReady) return;
		rebuildMeshes();
	});

	onMount(() => {
		if (!hostEl) return;
		scene = new THREE.Scene();
		scene.background = new THREE.Color(0xffffff);
		camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
		camera.up.set(0, 0, 1);
		renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		hostEl.appendChild(renderer.domElement);

		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.enablePan = true;
		controls.minDistance = 5;
		controls.maxDistance = 500;

		scene.add(new THREE.AmbientLight(0xffffff, 0.85));
		keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
		keyLight.position.set(60, -80, 140);
		keyLight.castShadow = true;
		keyLight.shadow.mapSize.width = 2048;
		keyLight.shadow.mapSize.height = 2048;
		scene.add(keyLight);
		scene.add(keyLight.target);

		const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
		fillLight.position.set(0, 0, -80);
		scene.add(fillLight);

		group = new THREE.Group();
		scene.add(group);

		const grid = new THREE.GridHelper(250, 25, 0xcbd5e1, 0xe2e8f0);
		grid.rotateX(Math.PI / 2);
		grid.position.z = -0.01;
		scene.add(grid);

		ro = new ResizeObserver(() => resize());
		ro.observe(hostEl);
		resize();

		const loader = new OBJLoader();
		loader.load(
			bagtagObjUrl,
			(root) => {
				const parts = extractPartGeometries(root);
				if (!parts) {
					loadError = 'Bag tag model must contain base and border mesh groups.';
					return;
				}
				centerPartGeometries(parts);
				partGeometries = parts;
				loadError = null;
				sceneReady = true;
				didInitFrame = false;
				rebuildMeshes();
			},
			undefined,
			(err) => {
				loadError = err instanceof Error ? err.message : 'Failed to load bag tag model';
			}
		);

		const tick = () => {
			rafId = requestAnimationFrame(tick);
			controls?.update();
			renderer?.render(scene!, camera!);
		};
		tick();

		return () => {
			ro?.disconnect();
			ro = null;
		};
	});

	onDestroy(() => {
		cancelAnimationFrame(rafId);
		disposePartGeometries();
		if (group) {
			disposeObject3D(group);
			group.clear();
		}
		group = null;
		renderer = null;
		scene = null;
		camera = null;
		controls = null;
		keyLight = null;
	});
</script>

<main class="h-dvh w-dvw bg-slate-100 p-4">
	<div class="mx-auto flex h-full w-full max-w-[1600px] min-h-0 flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full min-w-0 max-w-[360px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] lg:min-w-[320px]"
		>
			<div class="mb-4 flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Whistle Bag Tag</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
				<p class="text-xs text-slate-500">
					Whistle bag tag with base plate, border rim, and raised multiline text (border and text
					share one color).
				</p>

				{#if loadError}
					<p class="text-sm text-red-600">{loadError}</p>
				{/if}

				<div>
					<label for="bag-tag-font" class="mb-1 block text-xs font-medium text-slate-700">Font</label>
					<FontSelect id="bag-tag-font" bind:value={fontKey} />
				</div>

				<div class="space-y-2">
					<div class="flex items-center justify-between gap-2">
						<p class="text-xs font-medium text-slate-700">Text lines</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							class="h-7 px-2 text-[11px]"
							disabled={lines.length >= MAX_LINES}
							onclick={() => addLine()}
						>
							+ Line
						</Button>
					</div>

					{#each lines as line, idx (idx)}
						<div class="rounded-xl border border-slate-200 bg-slate-50/60 p-2.5">
							<div class="mb-2 flex items-center justify-between gap-2">
								<span class="text-[11px] font-medium text-slate-600">Line {idx + 1}</span>
								<div class="flex gap-1">
									<Button
										type="button"
										variant="outline"
										size="sm"
										class="h-6 w-6 p-0"
										disabled={idx === 0}
										aria-label="Move line up"
										onclick={() => moveLine(idx, -1)}
									>
										↑
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										class="h-6 w-6 p-0"
										disabled={idx === lines.length - 1}
										aria-label="Move line down"
										onclick={() => moveLine(idx, 1)}
									>
										↓
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										class="h-6 px-2 text-[10px]"
										disabled={lines.length <= 1}
										onclick={() => removeLine(idx)}
									>
										Remove
									</Button>
								</div>
							</div>
							<input
								type="text"
								placeholder="Line text"
								class="mb-2 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
								bind:value={line.content}
							/>
							<div class="flex items-center justify-between gap-2">
								<label class="text-[11px] text-slate-600" for="bag-tag-line-size-{idx}">
									Size
								</label>
								<span class="text-[11px] text-slate-500">{line.sizeMm.toFixed(1)} mm</span>
							</div>
							<Slider
								id="bag-tag-line-size-{idx}"
								type="single"
								bind:value={line.sizeMm}
								min={3}
								max={18}
								step={0.5}
								class="w-full"
							/>
						</div>
					{/each}
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="bag-tag-line-spacing" class="text-xs font-medium text-slate-700">
							Line spacing
						</label>
						<span class="text-xs text-slate-500">{lineSpacing.toFixed(1)} mm</span>
					</div>
					<Slider
						id="bag-tag-line-spacing"
						type="single"
						bind:value={lineSpacing}
						min={0}
						max={6}
						step={0.1}
						class="w-full"
					/>
				</div>

				<ColorPalettePicker bind:value={baseColor} {palette} label="Base color" />
				<ColorPalettePicker bind:value={accentColor} {palette} label="Border & text color" />

				{#if exportError}
					<p class="text-sm text-red-600">{exportError}</p>
				{/if}
			</div>
		</aside>

		<section
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<DesignerModelDimensionsHud sizes={modelAabbMm} />
			<div bind:this={hostEl} class="absolute inset-0"></div>
			<div class="absolute bottom-4 right-4">
				<DesignerExportToolbar
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, 'whistle-bag-tag')}
					onExport={() => exportStl()}
					exportDisabled={!sceneReady || exportLoading}
					exportTitle={getExportTitle(user, subscriptionStatus, 'Export STL or 3MF')}
					onExport3MF={() => export3MF()}
					onOpenWithBambuStudio={() => openWithBambuStudio()}
					openBambuStudioLoading={openBambuStudioLoading}
					{exportLoading}
					showLockIcon={!user || !subscriptionStatus?.isActive}
				/>
			</div>
		</section>
	</div>
</main>
