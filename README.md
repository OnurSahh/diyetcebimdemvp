## Diet Yourself - Daily MVP

Daily adaptive meal-plan MVP built with Next.js, Prisma (PostgreSQL), and Gemini/Groq.

Core loop:
1. Generate today plan
2. Tick meal or upload photo
3. Auto-adjust remaining meals

### Tech Stack

- Next.js App Router + React + TypeScript
- Prisma + PostgreSQL
- JWT cookie auth
- Gemini API integration for daily plan generation (with deterministic fallback)

### Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
copy .env.example .env
```

3. Run Prisma migration:

```bash
npx prisma db push
```

4. Start development server:

```bash
npm run dev
```

Open http://localhost:3000.

### Vercel Deployment (One-pass)

1. Push this repository to GitHub.
2. Import it into Vercel.
3. Set these environment variables in Vercel Project Settings:
	- `DATABASE_URL` (hosted Postgres connection string)
	- `JWT_SECRET`
	- `AI_PROVIDER_MODE` (`0` for Gemini, `1` for Groq)
	- `GEMINI_API_KEY` (if mode `0`)
	- `GROQ_API_KEY` (if mode `1`)
	- Optional model overrides: `GEMINI_MODEL`, `GROQ_MODEL`, `GROQ_VISION_MODEL`
4. Deploy.

This repo includes [vercel.json](vercel.json) with build command:

```bash
prisma generate && prisma db push && next build
```

That means Vercel will automatically sync the schema to your Postgres DB during build.

### Current MVP Routes

- Pages: `/`, `/signup`, `/login`, `/onboarding`, `/dashboard`
- APIs:
	- `/api/auth/signup`
	- `/api/auth/login`
	- `/api/auth/logout`
	- `/api/auth/me`
	- `/api/survey`
	- `/api/mealplan`
	- `/api/tracker`
	- `/api/mealphoto`

### Notes

- This version is daily-plan only (no weekly page yet).
- Meal photos are accepted for analysis flow but raw files are not stored.
- If AI provider keys are missing or unavailable, generation calls fail with API error responses.

### Validation Commands

```bash
npm run lint
npm run build
```

Both pass with the current implementation baseline.

