# Deploying to Firebase (no Blaze plan required)

This path avoids Cloud Run entirely, since that requires the Blaze
(pay-as-you-go) plan and a verified billing account:

- **Frontend** (everything in `backend/frontend/`) → **Firebase Hosting**,
  free forever on the Spark plan. No credit card, no billing account.
- **Backend** (`main.py`) → **Render**, whose free web-service tier doesn't
  require a card either. It's a normal Python/Docker host, so the existing
  `backend/Dockerfile` works unchanged.
- **Database** → Render's free Postgres tier works, or leave `DATABASE_URL`
  unset and let it fall back to SQLite for a quick demo (see the note at
  the bottom about what that costs you).

Because Firebase Hosting's rewrite-to-a-backend feature also needs Blaze,
the frontend instead calls Render's URL directly — CORS is already wide
open in `main.py`, so this just works. That's what `frontend/config.js`
and the `window.API_BASE` changes in each page's JS are for.

## 1. Deploy the backend to Render

1. Push this repo to GitHub (Render deploys from a Git repo).
2. Go to [render.com](https://render.com) → sign up (no card needed) →
   **New +** → **Web Service** → connect your repo.
3. Set:
   - **Root directory**: `uav-telemetry/backend`
   - **Runtime**: Docker (it'll auto-detect `Dockerfile`)
   - **Instance type**: Free
4. Deploy. Render gives you a URL like `https://uav-backend.onrender.com`
   — copy it.

Optional but recommended — add a database instead of relying on SQLite:

5. **New +** → **PostgreSQL** → Free tier → create it.
6. Copy its **Internal Database URL**.
7. Back on your web service → **Environment** → add `DATABASE_URL` = that
   connection string → save (this redeploys automatically).

## 2. Point the frontend at that backend

Edit `backend/frontend/config.js`:

```js
window.API_BASE = "https://uav-backend.onrender.com"; // your actual Render URL
```

## 3. Deploy the frontend to Firebase Hosting

```bash
firebase deploy --only hosting
```

Firebase gives you a `https://YOUR_PROJECT_ID.web.app` URL serving the
dashboard, calling out to Render for every `/api/**` request.

## 4. Point your simulator / Jetson bridge at the live backend

```bash
python simulate_uav.py --url https://uav-backend.onrender.com
```

## Notes / gotchas

- **Free-tier cold starts**: Render's free web services spin down after
  ~15 minutes of inactivity, so the first request after idle time can take
  20–30 seconds to wake back up. This is normal, not a bug.
- **SQLite fallback**: if you skip step 1's optional Postgres setup,
  telemetry will reset every time Render restarts the free instance
  (including every redeploy and every spin-down/spin-up cycle). Fine for a
  demo, not for anything you want to keep.
- **Local dev still works unchanged**: `config.js` defaults `API_BASE` to
  `""`, so running the backend locally and opening it at
  `http://localhost:8000` behaves exactly as before — you only need to set
  the Render URL for the *deployed* Firebase Hosting copy.
- If you get a Google Cloud billing/Blaze account working later, the
  Cloud Run path (proxying `/api/**` through Firebase Hosting) is still an
  option — just ask and I'll bring that config back.
