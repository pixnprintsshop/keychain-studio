<script lang="ts">
	import type { Session, User } from '@supabase/supabase-js';
	import ClipperLib from 'clipper-lib';
	import { onDestroy, onMount, tick } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
	import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
	import { exportTo3MF } from '$lib/export-to-3mf';
	import FontSelect from '$lib/components/FontSelect.svelte';
	import {
		centerGeometryXY,
		type CharSettings,
		DEFAULT_CHAR_SETTINGS,
		DEFAULT_FONT_KEY_OUTLINE,
		DEFAULT_FONT_SETTINGS_OUTLINE,
		DEFAULT_TEXT,
		disposeObject3D,
		downloadBlob,
		downloadSnapshot,
		FONT_OPTIONS,
		type FontSettings,
		frameCameraToObject,
		getFont,
		loadCharSettingsFromStorage,
		loadFontSettingsFromStorage,
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

	// ── Props ───────────────────────────────────────────────────────────────
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

	// ── Storage keys (outline-specific) ─────────────────────────────────────
	const STORAGE_KEY_SETTINGS = 'keychain-outline-font-settings';
	const STORAGE_KEY_KEYRING = 'keychain-outline-keyring-settings';
	const STORAGE_KEY_TEXT = 'keychain-outline-text';
	const STORAGE_KEY_BATCH_TEXT = 'keychain-outline-batch-text';
	const STORAGE_KEY_FONT = 'keychain-outline-font';
	const STORAGE_KEY_BATCH_ITEM_SETTINGS = 'keychain-outline-batch-item-settings';
	const STORAGE_KEY_TEXT_MODE = 'keychain-outline-text-mode';
	const STORAGE_KEY_SINGLE_LINES = 'keychain-outline-single-lines';
	const STORAGE_KEY_SINGLE_LINE_SPACING = 'keychain-outline-single-line-spacing';
	const STORAGE_KEY_KEYCHAIN_ITEMS = 'keychain-outline-keychain-items';

	/** Z amount text is sunk into the base so they overlap (avoids non-manifold at contact). */
	const TEXT_BASE_EMBED = 0.2;
	/** Z amount the optional text-outline layer is sunk into the base outline. */
	const TEXT_OUTLINE_BASE_EMBED = 0.2;
	/** Debounce heavy Clipper/Three rebuilds while sliders are dragged. */
	const MESH_REBUILD_DEBOUNCE_MS = 220;
	const PERSIST_DEBOUNCE_MS = 450;
	const BATCH_ITEM_SPACING = 12;
	const MAX_SINGLE_LINES = 8;
	// ── Persistence state ───────────────────────────────────────────────────
	let allFontSettings: Record<string, FontSettings> =
		loadFontSettingsFromStorage(STORAGE_KEY_SETTINGS);
	let allCharSettings: Record<string, Record<string, CharSettings>> = loadCharSettingsFromStorage(
		STORAGE_KEY_KEYRING
	);
	let isUpdatingFromStorage = $state(true);
	let lastFont = '';
	let lastChar = '';

	const defaults = DEFAULT_FONT_SETTINGS_OUTLINE;

	type KeychainTextLine = {
		id: string;
		content: string;
		fontKey: string;
		textSize: number;
		textDepth: number;
		textColor: string;
		offsetX: number;
		offsetY: number;
	};

	let nextSingleLineId = 0;
	let nextKeychainItemId = 0;

	function createSingleLineId(): string {
		nextSingleLineId += 1;
		return `line-${Date.now().toString(36)}-${nextSingleLineId}`;
	}

	function createKeychainItemId(): string {
		nextKeychainItemId += 1;
		return `keychain-${Date.now().toString(36)}-${nextKeychainItemId}`;
	}

	function isFiniteNumber(value: unknown): value is number {
		return typeof value === 'number' && Number.isFinite(value);
	}

	function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
		return Math.min(max, Math.max(min, isFiniteNumber(value) ? value : fallback));
	}

	function parseTextItems(value: string): string[] {
		return value
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
	}

	function getPrimaryText(value: string): string {
		return parseTextItems(value)[0] ?? value.trim();
	}

	function loadTextMode(): 'single' | 'batch' {
		try {
			return localStorage.getItem(STORAGE_KEY_TEXT_MODE) === 'single' ? 'single' : 'batch';
		} catch {
			return 'batch';
		}
	}

	type KeychainResolvedSettings = {
		text: string;
		fontKey: string;
		textSize: number;
		outlineOffsetPx: number;
		baseDepth: number;
		textDepth: number;
		textColor: string;
		outlineColor: string;
		textOutlineEnabled: boolean;
		/** Outline padding around letters in mm (must stay below base outline thickness). */
		textOutlineThicknessMm: number;
		textOutlineDepth: number;
		textOutlineColor: string;
		keyringEnabled: boolean;
		keyringOuterSize: number;
		keyringHoleSize: number;
		keyringOffsetX: number;
		keyringOffsetY: number;
	};

	type KeychainItemOverrides = Partial<
		Omit<KeychainResolvedSettings, 'text' | 'keyringEnabled'> & { keyringEnabled: boolean }
	>;

	type KeychainItem = {
		id: string;
		settings: KeychainResolvedSettings;
		lines: KeychainTextLine[];
		lineSpacing: number;
	};

	type KeychainModelItem = KeychainItem & {
		index: number;
		sourceText: string;
		isMultiline: boolean;
	};

	function createBatchItemId(index: number, itemText: string): string {
		return `${index}:${itemText.trim().toLowerCase()}`;
	}

	function loadBatchItemSettings(): Record<string, KeychainItemOverrides> {
		try {
			const raw = localStorage.getItem(STORAGE_KEY_BATCH_ITEM_SETTINGS);
			if (!raw) return {};
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}

	// Restore text and fontKey from localStorage (survive navigation)
	const restoredText = (() => {
		try {
			const batchText = localStorage.getItem(STORAGE_KEY_BATCH_TEXT);
			if (batchText !== null) return batchText;
			const legacyText = localStorage.getItem(STORAGE_KEY_TEXT);
			if (legacyText !== null) {
				localStorage.setItem(STORAGE_KEY_BATCH_TEXT, legacyText);
				return legacyText;
			}
			return DEFAULT_TEXT;
		} catch {
			return DEFAULT_TEXT;
		}
	})();
	const restoredFont = (() => {
		try {
			const f = localStorage.getItem(STORAGE_KEY_FONT);
			return f && FONT_OPTIONS.some((o) => o.key === f) ? f : DEFAULT_FONT_KEY_OUTLINE;
		} catch {
			return DEFAULT_FONT_KEY_OUTLINE;
		}
	})();
	const restoredMode = loadTextMode();

	const fontSettings = allFontSettings[restoredFont] || defaults;
	const initialText = getPrimaryText(restoredText);
	const initialChar = initialText.length > 0 ? initialText.charAt(0).toUpperCase() : '';
	const charSettings = allCharSettings[restoredFont]?.[initialChar] || DEFAULT_CHAR_SETTINGS;

	function createDefaultSingleLine(content = ''): KeychainTextLine {
		return {
			id: createSingleLineId(),
			content,
			fontKey: restoredFont,
			textSize: fontSettings.textSize,
			textDepth: fontSettings.textDepth,
			textColor: fontSettings.textColor,
			offsetX: 0,
			offsetY: 0
		};
	}

	function sanitizeSingleLine(raw: unknown, fallbackContent = ''): KeychainTextLine | null {
		if (!raw || typeof raw !== 'object') return null;
		const candidate = raw as Partial<KeychainTextLine>;
		const content = typeof candidate.content === 'string' ? candidate.content : fallbackContent;
		const fontKey =
			typeof candidate.fontKey === 'string' &&
			FONT_OPTIONS.some((option) => option.key === candidate.fontKey)
				? candidate.fontKey
				: restoredFont;

		return {
			id: typeof candidate.id === 'string' && candidate.id ? candidate.id : createSingleLineId(),
			content,
			fontKey,
			textSize: clampNumber(candidate.textSize, fontSettings.textSize, 1, 96),
			textDepth: clampNumber(candidate.textDepth, fontSettings.textDepth, 0.1, 20),
			textColor:
				typeof candidate.textColor === 'string' ? candidate.textColor : fontSettings.textColor,
			offsetX: clampNumber(candidate.offsetX, 0, -100, 100),
			offsetY: clampNumber(candidate.offsetY, 0, -100, 100)
		};
	}

	function createSingleLinesFromText(value: string): KeychainTextLine[] {
		const rawLines = value.split(/\r?\n/);
		const lines = (rawLines.length > 0 ? rawLines : [DEFAULT_TEXT]).map((content) =>
			createDefaultSingleLine(content)
		);
		return lines.length > 0
			? lines.slice(0, MAX_SINGLE_LINES)
			: [createDefaultSingleLine(DEFAULT_TEXT)];
	}

	function loadSingleLines(value: string): KeychainTextLine[] {
		try {
			const raw = localStorage.getItem(STORAGE_KEY_SINGLE_LINES);
			if (raw) {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					const lines = parsed
						.slice(0, MAX_SINGLE_LINES)
						.map((line) => sanitizeSingleLine(line))
						.filter((line): line is KeychainTextLine => line !== null);
					if (lines.length > 0) return lines;
				}
			}
		} catch {
			// Fall back to the textarea content when saved line settings are unavailable.
		}
		return createSingleLinesFromText(value);
	}

	function loadSingleLineSpacing(): number {
		try {
			const raw = localStorage.getItem(STORAGE_KEY_SINGLE_LINE_SPACING);
			const parsed = raw === null ? NaN : Number(raw);
			return Number.isFinite(parsed) ? Math.max(0, parsed) : 1.5;
		} catch {
			return 1.5;
		}
	}

	function createInitialResolvedSettings(
		textValue: string,
		overrides: KeychainItemOverrides = {}
	): KeychainResolvedSettings {
		return sanitizeKeychainSettings(
			{
				text: textValue,
				fontKey: restoredFont,
				textSize: fontSettings.textSize,
				outlineOffsetPx: fontSettings.outlineOffsetPx,
				baseDepth: fontSettings.baseDepth,
				textDepth: fontSettings.textDepth,
				textColor: fontSettings.textColor,
				outlineColor: fontSettings.outlineColor,
				textOutlineEnabled: false,
				textOutlineThicknessMm: 1,
				textOutlineDepth: 1,
				textOutlineColor: '#000000',
				keyringEnabled: fontSettings.keyringEnabled ?? true,
				keyringOuterSize: charSettings.keyringOuterSize,
				keyringHoleSize: charSettings.keyringHoleSize,
				keyringOffsetX: charSettings.keyringOffsetX,
				keyringOffsetY: charSettings.keyringOffsetY,
				...overrides
			},
			textValue
		);
	}

	function createLineFromSettings(
		id: string,
		settings: KeychainResolvedSettings,
		content = settings.text
	): KeychainTextLine {
		return {
			id,
			content,
			fontKey: settings.fontKey,
			textSize: settings.textSize,
			textDepth: settings.textDepth,
			textColor: settings.textColor,
			offsetX: 0,
			offsetY: 0
		};
	}

	function getItemText(item: Pick<KeychainItem, 'lines'>): string {
		return item.lines.map((line) => line.content).join('\n');
	}

	function sanitizeKeychainSettings(
		raw: unknown,
		fallbackText = DEFAULT_TEXT
	): KeychainResolvedSettings {
		const candidate =
			raw && typeof raw === 'object' ? (raw as Partial<KeychainResolvedSettings>) : {};
		const fontKey =
			typeof candidate.fontKey === 'string' &&
			FONT_OPTIONS.some((option) => option.key === candidate.fontKey)
				? candidate.fontKey
				: restoredFont;

		return {
			text: typeof candidate.text === 'string' ? candidate.text : fallbackText,
			fontKey,
			textSize: clampNumber(candidate.textSize, fontSettings.textSize, 1, 96),
			outlineOffsetPx: clampNumber(candidate.outlineOffsetPx, fontSettings.outlineOffsetPx, 0, 100),
			baseDepth: clampNumber(candidate.baseDepth, fontSettings.baseDepth, 0.1, 40),
			textDepth: clampNumber(candidate.textDepth, fontSettings.textDepth, 0.1, 40),
			textColor:
				typeof candidate.textColor === 'string' ? candidate.textColor : fontSettings.textColor,
			outlineColor:
				typeof candidate.outlineColor === 'string'
					? candidate.outlineColor
					: fontSettings.outlineColor,
			textOutlineEnabled:
				typeof candidate.textOutlineEnabled === 'boolean' ? candidate.textOutlineEnabled : false,
			textOutlineThicknessMm: clampNumber(
				candidate.textOutlineThicknessMm ??
					(typeof (candidate as { textOutlineOffsetPx?: number }).textOutlineOffsetPx === 'number'
						? (candidate as { textOutlineOffsetPx: number }).textOutlineOffsetPx *
							(clampNumber(candidate.textSize, fontSettings.textSize, 1, 96) / 60)
						: undefined),
				1,
				0.1,
				100
			),
			textOutlineDepth: clampNumber(candidate.textOutlineDepth, 1.5, 0.1, 40),
			textOutlineColor:
				typeof candidate.textOutlineColor === 'string'
					? candidate.textOutlineColor
					: '#ffffff',
			keyringEnabled:
				typeof candidate.keyringEnabled === 'boolean'
					? candidate.keyringEnabled
					: (fontSettings.keyringEnabled ?? true),
			keyringOuterSize: clampNumber(
				candidate.keyringOuterSize,
				charSettings.keyringOuterSize,
				0.1,
				100
			),
			keyringHoleSize: clampNumber(
				candidate.keyringHoleSize,
				charSettings.keyringHoleSize,
				0.1,
				100
			),
			keyringOffsetX: clampNumber(candidate.keyringOffsetX, charSettings.keyringOffsetX, -100, 100),
			keyringOffsetY: clampNumber(candidate.keyringOffsetY, charSettings.keyringOffsetY, -100, 100)
		};
	}

	function sanitizeKeychainItem(raw: unknown, fallbackIndex: number): KeychainItem | null {
		if (!raw || typeof raw !== 'object') return null;
		const candidate = raw as Partial<KeychainItem>;
		const rawLines = Array.isArray(candidate.lines) ? candidate.lines : [];
		const fallbackText =
			typeof candidate.settings?.text === 'string' && candidate.settings.text.trim()
				? candidate.settings.text
				: DEFAULT_TEXT;
		const settings = sanitizeKeychainSettings(candidate.settings, fallbackText);
		const lines = rawLines
			.slice(0, MAX_SINGLE_LINES)
			.map((line) => sanitizeSingleLine(line, settings.text))
			.filter((line): line is KeychainTextLine => line !== null);
		const safeLines =
			lines.length > 0 ? lines : [createLineFromSettings(createSingleLineId(), settings)];
		const textValue = safeLines.map((line) => line.content).join('\n');

		return {
			id:
				typeof candidate.id === 'string' && candidate.id
					? candidate.id
					: `migrated-keychain-${fallbackIndex + 1}`,
			settings: { ...settings, text: textValue },
			lines: safeLines,
			lineSpacing: clampNumber(candidate.lineSpacing, loadSingleLineSpacing(), 0, 100)
		};
	}

	function createMigratedKeychainItems(): KeychainItem[] {
		if (restoredMode === 'single') {
			const lines = loadSingleLines(restoredText);
			const textValue = lines.map((line) => line.content).join('\n');
			return [
				{
					id: createKeychainItemId(),
					settings: createInitialResolvedSettings(textValue),
					lines,
					lineSpacing: loadSingleLineSpacing()
				}
			];
		}

		const savedBatchItemSettings = loadBatchItemSettings();
		const items = textItemsFromRestoredText().map((sourceText, index) => {
			const legacyId = createBatchItemId(index, sourceText);
			const settings = createInitialResolvedSettings(
				sourceText,
				savedBatchItemSettings[legacyId] ?? {}
			);
			return {
				id: createKeychainItemId(),
				settings,
				lines: [createLineFromSettings(createSingleLineId(), settings, sourceText)],
				lineSpacing: loadSingleLineSpacing()
			};
		});
		return items.length > 0
			? items
			: [
					{
						id: createKeychainItemId(),
						settings: createInitialResolvedSettings(DEFAULT_TEXT),
						lines: [createDefaultSingleLine(DEFAULT_TEXT)],
						lineSpacing: loadSingleLineSpacing()
					}
				];
	}

	function textItemsFromRestoredText(): string[] {
		return parseTextItems(restoredText);
	}

	function loadKeychainItems(): KeychainItem[] {
		try {
			const raw = localStorage.getItem(STORAGE_KEY_KEYCHAIN_ITEMS);
			if (raw) {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					const items = parsed
						.map((item, index) => sanitizeKeychainItem(item, index))
						.filter((item): item is KeychainItem => item !== null);
					if (items.length > 0) return items;
				}
			}
		} catch {
			// Fall through to legacy migration.
		}
		return createMigratedKeychainItems();
	}

	// ── Reactive state ──────────────────────────────────────────────────────
	let textSize = $state(fontSettings.textSize);
	let outlineOffsetPx = $state(fontSettings.outlineOffsetPx);
	let baseDepth = $state(fontSettings.baseDepth);
	let textDepth = $state(fontSettings.textDepth);
	let textColor = $state(fontSettings.textColor);
	let outlineColor = $state(fontSettings.outlineColor);
	let fontKey = $state(restoredFont);
	let keyringEnabled = $state(fontSettings.keyringEnabled ?? true);
	let keyringOuterSize = $state(charSettings.keyringOuterSize);
	let keyringHoleSize = $state(charSettings.keyringHoleSize);
	let keyringOffsetX = $state(charSettings.keyringOffsetX);
	let keyringOffsetY = $state(charSettings.keyringOffsetY);
	let keychainItems = $state<KeychainItem[]>(loadKeychainItems());
	let selectedItemId = $state<string | null>(null);
	let activeFirstLineInput = $state<HTMLInputElement | null>(null);

	const sharedKeychainSettings = $derived<KeychainResolvedSettings>({
		text: DEFAULT_TEXT,
		fontKey,
		textSize,
		outlineOffsetPx,
		baseDepth,
		textDepth,
		textColor,
		outlineColor,
		textOutlineEnabled: false,
		textOutlineThicknessMm: 1,
		textOutlineDepth: 1.5,
		textOutlineColor: '#ffffff',
		keyringEnabled,
		keyringOuterSize,
		keyringHoleSize,
		keyringOffsetX,
		keyringOffsetY
	});

	const activeEditableItem = $derived(
		keychainItems.find((item) => item.id === selectedItemId) ??
			(keychainItems.length === 1 ? (keychainItems[0] ?? null) : null)
	);
	const activeEditableIndex = $derived(
		activeEditableItem ? keychainItems.findIndex((item) => item.id === activeEditableItem.id) : -1
	);
	const selectedSettings = $derived(activeEditableItem?.settings ?? null);
	const hasSelectedItem = $derived(activeEditableItem !== null && selectedSettings !== null);
	const editableSettings = $derived(selectedSettings ?? sharedKeychainSettings);
	const editableMaxTextSize = $derived(
		Math.max(
			1,
			...(activeEditableItem?.lines.map((line) => line.textSize) ?? [textSize])
		)
	);
	const editableBaseOutlineMm = $derived(
		(editableSettings.outlineOffsetPx * editableMaxTextSize) / 60
	);
	const editableMaxTextOutlineMm = $derived(Math.max(0.2, editableBaseOutlineMm - 0.2));
	const modelItems = $derived.by<KeychainModelItem[]>(() =>
		keychainItems.map((item, index) => {
			const sourceText = getItemText(item);
			return {
				...item,
				index,
				sourceText,
				settings: { ...item.settings, text: sourceText },
				isMultiline: item.lines.length > 1
			};
		})
	);
	const persistedText = $derived(modelItems.map((item) => item.sourceText).join('\n'));

	lastFont = restoredFont;
	lastChar = initialChar;

	function getCurrentChar(): string {
		const primaryText =
			activeEditableItem?.lines.find((line) => line.content.trim())?.content.trim() ??
			keychainItems[0]?.lines.find((line) => line.content.trim())?.content.trim() ??
			'';
		return primaryText.length > 0 ? primaryText.charAt(0).toUpperCase() : '';
	}

	function focusActiveFirstLine() {
		void tick().then(() => {
			activeFirstLineInput?.focus();
			activeFirstLineInput?.select();
		});
	}

	function updateSelectedItemSettings(next: KeychainItemOverrides) {
		const item = activeEditableItem;
		if (!item) return;
		keychainItems = keychainItems.map((candidate) => {
			if (candidate.id !== item.id) return candidate;
			const updated = {
				...candidate,
				settings: {
					...candidate.settings,
					...next,
					text: getItemText(candidate)
				}
			};
			return updated;
		});
	}

	function createKeychainFromActiveDefaults(): KeychainItem {
		const active = activeEditableItem;
		const templateSettings = active?.settings ?? sharedKeychainSettings;
		const templateLine = active?.lines[0];
		const settings = { ...templateSettings, text: DEFAULT_TEXT };
		const line = templateLine
			? { ...templateLine, id: createSingleLineId(), content: DEFAULT_TEXT }
			: createLineFromSettings(createSingleLineId(), settings, DEFAULT_TEXT);

		return {
			id: createKeychainItemId(),
			settings,
			lines: [line],
			lineSpacing: active?.lineSpacing ?? loadSingleLineSpacing()
		};
	}

	function addKeychain() {
		const nextItem = createKeychainFromActiveDefaults();
		keychainItems = [...keychainItems, nextItem];
		selectedItemId = nextItem.id;
		scheduleRebuildMeshes(true);
		updateSelectionOutline();
		focusActiveFirstLine();
	}

	function removeActiveKeychain() {
		const item = activeEditableItem;
		if (!item || keychainItems.length <= 1) return;
		const currentIndex = keychainItems.findIndex((candidate) => candidate.id === item.id);
		const remaining = keychainItems.filter((candidate) => candidate.id !== item.id);
		keychainItems = remaining;
		selectedItemId =
			remaining.length === 1 ? null : (remaining[Math.max(0, currentIndex - 1)]?.id ?? null);
		scheduleRebuildMeshes(true);
		updateSelectionOutline();
	}

	function addActiveLine() {
		const item = activeEditableItem;
		if (!item || item.lines.length >= MAX_SINGLE_LINES) return;
		const last = item.lines[item.lines.length - 1];
		const nextLine = last
			? { ...last, id: createSingleLineId(), content: '' }
			: createLineFromSettings(createSingleLineId(), item.settings, '');
		const nextLines = [...item.lines, nextLine];
		updateActiveLines(item.id, nextLines);
	}

	function removeActiveLine(index: number) {
		const item = activeEditableItem;
		if (!item || item.lines.length <= 1) return;
		updateActiveLines(
			item.id,
			item.lines.filter((_, lineIndex) => lineIndex !== index)
		);
	}

	function moveActiveLine(index: number, delta: -1 | 1) {
		const item = activeEditableItem;
		if (!item) return;
		const target = index + delta;
		if (target < 0 || target >= item.lines.length) return;
		const next = [...item.lines];
		const [line] = next.splice(index, 1);
		next.splice(target, 0, line);
		updateActiveLines(item.id, next);
	}

	function updateActiveLine(index: number, nextLine: Partial<Omit<KeychainTextLine, 'id'>>) {
		const item = activeEditableItem;
		if (!item) return;
		const nextLines = item.lines.map((line, lineIndex) =>
			lineIndex === index ? { ...line, ...nextLine } : line
		);
		updateActiveLines(item.id, nextLines);
	}

	function updateActiveLineSpacing(value: number) {
		const item = activeEditableItem;
		if (!item) return;
		keychainItems = keychainItems.map((candidate) =>
			candidate.id === item.id ? { ...candidate, lineSpacing: value } : candidate
		);
	}

	function updateActiveLines(itemId: string, lines: KeychainTextLine[]) {
		keychainItems = keychainItems.map((candidate) =>
			candidate.id === itemId
				? {
						...candidate,
						lines,
						settings: {
							...candidate.settings,
							text: lines.map((line) => line.content).join('\n')
						}
					}
				: candidate
		);
	}

	// ── Three.js state ──────────────────────────────────────────────────────
	let hostEl: HTMLDivElement | null = null;
	let renderer: any = null;
	let scene: any = null;
	let camera: any = null;
	let controls: any = null;
	let font: any = null;
	let group: any = null;
	let keyLight: any = null;
	let shadowPlane: any = null;
	let rafId = 0;
	let ro: ResizeObserver | null = null;
	let didInitFrame = false;
	let openBambuStudioLoading = $state(false);
	let modelAabbMm = $state<{ x: number; y: number; z: number } | null>(null);
	let selectionOutline: THREE.Box3Helper | null = null;
	let meshRebuildTimeout: ReturnType<typeof setTimeout> | null = null;
	let meshRebuildRaf = 0;
	let persistTimeout: ReturnType<typeof setTimeout> | null = null;
	const raycaster = new THREE.Raycaster();
	const pointerNdc = new THREE.Vector2();
	const pointerDown = new THREE.Vector2();

	// ── Persistence helpers ─────────────────────────────────────────────────
	function loadSettingsForFont(fontName: string) {
		if (!allFontSettings) allFontSettings = {};
		const settings = allFontSettings[fontName] || { ...defaults };
		textSize = settings.textSize;
		outlineOffsetPx = settings.outlineOffsetPx;
		baseDepth = settings.baseDepth;
		textDepth = settings.textDepth;
		textColor = settings.textColor;
		outlineColor = settings.outlineColor;
		if (settings.keyringEnabled !== undefined) keyringEnabled = settings.keyringEnabled;
		if (!allFontSettings[fontName]) allFontSettings[fontName] = { ...defaults };
	}

	function saveSettingsForFont(fontName: string) {
		if (isUpdatingFromStorage || !fontName) return;
		if (!allFontSettings) allFontSettings = {};
		allFontSettings[fontName] = {
			textSize,
			outlineOffsetPx,
			baseDepth,
			textDepth,
			textColor,
			outlineColor,
			keyringEnabled
		};
		try {
			localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(allFontSettings));
		} catch (e) {
			console.error('Failed to save font settings:', e);
		}
	}

	function loadKeyringForChar(fontName: string, char: string) {
		if (!char || !fontName) return;
		const cs = allCharSettings[fontName]?.[char] || DEFAULT_CHAR_SETTINGS;
		keyringOffsetX = cs.keyringOffsetX;
		keyringOffsetY = cs.keyringOffsetY;
		keyringOuterSize = cs.keyringOuterSize;
		keyringHoleSize = cs.keyringHoleSize;
	}

	function saveKeyringForChar(fontName: string, char: string) {
		if (isUpdatingFromStorage || !char || !fontName) return;
		if (!allCharSettings) allCharSettings = {};
		if (!allCharSettings[fontName]) allCharSettings[fontName] = {};
		allCharSettings[fontName][char] = {
			keyringOffsetX,
			keyringOffsetY,
			keyringOuterSize,
			keyringHoleSize
		};
		try {
			localStorage.setItem(STORAGE_KEY_KEYRING, JSON.stringify(allCharSettings));
		} catch (e) {
			console.error('Failed to save keyring settings:', e);
		}
	}

	// ── Scene helpers ───────────────────────────────────────────────────────
	function getSelectableKeychain(object: THREE.Object3D | null): THREE.Group | null {
		let current: THREE.Object3D | null = object;
		while (current && current !== group) {
			if (current.userData?.selectableKeychain) return current as THREE.Group;
			current = current.parent;
		}
		return null;
	}

	function getSelectedKeychainGroup(): THREE.Group | null {
		if (!group || !selectedItemId || modelItems.length <= 1) return null;
		return (
			(group.children.find((child: THREE.Object3D) => child.userData?.itemId === selectedItemId) as
				| THREE.Group
				| undefined) ?? null
		);
	}

	function updateSelectionOutline() {
		if (!scene) return;
		if (modelItems.length <= 1) {
			if (selectionOutline) selectionOutline.visible = false;
			return;
		}
		const selectedGroup = getSelectedKeychainGroup();
		if (!selectedGroup) {
			if (selectionOutline) selectionOutline.visible = false;
			return;
		}

		selectedGroup.updateWorldMatrix(true, true);
		const box = new THREE.Box3().setFromObject(selectedGroup);
		if (!selectionOutline) {
			selectionOutline = new THREE.Box3Helper(box, 0x4f46e5);
			selectionOutline.name = 'selection-outline';
			selectionOutline.renderOrder = 999;
			const material = selectionOutline.material as THREE.LineBasicMaterial;
			material.depthTest = false;
			material.depthWrite = false;
			scene.add(selectionOutline);
		} else {
			selectionOutline.box.copy(box);
		}
		selectionOutline.visible = true;
		selectionOutline.updateMatrixWorld(true);
	}

	function selectFromCanvasPointer(event: PointerEvent) {
		if (!renderer || !camera || !group) return;
		if (modelItems.length <= 1) {
			selectedItemId = null;
			updateSelectionOutline();
			return;
		}
		const canvas = renderer.domElement as HTMLCanvasElement;
		const rect = canvas.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;

		pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointerNdc.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
		raycaster.setFromCamera(pointerNdc, camera);
		const intersections = raycaster.intersectObjects(group.children, true);
		const selectedGroup = getSelectableKeychain(intersections[0]?.object ?? null);
		selectedItemId = selectedGroup?.userData.itemId ?? null;
		updateSelectionOutline();
	}

	function handleCanvasPointerDown(event: PointerEvent) {
		pointerDown.set(event.clientX, event.clientY);
	}

	function handleCanvasPointerUp(event: PointerEvent) {
		const distance = pointerDown.distanceTo(new THREE.Vector2(event.clientX, event.clientY));
		if (distance > 5) return;
		selectFromCanvasPointer(event);
	}

	function resize() {
		if (!renderer || !camera || !hostEl) return;
		const rect = hostEl.getBoundingClientRect();
		const width = Math.max(1, Math.floor(rect.width));
		const height = Math.max(1, Math.floor(rect.height));
		renderer.setSize(width, height, true);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
	}

	// ── Export ───────────────────────────────────────────────────────────────
	function getExportSafeName(): string {
		const raw =
			modelItems.length > 1
				? 'batch-keychains'
				: (modelItems[0]?.lines.find((line) => line.content.trim())?.content.trim() ?? 'model');
		return (
			raw
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/(^-|-$)/g, '') || 'model'
		);
	}

	function getKeychainExportName(item: KeychainModelItem): string {
		return `keychain-${item.index + 1}`;
	}

	function downloadCleanSnapshot() {
		const wasVisible = selectionOutline?.visible ?? false;
		if (selectionOutline) selectionOutline.visible = false;
		downloadSnapshot(renderer, scene, camera, 'keychain');
		if (selectionOutline) selectionOutline.visible = wasVisible;
	}

	function cleanExportRoot(root: THREE.Object3D, liftText: boolean): boolean {
		const nonModelObjects: THREE.Object3D[] = [];
		root.traverse((obj: THREE.Object3D) => {
			const materials = obj instanceof THREE.Mesh ? obj.material : null;
			const hasShadowMaterial = Array.isArray(materials)
				? materials.some((material) => material instanceof THREE.ShadowMaterial)
				: materials instanceof THREE.ShadowMaterial;
			if (
				obj.name === 'selection-outline' ||
				obj instanceof THREE.Box3Helper ||
				obj instanceof THREE.GridHelper ||
				obj instanceof THREE.Light ||
				obj instanceof THREE.Camera ||
				hasShadowMaterial
			) {
				nonModelObjects.push(obj);
				return;
			}
			if (liftText && obj instanceof THREE.Mesh) {
				if (obj.name === 'text') {
					obj.position.z += TEXT_BASE_EMBED;
				} else if (obj.name === 'text-outline') {
					obj.position.z += TEXT_OUTLINE_BASE_EMBED;
				}
			}
		});
		nonModelObjects.forEach((obj) => obj.parent?.remove(obj));
		let meshCount = 0;
		root.traverse((obj: THREE.Object3D) => {
			if (obj instanceof THREE.Mesh) meshCount += 1;
		});
		return meshCount > 0;
	}

	function cloneKeychainAsTopLevelObject(source: THREE.Object3D): THREE.Object3D {
		const clone = source.clone(true);
		clone.matrix.copy(source.matrixWorld);
		clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
		clone.updateWorldMatrix(true, true);
		return clone;
	}

	function createModelExportRoot({
		liftText = false,
		separateTopLevelObjects = false
	}: { liftText?: boolean; separateTopLevelObjects?: boolean } = {}): THREE.Object3D | null {
		if (!group) return null;
		group.updateWorldMatrix(true, true);
		const exportRoot = separateTopLevelObjects
			? new THREE.Scene()
			: (group.clone(true) as THREE.Group);
		exportRoot.name = separateTopLevelObjects ? 'text-outline-3mf-export' : 'text-outline-export';
		exportRoot.userData = {
			exportRoot: true,
			batchObjectCount: modelItems.length,
			textMode: 'object-list',
			separateTopLevelObjects
		};

		if (separateTopLevelObjects) {
			for (const child of group.children) {
				if (!child.userData?.selectableKeychain) continue;
				const exportObject = cloneKeychainAsTopLevelObject(child);
				exportObject.name = child.userData.exportName ?? child.name;
				exportRoot.add(exportObject);
			}
		}

		if (!cleanExportRoot(exportRoot, liftText)) return null;
		exportRoot.updateWorldMatrix(true, true);
		return exportRoot;
	}

	async function exportSTL() {
		if (!group || !scene) return;
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		rebuildMeshes();
		const exportGroup = createModelExportRoot();
		if (!exportGroup) return;
		const exporter = new STLExporter();
		const result = exporter.parse(exportGroup, { binary: true });
		const buffer = result instanceof DataView ? result.buffer : result;
		if (buffer && buffer.byteLength >= 84) {
			const blob = new Blob([buffer], { type: 'model/stl' });
			const safe = getExportSafeName();
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadBlob(`${safe}-${timestamp}.stl`, blob);
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Text Only',
				format: 'stl'
			});
		}
		onShowThankYou();
	}

	async function export3MF() {
		if (!group || !scene) return;
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		rebuildMeshes();
		const exportGroup = createModelExportRoot({ liftText: true, separateTopLevelObjects: true });
		if (!exportGroup) return;
		const blob = await exportTo3MF(exportGroup);
		if (!blob || blob.size === 0) return;
		const safe = getExportSafeName();
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		downloadBlob(`${safe}-multipart-${timestamp}.3mf`, blob);
		notifyExportEvent({
			email: user?.email,
			name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
			subscriptionStatus,
			designName: 'Text Only',
			format: '3mf'
		});
		onShowThankYou();
	}

	async function openWithBambuStudio() {
		if (!group || !scene) return;
		if (!(await ensureExportAccess(user, subscriptionStatus, onShowPricing, onRequestLogin)))
			return;
		openBambuStudioLoading = true;
		await tickThenYieldToPaint();
		try {
			rebuildMeshes();
			const exportGroup = createModelExportRoot({ liftText: true, separateTopLevelObjects: true });
			if (!exportGroup) return;
			const blob = await exportTo3MF(exportGroup);
			if (!blob || blob.size === 0) return;
			const publicUrl = await upload3mfToSupabase(blob, 'textonly');
			notifyExportEvent({
				email: user?.email,
				name: (user?.user_metadata?.full_name as string) ?? (user?.user_metadata?.name as string),
				subscriptionStatus,
				designName: 'Text Only',
				format: 'bambu_studio'
			});
			window.location.href = `bambustudioopen://${encodeURIComponent(publicUrl)}`;
		} catch (err) {
			console.error('Open with Bambu Studio failed:', err);
		} finally {
			openBambuStudioLoading = false;
		}
	}

	function clearScheduledMeshRebuild() {
		if (meshRebuildTimeout !== null) {
			clearTimeout(meshRebuildTimeout);
			meshRebuildTimeout = null;
		}
		if (meshRebuildRaf) {
			cancelAnimationFrame(meshRebuildRaf);
			meshRebuildRaf = 0;
		}
	}

	/** Coalesce rapid setting changes so sliders stay responsive during drag. */
	function scheduleRebuildMeshes(immediate = false) {
		if (!scene || !group) return;
		clearScheduledMeshRebuild();
		if (immediate) {
			rebuildMeshes();
			return;
		}
		meshRebuildRaf = requestAnimationFrame(() => {
			meshRebuildRaf = 0;
			meshRebuildTimeout = setTimeout(() => {
				meshRebuildTimeout = null;
				rebuildMeshes();
			}, MESH_REBUILD_DEBOUNCE_MS);
		});
	}

	// ── Rebuild meshes (outline only) ───────────────────────────────────────
	function rebuildMeshes() {
		if (!scene || !group || !font) return;
		disposeObject3D(group);
		group.clear();
		group.position.set(0, 0, 0);
		modelAabbMm = null;

		const divisions = 18;
		const SCALE = 1000;

		const shapeToPaths = (shape: any) => {
			const toPath = (pts: any[]) => {
				const out: any[] = [];
				for (const p of pts)
					out.push({
						X: Math.round(p.x * SCALE),
						Y: Math.round(p.y * SCALE)
					});
				if (out.length > 2) {
					const a = out[0];
					const b = out[out.length - 1];
					if (a.X === b.X && a.Y === b.Y) out.pop();
				}
				return out;
			};
			const outer = toPath(shape.getPoints(divisions));
			const holes = (shape.holes || []).map((h: any) => toPath(h.getPoints(divisions)));
			return { outer, holes };
		};

		const ensureCW = (path: any[], clockwise: boolean) => {
			const isCW = ClipperLib.Clipper.Orientation(path);
			if (isCW !== clockwise) path.reverse();
		};

		const buildKeychainGroup = (item: KeychainModelItem): THREE.Group | null => {
			const settings = item.settings;

			const cloneTranslatedPath = (path: any[], dx: number, dy: number) =>
				path.map((point) => ({
					X: Math.round(point.X + dx * SCALE),
					Y: Math.round(point.Y + dy * SCALE)
				}));
			const getPathsBbox = (paths: any[]) => {
				let minX = Infinity,
					maxX = -Infinity,
					minY = Infinity,
					maxY = -Infinity;
				for (const path of paths) {
					for (const point of path) {
						minX = Math.min(minX, point.X);
						maxX = Math.max(maxX, point.X);
						minY = Math.min(minY, point.Y);
						maxY = Math.max(maxY, point.Y);
					}
				}
				return {
					minX: minX / SCALE,
					maxX: maxX / SCALE,
					minY: minY / SCALE,
					maxY: maxY / SCALE
				};
			};
			const buildFilledTree = (paths: any[]) => {
				const tree = new ClipperLib.PolyTree();
				const clipper = new ClipperLib.Clipper();
				clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
				clipper.Execute(
					ClipperLib.ClipType.ctUnion,
					tree,
					ClipperLib.PolyFillType.pftNonZero,
					ClipperLib.PolyFillType.pftNonZero
				);
				return tree;
			};
			const buildUnionOffsetTree = (paths: any[], offsetWorld: number) => {
				const tree = new ClipperLib.PolyTree();
				if (offsetWorld > 0) {
					const co = new ClipperLib.ClipperOffset(2, 2);
					co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
					const offsetPaths: any[] = [];
					co.Execute(offsetPaths, offsetWorld * SCALE);
					const clipper = new ClipperLib.Clipper();
					clipper.AddPaths(offsetPaths, ClipperLib.PolyType.ptSubject, true);
					clipper.Execute(
						ClipperLib.ClipType.ctUnion,
						tree,
						ClipperLib.PolyFillType.pftNonZero,
						ClipperLib.PolyFillType.pftNonZero
					);
				} else {
					const clipper = new ClipperLib.Clipper();
					clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
					clipper.Execute(
						ClipperLib.ClipType.ctUnion,
						tree,
						ClipperLib.PolyFillType.pftNonZero,
						ClipperLib.PolyFillType.pftNonZero
					);
				}
				return tree;
			};
			const collectOuterPaths = (node: any, out: any[]) => {
				const isHole = node.IsHole?.() ?? node.m_IsHole;
				if (isHole) return;
				const contour = node.Contour?.() ?? node.m_polygon ?? [];
				if (contour.length >= 3) out.push(contour);
				const childs = node.Childs?.() ?? node.m_Childs ?? [];
				childs.forEach((child: any) => collectOuterPaths(child, out));
			};
			const getTreeBbox = (tree: any) => {
				let minX = Infinity,
					maxX = -Infinity,
					minY = Infinity,
					maxY = -Infinity;
				const collect = (node: any) => {
					const contour = node.Contour?.() ?? node.m_polygon ?? [];
					for (const point of contour) {
						minX = Math.min(minX, point.X);
						maxX = Math.max(maxX, point.X);
						minY = Math.min(minY, point.Y);
						maxY = Math.max(maxY, point.Y);
					}
					const childs = node.Childs?.() ?? node.m_Childs ?? [];
					childs.forEach(collect);
				};
				const roots = tree.Childs?.() ?? tree.m_Childs ?? [];
				roots.forEach(collect);
				return { minX, maxX, minY, maxY };
			};
			const getTreeCenter = (tree: any) => {
				const bbox = getTreeBbox(tree);
				return {
					x: (bbox.minX + bbox.maxX) / 2 / SCALE,
					y: (bbox.minY + bbox.maxY) / 2 / SCALE
				};
			};

			const rawLineEntries: Array<{
				line: KeychainTextLine;
				paths: any[];
				height: number;
				centerX: number;
				centerY: number;
			}> = [];
			for (const line of item.lines) {
				const content = line.content.trim();
				if (!content) continue;
				const itemFont = getFont(line.fontKey);
				const size = Math.max(1, Math.round(line.textSize));
				const shapes = itemFont.generateShapes(content, size);
				const rawPaths: any[] = [];
				for (const shape of shapes) {
					const { outer, holes } = shapeToPaths(shape);
					if (outer.length < 3) continue;
					ensureCW(outer, true);
					rawPaths.push(outer);
					for (const hole of holes) {
						if (hole.length < 3) continue;
						ensureCW(hole, false);
						rawPaths.push(hole);
					}
				}
				if (rawPaths.length === 0) continue;
				const bbox = getPathsBbox(rawPaths);
				rawLineEntries.push({
					line,
					paths: rawPaths,
					height: Math.max(0.001, bbox.maxY - bbox.minY),
					centerX: (bbox.minX + bbox.maxX) / 2,
					centerY: (bbox.minY + bbox.maxY) / 2
				});
			}
			if (rawLineEntries.length === 0) return null;

			const inputPaths: any[] = [];
			const lineEntries: Array<{ line: KeychainTextLine; filledTree: any }> = [];
			const gap = item.isMultiline ? Math.max(0, item.lineSpacing) : 0;
			const totalHeight =
				rawLineEntries.reduce((sum, entry) => sum + entry.height, 0) +
				Math.max(0, rawLineEntries.length - 1) * gap;
			let cursorY = totalHeight / 2;
			let maxLineSize = 1;
			for (const entry of rawLineEntries) {
				const yCenter = cursorY - entry.height / 2;
				cursorY -= entry.height + gap;
				const dx = -entry.centerX + entry.line.offsetX;
				const dy = yCenter - entry.centerY + entry.line.offsetY;
				const translatedPaths = entry.paths.map((path) => cloneTranslatedPath(path, dx, dy));
				inputPaths.push(...translatedPaths);
				lineEntries.push({ line: entry.line, filledTree: buildFilledTree(translatedPaths) });
				maxLineSize = Math.max(maxLineSize, entry.line.textSize);
			}
			if (inputPaths.length === 0) return null;
			const textBounds = getPathsBbox(inputPaths);
			const hasTextBounds =
				isFiniteNumber(textBounds.minX) &&
				isFiniteNumber(textBounds.maxX) &&
				isFiniteNumber(textBounds.minY) &&
				isFiniteNumber(textBounds.maxY);

			const outlineWorld = Math.max(0, settings.outlineOffsetPx) * (maxLineSize / 60);
			const outlineTree = buildUnionOffsetTree(inputPaths, outlineWorld);
			const textCenter = hasTextBounds
				? {
						x: (textBounds.minX + textBounds.maxX) / 2,
						y: (textBounds.minY + textBounds.maxY) / 2
					}
				: getTreeCenter(buildFilledTree(inputPaths));
			const maxTextOutlineMm = Math.max(0.1, outlineWorld - 0.1);
			const textOutlineWorld =
				settings.textOutlineEnabled && settings.textOutlineThicknessMm > 0
					? Math.min(Math.max(0.1, settings.textOutlineThicknessMm), maxTextOutlineMm)
					: 0;
			const textOutlineTree =
				textOutlineWorld > 0 ? buildUnionOffsetTree(inputPaths, textOutlineWorld) : null;
			const textOutlineCenter = textOutlineTree ? getTreeCenter(textOutlineTree) : textCenter;

			let baseTree: any = outlineTree;
			const outlineCenter = getTreeCenter(outlineTree);
			let combinedCenter = outlineCenter;
			if (settings.keyringEnabled) {
				const circleToPath = (cx: number, cy: number, r: number, clockwise: boolean, segs = 64) => {
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
				let textAnchorX = textBounds.minX - 4;
				let textAnchorY = textBounds.maxY;
				if (!hasTextBounds) {
					const outlineBbox = getTreeBbox(outlineTree);
					textAnchorX = outlineBbox.minX / SCALE;
					textAnchorY = outlineBbox.maxY / SCALE;
				}
				const kx = textAnchorX + settings.keyringOffsetX;
				const ky = textAnchorY + settings.keyringOffsetY;
				const outerR = Math.max(0.1, settings.keyringOuterSize / 2);
				const innerR = Math.min(Math.max(0.05, settings.keyringHoleSize / 2), outerR - 0.1);
				const outerCircle = circleToPath(kx, ky, outerR, true);
				const innerCircle = circleToPath(kx, ky, innerR, false);
				if (outerCircle && innerCircle) {
					const outlinePaths: any[] = [];
					const roots = outlineTree.Childs?.() ?? outlineTree.m_Childs ?? [];
					roots.forEach((n: any) => collectOuterPaths(n, outlinePaths));
					const unionTree = new ClipperLib.PolyTree();
					const unionC = new ClipperLib.Clipper();
					outlinePaths.forEach((p) => unionC.AddPath(p, ClipperLib.PolyType.ptSubject, true));
					unionC.AddPath(outerCircle, ClipperLib.PolyType.ptSubject, true);
					unionC.Execute(
						ClipperLib.ClipType.ctUnion,
						unionTree,
						ClipperLib.PolyFillType.pftNonZero,
						ClipperLib.PolyFillType.pftNonZero
					);
					const diffTree = new ClipperLib.PolyTree();
					const diffPaths: any[] = [];
					const unionRoots = unionTree.Childs?.() ?? unionTree.m_Childs ?? [];
					unionRoots.forEach((n: any) => collectOuterPaths(n, diffPaths));
					const diffC = new ClipperLib.Clipper();
					diffPaths.forEach((p) => diffC.AddPath(p, ClipperLib.PolyType.ptSubject, true));
					diffC.AddPath(innerCircle, ClipperLib.PolyType.ptClip, true);
					diffC.Execute(
						ClipperLib.ClipType.ctDifference,
						diffTree,
						ClipperLib.PolyFillType.pftNonZero,
						ClipperLib.PolyFillType.pftNonZero
					);
					baseTree = diffTree;
					combinedCenter = getTreeCenter(baseTree);
				}
			}

			const polyTreeToThreeShapes = (tree: any) => {
				const shapesOut: any[] = [];
				const toVec2 = (pt: any) => new THREE.Vector2(pt.X / SCALE, pt.Y / SCALE);
				const buildFromOuter = (outerNode: any) => {
					const contour = outerNode.Contour?.() ?? outerNode.m_polygon ?? [];
					if (!contour || contour.length < 3) return null;
					// Three.js ExtrudeGeometry expects outer CCW and holes CW
					const outerPts = contour.map(toVec2);
					if (THREE.ShapeUtils.isClockWise(outerPts)) outerPts.reverse();
					const shape = new THREE.Shape(outerPts);
					const children = outerNode.Childs?.() ?? outerNode.m_Childs ?? [];
					for (const ch of children) {
						const isHole = ch.IsHole?.() ?? ch.m_IsHole;
						if (!isHole) continue;
						const holeContour = ch.Contour?.() ?? ch.m_polygon ?? [];
						if (holeContour.length >= 3) {
							const holePts = holeContour.map(toVec2);
							if (!THREE.ShapeUtils.isClockWise(holePts)) holePts.reverse();
							shape.holes.push(new THREE.Path(holePts));
						}
						const holeKids = ch.Childs?.() ?? ch.m_Childs ?? [];
						for (const hk of holeKids) {
							const hkIsHole = hk.IsHole?.() ?? hk.m_IsHole;
							if (!hkIsHole) shapesOut.push(buildFromOuter(hk));
						}
					}
					return shape;
				};
				const roots = tree.Childs?.() ?? tree.m_Childs ?? [];
				for (const n of roots) {
					const isHole = n.IsHole?.() ?? n.m_IsHole;
					if (isHole) continue;
					const s = buildFromOuter(n);
					if (s) shapesOut.push(s);
				}
				return shapesOut;
			};

			const baseShapes = polyTreeToThreeShapes(baseTree);
			const textOutlineShapes =
				textOutlineTree !== null ? polyTreeToThreeShapes(textOutlineTree) : [];
			const textLineShapes = lineEntries
				.map((entry, index) => ({
					line: entry.line,
					index,
					shapes: polyTreeToThreeShapes(entry.filledTree)
				}))
				.filter((entry) => entry.shapes.length > 0);
			if (baseShapes.length === 0 || textLineShapes.length === 0) return null;

			const baseMat = new THREE.MeshStandardMaterial({
				color: settings.outlineColor,
				roughness: 0.85,
				metalness: 0.05
			});

			const baseGeo = new THREE.ExtrudeGeometry(baseShapes, {
				depth: Math.max(0.1, settings.baseDepth),
				bevelEnabled: false,
				curveSegments: 12
			});
			centerGeometryXY(baseGeo);
			baseGeo.translate(combinedCenter.x - outlineCenter.x, combinedCenter.y - outlineCenter.y, 0);

			const baseMesh = new THREE.Mesh(baseGeo, baseMat);
			baseMesh.name = 'base';
			const exportName = getKeychainExportName(item);
			baseMesh.userData = {
				partName: 'base',
				parentObjectName: exportName,
				itemId: item.id,
				itemIndex: item.index
			};
			baseMesh.castShadow = true;
			baseMesh.receiveShadow = true;
			baseMesh.position.z = 0;
			const itemGroup = new THREE.Group();
			itemGroup.name = exportName;
			itemGroup.userData = {
				selectableKeychain: true,
				itemId: item.id,
				itemIndex: item.index,
				exportName,
				modelName: exportName,
				sourceText: item.sourceText
			};
			itemGroup.add(baseMesh);

			const baseDepthMm = Math.max(0.1, settings.baseDepth);
			const textOutlineDepthMm = Math.max(0.1, settings.textOutlineDepth);
			const hasTextOutlineLayer =
				settings.textOutlineEnabled && textOutlineShapes.length > 0 && textOutlineWorld > 0;
			let textStackZ = baseDepthMm;

			if (hasTextOutlineLayer) {
				const textOutlineMat = new THREE.MeshStandardMaterial({
					color: settings.textOutlineColor,
					roughness: 0.55,
					metalness: 0.08
				});
				const textOutlineGeo = new THREE.ExtrudeGeometry(textOutlineShapes, {
					depth: textOutlineDepthMm,
					bevelEnabled: false,
					curveSegments: 12
				});
				textOutlineGeo.translate(
					textCenter.x - textOutlineCenter.x,
					textCenter.y - textOutlineCenter.y,
					0
				);
				const textOutlineMesh = new THREE.Mesh(textOutlineGeo, textOutlineMat);
				textOutlineMesh.name = 'text-outline';
				textOutlineMesh.userData = {
					partName: 'text-outline',
					parentObjectName: exportName,
					itemId: item.id,
					itemIndex: item.index
				};
				textOutlineMesh.castShadow = true;
				textOutlineMesh.receiveShadow = true;
				textOutlineMesh.position.z = baseDepthMm - TEXT_OUTLINE_BASE_EMBED;
				itemGroup.add(textOutlineMesh);
				textStackZ = baseDepthMm - TEXT_OUTLINE_BASE_EMBED + textOutlineDepthMm;
			}

			textLineShapes.forEach((entry) => {
				const textMat = new THREE.MeshStandardMaterial({
					color: entry.line.textColor,
					roughness: 0.35,
					metalness: 0.1
				});
				const textGeo = new THREE.ExtrudeGeometry(entry.shapes, {
					depth: Math.max(0.1, entry.line.textDepth),
					bevelEnabled: false
				});
				textGeo.translate(-textCenter.x, -textCenter.y, 0);
				const textMesh = new THREE.Mesh(textGeo, textMat);
				textMesh.name = 'text';
				textMesh.userData = {
					partName: item.isMultiline ? `text-line-${entry.index + 1}` : 'text',
					parentObjectName: exportName,
					itemId: item.id,
					itemIndex: item.index,
					lineId: entry.line.id,
					lineIndex: entry.index
				};
				textMesh.castShadow = true;
				textMesh.receiveShadow = true;
				textMesh.position.z = textStackZ - TEXT_BASE_EMBED;
				itemGroup.add(textMesh);
			});
			return itemGroup;
		};

		const itemModels = modelItems
			.map((item) => ({ item, itemGroup: buildKeychainGroup(item) }))
			.filter(
				(model): model is { item: KeychainModelItem; itemGroup: THREE.Group } =>
					model.itemGroup !== null
			)
			.map(({ item, itemGroup }) => {
				itemGroup.updateWorldMatrix(true, true);
				const itemBox = new THREE.Box3().setFromObject(itemGroup);
				const sizeVec = new THREE.Vector3();
				const center = new THREE.Vector3();
				itemBox.getSize(sizeVec);
				itemBox.getCenter(center);
				return { item, itemGroup, sizeVec, center };
			});

		if (itemModels.length === 0) {
			updateSelectionOutline();
			return;
		}

		const columns = Math.ceil(Math.sqrt(itemModels.length));
		const rows: Array<Array<(typeof itemModels)[number]>> = [];
		for (let i = 0; i < itemModels.length; i += columns) {
			rows.push(itemModels.slice(i, i + columns));
		}

		const rowMetrics = rows.map((row) => ({
			width: row.reduce(
				(sum, item, index) => sum + item.sizeVec.x + (index > 0 ? BATCH_ITEM_SPACING : 0),
				0
			),
			height: Math.max(...row.map((item) => item.sizeVec.y))
		}));
		const totalHeight = rowMetrics.reduce(
			(sum, row, index) => sum + row.height + (index > 0 ? BATCH_ITEM_SPACING : 0),
			0
		);
		let cursorY = totalHeight / 2;
		rows.forEach((row, rowIndex) => {
			const rowMetric = rowMetrics[rowIndex];
			const rowY = cursorY - rowMetric.height / 2;
			let cursorX = -rowMetric.width / 2;
			row.forEach((item) => {
				const itemX = cursorX + item.sizeVec.x / 2;
				item.itemGroup.position.set(itemX - item.center.x, rowY - item.center.y, 0);
				group.add(item.itemGroup);
				cursorX += item.sizeVec.x + BATCH_ITEM_SPACING;
			});
			cursorY -= rowMetric.height + BATCH_ITEM_SPACING;
		});

		// Shadow camera
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
			cam.updateProjectionMatrix?.();
			keyLight.target.position.copy(center);
			keyLight.target.updateWorldMatrix?.(true, true);
		}
		if (!didInitFrame) {
			frameCameraToObject(box, camera, controls);
			didInitFrame = true;
		}
		{
			const s = measureWorldAabbSizeMm(group);
			modelAabbMm = s ? { x: s.x, y: s.y, z: s.z } : null;
		}
		updateSelectionOutline();
	}

	// ── Lifecycle ───────────────────────────────────────────────────────────
	onMount(() => {
		if (!hostEl) return;
		isUpdatingFromStorage = true;
		if (!allFontSettings[fontKey]) allFontSettings[fontKey] = { ...defaults };
		font = getFont(fontKey);

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
		renderer.domElement.addEventListener('pointerdown', handleCanvasPointerDown);
		renderer.domElement.addEventListener('pointerup', handleCanvasPointerUp);
		controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.08;
		controls.screenSpacePanning = false;
		controls.minDistance = 50;
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
		shadowPlane = new THREE.Mesh(
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
		setTimeout(() => {
			isUpdatingFromStorage = false;
		}, 0);
		const tick = () => {
			rafId = requestAnimationFrame(tick);
			controls?.update();
			renderer?.render(scene!, camera!);
		};
		tick();
		return () => {
			renderer?.domElement.removeEventListener('pointerdown', handleCanvasPointerDown);
			renderer?.domElement.removeEventListener('pointerup', handleCanvasPointerUp);
			ro?.disconnect();
			ro = null;
		};
	});

	// ── Effects ─────────────────────────────────────────────────────────────

	// Persist the new object-list state and legacy text mirrors for older sessions.
	$effect(() => {
		void keychainItems;
		void persistedText;
		void modelItems;

		if (persistTimeout !== null) clearTimeout(persistTimeout);
		persistTimeout = setTimeout(() => {
			persistTimeout = null;
			try {
				localStorage.setItem(STORAGE_KEY_KEYCHAIN_ITEMS, JSON.stringify(keychainItems));
				localStorage.setItem(STORAGE_KEY_BATCH_TEXT, persistedText);
				localStorage.setItem(STORAGE_KEY_TEXT, modelItems[0]?.sourceText.trim() ?? '');
			} catch {
				// Local storage can be unavailable in private browsing contexts.
			}
		}, PERSIST_DEBOUNCE_MS);

		return () => {
			if (persistTimeout !== null) {
				clearTimeout(persistTimeout);
				persistTimeout = null;
			}
		};
	});
	$effect(() => {
		try {
			localStorage.setItem(STORAGE_KEY_FONT, fontKey);
		} catch {
			// Local storage can be unavailable in private browsing contexts.
		}
	});
	$effect(() => {
		const selectedId = selectedItemId;
		const ids = new Set(keychainItems.map((item) => item.id));
		if (keychainItems.length <= 1 && selectedId) selectedItemId = null;
		if (selectedId && !ids.has(selectedId)) selectedItemId = null;
		updateSelectionOutline();
	});

	$effect(() => {
		const currentFont = fontKey;
		const currentChar = getCurrentChar();
		if (currentFont !== lastFont) {
			if (lastFont && lastChar) {
				const wasUpdating = isUpdatingFromStorage;
				isUpdatingFromStorage = false;
				saveSettingsForFont(lastFont);
				saveKeyringForChar(lastFont, lastChar);
				isUpdatingFromStorage = wasUpdating;
			}
			isUpdatingFromStorage = true;
			lastFont = currentFont;
			loadSettingsForFont(currentFont);
			if (currentChar) {
				loadKeyringForChar(currentFont, currentChar);
				lastChar = currentChar;
			}
			setTimeout(() => {
				isUpdatingFromStorage = false;
			}, 0);
			if (scene) {
				font = getFont(fontKey);
				scheduleRebuildMeshes(true);
			}
		}
	});

	$effect(() => {
		const currentChar = getCurrentChar();
		const currentFont = fontKey;
		if (currentChar !== lastChar && currentFont) {
			if (lastChar) {
				const wasUpdating = isUpdatingFromStorage;
				isUpdatingFromStorage = false;
				saveKeyringForChar(currentFont, lastChar);
				isUpdatingFromStorage = wasUpdating;
			}
			isUpdatingFromStorage = true;
			lastChar = currentChar;
			if (currentChar) loadKeyringForChar(currentFont, currentChar);
			setTimeout(() => {
				isUpdatingFromStorage = false;
			}, 0);
		}
	});

	$effect(() => {
		if (isUpdatingFromStorage || !fontKey) return;
		void textSize;
		void outlineOffsetPx;
		void baseDepth;
		void textDepth;
		void textColor;
		void outlineColor;
		void keyringEnabled;
		saveSettingsForFont(fontKey);
	});

	$effect(() => {
		if (isUpdatingFromStorage) return;
		const currentChar = getCurrentChar();
		const currentFont = fontKey;
		void keyringOffsetX;
		void keyringOffsetY;
		void keyringOuterSize;
		void keyringHoleSize;
		if (currentChar && currentFont) saveKeyringForChar(currentFont, currentChar);
	});

	$effect(() => {
		void keychainItems;
		if (!scene) return;
		scheduleRebuildMeshes();
		return () => clearScheduledMeshRebuild();
	});

	onDestroy(() => {
		clearScheduledMeshRebuild();
		if (persistTimeout !== null) {
			clearTimeout(persistTimeout);
			persistTimeout = null;
		}
		cancelAnimationFrame(rafId);
		rafId = 0;
		ro?.disconnect();
		ro = null;
		if (group) {
			disposeObject3D(group);
			group.clear();
		}
		if (selectionOutline) {
			scene?.remove(selectionOutline);
			(selectionOutline.material as THREE.Material).dispose();
			selectionOutline = null;
		}
		controls?.dispose();
		controls = null;
		if (renderer && hostEl && renderer.domElement.parentElement === hostEl)
			hostEl.removeChild(renderer.domElement);
		renderer?.dispose();
		renderer = null;
		scene = null;
		camera = null;
		font = null;
		group = null;
	});
</script>

<main class="h-dvh w-dvw bg-slate-50 p-4">
	<div class="mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col gap-4 lg:flex-row">
		<aside
			class="flex min-h-0 w-full max-w-[360px] min-w-[320px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_12px_30px_rgba(15,23,42,0.07)]"
		>
			<div class="flex shrink-0 items-center justify-between p-4">
				<h1 class="text-lg font-semibold tracking-tight text-slate-900">Text Only</h1>
				<Button variant="outline" size="sm" onclick={onBack}>Back</Button>
			</div>

			<div class="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto p-4 pt-0">
				<div class="grid grid-cols-1 gap-4">
					<div class="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3">
						<div class="flex items-start justify-between gap-3">
							<div>
								<div class="text-xs font-semibold tracking-tight text-slate-700">Keychains</div>
								<div class="mt-0.5 text-[11px] text-slate-500">
									{#if keychainItems.length === 1}
										The only keychain is active automatically.
									{:else if activeEditableItem && activeEditableIndex >= 0}
										Editing keychain {activeEditableIndex + 1} of {keychainItems.length}.
									{:else}
										Select a keychain in the preview to edit it.
									{/if}
								</div>
							</div>
							<span class="shrink-0 text-xs text-slate-500 tabular-nums">
								{keychainItems.length} object{keychainItems.length === 1 ? '' : 's'}
							</span>
						</div>
						<div class="grid grid-cols-2 gap-2">
							<Button variant="outline" size="sm" onclick={addKeychain}>+ Add keychain</Button>
							<Button
								variant="outline"
								size="sm"
								class="text-red-600 hover:bg-red-50 hover:text-red-700"
								onclick={removeActiveKeychain}
								disabled={!activeEditableItem || keychainItems.length <= 1}
							>
								Remove active
							</Button>
						</div>
					</div>

					{#if activeEditableItem}
						<div
							class="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-3"
						>
							<div class="flex items-center justify-between">
								<div class="text-xs font-semibold tracking-tight text-slate-700">
									Active keychain lines
								</div>
								<span class="text-xs text-slate-500"
									>{activeEditableItem.lines.length} of {MAX_SINGLE_LINES}</span
								>
							</div>

							{#each activeEditableItem.lines as line, i (line.id)}
								<div class="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
									<div class="mb-2 flex items-center justify-between">
										<span class="text-[11px] font-semibold tracking-wide text-slate-500 uppercase"
											>Line {i + 1}</span
										>
										<div class="flex items-center gap-1">
											<Button
												variant="outline"
												size="xs"
												class="h-7 px-2"
												title="Move up"
												aria-label="Move line up"
												disabled={i === 0}
												onclick={() => moveActiveLine(i, -1)}
											>
												Up
											</Button>
											<Button
												variant="outline"
												size="xs"
												class="h-7 px-2"
												title="Move down"
												aria-label="Move line down"
												disabled={i === activeEditableItem.lines.length - 1}
												onclick={() => moveActiveLine(i, 1)}
											>
												Down
											</Button>
											<Button
												variant="outline"
												size="xs"
												class="h-7 px-2 text-red-600 hover:bg-red-50 hover:text-red-700"
												title="Remove line"
												aria-label="Remove line"
												disabled={activeEditableItem.lines.length <= 1}
												onclick={() => removeActiveLine(i)}
											>
												X
											</Button>
										</div>
									</div>

									<label class="grid gap-1.5">
										<span class="text-xs font-medium text-slate-700">Content</span>
										<input
											class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-indigo-500/25 outline-none focus:border-indigo-400 focus:ring-2"
											type="text"
											bind:this={activeFirstLineInput}
											value={line.content}
											placeholder={i === 0 ? 'Name' : 'Subtitle'}
											oninput={(event) =>
												updateActiveLine(i, {
													content: (event.currentTarget as HTMLInputElement).value
												})}
										/>
									</label>

									<label class="mt-2 grid gap-1.5">
										<span class="text-xs font-medium text-slate-700">Font</span>
										<FontSelect
											value={line.fontKey}
											onValueChange={(value) => updateActiveLine(i, { fontKey: value })}
										/>
									</label>

									<div class="mt-2 grid grid-cols-2 gap-3">
										<label class="grid gap-1.5">
											<div class="flex items-center justify-between gap-2">
												<span class="text-xs font-medium text-slate-700">Size</span>
												<span class="text-xs text-slate-600 tabular-nums">{line.textSize}</span>
											</div>
											<Slider
												type="single"
												value={line.textSize}
												onValueChange={(value: number) => updateActiveLine(i, { textSize: value })}
												min={2}
												max={72}
												step={0.5}
												class="w-full"
											/>
										</label>
										<label class="grid gap-1.5">
											<div class="flex items-center justify-between gap-2">
												<span class="text-xs font-medium text-slate-700">Depth</span>
												<span class="text-xs text-slate-600 tabular-nums">{line.textDepth}</span>
											</div>
											<Slider
												type="single"
												value={line.textDepth}
												onValueChange={(value: number) => updateActiveLine(i, { textDepth: value })}
												min={0.2}
												max={20}
												step={0.1}
												class="w-full"
											/>
										</label>
									</div>

									{#if activeEditableItem.lines.length > 1}
										<div class="mt-2 grid grid-cols-2 gap-3">
											<label class="grid gap-1.5">
												<div class="flex items-center justify-between gap-2">
													<span class="text-xs font-medium text-slate-700">Pos X</span>
													<span class="text-xs text-slate-600 tabular-nums">{line.offsetX}</span>
												</div>
												<Slider
													type="single"
													value={line.offsetX}
													onValueChange={(value: number) => updateActiveLine(i, { offsetX: value })}
													min={-40}
													max={40}
													step={0.5}
													class="w-full"
												/>
											</label>
											<label class="grid gap-1.5">
												<div class="flex items-center justify-between gap-2">
													<span class="text-xs font-medium text-slate-700">Pos Y</span>
													<span class="text-xs text-slate-600 tabular-nums">{line.offsetY}</span>
												</div>
												<Slider
													type="single"
													value={line.offsetY}
													onValueChange={(value: number) => updateActiveLine(i, { offsetY: value })}
													min={-40}
													max={40}
													step={0.5}
													class="w-full"
												/>
											</label>
										</div>
									{/if}

									<div class="mt-2">
										<ColorPalettePicker
											value={line.textColor}
											onValueChange={(value: string) => updateActiveLine(i, { textColor: value })}
											{palette}
											label="Text color"
										/>
									</div>
								</div>
							{/each}

							<Button
								variant="outline"
								size="sm"
								class="w-full"
								onclick={addActiveLine}
								disabled={activeEditableItem.lines.length >= MAX_SINGLE_LINES}
							>
								+ Add line
							</Button>

							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Line spacing</span>
									<span class="text-xs text-slate-600 tabular-nums"
										>{activeEditableItem.lineSpacing}</span
									>
								</div>
								<Slider
									type="single"
									value={activeEditableItem.lineSpacing}
									onValueChange={(value: number) => updateActiveLineSpacing(value)}
									min={0}
									max={20}
									step={0.1}
									class="w-full"
								/>
							</label>
						</div>
					{/if}

					<div
						class={`grid grid-cols-1 gap-4 rounded-2xl border p-3 transition ${
							hasSelectedItem
								? 'border-slate-200 bg-slate-50/60'
								: 'border-dashed border-slate-200 bg-slate-50/60 opacity-70'
						}`}
					>
						<div>
							<div class="text-xs font-semibold tracking-tight text-slate-700">Object settings</div>
							<div class="mt-0.5 text-[11px] text-slate-500">
								{#if activeEditableItem}
									{#if keychainItems.length === 1}
										Editing the only keychain. Changes affect this object.
									{:else}
										Editing keychain {activeEditableIndex + 1}. Changes affect only this object.
									{/if}
								{:else}
									Select a keychain in the preview to edit its settings.
								{/if}
							</div>
						</div>

						<label class="grid gap-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-xs font-medium text-slate-700">Base outline thickness</span>
								<span class="text-xs text-slate-600 tabular-nums"
									>{editableSettings.outlineOffsetPx}px</span
								>
							</div>
							<Slider
								type="single"
								value={editableSettings.outlineOffsetPx}
								onValueChange={(value: number) => {
									const next: KeychainItemOverrides = { outlineOffsetPx: value };
									const baseMm = (value * editableMaxTextSize) / 60;
									if (
										editableSettings.textOutlineEnabled &&
										editableSettings.textOutlineThicknessMm >= baseMm
									) {
										next.textOutlineThicknessMm = Math.max(0.2, baseMm - 0.2);
									}
									updateSelectedItemSettings(next);
								}}
								min={5}
								max={30}
								step={1}
								disabled={!hasSelectedItem}
								class="w-full"
							/>
						</label>

						<div class="grid grid-cols-1 gap-3">
							<ColorPalettePicker
								value={editableSettings.outlineColor}
								onValueChange={(value: string) =>
									updateSelectedItemSettings({ outlineColor: value })}
								{palette}
								label="Base outline color"
								disabled={!hasSelectedItem}
							/>
						</div>

						<div class="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white/70 p-3">
							<div class="flex items-center justify-between gap-2">
								<div class="text-xs font-semibold tracking-tight text-slate-700">Text outline</div>
								<label class="flex items-center gap-2 text-xs font-medium text-slate-700">
									<input
										class="h-4 w-4 accent-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
										type="checkbox"
										checked={editableSettings.textOutlineEnabled}
										onchange={(event) =>
											updateSelectedItemSettings({
												textOutlineEnabled: (event.currentTarget as HTMLInputElement).checked
											})}
										disabled={!hasSelectedItem}
									/>
									Enabled
								</label>
							</div>
							<p class="text-[11px] leading-snug text-slate-500">
								Optional middle layer between the letters and the base outline.
							</p>

							{#if editableSettings.textOutlineEnabled}
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Text outline thickness</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{editableSettings.textOutlineThicknessMm.toFixed(1)} mm</span
										>
									</div>
									<Slider
										type="single"
										value={editableSettings.textOutlineThicknessMm}
										onValueChange={(value: number) =>
											updateSelectedItemSettings({
												textOutlineThicknessMm: Math.min(value, editableMaxTextOutlineMm)
											})}
										min={0.2}
										max={editableMaxTextOutlineMm}
										step={0.1}
										disabled={!hasSelectedItem}
										class="w-full"
									/>
									<p class="text-[11px] text-slate-500">
										Max {editableMaxTextOutlineMm.toFixed(1)} mm (below base outline).
									</p>
								</label>

								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Text outline depth</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{editableSettings.textOutlineDepth}</span
										>
									</div>
									<Slider
										type="single"
										value={editableSettings.textOutlineDepth}
										onValueChange={(value: number) =>
											updateSelectedItemSettings({ textOutlineDepth: value })}
										min={0.4}
										max={10}
										step={0.1}
										disabled={!hasSelectedItem}
										class="w-full"
									/>
								</label>

								<ColorPalettePicker
									value={editableSettings.textOutlineColor}
									onValueChange={(value: string) =>
										updateSelectedItemSettings({ textOutlineColor: value })}
									{palette}
									label="Text outline color"
									disabled={!hasSelectedItem}
								/>
							{/if}
						</div>

						<div class="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white/70 p-3">
							<div class="text-xs font-semibold tracking-tight text-slate-700">Extrusion</div>
							<div class="grid grid-cols-1 gap-3">
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Base depth</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{editableSettings.baseDepth}</span
										>
									</div>
									<Slider
										type="single"
										value={editableSettings.baseDepth}
										onValueChange={(value: number) =>
											updateSelectedItemSettings({ baseDepth: value })}
										min={1}
										max={20}
										step={0.2}
										disabled={!hasSelectedItem}
										class="w-full"
									/>
								</label>
							</div>
						</div>

						<div class="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white/70 p-3">
							<div class="flex items-center justify-between">
								<div class="text-xs font-semibold tracking-tight text-slate-700">Keyring</div>
								<label class="flex items-center gap-2 text-xs font-medium text-slate-700">
									<input
										class="h-4 w-4 accent-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
										type="checkbox"
										checked={editableSettings.keyringEnabled}
										onchange={(event) =>
											updateSelectedItemSettings({
												keyringEnabled: (event.currentTarget as HTMLInputElement).checked
											})}
										disabled={!hasSelectedItem}
									/>
									Enabled
								</label>
							</div>
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Ring size</span>
									<span class="text-xs text-slate-600 tabular-nums"
										>{editableSettings.keyringOuterSize}</span
									>
								</div>
								<Slider
									type="single"
									value={editableSettings.keyringOuterSize}
									onValueChange={(value: number) =>
										updateSelectedItemSettings({ keyringOuterSize: value })}
									min={4}
									max={15}
									step={0.5}
									disabled={!hasSelectedItem}
									class="w-full"
								/>
							</label>
							<label class="grid gap-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-slate-700">Hole size</span>
									<span class="text-xs text-slate-600 tabular-nums"
										>{editableSettings.keyringHoleSize}</span
									>
								</div>
								<Slider
									type="single"
									value={editableSettings.keyringHoleSize}
									onValueChange={(value: number) =>
										updateSelectedItemSettings({ keyringHoleSize: value })}
									min={2}
									max={Math.max(1, editableSettings.keyringOuterSize - 1)}
									step={0.5}
									disabled={!hasSelectedItem}
									class="w-full"
								/>
							</label>
							<div class="grid grid-cols-2 gap-3">
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Pos X</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{editableSettings.keyringOffsetX}</span
										>
									</div>
									<Slider
										type="single"
										value={editableSettings.keyringOffsetX}
										onValueChange={(value: number) =>
											updateSelectedItemSettings({ keyringOffsetX: value })}
										min={-40}
										max={40}
										step={0.5}
										disabled={!hasSelectedItem}
										class="w-full"
									/>
								</label>
								<label class="grid gap-1.5">
									<div class="flex items-center justify-between gap-2">
										<span class="text-xs font-medium text-slate-700">Pos Y</span>
										<span class="text-xs text-slate-600 tabular-nums"
											>{editableSettings.keyringOffsetY}</span
										>
									</div>
									<Slider
										type="single"
										value={editableSettings.keyringOffsetY}
										onValueChange={(value: number) =>
											updateSelectedItemSettings({ keyringOffsetY: value })}
										min={-40}
										max={40}
										step={0.5}
										disabled={!hasSelectedItem}
										class="w-full"
									/>
								</label>
							</div>
						</div>
					</div>

					{#if !activeEditableItem}
						<div
							class="rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 p-3 text-xs text-slate-500"
						>
							Select a keychain to edit its lines and object settings.
						</div>
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
					onSnapshot={() => downloadCleanSnapshot()}
					onExport={() => exportSTL()}
					onExport3MF={() => export3MF()}
					onOpenWithBambuStudio={() => openWithBambuStudio()}
					{openBambuStudioLoading}
					exportDisabled={false}
					exportTitle={getExportTitle(user, subscriptionStatus, 'Export STL or 3MF (multipart)')}
					showLockIcon={!user || !subscriptionStatus?.isActive}
				/>
			</div>
		</section>
	</div>
</main>
