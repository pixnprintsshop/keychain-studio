<script lang="ts">
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import baseSvgRaw from '$lib/assets/svg/pickleball/base.svg?raw';
	import decorSvgRaw from '$lib/assets/svg/pickleball/decor.svg?raw';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import { notifyExportEvent } from '$lib/exportNotify';
	import {
		DEFAULT_PICKLEBALL_ICON_ID,
		iconifySvgUrl,
		PICKLEBALL_KEYCHAIN_ICONS
	} from '$lib/pickleball-keychain-icons';
	import { ensureExportAccess, getExportTitle, type SubscriptionStatus } from '$lib/subscription';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import {
		buildExtrudedLayerFromSvg,
		buildIconGeometryFromSvg,
		iconOffsetFromWorld,
		iconOffsetToWorld,
		preparePickleballUnitGeometries,
		scaleGeometryToDepth
	} from '$lib/utils-pickleball-keychain';
	import {
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		frameCameraToObject,
		makeKeyringGeometry,
		measureWorldAabbSizeMm
	} from '$lib/utils-3d';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import PickleballIconPickerDialog from './PickleballIconPickerDialog.svelte';
	import type { PaletteColor } from '$lib/colorPalette';

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

	const STORAGE_KEY = 'pickleball-keychain-settings-v2';
	const LEGACY_STORAGE_KEY = 'pickleball-keychain-settings';
	/** Vertical gap between stacked layers so faces do not touch (avoids coplanar / non-manifold). */
	const LAYER_GAP = 0.001;
	const DESIGN_NAME = 'Pickleball keychain';
	/** Overall scale 1.0 → this silhouette height (mm); default scale targets 50 mm. */
	const HEIGHT_AT_SCALE_1_MM = 55;
	const DEFAULT_OVERALL_SCALE = 50 / HEIGHT_AT_SCALE_1_MM;
	const KEYRING_OUTER_SIZE_MM = 8;
	const KEYRING_HOLE_SIZE_MM = 4;
	const KEYRING_OFFSET_X_MM = 31;
	const KEYRING_OFFSET_Y_MM = 2;

	interface PickleballSettings {
		baseDepth: number;
		baseColor: string;
		decorDepth: number;
		decorColor: string;
		overallScale: number;
		iconId: string;
		iconOffsetX: number;
		iconOffsetY: number;
		iconScale: number;
		iconRotationDeg: number;
	}

	const defaults: PickleballSettings = {
		baseDepth: 1.4,
		baseColor: '#ffffff',
		decorDepth: 1.0,
		decorColor: '#ec4899',
		overallScale: DEFAULT_OVERALL_SCALE,
		iconId: DEFAULT_PICKLEBALL_ICON_ID,
		// Paddle-aligned offsets (same visual spot as former world-space 5, 6.5)
		iconOffsetX: -1.1,
		iconOffsetY: 6.5,
		iconScale: 1,
		iconRotationDeg: -45
	};

	function loadSettings(): PickleballSettings {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw) as Partial<PickleballSettings>;
				if (parsed && typeof parsed === 'object') {
					const iconId =
						parsed.iconId &&
						PICKLEBALL_KEYCHAIN_ICONS.some((i) => i.id === parsed.iconId)
							? parsed.iconId
							: defaults.iconId;
					return { ...defaults, ...parsed, iconId };
				}
			}
			const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
			if (legacyRaw) {
				const parsed = JSON.parse(legacyRaw) as Partial<PickleballSettings>;
				if (parsed && typeof parsed === 'object') {
					const iconId =
						parsed.iconId &&
						PICKLEBALL_KEYCHAIN_ICONS.some((i) => i.id === parsed.iconId)
							? parsed.iconId
							: defaults.iconId;
					const legacyOx = parsed.iconOffsetX ?? defaults.iconOffsetX;
					const legacyOy = parsed.iconOffsetY ?? defaults.iconOffsetY;
					const aligned = iconOffsetFromWorld(legacyOx, legacyOy);
					return {
						...defaults,
						...parsed,
						iconId,
						iconOffsetX: aligned.x,
						iconOffsetY: aligned.y
					};
				}
			}
		} catch {
			// ignore corrupt storage
		}
		return { ...defaults };
	}

	const initial = loadSettings();

	let baseDepth = $state(initial.baseDepth);
	let baseColor = $state(initial.baseColor);
	let decorDepth = $state(initial.decorDepth);
	let decorColor = $state(initial.decorColor);
	let overallScale = $state(initial.overallScale);
	let iconId = $state(initial.iconId);
	let iconOffsetX = $state(initial.iconOffsetX);
	let iconOffsetY = $state(initial.iconOffsetY);
	let iconScale = $state(initial.iconScale);
	let iconRotationDeg = $state(initial.iconRotationDeg);

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

	let baseGeometryUnit: THREE.BufferGeometry | null = null;
	let decorGeometryUnit: THREE.BufferGeometry | null = null;
	let nativeHeightMm = $state(HEIGHT_AT_SCALE_1_MM);
	let modelLoadError = $state<string | null>(null);
	let modelReady = $state(false);
	let iconSvgRaw = $state<string | null>(null);
	let iconLoadError = $state<string | null>(null);
	let iconLoading = $state(false);

	let exportError = $state<string | null>(null);
	let exportLoading = $state(false);
	let openBambuStudioLoading = $state(false);

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
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({
					baseDepth,
					baseColor,
					decorDepth,
					decorColor,
					overallScale,
					iconId,
					iconOffsetX,
					iconOffsetY,
					iconScale,
					iconRotationDeg
				} satisfies PickleballSettings)
			);
		} catch {
			// storage unavailable
		}
	}

	async function loadIconSvg(id: string) {
		iconLoading = true;
		iconLoadError = null;
		try {
			const res = await fetch(iconifySvgUrl(id));
			if (!res.ok) throw new Error(`Icon fetch failed (${res.status})`);
			iconSvgRaw = await res.text();
		} catch (e) {
			iconSvgRaw = null;
			iconLoadError = e instanceof Error ? e.message : 'Could not load icon';
		} finally {
			iconLoading = false;
		}
	}

	function rebuildMeshes() {
		if (!scene || !group || !baseGeometryUnit || !decorGeometryUnit) {
			modelAabbMm = null;
			return;
		}

		disposeObject3D(group);
		group.clear();
		group.position.set(0, 0, 0);
		group.scale.set(1, 1, 1);
		modelAabbMm = null;

		const baseD = Math.max(0.05, baseDepth);
		const decorD = Math.max(0.05, decorDepth);
		const baseTopZ = baseD;
		/** Decor sits above the base with a gap — not embedded into the paddle. */
		const decorLayerZ = baseTopZ + LAYER_GAP;

		const baseGeo = scaleGeometryToDepth(baseGeometryUnit, baseD);
		const baseMat = new THREE.MeshStandardMaterial({
			color: baseColor,
			roughness: 0.85,
			metalness: 0.05
		});
		const baseMesh = new THREE.Mesh(baseGeo, baseMat);
		baseMesh.name = 'base';
		baseMesh.castShadow = true;
		baseMesh.receiveShadow = true;
		baseMesh.position.z = 0;
		group.add(baseMesh);

		const decorGeo = scaleGeometryToDepth(decorGeometryUnit, decorD);
		const decorMat = new THREE.MeshStandardMaterial({
			color: decorColor,
			roughness: 0.35,
			metalness: 0.1
		});
		const decorMesh = new THREE.Mesh(decorGeo, decorMat);
		decorMesh.name = 'decor';
		decorMesh.castShadow = true;
		decorMesh.receiveShadow = true;
		decorMesh.position.z = decorLayerZ;
		group.add(decorMesh);

		baseGeo.computeBoundingBox();
		const baseBb = baseGeo.boundingBox;

		if (iconSvgRaw && baseBb) {
			const baseWidth = baseBb.max.x - baseBb.min.x;
			const iconTargetWidth = baseWidth * 0.28 * Math.max(0.1, iconScale);
			const iconGeo = buildIconGeometryFromSvg(iconSvgRaw, iconTargetWidth, decorD);
			if (iconGeo) {
				const iconMat = new THREE.MeshStandardMaterial({
					color: decorColor,
					roughness: 0.35,
					metalness: 0.1,
					polygonOffset: true,
					polygonOffsetFactor: -1,
					polygonOffsetUnits: -1
				});
				const iconMesh = new THREE.Mesh(iconGeo, iconMat);
				iconMesh.name = 'icon';
				iconMesh.castShadow = true;
				iconMesh.receiveShadow = true;
				const iconPos = iconOffsetToWorld(iconOffsetX, iconOffsetY);
				/** Icon shares the decor layer plane (paddle face), not stacked above the ornament. */
				iconMesh.position.set(iconPos.x, iconPos.y, decorLayerZ);
				iconMesh.rotation.z = (iconRotationDeg * Math.PI) / 180;
				group.add(iconMesh);
			}
		}

		if (baseBb) {
			const ringGeo = makeKeyringGeometry(
				KEYRING_OUTER_SIZE_MM,
				Math.max(0.1, Math.min(KEYRING_HOLE_SIZE_MM, KEYRING_OUTER_SIZE_MM - 0.5)),
				Math.max(0.1, baseD)
			);
			const ringMat = new THREE.MeshStandardMaterial({
				color: baseColor,
				roughness: 0.85,
				metalness: 0.05
			});
			const ringMesh = new THREE.Mesh(ringGeo, ringMat);
			ringMesh.name = 'keyring';
			ringMesh.castShadow = true;
			ringMesh.receiveShadow = true;
			ringMesh.position.set(
				baseBb.min.x + KEYRING_OFFSET_X_MM,
				baseBb.max.y + KEYRING_OFFSET_Y_MM,
				0
			);
			group.add(ringMesh);
		}

		const heightNormalize = HEIGHT_AT_SCALE_1_MM / Math.max(1e-6, nativeHeightMm);
		const xyScale = heightNormalize * Math.max(0.2, overallScale);
		group.scale.set(xyScale, xyScale, 1);

		group.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(group);
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
			keyLight.target.updateWorldMatrix?.(true, true);
		}
		if (!didInitFrame && camera && controls) {
			frameCameraToObject(box, camera, controls);
			didInitFrame = true;
		}
		const s = measureWorldAabbSizeMm(group);
		modelAabbMm = s ? { x: s.x, y: s.y, z: s.z } : null;
	}

	function collectExportMeshes(): THREE.Mesh[] {
		if (!modelReady || !group || !baseGeometryUnit || !decorGeometryUnit) return [];
		if (group.children.length === 0) rebuildMeshes();
		const out: THREE.Mesh[] = [];
		for (const child of group.children) {
			if (child instanceof THREE.Mesh) out.push(child);
		}
		return out;
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

	function mergeExportMeshes(meshes: THREE.Mesh[]): THREE.BufferGeometry | null {
		if (meshes.length === 0) return null;
		const geometries = meshes.map(prepareWorldGeometry);
		const merged =
			geometries.length === 1
				? geometries[0]
				: BufferGeometryUtils.mergeGeometries(geometries);
		if (!merged) {
			geometries.forEach((g) => g.dispose());
			return null;
		}
		if (geometries.length > 1) geometries.forEach((g) => g !== merged && g.dispose());
		const welded = BufferGeometryUtils.mergeVertices(merged, 1e-3);
		if (welded !== merged) merged.dispose();
		return welded;
	}

	function meshesByName(meshes: THREE.Mesh[]): Record<string, THREE.Mesh> {
		const byName: Record<string, THREE.Mesh> = {};
		for (const mesh of meshes) {
			if (mesh.name) byName[mesh.name] = mesh;
		}
		return byName;
	}

	function buildMultipartExportGroup(meshes: THREE.Mesh[]): THREE.Group | null {
		const byName = meshesByName(meshes);
		const exportGroup = new THREE.Group();
		const baseMeshes = [byName.base, byName.keyring].filter(Boolean) as THREE.Mesh[];
		const baseGeo = mergeExportMeshes(baseMeshes);
		if (baseGeo) {
			exportGroup.add(
				new THREE.Mesh(
					baseGeo,
					new THREE.MeshBasicMaterial({ color: new THREE.Color(baseColor) })
				)
			);
		}
		const decorMeshes = [byName.decor, byName.icon].filter(Boolean) as THREE.Mesh[];
		const decorGeo = mergeExportMeshes(decorMeshes);
		if (decorGeo) {
			exportGroup.add(
				new THREE.Mesh(
					decorGeo,
					new THREE.MeshBasicMaterial({ color: new THREE.Color(decorColor) })
				)
			);
		}
		return exportGroup.children.length > 0 ? exportGroup : null;
	}

	async function exportSTL() {
		if (modelLoadError) {
			exportError = modelLoadError;
			return;
		}
		if (!modelReady) {
			exportError = 'Model is still loading';
			return;
		}
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		const meshes = collectExportMeshes();
		if (meshes.length === 0) {
			exportError = 'Nothing to export';
			return;
		}
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		try {
			group?.updateWorldMatrix(true, true);
			const welded = mergeExportMeshes(collectExportMeshes());
			if (!welded) {
				exportError = 'Failed to merge geometry';
				return;
			}

			const exporter = new STLExporter();
			const result = exporter.parse(new THREE.Mesh(welded), { binary: true });
			welded.dispose();
			const buffer = (result as DataView).buffer as ArrayBuffer;
			if (!buffer || buffer.byteLength < 84) {
				exportError = 'Export produced empty geometry';
				return;
			}
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`pickleball-keychain-${ts}.stl`, new Blob([buffer], { type: 'model/stl' }));
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
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
		if (modelLoadError) {
			exportError = modelLoadError;
			return;
		}
		if (!modelReady) {
			exportError = 'Model is still loading';
			return;
		}
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		const meshes = collectExportMeshes();
		if (meshes.length === 0) {
			exportError = 'Nothing to export';
			return;
		}
		exportError = null;
		exportLoading = true;
		await tickThenYieldToPaint();
		let exportGroup: THREE.Group | null = null;
		try {
			group?.updateWorldMatrix(true, true);
			exportGroup = buildMultipartExportGroup(collectExportMeshes());
			if (!exportGroup) {
				exportError = 'Failed to merge geometry';
				return;
			}
			exportGroup.updateWorldMatrix(true, true);
			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) {
				exportError = '3MF export produced no data';
				return;
			}
			const ts = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`pickleball-keychain-${ts}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				format: '3mf'
			});
			onShowThankYou();
		} catch (e) {
			exportError = e instanceof Error ? e.message : '3MF export failed';
		} finally {
			if (exportGroup) disposeObject3D(exportGroup);
			exportLoading = false;
		}
	}

	async function openWithBambuStudio() {
		if (!modelReady || modelLoadError) return;
		const meshes = collectExportMeshes();
		if (meshes.length === 0) return;
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		openBambuStudioLoading = true;
		await tickThenYieldToPaint();
		let exportGroup: THREE.Group | null = null;
		try {
			group?.updateWorldMatrix(true, true);
			exportGroup = buildMultipartExportGroup(collectExportMeshes());
			if (!exportGroup) return;
			exportGroup.updateWorldMatrix(true, true);
			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'pickleball-keychain');
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ??
					(user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: DESIGN_NAME,
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (err) {
			console.error('Open with Bambu Studio failed:', err);
		} finally {
			if (exportGroup) disposeObject3D(exportGroup);
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
		controls.maxDistance = 500;
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

		try {
			const baseSrc = buildExtrudedLayerFromSvg(baseSvgRaw);
			const decorSrc = buildExtrudedLayerFromSvg(decorSvgRaw);
			if (!baseSrc || !decorSrc) {
				throw new Error('Could not extrude pickleball SVG layers');
			}
			const prepared = preparePickleballUnitGeometries(
				baseSrc,
				decorSrc,
				HEIGHT_AT_SCALE_1_MM
			);
			baseSrc.dispose();
			decorSrc.dispose();
			baseGeometryUnit = prepared.baseUnit;
			decorGeometryUnit = prepared.decorUnit;
			nativeHeightMm = prepared.nativeHeightMm;
			modelReady = true;
			modelLoadError = null;
			rebuildMeshes();
		} catch (e) {
			modelLoadError = e instanceof Error ? e.message : 'Failed to prepare pickleball geometry';
		}

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

	$effect(() => {
		void baseDepth;
		void baseColor;
		void decorDepth;
		void decorColor;
		void overallScale;
		void iconId;
		void iconOffsetX;
		void iconOffsetY;
		void iconScale;
		void iconRotationDeg;
		saveSettings();
	});

	$effect(() => {
		const id = iconId;
		void loadIconSvg(id);
	});

	$effect(() => {
		void baseDepth;
		void baseColor;
		void decorDepth;
		void decorColor;
		void overallScale;
		void iconId;
		void iconSvgRaw;
		void iconOffsetX;
		void iconOffsetY;
		void iconScale;
		void iconRotationDeg;
		if (!scene || !group || !modelReady) return;
		rebuildMeshes();
	});

	onDestroy(() => {
		cancelAnimationFrame(rafId);
		rafId = 0;
		ro?.disconnect();
		ro = null;
		if (group) disposeObject3D(group);
		baseGeometryUnit?.dispose();
		decorGeometryUnit?.dispose();
		baseGeometryUnit = null;
		decorGeometryUnit = null;
		if (scene) disposeObject3D(scene);
		renderer?.dispose();
		if (renderer?.domElement?.parentElement) {
			renderer.domElement.parentElement.removeChild(renderer.domElement);
		}
	});
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
	<div class="mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full min-w-0 max-w-[360px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] lg:min-w-[320px]">
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Pickleball keychain</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
				<div class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="text-xs font-semibold tracking-tight text-slate-700">Icon</div>
					<PickleballIconPickerDialog bind:value={iconId} previewColor={decorColor} />
					{#if iconLoading}
						<p class="text-[11px] text-slate-500">Loading icon…</p>
					{:else if iconLoadError}
						<p class="text-[11px] text-red-600">{iconLoadError}</p>
					{/if}
					<p class="text-[11px] text-slate-500">Along ↖↘ and across ↗↙ the paddle face.</p>
					<label class="grid gap-1.5">
						<div class="grid grid-cols-[1fr_3.25rem] items-baseline gap-2">
							<span class="text-xs font-medium text-slate-700">Along ↖↘</span>
							<span class="text-right text-xs tabular-nums text-slate-600">
								{iconOffsetX.toFixed(1)}
							</span>
						</div>
						<Slider
							type="single"
							bind:value={iconOffsetX}
							min={-60}
							max={60}
							step={0.1}
							class="w-full" />
					</label>
					<label class="grid gap-1.5">
						<div class="grid grid-cols-[1fr_3.25rem] items-baseline gap-2">
							<span class="text-xs font-medium text-slate-700">Across ↗↙</span>
							<span class="text-right text-xs tabular-nums text-slate-600">
								{iconOffsetY.toFixed(1)}
							</span>
						</div>
						<Slider
							type="single"
							bind:value={iconOffsetY}
							min={-60}
							max={60}
							step={0.1}
							class="w-full" />
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Icon scale</span>
							<span class="text-xs tabular-nums text-slate-600">{iconScale.toFixed(2)}×</span>
						</div>
						<Slider
							type="single"
							bind:value={iconScale}
							min={0.25}
							max={2}
							step={0.05}
							class="w-full" />
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Icon rotation</span>
							<span class="text-xs tabular-nums text-slate-600">{iconRotationDeg}°</span>
						</div>
						<Slider
							type="single"
							bind:value={iconRotationDeg}
							min={-180}
							max={180}
							step={1}
							class="w-full" />
					</label>
				</div>

				<div class="grid grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<div class="text-xs font-semibold tracking-tight text-slate-700">Base</div>
					<ColorPalettePicker bind:value={baseColor} {palette} label="Base color" />
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Base thickness</span>
							<span class="text-xs tabular-nums text-slate-600">{baseDepth}</span>
						</div>
						<Slider
							type="single"
							bind:value={baseDepth}
							min={0.4}
							max={4}
							step={0.1}
							class="w-full" />
					</label>

					<div class="mt-1 border-t border-slate-200 pt-2 text-xs font-semibold text-slate-700">
						Decor &amp; icon
					</div>
					<ColorPalettePicker bind:value={decorColor} {palette} label="Decor color" />
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Decor thickness</span>
							<span class="text-xs tabular-nums text-slate-600">{decorDepth}</span>
						</div>
						<Slider
							type="single"
							bind:value={decorDepth}
							min={0.4}
							max={4}
							step={0.1}
							class="w-full" />
					</label>

					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Overall scale</span>
							<span class="text-xs tabular-nums text-slate-600">
								{(overallScale * HEIGHT_AT_SCALE_1_MM).toFixed(1)} mm
								<span class="text-slate-400">({overallScale.toFixed(2)}×)</span>
							</span>
						</div>
						<Slider
							type="single"
							bind:value={overallScale}
							min={0.5}
							max={1.5}
							step={0.01}
							class="w-full" />
						<p class="text-[11px] text-slate-500">1.00× = {HEIGHT_AT_SCALE_1_MM} mm height</p>
					</label>
				</div>
			</div>
		</aside>

		<section
			class="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]">
			<DesignerModelDimensionsHud sizes={modelAabbMm} />
			<div bind:this={hostEl} class="absolute inset-0"></div>
			{#if modelLoadError}
				<div
					class="pointer-events-none absolute inset-x-4 top-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-sm">
					{modelLoadError}
				</div>
			{/if}
			<div class="absolute bottom-4 right-4 flex items-center gap-2">
				<DesignerExportToolbar
					onSnapshot={() => {
						if (renderer && scene && camera)
							downloadSnapshot(renderer, scene, camera, 'pickleball-keychain');
					}}
					onExport={() => exportSTL()}
					onExport3MF={() => export3MF()}
					onOpenWithBambuStudio={() => openWithBambuStudio()}
					{openBambuStudioLoading}
					exportDisabled={!modelReady || !!modelLoadError}
					exportTitle={getExportTitle(user, subscriptionStatus, 'Export STL or 3MF')}
					{exportLoading}
					showLockIcon={!user || !subscriptionStatus?.isActive} />
				{#if exportError}
					<p
						class="max-w-[200px] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-lg">
						{exportError}
					</p>
				{/if}
			</div>
		</section>
	</div>
</main>
