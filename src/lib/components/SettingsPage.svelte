<script lang="ts">
	import type { User } from '@supabase/supabase-js';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import type { PaletteColor } from '$lib/colorPalette';

	interface Props {
		user: User | null;
		palette: PaletteColor[];
		onBack: () => void;
		onRequestLogin: () => void;
		onSavePalette: (colors: PaletteColor[]) => Promise<{ success: boolean; error?: string }>;
	}

	let { user, palette, onBack, onRequestLogin, onSavePalette }: Props = $props();

	const canEdit = $derived(!!user);

	let editingColors = $state<PaletteColor[]>([]);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let saveSuccess = $state(false);
	let newHex = $state('#ffffff');
	let newName = $state('');

	$effect(() => {
		editingColors = [...palette];
	});

	function addColor() {
		const hex = newHex.replace(/^#/, '').trim();
		const fullHex = hex.length === 3 ? '#' + hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] : '#' + hex;
		if (!editingColors.some((c) => c.hex.toLowerCase() === fullHex.toLowerCase())) {
			editingColors = [...editingColors, { hex: fullHex, name: newName.trim() || undefined }];
			newHex = '#ffffff';
			newName = '';
		}
	}

	function removeColor(index: number) {
		editingColors = editingColors.filter((_, i) => i !== index);
	}

	function updateColorName(index: number, name: string) {
		editingColors = editingColors.map((c, i) => (i === index ? { ...c, name: name || undefined } : c));
	}

	async function handleSave() {
		if (!user) return;
		saving = true;
		saveError = null;
		saveSuccess = false;
		const result = await onSavePalette(editingColors);
		saving = false;
		if (result.success) {
			saveSuccess = true;
			setTimeout(() => (saveSuccess = false), 2000);
		} else {
			saveError = result.error ?? 'Failed to save';
		}
	}
</script>

<main class="min-h-dvh w-dvw bg-slate-50">
	<div class="mx-auto max-w-2xl px-4 py-8">
		<div class="mb-6 flex items-center justify-between">
			<Button variant="outline" size="sm" onclick={onBack}>
				Back
			</Button>
		</div>
		<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
			<h1 class="text-2xl font-bold tracking-tight text-slate-900">Settings</h1>
			<p class="mt-1 text-sm text-slate-500">Manage your Print Studio preferences</p>

			<section class="mt-8">
				<h2 class="text-lg font-semibold text-slate-900">Filament colors</h2>
				<p class="mt-1 text-sm text-slate-600">
					Define the colors you have available for 3D printing. These will appear when selecting colors in
					designers.
				</p>

				{#if !canEdit}
					<p class="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
						Sign in to save your palette across devices.
					</p>
					<div class="mt-4 grid grid-cols-6 gap-2 sm:grid-cols-8">
						{#each palette as color (color.hex)}
							<div
								class="flex flex-col items-center gap-0.5 rounded-lg p-1"
								title={color.name ?? color.hex}
							>
								<span
									class="h-10 w-10 rounded border border-slate-300"
									style="background-color: {color.hex}"
								></span>
								{#if color.name}
									<span class="max-w-full truncate text-[10px] text-slate-600">{color.name}</span>
								{/if}
							</div>
						{/each}
					</div>
				{:else}
					<div class="mt-4 space-y-4">
						<div class="flex flex-wrap items-end gap-2">
							<div class="flex flex-col gap-1">
								<label for="settings-add-color-hex" class="text-xs font-medium text-slate-700">Color</label>
								<div class="flex items-center gap-2">
									<div class="relative h-9 w-9 shrink-0">
										<input
											id="settings-add-color-swatch"
											type="color"
											class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
											bind:value={newHex}
										/>
										<span
											class="pointer-events-none absolute inset-0 rounded-lg border border-slate-300 shadow-inner"
											style="background-color: {newHex}"
											aria-hidden="true"
										></span>
									</div>
									<input
										id="settings-add-color-hex"
										type="text"
										class="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
										placeholder="#ffffff"
										bind:value={newHex}
										onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addColor())}
									/>
								</div>
							</div>
							<div class="flex flex-col gap-1">
								<label for="settings-add-color-name" class="text-xs font-medium text-slate-700">Name (optional)</label>
								<input
									id="settings-add-color-name"
									type="text"
									class="w-32 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
									placeholder="e.g. Red PLA"
									bind:value={newName}
									onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addColor())}
								/>
							</div>
							<Button size="sm" onclick={addColor}>Add</Button>
						</div>

						<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
							{#each editingColors as color, i (color.hex + String(i))}
								<div
									class="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3"
								>
									<span
										class="h-10 w-10 shrink-0 rounded-lg border border-slate-300"
										style="background-color: {color.hex}"
									></span>
									<div class="min-w-0 flex-1">
										<input
											type="text"
											class="w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs"
											value={color.hex}
											disabled
										/>
										<input
											type="text"
											class="mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs"
											placeholder="Name (optional)"
											value={color.name ?? ''}
											oninput={(e) => updateColorName(i, e.currentTarget.value)}
										/>
									</div>
									<Button
										variant="ghost"
										size="icon"
										class="shrink-0 text-slate-500 hover:text-red-600"
										onclick={() => removeColor(i)}
										aria-label="Remove color"
									>
										<Trash2Icon class="size-4" />
									</Button>
								</div>
							{/each}
						</div>

						{#if saveError}
							<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{saveError}</p>
						{/if}
						{#if saveSuccess}
							<p class="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Saved.</p>
						{/if}

						<Button onclick={handleSave} disabled={saving}>
							{saving ? 'Saving...' : 'Save palette'}
						</Button>
					</div>
				{/if}
			</section>
		</div>
	</div>
</main>
