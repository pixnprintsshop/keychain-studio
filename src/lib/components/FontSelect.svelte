<script lang="ts">
    import { tick } from "svelte";
    import LockIcon from "@lucide/svelte/icons/lock";
    import CheckIcon from "@lucide/svelte/icons/check";
    import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
    import { FONT_OPTIONS, cn } from "$lib/utils";
    import type { FontOption } from "$lib/utils";
    import * as Command from "./ui/command/index.js";
    import * as Popover from "./ui/popover/index.js";

    interface Props {
        value: string;
        placeholder?: string;
        id?: string;
        triggerClass?: string;
        /** Optional override list of fonts (defaults to all FONT_OPTIONS). */
        options?: FontOption[];
    }

    let {
        value = $bindable(),
        placeholder = "Select font",
        id,
        triggerClass = "w-full",
        options = FONT_OPTIONS,
    }: Props = $props();

    let open = $state(false);
    let triggerRef = $state<HTMLButtonElement | null>(null);

    const selectedOpt = $derived(options.find((f) => f.key === value));
    const selectedLabel = $derived(selectedOpt?.label ?? placeholder);
    const selectedFontFamily = $derived(selectedOpt?.fontFamily ?? "inherit");

    function closeAndFocusTrigger() {
        open = false;
        tick().then(() => {
            triggerRef?.focus();
        });
    }

    function selectFont(fontKey: string, _index: number) {
        value = fontKey;
        closeAndFocusTrigger();
    }
</script>

<Popover.Root bind:open>
    <Popover.Trigger bind:ref={triggerRef}>
        {#snippet child({ props })}
            <button
                {id}
                type="button"
                {...props}
                class={cn(
                    "flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2",
                    triggerClass
                )}
                role="combobox"
                aria-expanded={open}
            >
                <span style="font-family: {selectedFontFamily}">
                    {selectedLabel}
                </span>
                <ChevronDownIcon
                    class={cn("h-4 w-4 shrink-0 text-slate-500 transition-transform", open && "rotate-180")}
                />
            </button>
        {/snippet}
    </Popover.Trigger>
    <Popover.Content class="w-(--bits-popover-trigger-width) max-w-(--bits-popover-trigger-width) p-0" align="start">
        <Command.Root>
            <Command.Input placeholder="Search fonts..." />
            <Command.List class="max-h-60">
                <Command.Empty>No font found.</Command.Empty>
                <Command.Group>
                    {#each options as f, index}
                        <Command.Item
                            value={f.label}
                            onSelect={() => selectFont(f.key, index)}
                            class={cn(
                                value === f.key && "bg-indigo-100"
                            )}
                            style="font-family: {f.fontFamily}"
                        >
                            <CheckIcon
                                class={cn(
                                    "size-4 shrink-0",
                                    value !== f.key && "text-transparent"
                                )}
                            />
                            <span class="flex-1">{f.label}</span>
                        </Command.Item>
                    {/each}
                </Command.Group>
            </Command.List>
        </Command.Root>
    </Popover.Content>
</Popover.Root>
