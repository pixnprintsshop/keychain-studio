<script lang="ts">
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import articulatedStartStlUrl from '$lib/assets/stl/articulated/start.stl?url';
	import articulatedMidStlUrl from '$lib/assets/stl/articulated/mid.stl?url';
	import articulatedEndStlUrl from '$lib/assets/stl/articulated/end.stl?url';
	import articulatedKeyringStlUrl from '$lib/assets/stl/articulated/keyring.stl?url';
	import FontSelect from '$lib/components/FontSelect.svelte';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import type { PaletteColor } from '$lib/colorPalette';
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
	import { ensureExportAccess, getExportTitle, showExportLockIcon, type SubscriptionStatus } from '$lib/subscription';
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

	type SegmentKind = 'start' | 'mid' | 'end';

	const BASE_REPEAT_OFFSET = { x: -4, y: 0, z: 0 };
	const CHAR_POSITION_OFFSET = { x: -2.3, y: 0, z: 0 };
	const END_BASE_OFFSET = { x: 0, y: 0, z: 0 };
	const KEYRING_OFFSET = { x: -39.7, y: 0, z: -1.9 };
	const KEYRING_MESH_NAME = 'articulated-keyring';

	const ARTICULATED_FONT_KEYS = new Set([
		'Titan One_Regular',
		'Showpop_Regular',
		'Kindergo_Regular',
		'Milkyway_Regular',
		'DynaPuff_Bold',
		'Coiny_Regular',
		'Roadside Sans_Regular'
	]);
	const ARTICULATED_FONT_OPTIONS = FONT_OPTIONS.filter((o) => ARTICULATED_FONT_KEYS.has(o.key));

	const FONT_SIZE_FOR_SHAPES = 12;
	const LETTER_TARGET_HEIGHT_MM = 8;
	const TEXT_SURFACE_EMBED = 0.02;

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

	let templateGeometries = $state<Record<SegmentKind, THREE.BufferGeometry> | null>(null);
	let keyringGeometry = $state<THREE.BufferGeometry | null>(null);
	let loadError = $state<string | null>(null);
	let sceneReady = $state(false);

	let textContent = $state('name');
	let textOrientation = $state<'horizontal' | 'vertical'>('horizontal');
	let fontKey = $state(ARTICULATED_FONT_OPTIONS[0]?.key ?? 'Titan One_Regular');
	let textScale = $state(1);
	let textDepth = $state(1);
	let baseColor = $state('#ef4444');
	let textColor = $state('#ffffff');

	let exportError = $state<string | null>(null);
	let exportLoading = $state(false);
	let openBambuStudioLoading = $state(false);

	function sanitizeText(raw: string): string {
		return (raw ?? '')
			.toUpperCase()
			.replace(/[^A-Z0-9]/g, '')
			.slice(0, 24);
	}

	function segmentKindForIndex(index: number, length: number): SegmentKind {
		if (length <= 1) return 'start';
		if (index === 0) return 'start';
		if (index === length - 1) return 'end';
		return 'mid';
	}

	/** Left-align X for chaining; center Y; floor on Z. */
	function normalizeSegmentGeometry(geo: THREE.BufferGeometry) {
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (!bb) return;
		const cy = (bb.min.y + bb.max.y) / 2;
		geo.translate(-bb.min.x, -cy, -bb.min.z);
		geo.computeBoundingBox();
		geo.computeVertexNormals();
	}

	function bottomAlignGeometryZ(geo: THREE.BufferGeometry) {
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		if (!bb) return;
		geo.translate(0, 0, -bb.min.z);
		geo.computeBoundingBox();
	}

	function addLetterOnSegment(
		assembly: THREE.Group,
		letter: string,
		segmentPosition: THREE.Vector3,
		segmentBb: THREE.Box3
	) {
		const font = getFont(fontKey);
		if (!font) return;
		const shapes = font.generateShapes(letter, FONT_SIZE_FOR_SHAPES);
		if (shapes.length === 0) return;

		const textGeo = new THREE.ExtrudeGeometry(shapes, {
			depth: Math.max(0.1, textDepth),
			bevelEnabled: false,
			curveSegments: 8
		});
		centerGeometryXY(textGeo);
		bottomAlignGeometryZ(textGeo);
		textGeo.computeBoundingBox();
		const tb = textGeo.boundingBox;
		if (!tb) return;

		const segW = Math.max(0.01, segmentBb.max.x - segmentBb.min.x);
		const segH = Math.max(0.01, segmentBb.max.y - segmentBb.min.y);
		const textW = Math.max(0.01, tb.max.x - tb.min.x);
		const textH = Math.max(0.01, tb.max.y - tb.min.y);
		const vertical = textOrientation === 'vertical';
		const scaleXY = vertical
			? Math.min(
					(segW * 0.72) / textH,
					(segH * 0.72) / textW,
					(LETTER_TARGET_HEIGHT_MM * textScale) / textH
				)
			: Math.min(
					(segW * 0.72) / textW,
					(segH * 0.72) / textH,
					(LETTER_TARGET_HEIGHT_MM * textScale) / textH
				);

		const textMat = new THREE.MeshStandardMaterial({
			color: textColor,
			roughness: 0.4,
			metalness: 0.1
		});
		const textMesh = new THREE.Mesh(textGeo, textMat);
		textMesh.name = `letter-${letter}`;
		textMesh.castShadow = true;
		textMesh.receiveShadow = true;
		textMesh.scale.set(scaleXY, scaleXY, 1);
		if (vertical) {
			textMesh.rotation.z = Math.PI / 2;
		}

		const topZ = segmentBb.max.z - segmentBb.min.z;
		const centerX = (segmentBb.min.x + segmentBb.max.x) / 2;
		const centerY = (segmentBb.min.y + segmentBb.max.y) / 2;
		textMesh.position.set(
			segmentPosition.x + centerX,
			segmentPosition.y + centerY,
			segmentPosition.z + topZ + TEXT_SURFACE_EMBED
		);
		assembly.add(textMesh);
	}

	function loadStlGeometry(loader: STLLoader, url: string): Promise<THREE.BufferGeometry> {
		return new Promise((resolve, reject) => {
			loader.load(
				url,
				(geometry) => resolve(geometry),
				undefined,
				(error) => reject(error)
			);
		});
	}

	function addKeyringOnStart(assembly: THREE.Group, startBasePos: THREE.Vector3) {
		if (!keyringGeometry) return;
		const geo = keyringGeometry.clone();
		const mat = new THREE.MeshStandardMaterial({
			color: baseColor,
			roughness: 0.75,
			metalness: 0.1
		});
		const mesh = new THREE.Mesh(geo, mat);
		mesh.name = KEYRING_MESH_NAME;
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.position.set(
			startBasePos.x + KEYRING_OFFSET.x,
			startBasePos.y + KEYRING_OFFSET.y,
			startBasePos.z + KEYRING_OFFSET.z
		);
		assembly.add(mesh);
	}

	function centerAssemblyOnOrigin(assembly: THREE.Group) {
		const box = new THREE.Box3();
		let hasGeometry = false;
		assembly.traverse((node) => {
			if (!(node as THREE.Mesh).isMesh) return;
			const mesh = node as THREE.Mesh;
			if (mesh.name === KEYRING_MESH_NAME) return;
			box.expandByObject(mesh);
			hasGeometry = true;
		});
		if (!hasGeometry) return;
		const center = new THREE.Vector3();
		box.getCenter(center);
		const floorZ = box.min.z;
		assembly.position.set(-center.x, -center.y, -floorZ);
	}

	function rebuildMeshes() {
		if (!group || !templateGeometries) return;
		disposeObject3D(group);
		group.clear();
		modelAabbMm = null;

		const content = sanitizeText(textContent);
		if (!content) {
			group.updateWorldMatrix(true, true);
			return;
		}

		const assembly = new THREE.Group();
		const baseMat = new THREE.MeshStandardMaterial({
			color: baseColor,
			roughness: 0.75,
			metalness: 0.1
		});

		let cursorX = 0;
		const len = content.length;
		let startBasePos: THREE.Vector3 | null = null;

		for (let i = 0; i < len; i++) {
			const kind = segmentKindForIndex(i, len);
			const isEnd = kind === 'end';
			const template = templateGeometries[kind];
			const geo = template.clone();
			normalizeSegmentGeometry(geo);
			geo.computeBoundingBox();
			const bb = geo.boundingBox!;

			const mesh = new THREE.Mesh(geo, baseMat.clone());
			mesh.name = `segment-${i}-${kind}`;
			mesh.castShadow = true;
			mesh.receiveShadow = true;

			const basePos = new THREE.Vector3(
				cursorX,
				i * BASE_REPEAT_OFFSET.y,
				i * BASE_REPEAT_OFFSET.z
			);
			if (isEnd) {
				basePos.x += END_BASE_OFFSET.x;
				basePos.y += END_BASE_OFFSET.y;
				basePos.z += END_BASE_OFFSET.z;
			}
			mesh.position.copy(basePos);
			assembly.add(mesh);

			if (i === 0) {
				startBasePos = basePos.clone();
			}

			const letterPos = basePos.clone();
			if (!isEnd) {
				letterPos.x += CHAR_POSITION_OFFSET.x;
				letterPos.y += CHAR_POSITION_OFFSET.y;
				letterPos.z += CHAR_POSITION_OFFSET.z;
			}
			addLetterOnSegment(assembly, content[i]!, letterPos, bb);

			const width = Math.max(0.01, bb.max.x - bb.min.x);
			cursorX += width;
			if (i < len - 1) {
				cursorX += BASE_REPEAT_OFFSET.x;
			}
		}

		centerAssemblyOnOrigin(assembly);
		if (startBasePos) {
			addKeyringOnStart(assembly, startBasePos);
		}
		group.add(assembly);

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
			const sub = child as THREE.Object3D;
			sub.traverse((node) => {
				if (!(node as THREE.Mesh).isMesh) return;
				const mesh = node as THREE.Mesh;
				if (mesh.name === KEYRING_MESH_NAME) return;
				const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
				const mat = mesh.material as THREE.MeshStandardMaterial;
				const color = mat?.color?.clone() ?? new THREE.Color(0xffffff);
				const exportMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
				exportMesh.name = mesh.name;
				exportGroup.add(exportMesh);
			});
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
			group.updateWorldMatrix(true, true);
			group.traverse((child) => {
				if (!(child as THREE.Mesh).isMesh) return;
				const mesh = child as THREE.Mesh;
				if (mesh.name === KEYRING_MESH_NAME) return;
				let g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
				if (g.attributes.uv) g.deleteAttribute('uv');
				if (!g.attributes.normal) g.computeVertexNormals();
				if (g.index) {
					const nonIndexed = g.toNonIndexed();
					g.dispose();
					g = nonIndexed;
				}
				geometries.push(g);
			});
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
			const slug = sanitizeText(textContent) || 'keychain';
			downloadBlob(`articulated-keychain-${slug}-${ts}.stl`, new Blob([buffer], { type: 'model/stl' }));
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Articulated',
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
			const slug = sanitizeText(textContent) || 'keychain';
			downloadBlob(`articulated-keychain-${slug}-${ts}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Articulated',
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
			const publicUrl = await upload3mfToSupabase(blob, 'articulated-keychain');
			notifyExportEvent({
				email: user?.email,
				name:
					(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Articulated',
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
		// Read readiness first so short-circuit on `scene` does not skip tracking sceneReady.
		void sceneReady;
		void templateGeometries;
		void textContent;
		void textOrientation;
		void fontKey;
		void textScale;
		void textDepth;
		void baseColor;
		void textColor;
		void keyringGeometry;
		if (!scene || !group || !sceneReady || !templateGeometries) return;
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
		scene.add(fillLight.target);

		group = new THREE.Group();
		scene.add(group);

		const grid = new THREE.GridHelper(250, 25, 0xcbd5e1, 0xe2e8f0);
		grid.rotateX(Math.PI / 2);
		grid.position.z = -0.01;
		scene.add(grid);

		ro = new ResizeObserver(() => resize());
		ro.observe(hostEl);
		resize();

		const loader = new STLLoader();
		getFont(fontKey);

		Promise.all([
			loadStlGeometry(loader, articulatedStartStlUrl),
			loadStlGeometry(loader, articulatedMidStlUrl),
			loadStlGeometry(loader, articulatedEndStlUrl),
			loadStlGeometry(loader, articulatedKeyringStlUrl)
		])
			.then(([start, mid, end, keyring]) => {
				normalizeSegmentGeometry(keyring);
				keyringGeometry = keyring;
				templateGeometries = { start, mid, end };
				loadError = null;
				sceneReady = true;
				didInitFrame = false;
				if (group && templateGeometries) rebuildMeshes();
			})
			.catch((err) => {
				loadError = err instanceof Error ? err.message : 'Failed to load articulated STLs';
			});

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

	function resize() {
		if (!renderer || !camera || !hostEl) return;
		const rect = hostEl.getBoundingClientRect();
		const w = Math.max(1, Math.floor(rect.width));
		const h = Math.max(1, Math.floor(rect.height));
		renderer.setSize(w, h, true);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}

	onDestroy(() => {
		cancelAnimationFrame(rafId);
		rafId = 0;
		if (templateGeometries) {
			for (const geo of Object.values(templateGeometries)) geo.dispose();
		}
		templateGeometries = null;
		keyringGeometry?.dispose();
		keyringGeometry = null;
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
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Articulated Keychain</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
				<p class="text-xs text-slate-500">
					Each letter uses a base segment: <strong>start</strong> for the first character,
					<strong>mid</strong> for middle characters, <strong>end</strong> for the last. Letters
					A–Z and 0–9 only.
				</p>

				{#if loadError}
					<p class="text-sm text-red-600">{loadError}</p>
				{/if}

				<div>
					<label for="articulated-text" class="mb-1 block text-xs font-medium text-slate-700">
						Text
					</label>
					<input
						id="articulated-text"
						type="text"
						placeholder="NAME"
						class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
						bind:value={textContent}
					/>
					<p class="mt-1 text-[11px] text-slate-500">
						Preview: {sanitizeText(textContent) || '—'}
						({sanitizeText(textContent).length} segment{sanitizeText(textContent).length === 1
							? ''
							: 's'})
					</p>
				</div>

				<div>
					<p class="mb-1 text-xs font-medium text-slate-700">Letter direction</p>
					<div class="flex items-center gap-4">
						<label class="flex cursor-pointer items-center gap-1.5">
							<input
								type="radio"
								name="articulated-text-orientation"
								value="horizontal"
								bind:group={textOrientation}
							/>
							<span class="text-xs text-slate-700">Horizontal</span>
						</label>
						<label class="flex cursor-pointer items-center gap-1.5">
							<input
								type="radio"
								name="articulated-text-orientation"
								value="vertical"
								bind:group={textOrientation}
							/>
							<span class="text-xs text-slate-700">Vertical</span>
						</label>
					</div>
				</div>

				<div>
					<label for="articulated-font" class="mb-1 block text-xs font-medium text-slate-700">
						Letter font
					</label>
					<FontSelect
						id="articulated-font"
						bind:value={fontKey}
						options={ARTICULATED_FONT_OPTIONS}
					/>
				</div>

				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="articulated-text-scale" class="text-xs font-medium text-slate-700">
							Letter scale
						</label>
						<span class="text-xs text-slate-500">{textScale.toFixed(1)}×</span>
					</div>
					<Slider
						id="articulated-text-scale"
						type="single"
						bind:value={textScale}
						min={0.3}
						max={2}
						step={0.1}
						class="w-full"
					/>
				</div>

				<ColorPalettePicker bind:value={baseColor} {palette} label="Base color" />
				<ColorPalettePicker bind:value={textColor} {palette} label="Letter color" />

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
					onSnapshot={() => downloadSnapshot(renderer, scene, camera, 'articulated')}
					onExport={() => exportStl()}
					exportDisabled={!sceneReady || !sanitizeText(textContent) || exportLoading}
					exportTitle={getExportTitle(user, subscriptionStatus, 'Export STL or 3MF')}
					onExport3MF={() => export3MF()}
					onOpenWithBambuStudio={() => openWithBambuStudio()}
					openBambuStudioLoading={openBambuStudioLoading}
					{exportLoading}
					showLockIcon={showExportLockIcon(user, subscriptionStatus)}
				/>
			</div>
		</section>
	</div>
</main>
