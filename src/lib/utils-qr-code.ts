import { create } from 'qrcode/lib/core/qrcode.js';
import ClipperLib from 'clipper-lib';
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createRoundedRectShape, getFont } from '$lib/utils-3d';

export const DESIGN_NAME = 'QR Code Maker';
export const STORAGE_KEY = 'keychain-qr-code-maker-settings';
export const DEFAULT_QR_CONTENT = 'https://pixnprints.shop';

export type QrPayloadType = 'link' | 'wifi' | 'contact';
export type WifiSecurityType = 'WPA' | 'WEP' | 'nopass';
export type QrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';
export type QrLabelPosition = 'top' | 'bottom';
export type QrKeyringPosition = 'topCenter' | 'topLeft' | 'topRight';

/** Standard quiet zone in modules (per QR spec). */
export const QR_QUIET_ZONE_MODULES = 4;

export interface QrCodeMakerSettings {
	qrType: QrPayloadType;
	linkContent: string;
	wifiSsid: string;
	wifiPassword: string;
	wifiSecurity: WifiSecurityType;
	wifiHidden: boolean;
	contactName: string;
	contactPhone: string;
	contactEmail: string;
	errorCorrectionLevel: QrErrorCorrectionLevel;
	qrSizeMm: number;
	qrDepthMm: number;
	qrBackgroundEnabled: boolean;
	qrBackgroundColor: string;
	qrBackgroundDepthMm: number;
	qrBackgroundPaddingMm: number;
	qrBackgroundCornerRadiusMm: number;
	labelText: string;
	labelPosition: QrLabelPosition;
	labelFontKey: string;
	labelSizeMm: number;
	labelThicknessMm: number;
	labelMarginMm: number;
	basePaddingMm: number;
	cornerRadiusMm: number;
	baseDepthMm: number;
	keyringEnabled: boolean;
	keyringPosition: QrKeyringPosition;
	keyringOuterMm: number;
	keyringHoleMm: number;
	baseColor: string;
	qrColor: string;
	labelColor: string;
}

export interface QrMatrixResult {
	moduleCount: number;
	modules: boolean[][];
}

export interface LabelBoundsMm {
	width: number;
	height: number;
	shapes: THREE.Shape[];
}

export interface QrTagLayout {
	matrix: QrMatrixResult;
	moduleSizeMm: number;
	/** Bounds of dark modules in matrix indices (inclusive). */
	moduleBounds: { minR: number; maxR: number; minC: number; maxC: number };
	qrFootprintMm: number;
	contentWidthMm: number;
	contentHeightMm: number;
	baseHalfWMm: number;
	baseHalfHMm: number;
	cornerRadiusMm: number;
	qrCenter: { x: number; y: number };
	activeSpanW: number;
	activeSpanH: number;
	label: {
		center: { x: number; y: number };
		bounds: LabelBoundsMm;
	} | null;
}

export interface DarkModuleBounds {
	minR: number;
	maxR: number;
	minC: number;
	maxC: number;
}

export function getDarkModuleBounds(matrix: QrMatrixResult): DarkModuleBounds | null {
	const n = matrix.moduleCount;
	let minR = n;
	let maxR = -1;
	let minC = n;
	let maxC = -1;
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			if (!matrix.modules[r][c]) continue;
			minR = Math.min(minR, r);
			maxR = Math.max(maxR, r);
			minC = Math.min(minC, c);
			maxC = Math.max(maxC, c);
		}
	}
	if (maxR < 0) return null;
	return { minR, maxR, minC, maxC };
}

export function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

/** Escape special characters in WiFi QR payload fields. */
export function escapeWifiField(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/:/g, '\\:')
		.replace(/"/g, '\\"');
}

export function buildWifiPayload(
	ssid: string,
	password: string,
	security: WifiSecurityType,
	hidden: boolean
): string {
	const parts = [`WIFI:T:${security}`, `S:${escapeWifiField(ssid)}`];
	if (security !== 'nopass' && password) {
		parts.push(`P:${escapeWifiField(password)}`);
	}
	if (hidden) {
		parts.push('H:true');
	}
	return `${parts.join(';')};;`;
}

function escapeVCardValue(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\n/g, '\\n');
}

export function buildContactPayload(name: string, phone: string, email: string): string {
	const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
	const trimmedName = name.trim();
	const trimmedPhone = phone.trim();
	const trimmedEmail = email.trim();
	if (trimmedName) {
		lines.push(`FN:${escapeVCardValue(trimmedName)}`);
	}
	if (trimmedPhone) {
		lines.push(`TEL:${escapeVCardValue(trimmedPhone)}`);
	}
	if (trimmedEmail) {
		lines.push(`EMAIL:${escapeVCardValue(trimmedEmail)}`);
	}
	lines.push('END:VCARD');
	return lines.join('\n');
}

export function buildQrPayload(settings: QrCodeMakerSettings): string {
	switch (settings.qrType) {
		case 'wifi':
			return buildWifiPayload(
				settings.wifiSsid,
				settings.wifiPassword,
				settings.wifiSecurity,
				settings.wifiHidden
			);
		case 'contact':
			return buildContactPayload(
				settings.contactName,
				settings.contactPhone,
				settings.contactEmail
			);
		default:
			return settings.linkContent.trim();
	}
}

export type QrPayloadValidation =
	| { ok: true; payload: string }
	| { ok: false; message: string };

export function validateQrPayload(settings: QrCodeMakerSettings): QrPayloadValidation {
	switch (settings.qrType) {
		case 'wifi': {
			const ssid = settings.wifiSsid.trim();
			if (!ssid) {
				return { ok: false, message: 'Enter a Wi‑Fi network name (SSID).' };
			}
			if (settings.wifiSecurity !== 'nopass' && !settings.wifiPassword.trim()) {
				return { ok: false, message: 'Enter the Wi‑Fi password.' };
			}
			return { ok: true, payload: buildWifiPayload(ssid, settings.wifiPassword, settings.wifiSecurity, settings.wifiHidden) };
		}
		case 'contact': {
			const phone = settings.contactPhone.trim();
			const name = settings.contactName.trim();
			const email = settings.contactEmail.trim();
			if (!phone && !name && !email) {
				return { ok: false, message: 'Enter a phone number, name, or email for the contact.' };
			}
			return {
				ok: true,
				payload: buildContactPayload(name, phone, email)
			};
		}
		default: {
			const content = settings.linkContent.trim();
			if (!content) {
				return { ok: false, message: 'Enter a URL or text to encode.' };
			}
			return { ok: true, payload: content };
		}
	}
}

export function createQrMatrix(
	payload: string,
	errorCorrectionLevel: QrErrorCorrectionLevel = 'M'
): QrMatrixResult | null {
	const text = payload.trim();
	if (!text || text.length > 500) return null;
	try {
		const qr = create(text, { errorCorrectionLevel });
		const size = qr.modules.size;
		const modules: boolean[][] = [];
		for (let row = 0; row < size; row++) {
			const rowData: boolean[] = [];
			for (let col = 0; col < size; col++) {
				rowData.push(qr.modules.get(row, col) !== 0);
			}
			modules.push(rowData);
		}
		return { moduleCount: size, modules };
	} catch {
		return null;
	}
}

export function measureLabelTextMm(text: string, fontKey: string, fontSizeMm: number): LabelBoundsMm | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const font = getFont(fontKey);
	if (!font) return null;
	const size = Math.max(1, fontSizeMm);
	let shapes: THREE.Shape[];
	try {
		shapes = font.generateShapes(trimmed, size) as THREE.Shape[];
	} catch {
		return null;
	}
	if (!shapes.length) return null;

	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const shape of shapes) {
		const pts = shape.getPoints(12);
		for (const p of pts) {
			minX = Math.min(minX, p.x);
			maxX = Math.max(maxX, p.x);
			minY = Math.min(minY, p.y);
			maxY = Math.max(maxY, p.y);
		}
	}
	if (!Number.isFinite(minX)) return null;
	return {
		width: maxX - minX,
		height: maxY - minY,
		shapes
	};
}

export function computeQrTagLayout(settings: QrCodeMakerSettings): QrTagLayout | null {
	const validation = validateQrPayload(settings);
	if (!validation.ok) return null;

	const matrix = createQrMatrix(validation.payload, settings.errorCorrectionLevel);
	if (!matrix) return null;

	const moduleBounds = getDarkModuleBounds(matrix);
	if (!moduleBounds) return null;

	const activeCols = moduleBounds.maxC - moduleBounds.minC + 1;
	const activeRows = moduleBounds.maxR - moduleBounds.minR + 1;
	const moduleSizeMm = Math.max(0.15, settings.qrSizeMm / activeCols);
	const activeSpanW = moduleSizeMm * activeCols;
	const activeSpanH = moduleSizeMm * activeRows;
	const edgeMarginMm = Math.max(0, settings.basePaddingMm);
	const qrFootprintMm = Math.max(activeSpanW, activeSpanH) + 2 * edgeMarginMm;

	const labelBounds = measureLabelTextMm(
		settings.labelText,
		settings.labelFontKey,
		settings.labelSizeMm
	);
	const hasLabel = labelBounds !== null;
	const labelGap = hasLabel ? Math.max(0, settings.labelMarginMm) : 0;

	const contentWidthMm = Math.max(activeSpanW, labelBounds?.width ?? 0);
	const contentHeightMm =
		activeSpanH + (hasLabel ? (labelBounds?.height ?? 0) + labelGap : 0);

	const baseHalfWMm = contentWidthMm / 2 + edgeMarginMm;
	const baseHalfHMm = contentHeightMm / 2 + edgeMarginMm;
	const cornerRadiusMm = clamp(
		settings.cornerRadiusMm,
		0,
		Math.min(baseHalfWMm, baseHalfHMm)
	);

	let yCursor = contentHeightMm / 2;
	let qrCenterY = 0;
	let labelCenter: { x: number; y: number } | null = null;

	if (hasLabel && settings.labelPosition === 'top') {
		labelCenter = { x: 0, y: yCursor - (labelBounds?.height ?? 0) / 2 };
		yCursor -= (labelBounds?.height ?? 0) + labelGap;
		qrCenterY = yCursor - activeSpanH / 2;
	} else if (hasLabel && settings.labelPosition === 'bottom') {
		qrCenterY = yCursor - activeSpanH / 2;
		const bottomLabelY = -contentHeightMm / 2 + (labelBounds?.height ?? 0) / 2;
		labelCenter = { x: 0, y: bottomLabelY };
	} else {
		qrCenterY = 0;
	}

	return {
		matrix,
		moduleSizeMm,
		moduleBounds,
		qrFootprintMm,
		contentWidthMm,
		contentHeightMm,
		baseHalfWMm,
		baseHalfHMm,
		cornerRadiusMm,
		qrCenter: { x: 0, y: qrCenterY },
		activeSpanW,
		activeSpanH,
		label:
			hasLabel && labelBounds && labelCenter
				? { center: labelCenter, bounds: labelBounds }
				: null
	};
}

export function buildQrModuleGeometry(
	layout: QrTagLayout,
	depthMm: number
): THREE.BufferGeometry | null {
	const { matrix, moduleSizeMm, moduleBounds, qrCenter } = layout;
	const n = matrix.moduleCount;
	const geos: THREE.BufferGeometry[] = [];
	const depth = Math.max(0.1, depthMm);
	const half = moduleSizeMm / 2;
	const midC = (moduleBounds.minC + moduleBounds.maxC) / 2;
	const midR = (moduleBounds.minR + moduleBounds.maxR) / 2;

	for (let row = 0; row < n; row++) {
		for (let col = 0; col < n; col++) {
			if (!matrix.modules[row][col]) continue;
			const cx = qrCenter.x + (col - midC) * moduleSizeMm;
			const cy = qrCenter.y + (midR - row) * moduleSizeMm;
			const shape = new THREE.Shape();
			shape.moveTo(cx - half, cy - half);
			shape.lineTo(cx + half, cy - half);
			shape.lineTo(cx + half, cy + half);
			shape.lineTo(cx - half, cy + half);
			shape.closePath();
			const geo = new THREE.ExtrudeGeometry(shape, {
				depth,
				bevelEnabled: false
			});
			geo.computeBoundingBox();
			const bb = geo.boundingBox!;
			geo.translate(0, 0, -bb.min.z);
			geos.push(geo);
		}
	}

	if (geos.length === 0) return null;
	const merged =
		geos.length === 1 ? geos[0] : BufferGeometryUtils.mergeGeometries(geos, false);
	for (const g of geos) {
		if (g !== merged) g.dispose();
	}
	return merged;
}

export function buildQrBackgroundGeometry(
	layout: QrTagLayout,
	depthMm: number,
	paddingMm: number,
	cornerRadiusMm: number
): THREE.BufferGeometry | null {
	const depth = Math.max(0.1, depthMm);
	const pad = Math.max(0, paddingMm);
	const halfW = layout.activeSpanW / 2 + pad;
	const halfH = layout.activeSpanH / 2 + pad;
	const { x: cx, y: cy } = layout.qrCenter;
	const cornerRadius = clamp(cornerRadiusMm, 0, Math.min(halfW, halfH));

	const shape = createRoundedRectShape(halfW, halfH, cornerRadius);
	const geo = new THREE.ExtrudeGeometry(shape, {
		depth,
		bevelEnabled: false,
		curveSegments: 32
	});
	geo.computeBoundingBox();
	const bb = geo.boundingBox!;
	geo.translate(cx - (bb.min.x + bb.max.x) / 2, cy - (bb.min.y + bb.max.y) / 2, -bb.min.z);
	return geo;
}

export function buildLabelGeometry(
	layout: QrTagLayout,
	thicknessMm: number
): THREE.BufferGeometry | null {
	if (!layout.label) return null;
	const depth = Math.max(0.1, thicknessMm);
	const { shapes, width, height } = layout.label.bounds;
	const { x: cx, y: cy } = layout.label.center;
	const geo = new THREE.ExtrudeGeometry(shapes, {
		depth,
		bevelEnabled: false
	});
	geo.computeBoundingBox();
	const bb = geo.boundingBox!;
	geo.translate(cx - (bb.min.x + bb.max.x) / 2, cy - (bb.min.y + bb.max.y) / 2, -bb.min.z);
	void width;
	void height;
	return geo;
}

export function createBaseShapeFromLayout(
	layout: QrTagLayout,
	settings: QrCodeMakerSettings
): THREE.Shape | null {
	const { baseHalfWMm: halfW, baseHalfHMm: halfH, cornerRadiusMm } = layout;
	if (!settings.keyringEnabled) {
		return createRoundedRectShape(halfW, halfH, cornerRadiusMm);
	}

	const margin = 6;
	const discRadius = Math.max(0.5, settings.keyringOuterMm / 2);
	const holeRadius = Math.min(
		Math.max(0.05, settings.keyringHoleMm / 2),
		discRadius - 0.1
	);

	const discCenterX = (() => {
		switch (settings.keyringPosition) {
			case 'topLeft':
				return -halfW;
			case 'topRight':
				return halfW;
			default:
				return 0;
		}
	})();
	const discCenterY = halfH;

	// Clipper union — same recipe as BasicNameDesigner.
	const SCALE = 1000;
	const divisions = 24;
	const circleDivisions = 64;

	const shapeToPath = (shape: THREE.Shape, clockwise: boolean) => {
		const pts = shape.getPoints(divisions);
		const path = pts.map((p) => ({
			X: Math.round(p.x * SCALE),
			Y: Math.round(p.y * SCALE)
		}));
		if (
			path.length > 2 &&
			path[0].X === path[path.length - 1].X &&
			path[0].Y === path[path.length - 1].Y
		) {
			path.pop();
		}
		if (path.length < 3) return null;
		const isCW = ClipperLib.Clipper.Orientation(path);
		if (isCW !== clockwise) path.reverse();
		return path;
	};

	const circleToPath = (
		cx: number,
		cy: number,
		r: number,
		clockwise: boolean,
		segs = divisions
	) => {
		const path: { X: number; Y: number }[] = [];
		for (let i = 0; i < segs; i++) {
			const t = (i / segs) * Math.PI * 2;
			path.push({
				X: Math.round((cx + r * Math.cos(t)) * SCALE),
				Y: Math.round((cy + r * Math.sin(t)) * SCALE)
			});
		}
		if (path.length < 3) return null;
		const isCW = ClipperLib.Clipper.Orientation(path);
		if (isCW !== clockwise) path.reverse();
		return path;
	};

	const rectShape = createRoundedRectShape(halfW, halfH, cornerRadiusMm);
	const rectPath = shapeToPath(rectShape, true);
	const discPath = circleToPath(discCenterX, discCenterY, discRadius, true, circleDivisions);
	if (!rectPath) return null;

	const unionTree = new ClipperLib.PolyTree();
	const clipperUnion = new ClipperLib.Clipper();
	clipperUnion.AddPath(rectPath, ClipperLib.PolyType.ptSubject, true);
	if (discPath) clipperUnion.AddPath(discPath, ClipperLib.PolyType.ptSubject, true);
	clipperUnion.Execute(
		ClipperLib.ClipType.ctUnion,
		unionTree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);

	const holePath = circleToPath(discCenterX, discCenterY, holeRadius, false, circleDivisions);
	const resultTree = new ClipperLib.PolyTree();
	const subjectPaths: { X: number; Y: number }[][] = [];
	const collectPaths = (node: {
		Contour?: () => { X: number; Y: number }[];
		m_polygon?: { X: number; Y: number }[];
		Childs?: () => unknown[];
		m_Childs?: unknown[];
		IsHole?: () => boolean;
		m_IsHole?: boolean;
	}) => {
		const contour = node.Contour?.() ?? node.m_polygon ?? [];
		if (contour && contour.length >= 3) subjectPaths.push(contour);
		const childs = node.Childs?.() ?? node.m_Childs ?? [];
		childs.forEach((c) => collectPaths(c as typeof node));
	};
	const roots = unionTree.Childs?.() ?? (unionTree as { m_Childs?: unknown[] }).m_Childs ?? [];
	roots.forEach((n) => {
		const node = n as Parameters<typeof collectPaths>[0];
		if (node.IsHole?.() ?? node.m_IsHole) return;
		collectPaths(node);
	});

	const clipperDiff = new ClipperLib.Clipper();
	subjectPaths.forEach((p) => clipperDiff.AddPath(p, ClipperLib.PolyType.ptSubject, true));
	if (holePath) clipperDiff.AddPath(holePath, ClipperLib.PolyType.ptClip, true);
	clipperDiff.Execute(
		ClipperLib.ClipType.ctDifference,
		resultTree,
		ClipperLib.PolyFillType.pftNonZero,
		ClipperLib.PolyFillType.pftNonZero
	);

	const toVec2 = (pt: { X: number; Y: number }) => new THREE.Vector2(pt.X / SCALE, pt.Y / SCALE);
	const resultRoots = resultTree.Childs?.() ?? (resultTree as { m_Childs?: unknown[] }).m_Childs ?? [];
	for (const n of resultRoots) {
		const node = n as Parameters<typeof collectPaths>[0];
		if (node.IsHole?.() ?? node.m_IsHole) continue;
		const contour = node.Contour?.() ?? node.m_polygon ?? [];
		if (contour.length < 3) continue;
		const mergedShape = new THREE.Shape(contour.map(toVec2));
		const childs = node.Childs?.() ?? node.m_Childs ?? [];
		for (const ch of childs) {
			const chNode = ch as Parameters<typeof collectPaths>[0];
			const holeContour = chNode.Contour?.() ?? chNode.m_polygon ?? [];
			if (holeContour.length >= 3) {
				mergedShape.holes.push(new THREE.Path(holeContour.map(toVec2)));
			}
		}
		return mergedShape;
	}

	return createRoundedRectShape(halfW, halfH, cornerRadiusMm);
}

export function buildBaseGeometry(
	layout: QrTagLayout,
	settings: QrCodeMakerSettings
): THREE.BufferGeometry | null {
	const shape = createBaseShapeFromLayout(layout, settings);
	if (!shape) return null;
	const depth = Math.max(0.1, settings.baseDepthMm);
	const geo = new THREE.ExtrudeGeometry([shape], {
		depth,
		bevelEnabled: false,
		curveSegments: 32
	});
	geo.computeBoundingBox();
	const bb = geo.boundingBox!;
	geo.translate(0, 0, -bb.min.z);
	return geo;
}
