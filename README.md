## Diet Yourself - Daily MVP

Daily adaptive meal-plan MVP built with Next.js, SQLite, Prisma, and Gemini.

Core loop:
1. Generate today plan
2. Tick meal or upload photo
3. Auto-adjust remaining meals

### Tech Stack

- Next.js App Router + React + TypeScript
- Prisma + SQLite
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
npx prisma migrate dev
```

4. Start development server:

```bash
npm run dev
```

Open http://localhost:3000.

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
- If `GEMINI_API_KEY` is missing, daily plan generation falls back to deterministic default meals.

### Validation Commands

```bash
npm run lint
npm run build
```

Both pass with the current implementation baseline.

