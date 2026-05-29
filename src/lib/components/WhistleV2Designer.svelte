<script lang="ts">
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import whistleV2ObjUrl from '$lib/assets/stl/whistle-v2.obj?url';
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

	type WhistlePartKey = 'accent' | 'main' | 'border';

	/** group_0 → Border, group_1 → Main, group_2 → Accent (embossed top for text) */
	const PART_ORDER: WhistlePartKey[] = ['border', 'main', 'accent'];

	const FONT_SIZE_FOR_SHAPES = 12;
	const TARGET_TEXT_HEIGHT_MM = 10;
	const TEXT_DEPTH_MM = 1;
	const TEXT_SURFACE_EMBED = 0.02;
	/** Fine-tune text XY on the embossed top (object is centered at origin). */
	const TEXT_OFFSET_X_MM = 4.5;
	const TEXT_OFFSET_Y_MM = 0;

	const STORAGE_KEY = 'keychain-whistle-v2-settings';
	const DEFAULT_BORDER_COLOR = '#1f2937';
	const DEFAULT_ACCENT_COLOR = '#eab308';

	interface WhistleV2Settings {
		textContent: string;
		fontKey: string;
		textScale: number;
		accentColor: string;
		mainColor: string;
		borderColor: string;
		textColor: string;
	}

	const defaults: WhistleV2Settings = {
		textContent: 'Name',
		fontKey: FONT_OPTIONS[0]?.key ?? 'Titan One_Regular',
		textScale: 1,
		accentColor: DEFAULT_ACCENT_COLOR,
		mainColor: '#f97316',
		borderColor: DEFAULT_BORDER_COLOR,
		textColor: DEFAULT_BORDER_COLOR
	};

	function clamp(n: number, lo: number, hi: number): number {
		return Math.min(hi, Math.max(lo, n));
	}

	function loadSettings(): WhistleV2Settings {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (!stored) return { ...defaults };
			const parsed = JSON.parse(stored) as Partial<WhistleV2Settings>;
			if (!parsed || typeof parsed !== 'object') return { ...defaults };
			const fontKey =
				typeof parsed.fontKey === 'string' &&
				FONT_OPTIONS.some((option) => option.key === parsed.fontKey)
					? parsed.fontKey
					: defaults.fontKey;
			return {
				textContent:
					typeof parsed.textContent === 'string'
						? parsed.textContent
						: defaults.textContent,
				fontKey,
				textScale:
					typeof parsed.textScale === 'number' && Number.isFinite(parsed.textScale)
						? clamp(parsed.textScale, 0.3, 2)
						: defaults.textScale,
				accentColor:
					typeof parsed.accentColor === 'string' ? parsed.accentColor : defaults.accentColor,
				mainColor:
					typeof parsed.mainColor === 'string' ? parsed.mainColor : defaults.mainColor,
				borderColor:
					typeof parsed.borderColor === 'string' ? parsed.borderColor : defaults.borderColor,
				textColor:
					typeof parsed.textColor === 'string' ? parsed.textColor : defaults.textColor
			};
		} catch {
			return { ...defaults };
		}
	}

	const initial = loadSettings();

	function saveSettings() {
		try {
			const payload: WhistleV2Settings = {
				textContent,
				fontKey,
				textScale,
				accentColor,
				mainColor,
				borderColor,
				textColor
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

	let partGeometries = $state<Record<WhistlePartKey, THREE.BufferGeometry> | null>(null);
	let loadError = $state<string | null>(null);
	let sceneReady = $state(false);

	let textContent = $state(initial.textContent);
	let fontKey = $state(initial.fontKey);
	let textScale = $state(initial.textScale);
	let accentColor = $state(initial.accentColor);
	let mainColor = $state(initial.mainColor);
	let borderColor = $state(initial.borderColor);
	let textColor = $state(initial.textColor);
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

	/** Parse OBJLoader output: meshes are named group_0_*, group_1_*, group_2_* (not obj_0). */
	function extractPartGeometries(root: THREE.Object3D): Record<WhistlePartKey, THREE.BufferGeometry> | null {
		const meshes: THREE.Mesh[] = [];
		root.traverse((child) => {
			if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
		});
		if (meshes.length === 0) return null;

		const byIndex = new Map<number, THREE.Mesh>();
		for (const mesh of meshes) {
			const m = /^group_(\d+)_/i.exec(mesh.name);
			if (m) byIndex.set(Number(m[1]), mesh);
		}

		const parts = {} as Record<WhistlePartKey, THREE.BufferGeometry>;
		for (let i = 0; i < PART_ORDER.length; i++) {
			const key = PART_ORDER[i];
			const mesh = byIndex.get(i) ?? meshes[i];
			if (!mesh) return null;
			parts[key] = meshToWorldGeometry(mesh);
		}
		return parts;
	}

	function centerPartGeometries(parts: Record<WhistlePartKey, THREE.BufferGeometry>) {
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

	/** Accent mesh is embossed: find upward-facing vertices on the top plateau. */
	function getAssemblyBounds(): THREE.Box3 | null {
		if (!partGeometries) return null;
		const box = new THREE.Box3();
		for (const geo of Object.values(partGeometries)) {
			geo.computeBoundingBox();
			if (geo.boundingBox) box.union(geo.boundingBox);
		}
		return box.isEmpty() ? null : box;
	}

	function getEmbossedTopSurface(borderGeo: THREE.BufferGeometry): {
		topZ: number;
		planWidth: number;
	} | null {
		borderGeo.computeBoundingBox();
		const bb = borderGeo.boundingBox;
		if (!bb) return null;

		if (!borderGeo.getAttribute('normal')) borderGeo.computeVertexNormals();
		const pos = borderGeo.getAttribute('position');
		const norm = borderGeo.getAttribute('normal');
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

	function bottomAlignGeometryZ(geo: THREE.BufferGeometry) {
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (!bb) return;
		geo.translate(0, 0, -bb.min.z);
		geo.computeBoundingBox();
	}

	function rebuildMeshes() {
		if (!group) return;
		disposeObject3D(group);
		group.clear();
		modelAabbMm = null;

		if (!partGeometries) return;

		const partColors: Record<WhistlePartKey, string> = {
			accent: accentColor,
			main: mainColor,
			border: borderColor
		};

		for (const key of ['accent', 'main', 'border'] as const) {
			const geo = partGeometries[key];
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

		const content = (textContent ?? '').trim();
		const assemblyBox = getAssemblyBounds();
		const topSurface = partGeometries.accent
			? getEmbossedTopSurface(partGeometries.accent)
			: null;
		if (content && topSurface && assemblyBox) {
			const font = getFont(fontKey);
			if (font) {
				const shapes = font.generateShapes(content, FONT_SIZE_FOR_SHAPES);
				if (shapes.length > 0) {
					const textGeo = new THREE.ExtrudeGeometry(shapes, {
						depth: TEXT_DEPTH_MM,
						bevelEnabled: false,
						curveSegments: 8
					});
					centerGeometryXY(textGeo);
					bottomAlignGeometryZ(textGeo);

					const textMat = new THREE.MeshStandardMaterial({
						color: textColor,
						roughness: 0.4,
						metalness: 0.1
					});
					const textMesh = new THREE.Mesh(textGeo, textMat);
					textMesh.name = 'text';
					textMesh.castShadow = true;
					textMesh.receiveShadow = true;

					textGeo.computeBoundingBox();
					const tb = textGeo.boundingBox!;
					const textH = Math.max(tb.max.y - tb.min.y, 0.01);
					const scale = (TARGET_TEXT_HEIGHT_MM * textScale) / textH;
					const assemblyW = Math.max(0.01, assemblyBox.max.x - assemblyBox.min.x);
					const scaleCap = (assemblyW * 0.8) / (tb.max.x - tb.min.x || 0.01);
					const scaleCapped = Math.min(scale, scaleCap);
					textMesh.scale.set(scaleCapped, scaleCapped, 1);
					const centerX = (assemblyBox.min.x + assemblyBox.max.x) / 2;
					const centerY = (assemblyBox.min.y + assemblyBox.max.y) / 2;
					textMesh.position.set(
						centerX + TEXT_OFFSET_X_MM,
						centerY + TEXT_OFFSET_Y_MM,
						topSurface.topZ + TEXT_SURFACE_EMBED
					);
					group.add(textMesh);
				}
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

	function buildExportGroup(): THREE.Group {
		if (!group) throw new Error('Scene not ready');
		rebuildMeshes();
		group.updateWorldMatrix(true, true);
		const exportGroup = new THREE.Group();
		for (const child of group.children) {
			if (!(child as THREE.Mesh).isMesh) continue;
			const mesh = child as THREE.Mesh;
			const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
			const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
			const color = mat?.color?.clone() ?? new THREE.Color(0xffffff);
			const exportMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
			exportMesh.name = mesh.name;
			exportGroup.add(exportMesh);
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
			const geometries: THREE.BufferGeometry[] = [];
			for (const child of group.children) {
				if (!(child as THREE.Mesh).isMesh) continue;
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
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`whistle-v2-${ts}.stl`, new Blob([buffer], { type: 'model/stl' }));
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Whistle v2',
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
			const exportGroup = buildExportGroup();
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) {
				exportError = 'Export produced empty geometry';
				return;
			}
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`whistle-v2-${ts}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Whistle v2',
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
			const exportGroup = buildExportGroup();
			const blob = await exportTo3MF(exportGroup);
			disposeObject3D(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'whistle-v2');
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Whistle v2',
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
		void textContent;
		void fontKey;
		void textScale;
		void textColor;
		void accentColor;
		void mainColor;
		void borderColor;
		saveSettings();
	});

	$effect(() => {
		void partGeometries;
		void textContent;
		void fontKey;
		void textScale;
		void textColor;
		void accentColor;
		void mainColor;
		void borderColor;
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
		fillLight.target.position.set(0, 0, 0);
		scene.add(fillLight);
		scene.add(fillLight.target);

		group = new THREE.Group();
		scene.add(group);

		const grid = new THREE.GridHelper(250, 25, 0xcbd5e1, 0xe2e8f0);
		grid.rotateX(Math.PI / 2);
		grid.position.z = -0.01;
		scene.add(grid);

		const loader = new OBJLoader();
		loader.load(
			whistleV2ObjUrl,
			(root) => {
				const parts = extractPartGeometries(root);
				if (!parts) {
					loadError = 'Whistle model must contain three mesh groups (Accent, Main, Border).';
					disposePartGeometries();
					return;
				}
				centerPartGeometries(parts);
				partGeometries = parts;
				loadError = null;
				sceneReady = true;
				rebuildMeshes();
			},
			undefined,
			(err) => {
				loadError = err instanceof Error ? err.message : 'Failed to load whistle model';
			}
		);

		ro = new ResizeObserver(() => resize());
		ro.observe(hostEl);
		resize();

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
		rafId = 0;
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
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Whistle v2</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
				<p class="text-xs text-slate-500">
					Multicolor whistle with Border, Main, and Accent parts. Raised text (1&nbsp;mm) sits on
					the embossed Accent top. Text defaults to the Border color but can be changed separately.
				</p>

				{#if loadError}
					<p class="text-sm text-red-600">{loadError}</p>
				{/if}

				<div>
					<label for="whistle-v2-text" class="mb-1 block text-xs font-medium text-slate-700">
						Text
					</label>
					<input
						id="whistle-v2-text"
						type="text"
						placeholder="Your name or message"
						class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
						bind:value={textContent}
					/>
				</div>

				<div>
					<label for="whistle-v2-font" class="mb-1 block text-xs font-medium text-slate-700">
						Font
					</label>
					<FontSelect id="whistle-v2-font" bind:value={fontKey} />
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="whistle-v2-text-scale" class="text-xs font-medium text-slate-700">
							Text scale
						</label>
						<span class="text-xs text-slate-500">{textScale.toFixed(1)}×</span>
					</div>
					<Slider
						id="whistle-v2-text-scale"
						type="single"
						bind:value={textScale}
						min={0.3}
						max={2}
						step={0.1}
						class="w-full"
					/>
				</div>

				<ColorPalettePicker bind:value={textColor} {palette} label="Text color" />

				<div class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<p class="text-xs font-semibold tracking-tight text-slate-700">Body colors</p>
					<ColorPalettePicker bind:value={mainColor} {palette} label="Main" />
					<ColorPalettePicker bind:value={borderColor} {palette} label="Border" />
					<ColorPalettePicker bind:value={accentColor} {palette} label="Accent" />
				</div>

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
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, 'whistle-v2')}
					onExport={() => exportStl()}
					exportDisabled={!partGeometries || exportLoading}
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
