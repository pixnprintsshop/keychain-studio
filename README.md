# Keychain Studio (PixnPrints)

A **SvelteKit 2** + **Svelte 5** app for designing personalized 3D keychains. Users pick a style (text-only, flower + initial, custom SVG, keycap, whistle, and more), customize in the browser, and export for 3D printing. Includes auth (Supabase), licensing, URL routes for legal/pricing pages, and hash-based routing for designers.

## Tech stack

- **SvelteKit 2** (Vite 7) + **Svelte 5**
- **adapter-vercel** for deployment
- **Supabase** (auth, optional storage)
- **Three.js** (3D preview and export)
- **Tailwind CSS 4**, **bits-ui**, **tw-animate**
- **paper.js**, **clipper-lib**, **opencascade.js**, **three-bvh-csg** (designer logic and geometry)

## Prerequisites

- Node.js 18+
- pnpm

## Setup

```sh
pnpm install
```

Copy environment variables and fill in your Supabase credentials:

```sh
cp .env.example .env
```

| Variable | Description |
| -------- | ----------- |
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Supabase anon/public key |
| `VITE_MAINTENANCE_MODE` | Set to `true` or `1` to show only the maintenance page |
| `VITE_UNDER_MAINTENANCE_DESIGNERS` | Comma-separated designer ids to hide (e.g. `charm,flower`) |

## Developing

```sh
pnpm run dev
```

Open the app in the browser (e.g. `http://localhost:5173`). Use **Sign in** and the in-app **Pricing** / **Get a license** flow for full export and paid designers.

## Building

```sh
pnpm run build
```

Uses **@sveltejs/adapter-vercel**; output is in `.svelte-kit/` and adapter-specific build artifacts. Preview the production build:

```sh
pnpm run preview
```

## Scripts

| Command | Description |
| ------- | ----------- |
| `pnpm run dev` | Start dev server |
| `pnpm run build` | Production build |
| `pnpm run preview` | Preview production build |
| `pnpm run check` | Run svelte-check |
| `pnpm run lint` | Lint with ESLint + Prettier |
| `pnpm run format` | Format with Prettier |

## Project layout

- `src/routes/` — SvelteKit routes: `/` (main app), `/terms`, `/privacy`, `/pricing`, `/refund`
- `src/routes/+page.svelte` — Root page (client-only), mounts the main app
- `src/lib/App.svelte` — Main app and hash-based designer view routing
- `src/lib/components/` — Designers, HomeScreen, LoginModal, legal/pricing pages, UI primitives
- `src/lib/` — Auth, licensing, Supabase client, utils, font/geometry helpers
- `src/lib/assets/` — Font JSON, SVG, STL assets
- `src/app.html` — HTML shell, meta, title
