<script lang="ts">
	import { openInSlicer, type OpenWithSlicerId } from '$lib/openInSlicer';
	import { type PaletteColor } from '$lib/colorPalette';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import { notifyExportEvent } from '$lib/exportNotify';
	import { warmupOpenScadWorker } from '$lib/openscad';
	import {
		ensureExportAccess,
		getExportTitle,
		showExportLockIcon,
		type SubscriptionStatus
	} from '$lib/subscription';
	import {
		buildNameInsertGeometry,
		buildNameInsertGeometryStandalone,
		buildPocketedInitialGeometry,
		buildSolidInitialGeometry,
		DEFAULT_INITIAL_FONT_KEY,
		DEFAULT_INITIAL_SIZE_MM,
		DEFAULT_LETTER_THICKNESS_MM,
		DEFAULT_NAME_FONT_KEY,
		DEFAULT_NAME_THICKNESS_MM,
		DEFAULT_NAME_OFFSET_X_MM,
		DEFAULT_NAME_OFFSET_Y_MM,
		DEFAULT_NAME_SIZE_MM,
		DEFAULT_NAME_TEXT,
		DEFAULT_POCKET_DEPTH_MM,
		DEFAULT_TOLERANCE_MM,
		DESIGN_NAME,
		effectiveLargeInitial,
		paramsFromInputs,
		STORAGE_KEY,
		type InitialAndNameParams
	} from '$lib/utils-initial-and-name';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import {
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		frameCameraToObject,
		getFont,
		measureWorldAabbSizeMm
	} from '$lib/utils-3d';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import FontSelect from './FontSelect.svelte';

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
		subscriptionStatus,
		palette,
		onBack,
		onRequestLogin,
		onShowThankYou,
		onShowPricing
	}: Props = $props();

	const SLUG = 'initial-and-name';
	const PREVIEW_DEBOUNCE_MS = 400;

	interface Settings {
		nameText: string;
		largeInitialChar: string;
		initialFontKey: string;
		nameFontKey: string;
		initialSizeMm: number;
		nameSizeMm: number;
		letterThicknessMm: number;
		nameThicknessMm: number;
		pocketDepthMm: number;
		toleranceMm: number;
		nameOffsetXMm: number;
		nameOffsetYMm: number;
		initialColor: string;
		nameColor: string;
	}

	const defaults: Settings = {
		nameText: DEFAULT_NAME_TEXT,
		largeInitialChar: '',
		initialFontKey: DEFAULT_INITIAL_FONT_KEY,
		nameFontKey: DEFAULT_NAME_FONT_KEY,
		initialSizeMm: DEFAULT_INITIAL_SIZE_MM,
		nameSizeMm: DEFAULT_NAME_SIZE_MM,
		letterThicknessMm: DEFAULT_LETTER_THICKNESS_MM,
		nameThicknessMm: DEFAULT_NAME_THICKNESS_MM,
		pocketDepthMm: DEFAULT_POCKET_DEPTH_MM,
		toleranceMm: DEFAULT_TOLERANCE_MM,
		nameOffsetXMm: DEFAULT_NAME_OFFSET_X_MM,
		nameOffsetYMm: DEFAULT_NAME_OFFSET_Y_MM,
		initialColor: '#3b82f6',
		nameColor: '#ffffff'
	};

	function clamp(n: number, lo: number, hi: number) {
		return Math.min(hi, Math.max(lo, n));
	}

	function loadSettings(): Settings {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return { ...defaults };
			const p = JSON.parse(raw) as Partial<Settings>;
			return {
				nameText: typeof p.nameText === 'string' ? p.nameText : defaults.nameText,
				largeInitialChar:
					typeof p.largeInitialChar === 'string' ? p.largeInitialChar : defaults.largeInitialChar,
				initialFontKey:
					typeof p.initialFontKey === 'string' ? p.initialFontKey : defaults.initialFontKey,
				nameFontKey: typeof p.nameFontKey === 'string' ? p.nameFontKey : defaults.nameFontKey,
				initialSizeMm:
					typeof p.initialSizeMm === 'number'
						? clamp(p.initialSizeMm, 40, 200)
						: defaults.initialSizeMm,
				nameSizeMm:
					typeof p.nameSizeMm === 'number'
						? clamp(p.nameSizeMm, 8, 80)
						: defaults.nameSizeMm,
				letterThicknessMm:
					typeof p.letterThicknessMm === 'number'
						? clamp(p.letterThicknessMm, 5, 60)
						: typeof (p as { letterHeightMm?: number }).letterHeightMm === 'number'
							? clamp((p as { letterHeightMm: number }).letterHeightMm, 5, 60)
							: defaults.letterThicknessMm,
				nameThicknessMm:
					typeof p.nameThicknessMm === 'number'
						? clamp(p.nameThicknessMm, 2, 40)
						: typeof (p as { nameHeightMm?: number }).nameHeightMm === 'number'
							? clamp((p as { nameHeightMm: number }).nameHeightMm, 2, 40)
							: defaults.nameThicknessMm,
				pocketDepthMm:
					typeof p.pocketDepthMm === 'number'
						? clamp(p.pocketDepthMm, 1, 50)
						: defaults.pocketDepthMm,
				toleranceMm:
					typeof p.toleranceMm === 'number'
						? clamp(p.toleranceMm, 0, 1)
						: defaults.toleranceMm,
				nameOffsetXMm:
					typeof p.nameOffsetXMm === 'number'
						? clamp(p.nameOffsetXMm, -50, 50)
						: defaults.nameOffsetXMm,
				nameOffsetYMm:
					typeof p.nameOffsetYMm === 'number'
						? clamp(p.nameOffsetYMm, -50, 50)
						: defaults.nameOffsetYMm,
				initialColor:
					typeof p.initialColor === 'string' ? p.initialColor : defaults.initialColor,
				nameColor: typeof p.nameColor === 'string' ? p.nameColor : defaults.nameColor
			};
		} catch {
			return { ...defaults };
		}
	}

	const initial = loadSettings();
	let nameText = $state(initial.nameText);
	let largeInitialChar = $state(initial.largeInitialChar);
	let initialFontKey = $state(initial.initialFontKey);
	let nameFontKey = $state(initial.nameFontKey);
	let initialSizeMm = $state(initial.initialSizeMm);
	let nameSizeMm = $state(initial.nameSizeMm);
	let letterThicknessMm = $state(initial.letterThicknessMm);
	let nameThicknessMm = $state(initial.nameThicknessMm);
	let pocketDepthMm = $state(initial.pocketDepthMm);
	let toleranceMm = $state(initial.toleranceMm);
	let nameOffsetXMm = $state(initial.nameOffsetXMm);
	let nameOffsetYMm = $state(initial.nameOffsetYMm);
	let initialColor = $state(initial.initialColor);
	let nameColor = $state(initial.nameColor);

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
	let sceneReady = $state(false);
	let exportLoading = $state(false);
	let exportError = $state<string | null>(null);
	let openWithSlicerLoading = $state(false);
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);
	let previewLoading = $state(true);
	let previewReady = $state(false);
	let previewError = $state<string | null>(null);
	let rebuildToken = 0;
	let rebuildTimeoutId: ReturnType<typeof setTimeout> | null = null;

	const effectiveInitial = $derived(effectiveLargeInitial(largeInitialChar, nameText));

	function buildParams(): InitialAndNameParams {
		return paramsFromInputs({
			initialFontKey,
			nameFontKey,
			nameText,
			largeInitialChar,
			initialSizeMm,
			nameSizeMm,
			letterThicknessMm,
			nameThicknessMm,
			pocketDepthMm,
			toleranceMm,
			nameOffsetXMm,
			nameOffsetYMm
		});
	}

	function saveSettings() {
		try {
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({
					nameText,
					largeInitialChar,
					initialFontKey,
					nameFontKey,
					initialSizeMm,
					nameSizeMm,
					letterThicknessMm,
					nameThicknessMm,
					pocketDepthMm,
					toleranceMm,
					nameOffsetXMm,
					nameOffsetYMm,
					initialColor,
					nameColor
				} satisfies Settings)
			);
		} catch {
			// ignore
		}
	}

	function resize() {
		if (!hostEl || !renderer || !camera) return;
		const w = hostEl.clientWidth;
		const h = hostEl.clientHeight;
		if (w < 1 || h < 1) return;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.setSize(w, h, false);
	}

	function clearGroup() {
		if (!group) return;
		for (const child of [...group.children]) {
			group.remove(child);
			const mesh = child as THREE.Mesh;
			mesh.geometry?.dispose();
			const mat = mesh.material;
			if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
			else mat?.dispose();
		}
	}

	async function runPreviewRebuild() {
		if (!scene || !group || !sceneReady) return;
		const token = ++rebuildToken;
		previewLoading = true;
		previewError = null;

		const params = buildParams();
		const initialFont = getFont(initialFontKey);
		const nameFont = getFont(nameFontKey);
		if (!initialFont || !nameFont) {
			previewError = 'Fonts not loaded';
			previewLoading = false;
			return;
		}

		clearGroup();

		const nameGeo = buildNameInsertGeometry(nameFont, params);
		if (nameGeo) {
			const nameMesh = new THREE.Mesh(
				nameGeo,
				new THREE.MeshStandardMaterial({
					color: nameColor,
					roughness: 0.35,
					metalness: 0.1
				})
			);
			nameMesh.name = 'name';
			nameMesh.castShadow = true;
			nameMesh.receiveShadow = true;
			group.add(nameMesh);
		}

		const fallback = buildSolidInitialGeometry(initialFont, params);
		if (fallback) {
			const fallbackMesh = new THREE.Mesh(
				fallback,
				new THREE.MeshStandardMaterial({
					color: initialColor,
					roughness: 0.85,
					metalness: 0.05,
					transparent: true,
					opacity: 0.55
				})
			);
			fallbackMesh.name = 'initial-fallback';
			fallbackMesh.castShadow = true;
			fallbackMesh.receiveShadow = true;
			group.add(fallbackMesh);
		}

		try {
			const pocketed = await buildPocketedInitialGeometry(initialFont, nameFont, params);
			if (token !== rebuildToken) {
				pocketed.dispose();
				return;
			}
			const oldFallback = group.getObjectByName('initial-fallback');
			if (oldFallback) {
				group.remove(oldFallback);
				(oldFallback as THREE.Mesh).geometry.dispose();
				((oldFallback as THREE.Mesh).material as THREE.Material).dispose();
			}
			const initialMesh = new THREE.Mesh(
				pocketed,
				new THREE.MeshStandardMaterial({
					color: initialColor,
					roughness: 0.85,
					metalness: 0.05
				})
			);
			initialMesh.name = 'initial';
			initialMesh.castShadow = true;
			initialMesh.receiveShadow = true;
			group.add(initialMesh);
		} catch (e) {
			if (token === rebuildToken) {
				previewError = e instanceof Error ? e.message : 'Preview build failed';
			}
		}

		if (token !== rebuildToken) return;

		group.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(group);
		if (!didInitFrame && camera && controls) {
			frameCameraToObject(box, camera, controls);
			didInitFrame = true;
		}
		if (keyLight?.shadow?.camera && !box.isEmpty()) {
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
		const size = measureWorldAabbSizeMm(group);
		modelAabbMm = size ? { x: size.x, y: size.y, z: size.z } : null;
		previewLoading = false;
		previewReady = true;
	}

	function queuePreviewRebuild(delayMs = PREVIEW_DEBOUNCE_MS) {
		if (rebuildTimeoutId) clearTimeout(rebuildTimeoutId);
		rebuildTimeoutId = setTimeout(() => {
			rebuildTimeoutId = null;
			void runPreviewRebuild();
		}, delayMs);
	}

	function prepareWorldGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
		let g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
		if (g.getAttribute('uv')) g.deleteAttribute('uv');
		if (!g.getAttribute('normal')) g.computeVertexNormals();
		if (g.index) {
			const nonIndexed = g.toNonIndexed();
			g.dispose();
			g = nonIndexed;
		}
		return g;
	}

	async function buildExportMeshes(): Promise<THREE.Mesh[]> {
		const params = buildParams();
		const initialFont = getFont(initialFontKey);
		const nameFont = getFont(nameFontKey);
		if (!initialFont || !nameFont) throw new Error('Fonts not loaded');

		const initialGeo = await buildPocketedInitialGeometry(initialFont, nameFont, params);
		const nameGeo = buildNameInsertGeometryStandalone(nameFont, params);
		if (!nameGeo) {
			initialGeo.dispose();
			throw new Error('Name geometry empty');
		}

		const initialMesh = new THREE.Mesh(
			initialGeo,
			new THREE.MeshStandardMaterial({ color: initialColor })
		);
		initialMesh.name = 'initial';
		const nameMesh = new THREE.Mesh(
			nameGeo,
			new THREE.MeshStandardMaterial({ color: nameColor })
		);
		nameMesh.name = 'name';
		initialMesh.updateMatrixWorld(true);
		nameMesh.updateMatrixWorld(true);
		return [initialMesh, nameMesh];
	}

	const EXPORT_PART_GAP_MM = 10;

	function flipMeshFaceDown(mesh: THREE.Mesh) {
		mesh.rotateX(Math.PI);
		mesh.updateMatrixWorld(true);
	}

	function snapMeshBottomToBuildPlate(mesh: THREE.Mesh) {
		mesh.updateMatrixWorld(true);
		const box = new THREE.Box3().setFromObject(mesh);
		if (!box.isEmpty() && Number.isFinite(box.min.z)) {
			mesh.position.z -= box.min.z;
			mesh.updateMatrixWorld(true);
		}
	}

	async function buildExportMeshesForSeparatedPrinting(): Promise<THREE.Mesh[]> {
		const meshes = await buildExportMeshes();
		const initialMesh = meshes.find((m) => m.name === 'initial');
		const nameMesh = meshes.find((m) => m.name === 'name');
		if (!initialMesh || !nameMesh) throw new Error('Export meshes missing parts');

		flipMeshFaceDown(initialMesh);
		flipMeshFaceDown(nameMesh);
		snapMeshBottomToBuildPlate(initialMesh);
		snapMeshBottomToBuildPlate(nameMesh);

		const initBox = new THREE.Box3().setFromObject(initialMesh);
		const nameBox = new THREE.Box3().setFromObject(nameMesh);
		nameMesh.position.x += initBox.max.x + EXPORT_PART_GAP_MM - nameBox.min.x;
		const initCenterY = (initBox.min.y + initBox.max.y) / 2;
		const nameCenterY = (nameBox.min.y + nameBox.max.y) / 2;
		nameMesh.position.y += initCenterY - nameCenterY;

		snapMeshBottomToBuildPlate(initialMesh);
		snapMeshBottomToBuildPlate(nameMesh);

		return [initialMesh, nameMesh];
	}

	/**
	 * Scene root (not Group): three-3mf-exporter yields one build item per direct mesh child.
	 */
	function buildMultipartExportScene(meshes: THREE.Mesh[]): THREE.Scene {
		const exportRoot = new THREE.Scene();
		exportRoot.name = 'initial-and-name-3mf-export';
		for (const mesh of meshes) {
			const g = prepareWorldGeometry(mesh);
			const exportMesh = new THREE.Mesh(
				g,
				new THREE.MeshBasicMaterial({
					color: new THREE.Color(mesh.name === 'initial' ? initialColor : nameColor)
				})
			);
			exportMesh.name = mesh.name;
			exportRoot.add(exportMesh);
			mesh.geometry.dispose();
		}
		return exportRoot;
	}

	async function runBackgroundExport(fn: () => Promise<void>) {
		exportLoading = true;
		exportError = null;
		await tickThenYieldToPaint();
		try {
			await fn();
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exportLoading = false;
		}
	}

	async function exportSTL() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		await runBackgroundExport(async () => {
			const meshes = await buildExportMeshesForSeparatedPrinting();
			const exporter = new STLExporter();
			const ts = Date.now();
			const safe = (nameText || 'name').replace(/[^\w.-]+/g, '_').slice(0, 40);
			let didExport = false;
			for (const mesh of meshes) {
				const geo = prepareWorldGeometry(mesh);
				const welded = BufferGeometryUtils.mergeVertices(geo, 1e-5);
				if (welded !== geo) geo.dispose();
				const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
				welded.dispose();
				mesh.geometry.dispose();
				const buffer = result instanceof DataView ? result.buffer : result;
				if (!buffer || (buffer as ArrayBuffer).byteLength < 84) continue;
				downloadBlob(
					`${safe}-${SLUG}-${mesh.name}-${ts}.stl`,
					new Blob([buffer], { type: 'model/stl' })
				);
				didExport = true;
				await new Promise((r) => setTimeout(r, 200));
			}
			if (!didExport) throw new Error('Export produced empty geometry');
			notifyExportEvent({
				email: user?.email,
				name: user?.user_metadata?.full_name as string | undefined,
				subscriptionStatus,
				designName: DESIGN_NAME,
				designerId: 'monogramInsert',
				format: 'stl'
			});
			onShowThankYou();
		});
	}

	async function export3MF() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		await runBackgroundExport(async () => {
			const meshes = await buildExportMeshesForSeparatedPrinting();
			const exportRoot = buildMultipartExportScene(meshes);
			const blob = await exportTo3MF(exportRoot);
			disposeObject3D(exportRoot);
			const ts = Date.now();
			const safe = (nameText || 'name').replace(/[^\w.-]+/g, '_').slice(0, 40);
			downloadBlob(`${safe}-${SLUG}-multipart-${ts}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name: user?.user_metadata?.full_name as string | undefined,
				subscriptionStatus,
				designName: DESIGN_NAME,
				designerId: 'monogramInsert',
				format: '3mf'
			});
			onShowThankYou();
		});
	}

	async function openWithSlicer(slicer: OpenWithSlicerId) {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		openWithSlicerLoading = true;
		exportError = null;
		await tickThenYieldToPaint();
		try {
			const meshes = await buildExportMeshesForSeparatedPrinting();
			const exportRoot = buildMultipartExportScene(meshes);
			const blob = await exportTo3MF(exportRoot);
			disposeObject3D(exportRoot);
			const publicUrl = await upload3mfToSupabase(blob, SLUG);
			openInSlicer(publicUrl, slicer);
			notifyExportEvent({
				email: user?.email,
				name: user?.user_metadata?.full_name as string | undefined,
				subscriptionStatus,
				designName: DESIGN_NAME,
				designerId: 'monogramInsert',
				format: 'bambu_studio'
			});
			onShowThankYou();
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Bambu export failed';
		} finally {
			openWithSlicerLoading = false;
		}
	}

	onMount(() => {
		if (!hostEl) return;

		scene = new THREE.Scene();
		scene.background = new THREE.Color(0xffffff);
		camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
		camera.up.set(0, 0, 1);

		renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
		renderer.setPixelRatio(Math.max(1, window.devicePixelRatio || 1));
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		hostEl.appendChild(renderer.domElement);
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';

		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;

		const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.25);
		scene.add(hemi);
		keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
		keyLight.position.set(80, -120, 140);
		keyLight.castShadow = true;
		keyLight.shadow.mapSize.width = 2048;
		keyLight.shadow.mapSize.height = 2048;
		scene.add(keyLight);
		scene.add(keyLight.target);

		const rim = new THREE.DirectionalLight(0xffffff, 0.7);
		rim.position.set(-60, 80, 60);
		scene.add(rim);

		const grid = new THREE.GridHelper(400, 40, 0xe2e8f0, 0xf1f5f9);
		grid.rotation.x = Math.PI / 2;
		grid.position.z = -0.01;
		scene.add(grid);

		const shadowPlane = new THREE.Mesh(
			new THREE.PlaneGeometry(800, 800),
			new THREE.ShadowMaterial({ opacity: 0.12 })
		);
		shadowPlane.receiveShadow = true;
		shadowPlane.position.z = -0.015;
		scene.add(shadowPlane);

		group = new THREE.Group();
		scene.add(group);

		getFont(initialFontKey);
		getFont(nameFontKey);
		sceneReady = true;
		queuePreviewRebuild(0);

		const scheduleOpenScadWarmup = () => void warmupOpenScadWorker();
		if (typeof requestIdleCallback !== 'undefined') {
			requestIdleCallback(scheduleOpenScadWarmup, { timeout: 8000 });
		} else {
			setTimeout(scheduleOpenScadWarmup, 500);
		}

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
		if (rebuildTimeoutId) clearTimeout(rebuildTimeoutId);
		cancelAnimationFrame(rafId);
		if (group) clearGroup();
		disposeObject3D(scene);
		renderer?.dispose();
	});

	$effect(() => {
		void nameText;
		void largeInitialChar;
		void initialFontKey;
		void nameFontKey;
		void initialSizeMm;
		void nameSizeMm;
		void letterThicknessMm;
		void nameThicknessMm;
		void pocketDepthMm;
		void toleranceMm;
		void nameOffsetXMm;
		void nameOffsetYMm;
		void initialColor;
		void nameColor;
		saveSettings();
		if (sceneReady) queuePreviewRebuild();
	});
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
	<div class="mx-auto flex h-full w-full max-w-[1600px] min-h-0 flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full max-w-[360px] min-w-[320px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">{DESIGN_NAME}</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto p-4 pt-0">
			<div class="grid gap-3">
				<label class="grid gap-1">
					<span class="text-xs font-semibold text-slate-700">Name</span>
					<input
						class="rounded-lg border border-slate-200 px-3 py-2 text-sm"
						bind:value={nameText}
						placeholder="Name"
					/>
				</label>
				<label class="grid gap-1">
					<span class="text-xs font-semibold text-slate-700">Initial letter (optional)</span>
					<input
						class="rounded-lg border border-slate-200 px-3 py-2 text-sm uppercase"
						bind:value={largeInitialChar}
						maxlength="1"
						placeholder={effectiveInitial}
					/>
					<span class="text-[11px] text-slate-500">Using: {effectiveInitial}</span>
				</label>
			</div>

			<div class="grid gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
				<span class="text-xs font-semibold text-slate-700">Initial font</span>
				<FontSelect bind:value={initialFontKey} />
				<label class="grid gap-1.5">
					<div class="flex justify-between text-xs">
						<span class="font-medium text-slate-700">Initial size (mm)</span>
						<span class="tabular-nums text-slate-600">{initialSizeMm}</span>
					</div>
					<Slider type="single" bind:value={initialSizeMm} min={40} max={200} step={1} />
				</label>
				<label class="grid gap-1.5">
					<div class="flex justify-between text-xs">
						<span class="font-medium text-slate-700">Letter thickness (mm)</span>
						<span class="tabular-nums text-slate-600">{letterThicknessMm}</span>
					</div>
					<Slider type="single" bind:value={letterThicknessMm} min={5} max={60} step={0.5} />
				</label>
				<ColorPalettePicker {palette} bind:value={initialColor} label="Initial color" />
			</div>

			<div class="grid gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
				<span class="text-xs font-semibold text-slate-700">Name font</span>
				<FontSelect bind:value={nameFontKey} />
				<label class="grid gap-1.5">
					<div class="flex justify-between text-xs">
						<span class="font-medium text-slate-700">Name size (mm)</span>
						<span class="tabular-nums text-slate-600">{nameSizeMm}</span>
					</div>
					<Slider type="single" bind:value={nameSizeMm} min={8} max={80} step={0.5} />
				</label>
				<label class="grid gap-1.5">
					<div class="flex justify-between text-xs">
						<span class="font-medium text-slate-700">Name thickness (mm)</span>
						<span class="tabular-nums text-slate-600">{nameThicknessMm}</span>
					</div>
					<Slider type="single" bind:value={nameThicknessMm} min={2} max={40} step={0.5} />
				</label>
				<div class="grid grid-cols-2 gap-3">
					<label class="grid gap-1.5">
						<div class="flex justify-between text-xs">
							<span class="font-medium text-slate-700">Text pos X</span>
							<span class="tabular-nums text-slate-600">{nameOffsetXMm}</span>
						</div>
						<Slider type="single" bind:value={nameOffsetXMm} min={-50} max={50} step={0.5} />
					</label>
					<label class="grid gap-1.5">
						<div class="flex justify-between text-xs">
							<span class="font-medium text-slate-700">Text pos Y</span>
							<span class="tabular-nums text-slate-600">{nameOffsetYMm}</span>
						</div>
						<Slider type="single" bind:value={nameOffsetYMm} min={-50} max={50} step={0.5} />
					</label>
				</div>
				<ColorPalettePicker {palette} bind:value={nameColor} label="Name color" />
			</div>

			<div class="grid gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
				<span class="text-xs font-semibold text-slate-700">Pocket fit</span>
				<label class="grid gap-1.5">
					<div class="flex justify-between text-xs">
						<span class="font-medium text-slate-700">Pocket depth (mm)</span>
						<span class="tabular-nums text-slate-600">{pocketDepthMm}</span>
					</div>
					<Slider type="single" bind:value={pocketDepthMm} min={1} max={50} step={0.5} />
				</label>
				<label class="grid gap-1.5">
					<div class="flex justify-between text-xs">
						<span class="font-medium text-slate-700">Clearance / tolerance (mm)</span>
						<span class="tabular-nums text-slate-600">{toleranceMm}</span>
					</div>
					<Slider type="single" bind:value={toleranceMm} min={0} max={1} step={0.02} />
				</label>
			</div>

			{#if previewError}
				<p class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
					{previewError}
				</p>
			{/if}
			</div>
		</aside>

		<section
			class="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<DesignerModelDimensionsHud sizes={modelAabbMm} />
			<div bind:this={hostEl} class="absolute inset-0 bg-white"></div>
			{#if !sceneReady || (previewLoading && !previewReady)}
				<div
					class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white"
					aria-busy="true"
					aria-live="polite"
				>
					<div
						class="h-10 w-10 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600"
						aria-hidden="true"
					></div>
					<p class="text-sm font-medium text-slate-600">Building preview…</p>
				</div>
			{:else if previewLoading}
				<div
					class="pointer-events-none absolute inset-x-4 top-4 z-10 rounded-lg border border-slate-200 bg-white/90 px-3 py-2 text-xs text-slate-600 shadow-sm"
				>
					Updating preview…
				</div>
			{/if}
			<div class="absolute bottom-4 right-4">
				<DesignerExportToolbar
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, SLUG)}
					onExport={() => exportSTL()}
					onExport3MF={() => export3MF()}
					onOpenWithSlicer={openWithSlicer}
					{openWithSlicerLoading}
					exportDisabled={exportLoading || previewLoading}
					exportTitle={getExportTitle(
						user,
						subscriptionStatus,
						'Export STL or 3MF (multipart) for 3D print'
					)}
					{exportLoading}
					showLockIcon={showExportLockIcon(user, subscriptionStatus)}
				/>
				{#if exportError}
					<p
						class="absolute bottom-14 right-4 max-w-[220px] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-lg"
					>
						{exportError}
					</p>
				{/if}
			</div>
		</section>
	</div>
</main>
