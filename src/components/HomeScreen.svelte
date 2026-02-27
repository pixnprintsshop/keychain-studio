<script lang="ts">
    type StyleName =
        | "textOutline"
        | "initial"
        | "flower"
        | "basicName"
        | "customSvg"
        | "charm"
        | "keycap";

    interface DesignerItem {
        id: StyleName;
        title: string;
        description: string;
        imageSrc: string;
        imageAlt: string;
    }

    const DESIGNERS: DesignerItem[] = [
        {
            id: "textOutline",
            title: "Text Only",
            description:
                "Make a keychain with just your name or favorite word—simple and fun.",
            imageSrc: "/images/text-only.png",
            imageAlt: "Text Only preview",
        },
        {
            id: "initial",
            title: "Text & Initial",
            description:
                "Perfect for gifts—show off a big letter and a name together on your keychain.",
            imageSrc: "/images/text+initial.png",
            imageAlt: "Text & Initial preview",
        },
        {
            id: "flower",
            title: "Flower + Initial",
            description:
                "Add a colorful flower with your letter for a cute and cheerful keychain.",
            imageSrc: "/images/flower+initial.png",
            imageAlt: "Flower & Initial preview",
        },
        {
            id: "basicName",
            title: "Basic Name Tag",
            description:
                "Classic name tag style—simple, stylish, and great for any occasion.",
            imageSrc: "/images/nametag.png",
            imageAlt: "Basic Name Tag preview",
        },
        {
            id: "customSvg",
            title: "Custom SVG",
            description:
                "Want something unique? Upload your drawing or logo to create a custom keychain!",
            imageSrc: "/images/custom-svg.png",
            imageAlt: "Custom SVG Designer preview",
        },
        {
            id: "charm",
            title: "Chunky Charm",
            description:
                "Turn your design into a cute charm you can easily thread a cord through.",
            imageSrc: "/images/charm.png",
            imageAlt: "Chunky Charm preview",
        },
        {
            id: "keycap",
            title: "Keycap Maker",
            description:
                "Upload your keycap base (STL) and add a centered icon on top.",
            imageSrc: "/images/keycap-maker.png",
            imageAlt: "Keycap Maker preview",
        },
    ];

    interface Props {
        paidOnlyDesigners: ReadonlySet<string>;
        onSelect: (style: StyleName) => void;
    }

    let { paidOnlyDesigners, onSelect }: Props = $props();

    function isPaidDesigner(style: StyleName): boolean {
        return paidOnlyDesigners.has(style);
    }
</script>

<div class="flex min-h-dvh w-dvw items-center justify-center bg-slate-50 p-6">
    <div class="w-full max-w-4xl">
        <div class="mb-10 text-center">
            <div class="mb-4 flex justify-center">
                <img
                    src="/app-logo.png"
                    alt="PixnPrints Logo"
                    class="h-16 w-auto object-contain"
                />
            </div>
            <h1 class="text-3xl font-bold tracking-tight text-slate-900">
                Keychain Studio
            </h1>
            <p class="mt-2 text-sm text-slate-500">
                Choose a style to start designing your 3D keychain
            </p>
        </div>

        <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {#each DESIGNERS as designer (designer.id)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="group relative cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-lg hover:border-indigo-300"
                    onclick={() => onSelect(designer.id)}
                >
                    {#if isPaidDesigner(designer.id)}
                        <span
                            class="absolute right-3 top-3 z-10 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                            >PLUS</span
                        >
                    {/if}
                    <div class="aspect-4/3 w-full overflow-hidden bg-slate-100">
                        <img
                            src={designer.imageSrc}
                            alt={designer.imageAlt}
                            class="h-full w-full object-cover transition group-hover:scale-105"
                        />
                    </div>
                    <div class="p-5">
                        <h2 class="text-lg font-semibold text-slate-900">
                            {designer.title}
                        </h2>
                        <p class="mt-1 text-sm leading-relaxed text-slate-500">
                            {designer.description}
                        </p>
                    </div>
                </div>
            {/each}
        </div>

        <div
            class="mt-8 flex items-center justify-center gap-2 text-xs text-slate-400"
        >
            <span>By</span>
            <img
                src="/pixnprints-logo.png"
                alt="PixnPrints"
                class="h-10 w-auto object-contain"
            />
        </div>
    </div>
</div>
