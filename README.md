# Print Studio (PixnPrints)

A **SvelteKit 2** + **Svelte 5** app for 3D printer makers and creators. Design personalized 3D printables (keychains, toppers, charms, and more), customize in the browser with a live 3D preview, and export STL or 3MF for slicing and printing.

## Features

- **14 designers**: Text Only, Bumpy Text, Bow Keychain, Text & Initial, Flower + Initial, Basic Name Tag, Dog Tag, Custom SVG, Chunky Charm, Keycap Maker, Custom Whistle, Stanley Topper, Straw Topper, Pencil Topper
- **Live 3D preview** with Three.js
- **Export**: STL and 3MF (multipart for multi-material printing)
- **Auth**: Supabase (email/password, Google OAuth)
- **Subscription**: Lemon Squeezy (monthly/yearly) or legacy license codes
- **User color palettes**: Save filament colors in Settings (persisted to Supabase)
- **Desktop-first**: Optimized for desktop; mobile shows home screen and a “use desktop” prompt when opening designers
- **Responsive home**: Mobile-friendly home screen with burger menu; desktop status bar

## Tech stack

| Layer | Stack |
|-------|-------|
| Framework | SvelteKit 2, Svelte 5, Vite 7 |
| Deployment | @sveltejs/adapter-vercel |
| Auth & DB | Supabase (auth, PostgreSQL) |
| 3D | Three.js, three-bvh-csg, three-3mf-exporter |
| Geometry | paper.js, clipper-lib, opencascade.js, openscad-wasm |
| UI | Tailwind CSS 4, bits-ui, tw-animate, Lucide icons |
| Payments | Lemon Squeezy (subscriptions) |
| Email | Resend (feedback notifications) |

## Prerequisites

- **Node.js** 18+
- **pnpm** (package manager)

## Setup

### 1. Install dependencies

```sh
pnpm install
```

### 2. Environment variables

Copy the example env and fill in your values:

```sh
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (license activation, server-side) |
| `VITE_MAINTENANCE_MODE` | Set to `true` or `1` to show only the maintenance page |
| `VITE_UNDER_MAINTENANCE_DESIGNERS` | Comma-separated designer ids to hide (e.g. `charm,flower`) |
| `LEMONSQUEEZY_STORE_ID` | Lemon Squeezy store ID |
| `LEMONSQUEEZY_API_KEY` | Lemon Squeezy API key (server-side) |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | Webhook signing secret |
| `LEMONSQUEEZY_VARIANT_MONTHLY_ID` | Variant ID for monthly subscription |
| `LEMONSQUEEZY_VARIANT_YEARLY_ID` | Variant ID for yearly subscription |
| `RESEND_API_KEY` | Resend API key (feedback email notifications) |
| `FEEDBACK_NOTIFY_EMAIL` | Email address to receive feedback submissions |

### 3. Supabase database

Run migrations to create tables:

```sh
supabase db push
```

Or apply migrations manually. Key tables:

- `subscriptions` — Lemon Squeezy subscription data linked to users
- `lemonsqueezy_events` — Webhook event audit log
- `licenses` / `license_activations` — Legacy license codes
- `user_color_palettes` — Saved filament color palettes

### 4. Lemon Squeezy webhook

For subscription lifecycle events, deploy the Supabase Edge Function:

- Function: `supabase/functions/lemonsqueezy-webhook`
- Webhook URL: `https://<project-ref>.supabase.co/functions/v1/lemonsqueezy-webhook`
- Configure in Lemon Squeezy dashboard with `LEMONSQUEEZY_WEBHOOK_SECRET`

## Developing

```sh
pnpm run dev
```

Open `http://localhost:5173`. Use **Sign in** and **View pricing** to access full export and subscription flow.

## Building

```sh
pnpm run build
```

Output is in `.svelte-kit/` and adapter-specific artifacts. Preview:

```sh
pnpm run preview
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm run dev` | Start dev server |
| `pnpm run build` | Production build |
| `pnpm run preview` | Preview production build |
| `pnpm run check` | Run svelte-check |
| `pnpm run check:watch` | svelte-check in watch mode |
| `pnpm run lint` | ESLint + Prettier check |
| `pnpm run format` | Prettier format |

## Project structure

```
src/
├── routes/
│   ├── +page.svelte          # Root (mounts App)
│   ├── +page.server.ts       # Server load
│   ├── +layout.svelte        # Layout, CSS
│   ├── pricing/+page.svelte  # Pricing page
│   ├── terms/                # Terms and Conditions
│   ├── privacy/              # Privacy Policy
│   ├── refund/               # Refund Policy
│   ├── about/                # About page
│   └── api/
│       ├── lemonsqueezy/
│       │   ├── checkout/     # Create checkout session
│       │   └── pricing/      # Fetch pricing from Lemon Squeezy
│       ├── license/activate/ # Activate legacy license codes
│       └── feedback-notify/  # Send feedback email via Resend
├── lib/
│   ├── App.svelte            # Main app, hash-based designer routing
│   ├── auth.ts               # Supabase auth helpers
│   ├── supabase.ts           # Supabase client
│   ├── subscription.ts       # Subscription status, license cache
│   ├── colorPalette.ts       # User palettes, default filament colors
│   ├── feedback.ts           # Feedback submission
│   └── components/
│       ├── HomeScreen.svelte # Designer grid, CTA, notice banner
│       ├── DesktopRequiredView.svelte  # Mobile “use desktop” view
│       ├── *Designer.svelte  # 14 designer components
│       ├── DesignerExportToolbar.svelte
│       ├── ColorPalettePicker.svelte
│       ├── SettingsPage.svelte
│       ├── PricingPage.svelte
│       ├── LoginModal.svelte
│       ├── LicenseActivationModal.svelte
│       └── ui/               # bits-ui primitives (button, dialog, popover, etc.)
└── app.html                  # HTML shell, meta, title

static/                       # Static assets (images, fonts, favicon)
├── images/                   # Designer preview images
├── fonts/                    # TTF fonts for designers
└── app-logo.png, favicon.ico, etc.

supabase/
├── migrations/               # SQL migrations
└── functions/
    └── lemonsqueezy-webhook/ # Edge function for subscription webhooks
```

## Architecture notes

- **Hash routing**: Designer views use URL hash (`/#textOutline`, `/#flower`, etc.) for shareable links and refresh.
- **Desktop-first**: Designers require desktop for 3D preview and export; mobile shows `DesktopRequiredView`.
- **Subscription gating**: Export (STL/3MF) requires sign-in and active subscription or license. Guests see “View pricing” CTA.
- **License codes**: Users can enter legacy license codes via “Enter license” in the menu to unlock export without a Lemon Squeezy subscription.

## Testing subscriptions

1. Use a **Lemon Squeezy test store** or enable test mode.
2. Set test API key and store ID in env.
3. Point webhook URL to your dev/staging `/api/lemonsqueezy/webhook` (or Supabase Edge Function URL).
4. Use Lemon Squeezy test card numbers.
5. Verify checkout URL from `/api/lemonsqueezy/checkout` and that webhooks update `subscriptions` and `lemonsqueezy_events`.

## License

Private. See terms for usage.
