# Print Studio (PixnPrints)

A **SvelteKit 2** + **Svelte 5** app for 3D printer makers and creators. Design personalized 3D printables (keychains, toppers, charms, and more), customize in the browser with a live 3D preview, and export STL or 3MF for slicing and printing.

## Features

- **20 designers**: Canvas Studio, Cake Topper, ID Name Tag, Basic Name Tag, Keycap Set Maker, Engrave name plate, Text Only, Bumpy Text, Bow Keychain, Baby / Toddler Name Puzzle, Text & Initial, Flower + Initial, Dog Tag, Custom SVG, Chunky Charm, Keycap Maker, Custom Whistle, Stanley Topper, Straw Topper, Pencil Topper
- **Canvas Studio**: 2D layout on the canvas with Konva-backed tools; curated shapes can be loaded from Supabase (`canvas_studio_shapes`)
- **Live 3D preview** with Three.js
- **Export**: STL and 3MF (multipart for multi-material printing)
- **Auth**: Supabase (email/password, Google OAuth)
- **Subscription**: Lemon Squeezy (monthly/yearly) or legacy license codes; **free trial** exports for signed-in users (cap from `VITE_FREE_TRIAL_CREDITS`, enforced server-side via `trial_usage`; max **2 accounts per browser fingerprint** via `trial_fingerprint_users`)
- **User color palettes**: Save filament colors in Settings (persisted to Supabase)
- **Analytics**: Vercel Analytics; PostHog (client + server error capture; `/ingest` reverse proxy in `hooks.server.ts`)
- **Optional notifications**: Telegram hooks for exports, contact, visits, and in-app ratings; Resend for feedback and contact email
- **Desktop-first**: Optimized for desktop; mobile shows home screen and a “use desktop” prompt when opening designers
- **Responsive home**: Mobile-friendly home screen with burger menu; desktop status bar; **New** badges via `VITE_NEW_DESIGNERS`, **Updated** badges via `UPDATE_NOTES` in `HomeScreen.svelte`

## Tech stack

| Layer | Stack |
|-------|-------|
| Framework | SvelteKit 2, Svelte 5, Vite 7 |
| Deployment | @sveltejs/adapter-vercel |
| Auth & DB | Supabase (auth, PostgreSQL) |
| 3D | Three.js, three-bvh-csg, three-3mf-exporter |
| Geometry | paper.js, clipper-lib, opencascade.js, openscad-wasm |
| Canvas | Konva (Canvas Studio) |
| UI | Tailwind CSS 4, bits-ui, tw-animate, Lucide icons |
| Payments | Lemon Squeezy (subscriptions) |
| Email | Resend (feedback and contact notifications) |
| Analytics | PostHog, @vercel/analytics |

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

#### Core

| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-side; license activation and admin-style operations) |
| `VITE_MAINTENANCE_MODE` | Set to `true` or `1` to show only the maintenance page |
| `VITE_UNDER_MAINTENANCE_DESIGNERS` | Comma-separated designer ids to hide (e.g. `charm,flower`) |
| `VITE_NEW_DESIGNERS` | Comma-separated designer ids to show a “New” badge on the home grid |
| `VITE_FREE_TRIAL_CREDITS` | Max free trial exports per signed-in user before the paywall (server-enforced) |

Updated badges on the home grid are configured in `UPDATE_NOTES` inside `HomeScreen.svelte` (not an env var).

#### Lemon Squeezy

| Variable | Description |
|----------|-------------|
| `LEMONSQUEEZY_STORE_ID` | Store ID |
| `LEMONSQUEEZY_API_KEY` | API key (server-side checkout and pricing) |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | Webhook signing secret (Lemon Squeezy dashboard + Edge Function secret) |
| `LEMONSQUEEZY_VARIANT_MONTHLY_ID` | Monthly subscription variant ID |
| `LEMONSQUEEZY_VARIANT_YEARLY_ID` | Yearly subscription variant ID |

#### Email, cron, canvas upload

| Variable | Description |
|----------|-------------|
| `RESEND_API_KEY` | Resend API key |
| `FEEDBACK_NOTIFY_EMAIL` | Inbox for feedback submissions |
| `CONTACT_NOTIFY_EMAIL` | Optional; contact form notifications (defaults to `FEEDBACK_NOTIFY_EMAIL`) |
| `CRON_SECRET` | Bearer-style secret for Vercel Cron (e.g. `api/cron/cleanup-uploads`) |
| `CANVAS_STUDIO_UPLOAD_SECRET` | Secret for `POST /canvas/upload` (curate Iconify SVG URLs into `canvas_studio_shapes`) |

#### Optional integrations

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram bot for export, contact, rating, and visit notifications |
| `IPINFO_TOKEN` | Optional ipinfo.io token for country resolution when the platform does not send geo headers |
| `PUBLIC_POSTHOG_HOST` / `PUBLIC_POSTHOG_PROJECT_TOKEN` | PostHog (`hooks.client.ts` uses `/ingest` as `api_host`) |
| `PUBLIC_APP_REVIEW_URL` | Optional external review link; if unset, “Leave a review” uses in-app feedback |

### 3. Supabase database

Run migrations to create tables:

```sh
supabase db push
```

Or apply migrations manually. Key tables (non-exhaustive):

- `subscriptions` — Lemon Squeezy subscription data linked to users
- `lemonsqueezy_events` — Webhook event audit log
- `licenses` / `license_activations` — Legacy license codes (expiration enforced in `get_user_export_access`)
- `user_color_palettes` — Saved filament color palettes
- `user_designer_presets` — Custom color presets per user and designer (`designer_id` + `presets` jsonb)
- `trial_usage` — Per-user trial export ledger
- `trial_fingerprint_users` — Links browser fingerprint hashes to trial accounts (max 2 per device)
- `canvas_studio_shapes` — Curated SVG URLs for the Canvas Studio shape picker
- `app_rating_submissions` — In-app star ratings (optional comments)

### 4. Lemon Squeezy webhook

For subscription lifecycle events, deploy the Supabase Edge Function:

- Function: `supabase/functions/lemonsqueezy-webhook`
- Webhook URL: `https://<project-ref>.supabase.co/functions/v1/lemonsqueezy-webhook`
- Configure in Lemon Squeezy dashboard with `LEMONSQUEEZY_WEBHOOK_SECRET`

## Developing

```sh
pnpm run dev
```

Open `http://localhost:5173`. Use **Sign in** and **View pricing** to access the full export and subscription flow.

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
├── hooks.server.ts           # PostHog /ingest reverse proxy; server_error capture
├── hooks.client.ts           # PostHog init; client error capture
├── routes/
│   ├── +page.svelte          # Root (mounts App)
│   ├── +page.server.ts       # Server load
│   ├── +layout.svelte        # Layout, global CSS, Vercel Analytics
│   ├── home/                 # Marketing home (separate from in-app hash #home)
│   ├── pricing/              # Pricing
│   ├── subscription/         # Subscription management
│   ├── about/, terms/, privacy/, refund/
│   ├── canvas/
│   │   └── upload/+server.ts # Authenticated SVG catalog upload (Canvas Studio)
│   └── api/
│       ├── lemonsqueezy/checkout/, pricing/
│       ├── license/activate/, status/
│       ├── contact/, feedback-notify/
│       ├── cron/cleanup-uploads/
│       └── telegram/         # export-notify, visit-notify, rating-notify
├── lib/
│   ├── App.svelte            # Main shell: hash-based views, designers, modals
│   ├── auth.ts, supabase.ts
│   ├── subscription.ts, freeTrial.svelte.ts, colorPalette.ts, feedback.ts
│   ├── server/               # posthog.ts, email.ts, visit-info.ts, …
│   └── components/
│       ├── HomeScreen.svelte, DesktopRequiredView.svelte
│       ├── *Designer.svelte  # One component per designer
│       ├── DesignerExportToolbar.svelte, ColorPalettePicker.svelte
│       ├── SettingsPage.svelte, PricingPage.svelte, …
│       └── ui/               # bits-ui primitives (button, dialog, popover, …)
└── app.html

static/                       # Images, fonts, favicon
supabase/
├── migrations/
└── functions/lemonsqueezy-webhook/
```

## Architecture notes

- **Hash routing**: In-app views use the URL hash (`/#textOutline`, `/#flower`, `/#home`, etc.) for shareable links and refresh. OAuth return fragments are handled before overwriting the hash.
- **Desktop-first**: Designers require desktop for 3D preview and export; mobile shows `DesktopRequiredView`.
- **Subscription gating**: Export (STL/3MF) requires sign-in and active subscription, valid license, or remaining trial credits.
- **License codes**: Users can enter legacy license codes via “Enter license” in the menu to unlock export without a Lemon Squeezy subscription.
- **PostHog**: Browser SDK posts to same-origin `/ingest`, which `hooks.server.ts` forwards to PostHog’s ingest hosts (`svelte.config.js` sets `kit.paths.relative: false` so session replay works with SSR).

## Testing subscriptions

1. Use a **Lemon Squeezy test store** or enable test mode.
2. Set test API key and store ID in env.
3. Point the Lemon Squeezy webhook URL to your **Supabase Edge Function** (for example `https://<project-ref>.supabase.co/functions/v1/lemonsqueezy-webhook`), not an `/api/...` route on the SvelteKit app.
4. Use Lemon Squeezy test card numbers.
5. Verify checkout via `/api/lemonsqueezy/checkout` and that webhooks update `subscriptions` and `lemonsqueezy_events`.

## License

Private. See terms for usage.
