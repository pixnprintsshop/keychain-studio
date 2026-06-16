<script lang="ts">
	import type { PaletteColor } from '$lib/colorPalette';
	import FontSelect from '$lib/components/FontSelect.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import { notifyExportEvent } from '$lib/exportNotify';
	import {
		ensureExportAccess,
		getExportTitle,
		showExportLockIcon,
		type SubscriptionStatus
	} from '$lib/subscription';
	import { upload3mfToSupabase } from '$lib/upload3mf';
	import {
		buildBaseGeometry,
		buildLabelGeometry,
		buildQrBackgroundGeometry,
		buildQrModuleGeometry,
		clamp,
		computeQrTagLayout,
		DEFAULT_QR_CONTENT,
		DESIGN_NAME,
		STORAGE_KEY,
		validateQrPayload,
		type QrCodeMakerSettings,
		type QrErrorCorrectionLevel,
		type QrKeyringPosition,
		type QrLabelPosition,
		type QrPayloadType,
		type WifiSecurityType
	} from '$lib/utils-qr-code';
	import {
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		FONT_OPTIONS,
		frameCameraToObject,
		measureWorldAabbSizeMm
	} from '$lib/utils-3d';
	import { tickThenYieldToPaint } from '$lib/yield-to-paint';
	import type { Session, User } from '@supabase/supabase-js';
	import { onDestroy, onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import ColorPalettePicker from './ColorPalettePicker.svelte';
	import DesignerExportToolbar from './DesignerExportToolbar.svelte';
	import DesignerModelDimensionsHud from './DesignerModelDimensionsHud.svelte';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';

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

	const LAYER_GAP = 0.001;
	const PREVIEW_DEBOUNCE_MS = 300;
	const DEFAULT_FONT_KEY = FONT_OPTIONS[0]?.key ?? 'Titan One_Regular';

	const defaults: QrCodeMakerSettings = {
		qrType: 'link',
		linkContent: DEFAULT_QR_CONTENT,
		wifiSsid: '',
		wifiPassword: '',
		wifiSecurity: 'WPA',
		wifiHidden: false,
		contactName: '',
		contactPhone: '',
		contactEmail: '',
		errorCorrectionLevel: 'M',
		qrSizeMm: 40,
		qrDepthMm: 0.8,
		qrBackgroundEnabled: false,
		qrBackgroundColor: '#ffffff',
		qrBackgroundDepthMm: 0.4,
		qrBackgroundPaddingMm: 2,
		qrBackgroundCornerRadiusMm: 1,
		labelText: '',
		labelPosition: 'bottom',
		labelFontKey: DEFAULT_FONT_KEY,
		labelSizeMm: 6,
		labelThicknessMm: 0.8,
		labelMarginMm: 2,
		basePaddingMm: 3,
		cornerRadiusMm: 3,
		baseDepthMm: 2,
		keyringEnabled: true,
		keyringPosition: 'topCenter',
		keyringOuterMm: 8,
		keyringHoleMm: 4,
		baseColor: '#ffffff',
		qrColor: '#000000',
		labelColor: '#111111'
	};

	function loadSettings(): QrCodeMakerSettings {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return { ...defaults };
			const p = JSON.parse(raw) as Partial<QrCodeMakerSettings> & { qrContent?: string };
			const legacyLink =
				typeof p.linkContent === 'string'
					? p.linkContent
					: typeof p.qrContent === 'string'
						? p.qrContent
						: defaults.linkContent;
			return {
				qrType:
					p.qrType === 'link' || p.qrType === 'wifi' || p.qrType === 'contact'
						? p.qrType
						: defaults.qrType,
				linkContent: legacyLink,
				wifiSsid: typeof p.wifiSsid === 'string' ? p.wifiSsid : defaults.wifiSsid,
				wifiPassword:
					typeof p.wifiPassword === 'string' ? p.wifiPassword : defaults.wifiPassword,
				wifiSecurity:
					p.wifiSecurity === 'WPA' || p.wifiSecurity === 'WEP' || p.wifiSecurity === 'nopass'
						? p.wifiSecurity
						: defaults.wifiSecurity,
				wifiHidden: typeof p.wifiHidden === 'boolean' ? p.wifiHidden : defaults.wifiHidden,
				contactName:
					typeof p.contactName === 'string' ? p.contactName : defaults.contactName,
				contactPhone:
					typeof p.contactPhone === 'string' ? p.contactPhone : defaults.contactPhone,
				contactEmail:
					typeof p.contactEmail === 'string' ? p.contactEmail : defaults.contactEmail,
				errorCorrectionLevel:
					p.errorCorrectionLevel === 'L' ||
					p.errorCorrectionLevel === 'M' ||
					p.errorCorrectionLevel === 'Q' ||
					p.errorCorrectionLevel === 'H'
						? p.errorCorrectionLevel
						: defaults.errorCorrectionLevel,
				qrSizeMm:
					typeof p.qrSizeMm === 'number'
						? clamp(p.qrSizeMm, 12, 60)
						: defaults.qrSizeMm,
				qrDepthMm:
					typeof p.qrDepthMm === 'number'
						? clamp(p.qrDepthMm, 0.2, 4)
						: defaults.qrDepthMm,
				qrBackgroundEnabled:
					typeof p.qrBackgroundEnabled === 'boolean'
						? p.qrBackgroundEnabled
						: defaults.qrBackgroundEnabled,
				qrBackgroundColor:
					typeof p.qrBackgroundColor === 'string'
						? p.qrBackgroundColor
						: defaults.qrBackgroundColor,
				qrBackgroundDepthMm:
					typeof p.qrBackgroundDepthMm === 'number'
						? clamp(p.qrBackgroundDepthMm, 0.1, 2)
						: defaults.qrBackgroundDepthMm,
				qrBackgroundPaddingMm:
					typeof p.qrBackgroundPaddingMm === 'number'
						? clamp(p.qrBackgroundPaddingMm, 0, 10)
						: defaults.qrBackgroundPaddingMm,
				qrBackgroundCornerRadiusMm:
					typeof p.qrBackgroundCornerRadiusMm === 'number'
						? clamp(p.qrBackgroundCornerRadiusMm, 0, 20)
						: defaults.qrBackgroundCornerRadiusMm,
				labelText: typeof p.labelText === 'string' ? p.labelText : defaults.labelText,
				labelPosition:
					p.labelPosition === 'top' || p.labelPosition === 'bottom'
						? p.labelPosition
						: defaults.labelPosition,
				labelFontKey:
					typeof p.labelFontKey === 'string' ? p.labelFontKey : defaults.labelFontKey,
				labelSizeMm:
					typeof p.labelSizeMm === 'number'
						? clamp(p.labelSizeMm, 3, 20)
						: defaults.labelSizeMm,
				labelThicknessMm:
					typeof p.labelThicknessMm === 'number'
						? clamp(p.labelThicknessMm, 0.2, 4)
						: defaults.labelThicknessMm,
				labelMarginMm:
					typeof p.labelMarginMm === 'number'
						? clamp(p.labelMarginMm, 0, 20)
						: defaults.labelMarginMm,
				basePaddingMm:
					typeof p.basePaddingMm === 'number'
						? clamp(p.basePaddingMm, 0, 20)
						: defaults.basePaddingMm,
				cornerRadiusMm:
					typeof p.cornerRadiusMm === 'number'
						? clamp(p.cornerRadiusMm, 0, 20)
						: defaults.cornerRadiusMm,
				baseDepthMm:
					typeof p.baseDepthMm === 'number'
						? clamp(p.baseDepthMm, 0.5, 8)
						: defaults.baseDepthMm,
				keyringEnabled:
					typeof p.keyringEnabled === 'boolean' ? p.keyringEnabled : defaults.keyringEnabled,
				keyringPosition:
					p.keyringPosition === 'topLeft' ||
					p.keyringPosition === 'topCenter' ||
					p.keyringPosition === 'topRight'
						? p.keyringPosition
						: defaults.keyringPosition,
				keyringOuterMm:
					typeof p.keyringOuterMm === 'number'
						? clamp(p.keyringOuterMm, 4, 16)
						: defaults.keyringOuterMm,
				keyringHoleMm:
					typeof p.keyringHoleMm === 'number'
						? clamp(p.keyringHoleMm, 2, 12)
						: defaults.keyringHoleMm,
				baseColor: typeof p.baseColor === 'string' ? p.baseColor : defaults.baseColor,
				qrColor: typeof p.qrColor === 'string' ? p.qrColor : defaults.qrColor,
				labelColor: typeof p.labelColor === 'string' ? p.labelColor : defaults.labelColor
			};
		} catch {
			return { ...defaults };
		}
	}

	const initial = loadSettings();

	let qrType = $state<QrPayloadType>(initial.qrType);
	let linkContent = $state(initial.linkContent);
	let wifiSsid = $state(initial.wifiSsid);
	let wifiPassword = $state(initial.wifiPassword);
	let wifiSecurity = $state<WifiSecurityType>(initial.wifiSecurity);
	let wifiHidden = $state(initial.wifiHidden);
	let contactName = $state(initial.contactName);
	let contactPhone = $state(initial.contactPhone);
	let contactEmail = $state(initial.contactEmail);
	let errorCorrectionLevel = $state<QrErrorCorrectionLevel>(initial.errorCorrectionLevel);
	let qrSizeMm = $state(initial.qrSizeMm);
	let qrDepthMm = $state(initial.qrDepthMm);
	let qrBackgroundEnabled = $state(initial.qrBackgroundEnabled);
	let qrBackgroundColor = $state(initial.qrBackgroundColor);
	let qrBackgroundDepthMm = $state(initial.qrBackgroundDepthMm);
	let qrBackgroundPaddingMm = $state(initial.qrBackgroundPaddingMm);
	let qrBackgroundCornerRadiusMm = $state(initial.qrBackgroundCornerRadiusMm);
	let labelText = $state(initial.labelText);
	let labelPosition = $state<QrLabelPosition>(initial.labelPosition);
	let labelFontKey = $state(initial.labelFontKey);
	let labelSizeMm = $state(initial.labelSizeMm);
	let labelThicknessMm = $state(initial.labelThicknessMm);
	let labelMarginMm = $state(initial.labelMarginMm);
	let basePaddingMm = $state(initial.basePaddingMm);
	let cornerRadiusMm = $state(initial.cornerRadiusMm);
	let baseDepthMm = $state(initial.baseDepthMm);
	let keyringEnabled = $state(initial.keyringEnabled);
	let keyringPosition = $state<QrKeyringPosition>(initial.keyringPosition);
	let keyringOuterMm = $state(initial.keyringOuterMm);
	let keyringHoleMm = $state(initial.keyringHoleMm);
	let baseColor = $state(initial.baseColor);
	let qrColor = $state(initial.qrColor);
	let labelColor = $state(initial.labelColor);

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
	let previewLoading = $state(true);
	let previewReady = $state(false);
	let sceneReady = $state(false);
	let buildError = $state<string | null>(null);
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);
	let exportLoading = $state(false);
	let openBambuStudioLoading = $state(false);
	let wifiPasswordVisible = $state(false);

	const settings = $derived<QrCodeMakerSettings>({
		qrType,
		linkContent,
		wifiSsid,
		wifiPassword,
		wifiSecurity,
		wifiHidden,
		contactName,
		contactPhone,
		contactEmail,
		errorCorrectionLevel,
		qrSizeMm,
		qrDepthMm,
		qrBackgroundEnabled,
		qrBackgroundColor,
		qrBackgroundDepthMm,
		qrBackgroundPaddingMm,
		qrBackgroundCornerRadiusMm,
		labelText,
		labelPosition,
		labelFontKey,
		labelSizeMm,
		labelThicknessMm,
		labelMarginMm,
		basePaddingMm,
		cornerRadiusMm,
		baseDepthMm,
		keyringEnabled,
		keyringPosition,
		keyringOuterMm,
		keyringHoleMm,
		baseColor,
		qrColor,
		labelColor
	});

	const qrPayloadState = $derived(validateQrPayload(settings));
	const sceneOverlayMessage = $derived.by(() => {
		if (!qrPayloadState.ok) return qrPayloadState.message;
		if (!previewLoading && buildError) return buildError;
		return null;
	});
	const exportDisabled = $derived(
		!qrPayloadState.ok || previewLoading || Boolean(buildError)
	);

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
			localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
		} catch {
			/* storage unavailable */
		}
	}

	function rebuildMeshes() {
		if (!scene || !group) return;
		disposeObject3D(group);
		group.clear();
		group.position.set(0, 0, 0);
		modelAabbMm = null;
		buildError = null;

		if (!qrPayloadState.ok) {
			buildError = qrPayloadState.message;
			return;
		}

		const layout = computeQrTagLayout(settings);
		if (!layout) {
			buildError = 'Could not generate QR code. Try shorter text or a different error correction level.';
			return;
		}

		const baseGeo = buildBaseGeometry(layout, settings);
		if (!baseGeo) {
			buildError = 'Could not build base shape.';
			return;
		}

		const baseMat = new THREE.MeshStandardMaterial({
			color: baseColor,
			roughness: 0.85,
			metalness: 0.05
		});
		const baseMesh = new THREE.Mesh(baseGeo, baseMat);
		baseMesh.name = 'base';
		baseMesh.castShadow = true;
		baseMesh.receiveShadow = true;
		group.add(baseMesh);

		const baseTopZ = settings.baseDepthMm;
		let contentZ = baseTopZ + LAYER_GAP;
		const backgroundPlateZ = contentZ;

		if (settings.qrBackgroundEnabled) {
			const bgGeo = buildQrBackgroundGeometry(
				layout,
				settings.qrBackgroundDepthMm,
				settings.qrBackgroundPaddingMm,
				settings.qrBackgroundCornerRadiusMm
			);
			if (bgGeo) {
				const bgMat = new THREE.MeshStandardMaterial({
					color: qrBackgroundColor,
					roughness: 0.85,
					metalness: 0.05
				});
				const bgMesh = new THREE.Mesh(bgGeo, bgMat);
				bgMesh.name = 'qr-background';
				bgMesh.position.z = backgroundPlateZ;
				bgMesh.castShadow = true;
				bgMesh.receiveShadow = true;
				group.add(bgMesh);

				const labelBgGeo = buildLabelGeometry(layout, settings.qrBackgroundDepthMm);
				if (labelBgGeo) {
					const labelBgMat = new THREE.MeshStandardMaterial({
						color: labelColor,
						roughness: 0.75,
						metalness: 0.05
					});
					const labelBgMesh = new THREE.Mesh(labelBgGeo, labelBgMat);
					labelBgMesh.name = 'label-background';
					labelBgMesh.position.z = backgroundPlateZ;
					labelBgMesh.castShadow = true;
					labelBgMesh.receiveShadow = true;
					group.add(labelBgMesh);
				}

				contentZ += settings.qrBackgroundDepthMm + LAYER_GAP;
			}
		}

		const qrGeo = buildQrModuleGeometry(layout, settings.qrDepthMm);
		if (qrGeo) {
			const qrMat = new THREE.MeshStandardMaterial({
				color: qrColor,
				roughness: 0.75,
				metalness: 0.05
			});
			const qrMesh = new THREE.Mesh(qrGeo, qrMat);
			qrMesh.name = 'qr';
			qrMesh.position.z = contentZ;
			qrMesh.castShadow = true;
			group.add(qrMesh);
		}

		const labelGeo = buildLabelGeometry(layout, settings.labelThicknessMm);
		if (labelGeo) {
			const labelMat = new THREE.MeshStandardMaterial({
				color: labelColor,
				roughness: 0.75,
				metalness: 0.05
			});
			const labelMesh = new THREE.Mesh(labelGeo, labelMat);
			labelMesh.name = 'label';
			labelMesh.position.z = contentZ;
			labelMesh.castShadow = true;
			group.add(labelMesh);
		}

		group.updateWorldMatrix(true, true);
		const rawBox = new THREE.Box3().setFromObject(group);
		const rawCenter = new THREE.Vector3();
		rawBox.getCenter(rawCenter);
		group.position.x -= rawCenter.x;
		group.position.y -= rawCenter.y;
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
			keyLight.target.updateWorldMatrix(true, true);
		}

		const size = measureWorldAabbSizeMm(group);
		modelAabbMm = size ? { x: size.x, y: size.y, z: size.z } : null;
		if (!didInitFrame && camera && controls) {
			frameCameraToObject(box, camera, controls);
			didInitFrame = true;
		}
	}

	function buildExportGroup(): THREE.Group | null {
		if (!group || exportDisabled) return null;
		const exportGroup = new THREE.Group();
		for (const child of group.children) {
			if (child instanceof THREE.Mesh) {
				const clone = child.clone();
				clone.geometry = child.geometry.clone();
				exportGroup.add(clone);
			}
		}
		exportGroup.updateWorldMatrix(true, true);
		return exportGroup;
	}

	function modelSlug(): string {
		let raw = 'qr-code';
		if (qrType === 'wifi') {
			raw = wifiSsid.trim() || 'wifi';
		} else if (qrType === 'contact') {
			raw = contactName.trim() || contactPhone.trim() || 'contact';
		} else {
			raw = linkContent.trim() || 'qr-code';
		}
		const safe = raw
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '')
			.slice(0, 40);
		return safe || 'qr-code';
	}

	function exportNotifyName(): string | undefined {
		return (
			(user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string)
		);
	}

	async function exportStl() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		const exportGroup = buildExportGroup();
		if (!exportGroup) return;
		exportLoading = true;
		try {
			const exporter = new STLExporter();
			const result = exporter.parse(exportGroup, { binary: true });
			const buffer = result instanceof DataView ? result.buffer : result;
			if (!buffer || buffer.byteLength < 84) return;
			const blob = new Blob([buffer], { type: 'model/stl' });
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${modelSlug()}-${timestamp}.stl`, blob);
			notifyExportEvent({
				email: user?.email,
				name: exportNotifyName(),
				subscriptionStatus,
				designName: DESIGN_NAME,
				designerId: 'qrCodeMaker',
				format: 'stl'
			});
			onShowThankYou();
		} finally {
			exportLoading = false;
			disposeObject3D(exportGroup);
		}
	}

	async function export3mf() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		const exportGroup = buildExportGroup();
		if (!exportGroup) return;
		exportLoading = true;
		try {
			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) return;
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${modelSlug()}-multipart-${timestamp}.3mf`, blob);
			notifyExportEvent({
				email: user?.email,
				name: exportNotifyName(),
				subscriptionStatus,
				designName: DESIGN_NAME,
				designerId: 'qrCodeMaker',
				format: '3mf'
			});
			onShowThankYou();
		} finally {
			exportLoading = false;
			disposeObject3D(exportGroup);
		}
	}

	async function openWithBambuStudio() {
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin))) return;
		const exportGroup = buildExportGroup();
		if (!exportGroup) return;
		openBambuStudioLoading = true;
		try {
			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'qr-code-maker');
			notifyExportEvent({
				email: user?.email,
				name: exportNotifyName(),
				subscriptionStatus,
				designName: DESIGN_NAME,
				designerId: 'qrCodeMaker',
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
			onShowThankYou();
		} catch (e) {
			console.error('Bambu Studio open failed:', e);
		} finally {
			openBambuStudioLoading = false;
			disposeObject3D(exportGroup);
		}
	}

	let previewTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		void settings;
		void sceneReady;
		saveSettings();
		if (!scene || !group || !sceneReady) return;
		clearTimeout(previewTimer);
		if (!previewReady) previewLoading = true;
		previewTimer = setTimeout(async () => {
			await tickThenYieldToPaint();
			rebuildMeshes();
			previewLoading = false;
			previewReady = true;
		}, PREVIEW_DEBOUNCE_MS);
		return () => clearTimeout(previewTimer);
	});

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
		sceneReady = true;

		ro = new ResizeObserver(() => resize());
		ro.observe(hostEl);
		resize();

		const animate = () => {
			rafId = requestAnimationFrame(animate);
			controls?.update();
			if (renderer && scene && camera) renderer.render(scene, camera);
		};
		animate();

		return () => {
			ro?.disconnect();
			ro = null;
		};
	});

	onDestroy(() => {
		cancelAnimationFrame(rafId);
		rafId = 0;
		ro?.disconnect();
		ro = null;
		if (group) disposeObject3D(group);
		group = null;
		disposeObject3D(scene);
		controls?.dispose();
		controls = null;
		if (renderer && hostEl && renderer.domElement.parentElement === hostEl) {
			hostEl.removeChild(renderer.domElement);
		}
		renderer?.dispose();
		renderer = null;
		scene = null;
		camera = null;
		keyLight = null;
	});
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
	<div class="mx-auto flex h-full w-full max-w-[1600px] min-h-0 flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full min-w-0 max-w-[360px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)] lg:min-w-[320px]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">{DESIGN_NAME}</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>
			<div class="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 pt-0">
				<section class="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<p class="text-xs font-semibold tracking-tight text-slate-700">QR code</p>
					<div class="grid gap-1.5">
						<span class="text-xs font-medium text-slate-700">Type</span>
						<div class="grid grid-cols-3 gap-2">
							<Button
								variant={qrType === 'link' ? 'default' : 'outline'}
								size="sm"
								onclick={() => (qrType = 'link')}>Link</Button
							>
							<Button
								variant={qrType === 'wifi' ? 'default' : 'outline'}
								size="sm"
								onclick={() => (qrType = 'wifi')}>Wi‑Fi</Button
							>
							<Button
								variant={qrType === 'contact' ? 'default' : 'outline'}
								size="sm"
								onclick={() => (qrType = 'contact')}>Contact</Button
							>
						</div>
					</div>

					{#if qrType === 'link'}
						<label class="grid gap-1.5" for="qr-link-content">
							<span class="text-xs font-medium text-slate-700">URL or text</span>
							<textarea
								id="qr-link-content"
								class="min-h-20 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2"
								bind:value={linkContent}
								placeholder="https://example.com"
							></textarea>
						</label>
					{:else if qrType === 'wifi'}
						<label class="grid gap-1.5" for="wifi-ssid">
							<span class="text-xs font-medium text-slate-700">Network name (SSID)</span>
							<input
								id="wifi-ssid"
								class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
								bind:value={wifiSsid}
								placeholder="MyHomeWiFi"
								autocomplete="off"
							/>
						</label>
						<label class="grid gap-1.5" for="wifi-security">
							<span class="text-xs font-medium text-slate-700">Security</span>
							<select
								id="wifi-security"
								class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
								bind:value={wifiSecurity}
							>
								<option value="WPA">WPA / WPA2 / WPA3</option>
								<option value="WEP">WEP</option>
								<option value="nopass">Open (no password)</option>
							</select>
						</label>
						{#if wifiSecurity !== 'nopass'}
							<div class="grid gap-1.5">
								<span class="text-xs font-medium text-slate-700">Password</span>
								<div class="relative">
									<input
										id="wifi-password"
										type={wifiPasswordVisible ? 'text' : 'password'}
										class="w-full rounded-xl border border-slate-200 bg-white py-2 pr-10 pl-3 text-sm shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
										bind:value={wifiPassword}
										placeholder="Password"
										autocomplete="off"
									/>
									<button
										type="button"
										class="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
										aria-label={wifiPasswordVisible ? 'Hide password' : 'Show password'}
										aria-pressed={wifiPasswordVisible}
										onclick={() => (wifiPasswordVisible = !wifiPasswordVisible)}
									>
										{#if wifiPasswordVisible}
											<EyeOffIcon class="size-4" />
										{:else}
											<EyeIcon class="size-4" />
										{/if}
									</button>
								</div>
							</div>
						{/if}
						<label class="flex items-center gap-2 text-sm text-slate-700">
							<input
								type="checkbox"
								bind:checked={wifiHidden}
								class="size-4 rounded border-slate-300"
							/>
							Hidden network
						</label>
					{:else}
						<label class="grid gap-1.5" for="contact-name">
							<span class="text-xs font-medium text-slate-700">Name</span>
							<input
								id="contact-name"
								class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
								bind:value={contactName}
								placeholder="Jane Doe"
								autocomplete="name"
							/>
						</label>
						<label class="grid gap-1.5" for="contact-phone">
							<span class="text-xs font-medium text-slate-700">Phone</span>
							<input
								id="contact-phone"
								type="tel"
								class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
								bind:value={contactPhone}
								placeholder="+639171234567"
								autocomplete="tel"
							/>
						</label>
						<label class="grid gap-1.5" for="contact-email">
							<span class="text-xs font-medium text-slate-700">Email</span>
							<input
								id="contact-email"
								type="email"
								class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
								bind:value={contactEmail}
								placeholder="jane@example.com"
								autocomplete="email"
							/>
						</label>
					{/if}

					<label class="grid gap-1.5" for="qr-ecc">
						<span class="text-xs font-medium text-slate-700">Error correction</span>
						<select
							id="qr-ecc"
							class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
							bind:value={errorCorrectionLevel}
						>
							<option value="L">Low (L)</option>
							<option value="M">Medium (M)</option>
							<option value="Q">Quartile (Q)</option>
							<option value="H">High (H)</option>
						</select>
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Data area width</span>
							<span class="text-xs tabular-nums text-slate-600">{qrSizeMm.toFixed(1)} mm</span>
						</div>
						<Slider type="single" bind:value={qrSizeMm} min={12} max={60} step={0.5} class="w-full" />
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Module height</span>
							<span class="text-xs tabular-nums text-slate-600">{qrDepthMm.toFixed(1)} mm</span>
						</div>
						<Slider type="single" bind:value={qrDepthMm} min={0.2} max={4} step={0.1} class="w-full" />
					</label>
					<ColorPalettePicker bind:value={qrColor} {palette} label="Module color" />
					<label class="flex items-center gap-2 text-sm text-slate-700">
						<input
							type="checkbox"
							bind:checked={qrBackgroundEnabled}
							class="size-4 rounded border-slate-300"
						/>
						QR background layer
					</label>
					{#if qrBackgroundEnabled}
						<ColorPalettePicker
							bind:value={qrBackgroundColor}
							{palette}
							label="Background color"
						/>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Background thickness</span>
								<span class="text-xs tabular-nums text-slate-600"
									>{qrBackgroundDepthMm.toFixed(1)} mm</span
								>
							</div>
							<Slider
								type="single"
								bind:value={qrBackgroundDepthMm}
								min={0.1}
								max={2}
								step={0.1}
								class="w-full"
							/>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Background padding</span>
								<span class="text-xs tabular-nums text-slate-600"
									>{qrBackgroundPaddingMm.toFixed(1)} mm</span
								>
							</div>
							<Slider
								type="single"
								bind:value={qrBackgroundPaddingMm}
								min={0}
								max={10}
								step={0.5}
								class="w-full"
							/>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Corner radius</span>
								<span class="text-xs tabular-nums text-slate-600"
									>{qrBackgroundCornerRadiusMm.toFixed(1)} mm</span
								>
							</div>
							<Slider
								type="single"
								bind:value={qrBackgroundCornerRadiusMm}
								min={0}
								max={20}
								step={0.5}
								class="w-full"
							/>
						</label>
					{/if}
				</section>

				<section class="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<p class="text-xs font-semibold tracking-tight text-slate-700">Label</p>
					<label class="grid gap-1.5">
						<span class="text-xs font-medium text-slate-700">Text</span>
						<input
							class="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
							bind:value={labelText}
							placeholder="Optional text above or below QR"
						/>
					</label>
					<div class="grid gap-1.5">
						<span class="text-xs font-medium text-slate-700">Position</span>
						<div class="flex gap-2">
							<Button
								variant={labelPosition === 'top' ? 'default' : 'outline'}
								size="sm"
								class="flex-1"
								onclick={() => (labelPosition = 'top')}>Top</Button
							>
							<Button
								variant={labelPosition === 'bottom' ? 'default' : 'outline'}
								size="sm"
								class="flex-1"
								onclick={() => (labelPosition = 'bottom')}>Bottom</Button
							>
						</div>
					</div>
					<FontSelect bind:value={labelFontKey} />
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Size</span>
							<span class="text-xs tabular-nums text-slate-600">{labelSizeMm.toFixed(1)} mm</span>
						</div>
						<Slider type="single" bind:value={labelSizeMm} min={3} max={20} step={0.5} class="w-full" />
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Thickness</span>
							<span class="text-xs tabular-nums text-slate-600"
								>{labelThicknessMm.toFixed(1)} mm</span
							>
						</div>
						<Slider
							type="single"
							bind:value={labelThicknessMm}
							min={0.2}
							max={4}
							step={0.1}
							class="w-full"
						/>
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Margin</span>
							<span class="text-xs tabular-nums text-slate-600">{labelMarginMm.toFixed(1)} mm</span>
						</div>
						<Slider
							type="single"
							bind:value={labelMarginMm}
							min={0}
							max={20}
							step={0.5}
							class="w-full"
						/>
					</label>
					<ColorPalettePicker bind:value={labelColor} {palette} label="Text color" />
				</section>

				<section class="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<p class="text-xs font-semibold tracking-tight text-slate-700">Base</p>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Padding</span>
							<span class="text-xs tabular-nums text-slate-600">{basePaddingMm.toFixed(1)} mm</span>
						</div>
						<Slider
							type="single"
							bind:value={basePaddingMm}
							min={0}
							max={20}
							step={0.5}
							class="w-full"
						/>
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Corner radius</span>
							<span class="text-xs tabular-nums text-slate-600">{cornerRadiusMm.toFixed(1)} mm</span>
						</div>
						<Slider
							type="single"
							bind:value={cornerRadiusMm}
							min={0}
							max={20}
							step={0.5}
							class="w-full"
						/>
					</label>
					<label class="grid gap-1.5">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs font-medium text-slate-700">Thickness</span>
							<span class="text-xs tabular-nums text-slate-600">{baseDepthMm.toFixed(1)} mm</span>
						</div>
						<Slider
							type="single"
							bind:value={baseDepthMm}
							min={0.5}
							max={8}
							step={0.1}
							class="w-full"
						/>
					</label>
					<ColorPalettePicker bind:value={baseColor} {palette} label="Base color" />
				</section>

				<section class="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
					<p class="text-xs font-semibold tracking-tight text-slate-700">Keyring</p>
					<label class="flex items-center gap-2 text-sm text-slate-700">
						<input
							type="checkbox"
							bind:checked={keyringEnabled}
							class="size-4 rounded border-slate-300"
						/>
						Add keyring hole
					</label>
					{#if keyringEnabled}
						<div class="grid grid-cols-3 gap-2">
							<Button
								variant={keyringPosition === 'topLeft' ? 'default' : 'outline'}
								size="sm"
								onclick={() => (keyringPosition = 'topLeft')}>Left</Button
							>
							<Button
								variant={keyringPosition === 'topCenter' ? 'default' : 'outline'}
								size="sm"
								onclick={() => (keyringPosition = 'topCenter')}>Center</Button
							>
							<Button
								variant={keyringPosition === 'topRight' ? 'default' : 'outline'}
								size="sm"
								onclick={() => (keyringPosition = 'topRight')}>Right</Button
							>
						</div>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Outer diameter</span>
								<span class="text-xs tabular-nums text-slate-600"
									>{keyringOuterMm.toFixed(1)} mm</span
								>
							</div>
							<Slider
								type="single"
								bind:value={keyringOuterMm}
								min={4}
								max={16}
								step={0.5}
								class="w-full"
							/>
						</label>
						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Hole diameter</span>
								<span class="text-xs tabular-nums text-slate-600"
									>{keyringHoleMm.toFixed(1)} mm</span
								>
							</div>
							<Slider
								type="single"
								bind:value={keyringHoleMm}
								min={2}
								max={12}
								step={0.5}
								class="w-full"
							/>
						</label>
					{/if}
				</section>
			</div>
		</aside>

		<section
			class="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<DesignerModelDimensionsHud sizes={modelAabbMm} />
			<div bind:this={hostEl} class="absolute inset-0"></div>
			{#if previewLoading}
				<div
					class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-white/80 backdrop-blur-sm"
					aria-live="polite"
				>
					<p class="text-sm font-medium text-slate-600">Building preview…</p>
				</div>
			{:else if sceneOverlayMessage}
				<div
					class="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/15 p-6 backdrop-blur-[1px]"
					aria-live="polite"
					role="status"
				>
					<div
						class="max-w-sm rounded-2xl border border-slate-200 bg-white px-5 py-4 text-center shadow-xl"
					>
						<p class="text-sm font-semibold text-slate-900">
							{!qrPayloadState.ok ? 'Add QR content to preview' : "Couldn't build preview"}
						</p>
						<p class="mt-2 text-sm leading-relaxed text-slate-600">{sceneOverlayMessage}</p>
					</div>
				</div>
			{/if}
			<div class="absolute right-4 bottom-4">
				<DesignerExportToolbar
					onSnapshot={() =>
						downloadSnapshot(renderer, scene, camera, 'qr-code-maker')}
					onExport={exportStl}
					onExport3MF={export3mf}
					onOpenWithBambuStudio={openWithBambuStudio}
					exportDisabled={exportDisabled}
					exportLoading={exportLoading}
					openBambuStudioLoading={openBambuStudioLoading}
					exportTitle={getExportTitle(user, subscriptionStatus, 'Export STL or 3MF')}
					showLockIcon={showExportLockIcon(user, subscriptionStatus)}
				/>
			</div>
		</section>
	</div>
</main>
