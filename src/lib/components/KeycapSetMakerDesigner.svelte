<script lang="ts">
	import defaultKeycapStlUrl from '$lib/assets/stl/keycap.stl?url';
	import borderStlUrl from '$lib/assets/stl/border.stl?url';
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
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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

	const DEFAULT_LEGENDS_TEXT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	const LOGO_TEXT_FONT_SIZE = 24;
	const STORAGE_KEY_OPTIONS = 'keycap-set-maker-options';

	type KeycapSetMakerPersisted = {
		legendsText?: string;
		logoFontKey?: string;
		logoDepth?: number;
		logoScale?: number;
		keycapColor?: string;
		logoColor?: string;
		showBorder?: boolean;
	};

	function loadKeycapSetMakerOptions(): KeycapSetMakerPersisted {
		try {
			const raw = localStorage.getItem(STORAGE_KEY_OPTIONS);
			if (!raw) return {};
			const p = JSON.parse(raw) as unknown;
			return typeof p === 'object' && p !== null ? (p as KeycapSetMakerPersisted) : {};
		} catch {
			return {};
		}
	}

	const persisted = loadKeycapSetMakerOptions();
	const initialFontKey =
		persisted.logoFontKey && FONT_OPTIONS.some((o) => o.key === persisted.logoFontKey)
			? persisted.logoFontKey
			: FONT_OPTIONS[0].key;
	const initialLegends =
		typeof persisted.legendsText === 'string' ? persisted.legendsText : DEFAULT_LEGENDS_TEXT;
	const initialLogoDepth =
		typeof persisted.logoDepth === 'number' &&
		Number.isFinite(persisted.logoDepth) &&
		persisted.logoDepth >= 0.1 &&
		persisted.logoDepth <= 2
			? persisted.logoDepth
			: 0.5;
	const initialLogoScale =
		typeof persisted.logoScale === 'number' &&
		Number.isFinite(persisted.logoScale) &&
		persisted.logoScale >= 0.2 &&
		persisted.logoScale <= 1
			? persisted.logoScale
			: 0.6;
	const initialKeycapColor =
		typeof persisted.keycapColor === 'string' && persisted.keycapColor.length > 0
			? persisted.keycapColor
			: '#ffffff';
	const initialLogoColor =
		typeof persisted.logoColor === 'string' && persisted.logoColor.length > 0
			? persisted.logoColor
			: '#3898ff';
	const initialShowBorder = persisted.showBorder === true;

	/** One keycap per grapheme / character; newlines are ignored for layout. */
	function parseLegendsInput(raw: string): string[] {
		const withoutBreaks = raw
			.replace(/\r\n/g, '\n')
			.replace(/\r/g, '')
			.replace(/[\n\t]/g, '')
			.replace(/[\u200B-\u200D\uFEFF]/g, '');
		if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
			const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
			return [...seg.segment(withoutBreaks)]
				.map((s) => s.segment)
				.filter((s) => s.length > 0);
		}
		return [...withoutBreaks].filter((s) => s.length > 0);
	}

	/** Minimize deviation from a 1:1 aspect ratio; slight penalty for empty grid slots. */
	function nearSquareGridDimensions(n: number): { cols: number; rows: number } {
		if (n <= 0) return { cols: 1, rows: 1 };
		let bestCols = 1;
		let bestRows = n;
		let bestScore = Number.POSITIVE_INFINITY;
		for (let cols = 1; cols <= n; cols++) {
			const rows = Math.ceil(n / cols);
			const slack = cols * rows - n;
			const ar = cols / rows;
			const imbalance = Math.abs(Math.log(ar));
			const score = imbalance + slack * 0.35;
			if (score < bestScore - 1e-12) {
				bestScore = score;
				bestCols = cols;
				bestRows = rows;
			}
		}
		return { cols: bestCols, rows: bestRows };
	}

	let legendsText = $state(initialLegends);
	const legendLabels = $derived(parseLegendsInput(legendsText));
	const gridDims = $derived(
		legendLabels.length === 0
			? { cols: 0, rows: 0 }
			: nearSquareGridDimensions(legendLabels.length)
	);

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

	let keycapGeometry = $state<THREE.BufferGeometry | null>(null);
	/** Shared template; clones per cell. Same XY/Z normalization as keycap (bottom z = 0). */
	let borderGeometry = $state<THREE.BufferGeometry | null>(null);
	let keycapObjectUrl = $state<string | null>(null);
	let keycapFileName = $state('');
	let exportError = $state<string | null>(null);
	let exportLoading = $state(false);
	let openBambuStudioLoading = $state(false);
	let logoDepth = $state(initialLogoDepth);
	let logoScale = $state(initialLogoScale);
	let keycapColor = $state(initialKeycapColor);
	let logoColor = $state(initialLogoColor);
	let logoFontKey = $state(initialFontKey);
	let showBorder = $state(initialShowBorder);

	function centerAndNormalizeKeycap(geo: THREE.BufferGeometry) {
		geo.computeBoundingBox();
		const bb = geo.boundingBox!;
		const cx = (bb.min.x + bb.max.x) / 2;
		const cy = (bb.min.y + bb.max.y) / 2;
		const cz = bb.min.z;
		geo.translate(-cx, -cy, -cz);
		geo.computeBoundingBox();
	}

	function resize() {
		if (!renderer || !camera || !hostEl) return;
		const rect = hostEl.getBoundingClientRect();
		const w = Math.max(1, Math.floor(rect.width));
		const h = Math.max(1, Math.floor(rect.height));
		renderer.setSize(w, h, true);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}

	async function onKeycapSelected(file: File) {
		if (keycapObjectUrl) {
			URL.revokeObjectURL(keycapObjectUrl);
			keycapObjectUrl = null;
		}
		if (keycapGeometry) {
			keycapGeometry.dispose();
			keycapGeometry = null;
		}
		keycapFileName = file.name;
		const url = URL.createObjectURL(file);
		keycapObjectUrl = url;
		const loader = new STLLoader();
		try {
			const geo = await new Promise<THREE.BufferGeometry>((resolve, reject) => {
				loader.load(url, resolve, undefined, reject);
			});
			centerAndNormalizeKeycap(geo);
			keycapGeometry = geo;
			didInitFrame = false;
		} catch (e) {
			keycapGeometry = null;
			exportError = e instanceof Error ? e.message : 'Failed to load keycap STL';
		}
	}

	function buildLogoGeometryFromText(char: string): THREE.BufferGeometry | null {
		const ch = char ?? '';
		if (!ch) return null;
		const font = getFont(logoFontKey);
		if (!font) return null;
		const shapes = font.generateShapes(ch, LOGO_TEXT_FONT_SIZE);
		if (shapes.length === 0) return null;
		const depth = Math.max(0.05, logoDepth);
		const geo = new THREE.ExtrudeGeometry(shapes, {
			depth,
			bevelEnabled: false,
			curveSegments: 12,
			steps: 1
		});
		geo.computeVertexNormals();
		centerGeometryXY(geo);
		geo.computeBoundingBox();
		return geo;
	}

	/**
	 * Typical cap-size bbox in shape space (same font size / depth as legends).
	 * Used to cap scale so punctuation with a tiny tight bbox (., ') does not
	 * blow up to fill the whole keycap like a full letter.
	 */
	function referenceLegendFitBox(
		font: NonNullable<ReturnType<typeof getFont>>,
		depth: number
	): { w: number; h: number } | null {
		const d = Math.max(0.05, depth);
		for (const ref of ['M', 'W', 'H', '0', 'O', 'A'] as const) {
			const shapes = font.generateShapes(ref, LOGO_TEXT_FONT_SIZE);
			if (shapes.length === 0) continue;
			const geo = new THREE.ExtrudeGeometry(shapes, {
				depth: d,
				bevelEnabled: false,
				curveSegments: 12,
				steps: 1
			});
			geo.computeVertexNormals();
			centerGeometryXY(geo);
			geo.computeBoundingBox();
			const bb = geo.boundingBox!;
			const w = Math.max(0.01, bb.max.x - bb.min.x);
			const h = Math.max(0.01, bb.max.y - bb.min.y);
			geo.dispose();
			return { w, h };
		}
		return null;
	}

	function rebuildMeshes() {
		if (!group) return;
		disposeObject3D(group);
		group.clear();
		modelAabbMm = null;
		exportError = null;

		const font = getFont(logoFontKey);
		if (!keycapGeometry || !font) return;

		const labels = legendLabels;
		if (labels.length === 0) return;

		const gridCols = gridDims.cols;
		const nRows = gridDims.rows;

		keycapGeometry.computeBoundingBox();
		const bb = keycapGeometry.boundingBox!;
		const keycapMaxZ = bb.max.z;
		const keycapW = Math.max(0.01, bb.max.x - bb.min.x);
		const keycapH = Math.max(0.01, bb.max.y - bb.min.y);
		const gap = Math.max(keycapW, keycapH) * 0.08;
		const pitchX = keycapW + gap;
		const pitchY = keycapH + gap;

		const fitK = logoScale * 0.8;
		const refBox = referenceLegendFitBox(font, logoDepth);
		const refCapScale = refBox
			? Math.min((keycapW * fitK) / refBox.w, (keycapH * fitK) / refBox.h)
			: Number.POSITIVE_INFINITY;

		const keycapMatProto = new THREE.MeshStandardMaterial({
			color: keycapColor,
			roughness: 0.7,
			metalness: 0.1
		});
		const logoMatProto = new THREE.MeshStandardMaterial({
			color: logoColor,
			roughness: 0.4,
			metalness: 0.1
		});

		for (let i = 0; i < labels.length; i++) {
			const char = labels[i];
			const col = i % gridCols;
			const row = Math.floor(i / gridCols);
			// Row 0 = top (larger y), last row = bottom — left-to-right, top-to-bottom.
			const rowFromTop = nRows - 1 - row;
			const x = (col - (gridCols - 1) / 2) * pitchX;
			const y = (rowFromTop - (nRows - 1) / 2) * pitchY;

			const cell = new THREE.Group();
			cell.position.set(x, y, 0);

			const keycapMesh = new THREE.Mesh(keycapGeometry.clone(), keycapMatProto.clone());
			keycapMesh.name = 'keycap';
			keycapMesh.castShadow = true;
			keycapMesh.receiveShadow = true;
			cell.add(keycapMesh);

			if (showBorder && borderGeometry) {
				const borderMesh = new THREE.Mesh(borderGeometry.clone(), logoMatProto.clone());
				borderMesh.name = 'border';
				borderMesh.castShadow = true;
				borderMesh.receiveShadow = true;
				borderMesh.position.set(0, 0, keycapMaxZ);
				cell.add(borderMesh);
			}

			const logoGeo = buildLogoGeometryFromText(char);
			if (logoGeo) {
				const logoBb = logoGeo.boundingBox!;
				const logoW = Math.max(0.01, logoBb.max.x - logoBb.min.x);
				const logoH = Math.max(0.01, logoBb.max.y - logoBb.min.y);
				const glyphFit = Math.min((keycapW * fitK) / logoW, (keycapH * fitK) / logoH);
				const scale = Math.min(refCapScale, glyphFit);
				logoGeo.scale(scale, scale, 1);
				logoGeo.computeBoundingBox();

				const logoMesh = new THREE.Mesh(logoGeo, logoMatProto.clone());
				logoMesh.name = 'legend';
				logoMesh.castShadow = true;
				logoMesh.receiveShadow = true;
				logoMesh.position.set(0, 0, keycapMaxZ);
				cell.add(logoMesh);
			}

			group.add(cell);
		}

		keycapMatProto.dispose();
		logoMatProto.dispose();

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
		const hasContent = keycapGeometry != null && group.children.length > 0;
		const boxValid =
			!box.isEmpty() && box.getSize(new THREE.Vector3()).lengthSq() > 1e-6;
		if (!didInitFrame && camera && controls && hasContent && boxValid) {
			frameCameraToObject(box, camera, controls);
			didInitFrame = true;
		}
		{
			const s = measureWorldAabbSizeMm(group);
			modelAabbMm = s ? { x: s.x, y: s.y, z: s.z } : null;
		}
	}

	/**
	 * 3MF exporter reads mesh vertices in local space and applies Group/Mesh transforms
	 * via assemblies. Flattening with applyMatrix4(world) breaks that — clone each cell
	 * as a Group with keycap + legend meshes (not merged).
	 */
	function buildKeycapSet3mfExportScene(source: THREE.Group): THREE.Scene {
		const exportRoot = new THREE.Scene();
		exportRoot.name = 'keycap-set-3mf';
		for (const cell of source.children) {
			if (!(cell instanceof THREE.Group)) continue;
			const cellOut = new THREE.Group();
			cellOut.name = 'keycap-with-legend';
			cellOut.position.copy(cell.position);
			cellOut.quaternion.copy(cell.quaternion);
			cellOut.scale.copy(cell.scale);
			let partIndex = 0;
			for (const child of cell.children) {
				if (!(child as THREE.Mesh).isMesh) continue;
				const mesh = child as THREE.Mesh;
				const srcMat = (Array.isArray(mesh.material)
					? mesh.material[0]
					: mesh.material) as THREE.MeshStandardMaterial;
				const color = srcMat?.color != null ? srcMat.color.clone() : new THREE.Color(0xffffff);
				const geo = mesh.geometry.clone();
				const outMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
				outMesh.name = mesh.name || `part_${partIndex}`;
				outMesh.position.copy(mesh.position);
				outMesh.quaternion.copy(mesh.quaternion);
				outMesh.scale.copy(mesh.scale);
				cellOut.add(outMesh);
				partIndex++;
			}
			exportRoot.add(cellOut);
		}
		exportRoot.updateMatrixWorld(true);
		return exportRoot;
	}

	function collectMeshGeometries(root: THREE.Object3D): THREE.BufferGeometry[] {
		const geometries: THREE.BufferGeometry[] = [];
		root.traverse((child) => {
			if ((child as THREE.Mesh).isMesh) {
				const mesh = child as THREE.Mesh;
				let g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
				if (g.attributes.uv) g.deleteAttribute('uv');
				if (!g.attributes.normal) g.computeVertexNormals();
				if (g.index) {
					const nonIndexed = g.toNonIndexed();
					g.dispose();
					g = nonIndexed;
				}
				geometries.push(g);
			}
		});
		return geometries;
	}

	async function exportStl() {
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		if (!group || !keycapGeometry) {
			exportError = 'Load a keycap STL to export';
			return;
		}
		if (!getFont(logoFontKey)) {
			exportError = 'Font not ready';
			return;
		}
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			rebuildMeshes();
			group!.updateWorldMatrix(true, true);
			const geometries = collectMeshGeometries(group!);
			if (geometries.length === 0) {
				exportError = 'Nothing to export';
				return;
			}
			const merged =
				geometries.length === 1
					? geometries[0]
					: BufferGeometryUtils.mergeGeometries(geometries);
			if (!merged) {
				geometries.forEach((g) => g.dispose());
				exportError = 'Failed to merge geometry';
				return;
			}
			if (geometries.length > 1) geometries.forEach((g) => g.dispose());
			const welded = BufferGeometryUtils.mergeVertices(merged, 1e-3);
			if (welded !== merged) merged.dispose();

			const exporter = new STLExporter();
			const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
			welded.dispose();
			const buffer = result instanceof DataView ? result.buffer : result;
			if (!buffer || (buffer as ArrayBuffer).byteLength < 84) {
				exportError = 'Export produced empty geometry';
				return;
			}
			const slug = (keycapFileName || 'keycap-set')
				.toLowerCase()
				.replace(/\.stl$/i, '')
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/(^-|-$)/g, '');
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${slug || 'keycap-set'}-${ts}.stl`, new Blob([buffer], { type: 'model/stl' }));
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string) ??
					'',
				subscriptionStatus,
				designName: 'Keycap Set Maker',
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
		if (!group || !scene) return;
		if (!ensureExportAccess(user, subscriptionStatus, onShowPricing)) return;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			rebuildMeshes();
			group.updateWorldMatrix(true, true);
			const exportRoot = buildKeycapSet3mfExportScene(group);
			if (exportRoot.children.length === 0) return;
			const blob = await exportTo3MF(exportRoot);
			disposeObject3D(exportRoot);
			if (!blob || blob.size === 0) return;
			const slug = (keycapFileName || 'keycap-set')
				.toLowerCase()
				.replace(/\.stl$/i, '')
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/(^-|-$)/g, '');
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${slug || 'keycap-set'}-${timestamp}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string) ??
					'',
				subscriptionStatus,
				designName: 'Keycap Set Maker',
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
			rebuildMeshes();
			group.updateWorldMatrix(true, true);
			const exportRoot = buildKeycapSet3mfExportScene(group);
			if (exportRoot.children.length === 0) return;
			const blob = await exportTo3MF(exportRoot);
			disposeObject3D(exportRoot);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'keycap-set');
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string) ??
					'',
				subscriptionStatus,
				designName: 'Keycap Set Maker',
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (err) {
			console.error('Open with Bambu Studio failed:', err);
		} finally {
			openBambuStudioLoading = false;
		}
	}

	$effect(() => {
		void keycapGeometry;
		void logoFontKey;
		void logoDepth;
		void logoScale;
		void keycapColor;
		void logoColor;
		void legendsText;
		void showBorder;
		void borderGeometry;
		try {
			const payload: KeycapSetMakerPersisted = {
				legendsText,
				logoFontKey,
				logoDepth,
				logoScale,
				keycapColor,
				logoColor,
				showBorder
			};
			localStorage.setItem(STORAGE_KEY_OPTIONS, JSON.stringify(payload));
		} catch (e) {
			console.error('Keycap Set Maker: failed to save options', e);
		}
		if (!scene || !group) return;
		rebuildMeshes();
	});

	onMount(() => {
		if (!hostEl) return;
		scene = new THREE.Scene();
		scene.background = new THREE.Color(0xffffff);
		camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
		camera.up.set(0, 0, 1);
		renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.2;
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		hostEl.appendChild(renderer.domElement);

		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.enablePan = true;
		controls.minDistance = 5;
		controls.maxDistance = 800;

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
		fillLight.target.position.set(0, 0, 0);
		scene.add(fillLight);
		scene.add(fillLight.target);

		group = new THREE.Group();
		scene.add(group);

		const grid = new THREE.GridHelper(250, 25, 0xcbd5e1, 0xe2e8f0);
		grid.rotateX(Math.PI / 2);
		grid.position.z = -0.01;
		scene.add(grid);

		const loader = new STLLoader();
		loader.load(defaultKeycapStlUrl, (geometry: THREE.BufferGeometry) => {
			centerAndNormalizeKeycap(geometry);
			keycapGeometry = geometry;
			keycapFileName = 'keycap.stl';
			didInitFrame = false;
		});
		loader.load(borderStlUrl, (geometry: THREE.BufferGeometry) => {
			centerAndNormalizeKeycap(geometry);
			borderGeometry = geometry;
		});

		ro = new ResizeObserver(() => resize());
		ro.observe(hostEl);
		resize();

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

	onDestroy(() => {
		cancelAnimationFrame(rafId);
		rafId = 0;
		if (keycapObjectUrl) {
			URL.revokeObjectURL(keycapObjectUrl);
			keycapObjectUrl = null;
		}
		if (keycapGeometry) {
			keycapGeometry.dispose();
			keycapGeometry = null;
		}
		if (borderGeometry) {
			borderGeometry.dispose();
			borderGeometry = null;
		}
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
	<div class="mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full min-w-0 max-w-[360px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] lg:min-w-[320px]"
		>
			<div class="mb-4 flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Keycap Set Maker</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
				<p class="text-xs text-slate-500">
					Upload a flat keycap base (STL) or use the default. Enter one legend per grapheme
				</p>

				<div>
					<div class="mb-1 flex flex-wrap items-center justify-between gap-1">
						<label for="keycap-set-legends" class="text-xs font-medium text-slate-700">Legends</label>
						<span class="text-xs tabular-nums text-slate-500">
							{legendLabels.length} key{legendLabels.length === 1 ? '' : 's'} · {legendLabels.length === 0
								? '—'
								: `${gridDims.cols}×${gridDims.rows}`}
						</span>
					</div>
					<textarea
						id="keycap-set-legends"
						rows={4}
						bind:value={legendsText}
						spellcheck="false"
						class="min-h-[88px] w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm leading-relaxed text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
						placeholder={DEFAULT_LEGENDS_TEXT}
					></textarea>
					<p class="mt-1 text-[11px] text-slate-500">
						Default is A–Z and 0–9. Clear and type your own set; order is left-to-right, top to bottom.
					</p>
				</div>

				<div>
					<label for="keycap-set-stl-input" class="mb-1 block text-xs font-medium text-slate-700">
						Keycap base (STL)
					</label>
					<input
						id="keycap-set-stl-input"
						type="file"
						accept=".stl"
						class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
						onchange={(e) => {
							const input = e.currentTarget as HTMLInputElement;
							const file = input.files?.[0];
							if (file) void onKeycapSelected(file);
						}}
					/>
					{#if keycapFileName}
						<p class="mt-1 truncate text-xs text-slate-500">{keycapFileName}</p>
					{/if}
				</div>

				<div>
					<label for="keycap-set-font" class="mb-1 block text-xs font-medium text-slate-700">Font</label>
					<FontSelect id="keycap-set-font" bind:value={logoFontKey} />
				</div>

				{#if keycapGeometry}
					<div>
						<div class="mb-1 flex items-center justify-between">
							<label for="keycap-set-logo-scale" class="text-xs font-medium text-slate-700"
								>Legend size</label
							>
							<span class="text-xs text-slate-500">{(logoScale * 100).toFixed(0)}%</span>
						</div>
						<Slider
							id="keycap-set-logo-scale"
							type="single"
							bind:value={logoScale}
							min={0.2}
							max={1}
							step={0.05}
							class="w-full"
						/>
					</div>

					<div>
						<div class="mb-1 flex items-center justify-between">
							<label for="keycap-set-logo-depth" class="text-xs font-medium text-slate-700"
								>Legend depth</label
							>
							<span class="text-xs text-slate-500">{logoDepth.toFixed(1)} mm</span>
						</div>
						<Slider
							id="keycap-set-logo-depth"
							type="single"
							bind:value={logoDepth}
							min={0.1}
							max={2}
							step={0.05}
							class="w-full"
						/>
					</div>

					<div class="grid grid-cols-2 gap-3">
						<ColorPalettePicker bind:value={keycapColor} {palette} label="Keycap color" />
						<ColorPalettePicker bind:value={logoColor} {palette} label="Legend color" />
					</div>

					<div class="flex items-center gap-2 pt-1">
						<input
							id="keycap-set-border-toggle"
							type="checkbox"
							bind:checked={showBorder}
							class="size-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
						/>
						<label for="keycap-set-border-toggle" class="text-xs leading-snug text-slate-700">
							Top border (STL){#if !borderGeometry}
								<span class="text-slate-400"> — loading…</span>
							{/if}
							<span class="block text-[11px] font-normal text-slate-500"
								>Uses legend color; border and legend share the keycap top (z).</span
							>
						</label>
					</div>
				{/if}

				{#if exportError}
					<p class="text-xs text-red-600">{exportError}</p>
				{/if}
			</div>
		</aside>

		<section
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<DesignerModelDimensionsHud sizes={modelAabbMm} />
			<div bind:this={hostEl} class="absolute inset-0"></div>
			<div class="absolute bottom-4 right-4 z-10">
				<DesignerExportToolbar
					onSnapshot={() =>
						downloadSnapshot(renderer, scene, camera, 'keycap-set-maker')}
					onExport={() => (user && subscriptionStatus?.isActive ? exportStl() : onShowPricing?.())}
					exportDisabled={!keycapGeometry ||
						legendLabels.length === 0 ||
						!getFont(logoFontKey) ||
						exportLoading}
					exportTitle={getExportTitle(user, subscriptionStatus, 'Export STL')}
					onExport3MF={() =>
						user && subscriptionStatus?.isActive ? void export3MF() : onShowPricing?.()}
					onOpenWithBambuStudio={() =>
						user && subscriptionStatus?.isActive ? void openWithBambuStudio() : onShowPricing?.()}
					openBambuStudioLoading={openBambuStudioLoading}
					{exportLoading}
					showLockIcon={!user || !subscriptionStatus?.isActive}
				/>
			</div>
		</section>
	</div>
</main>
