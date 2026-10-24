# Deployment Guide: Frontend → Cloudflare Pages, Backend → Render.com

## Prerequisites
- GitHub account
- Cloudflare account
- Render.com account
- Render CLI installed (`npm i -g @render/cli` or download from render.com)

---

## 1. Push Code to GitHub

```bash
cd /Users/dehhat/Desktop/dashboard/dashboard-worker
git init
git add .
git commit -m "Initial commit: AWS Cost Audit Dashboard"
gh repo create aws-cost-audit-dashboard --public --source=. --push
```

---

## 2. Deploy Backend to Render.com

### Option A: Using Render CLI (requires GitHub repo)

```bash
# Set workspace
render workspace set <workspace-id>

# Create web service from GitHub repo
render services create \
  --name aws-cost-audit-backend \
  --type web_service \
  --repo https://github.com/<your-username>/aws-cost-audit-dashboard \
  --runtime docker \
  --dockerfile-path ./Dockerfile \
  --plan free \
  --health-check-path /api/health \
  --env-var DB_DIR=/data \
  --env-var NODE_ENV=production \
  --branch main \
  --auto-deploy true
```

### Option B: Using Render Dashboard (easier)

1. Go to https://dashboard.render.com
2. Click **New** → **Web Service**
3. Connect your GitHub repo
4. Configure:
   - **Name**: `aws-cost-audit-backend`
   - **Runtime**: `Docker`
   - **Dockerfile Path**: `./Dockerfile`
   - **Plan**: `Free`
   - **Health Check Path**: `/api/health`
   - **Environment Variables**:
     - `DB_DIR` = `/data`
     - `NODE_ENV` = `production`
5. Click **Create Web Service**

> **Note**: Free tier has no persistent disk. SQLite data will be lost on restart.
> For production, upgrade to **Starter plan ($7/mo)** and add a disk, or use Render PostgreSQL.

---

## 3. Deploy Frontend to Cloudflare Pages

### Option A: Using Cloudflare Dashboard (recommended)

1. Go to https://dash.cloudflare.com → **Pages**
2. Click **Create a project** → **Connect to Git**
3. Select your GitHub repo
4. Configure:
   - **Project name**: `aws-cost-audit-frontend`
   - **Production branch**: `main`
   - **Build command**: (leave empty - static files)
   - **Build output directory**: `public`
   - **Root directory**: `/`
5. **Environment Variables** (in Pages settings):
   - `VITE_API_BASE_URL` = `https://aws-cost-audit-backend.onrender.com`
6. Click **Save and Deploy**

### Option B: Using Wrangler CLI (direct upload)

```bash
# Install wrangler
npm i -g wrangler

# Login
wrangler login

# Deploy public folder directly
wrangler pages deploy public --project-name=aws-cost-audit-frontend
```

> **Note**: With direct upload, you'll need to set `VITE_API_BASE_URL` in Cloudflare Pages dashboard after deployment.

---

## 4. Configure CORS (if needed)

The backend already accepts requests from any origin. If you need to restrict:

```typescript
// In src/index.ts, add CORS middleware
import { cors } from "hono/cors";
app.use("/*", cors({ origin: "https://aws-cost-audit-frontend.pages.dev" }));
```

---

## 5. Verify Deployment

1. **Backend health**: `curl https://aws-cost-audit-backend.onrender.com/api/health`
2. **Frontend**: Visit `https://aws-cost-audit-frontend.pages.dev/analyze`
3. **Run demo**: Click "Demo" button on frontend
4. **Run real audit**: Enter valid AWS read-only credentials

---

## Architecture After Deployment

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Pages                           │
│  https://aws-cost-audit-frontend.pages.dev                   │
│  (Static HTML/JS/CSS - global CDN, free)                     │
└──────────────────────────┬────────────────────────────────────┘
                           │ HTTPS API calls
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      Render.com                               │
│  https://aws-cost-audit-backend.onrender.com                 │
│  (Bun + Hono + SQLite - runs full audit in single process)   │
└─────────────────────────────────────────────────────────────┘
```

---

## Cost Breakdown

| Component | Platform | Plan | Cost |
|-----------|----------|------|------|
| Frontend | Cloudflare Pages | Free | $0/mo |
| Backend | Render.com | Free* | $0/mo |
| **Total** | | | **$0/mo** |

*Free tier: 750 hrs/mo, spins down after 15 min inactivity, no persistent disk.

**For production**: Render Starter plan ($7/mo) + 1GB disk ($1/mo) = **$8/mo** for persistent data.

---

## Local Development

```bash
# Backend
cd /Users/dehhat/Desktop/dashboard/dashboard-worker
bun src/index.ts  # Runs on http://localhost:3000

# Frontend (in another terminal)
cd /Users/dehhat/Desktop/dashboard/dashboard-worker/public
npx serve .  # Runs on http://localhost:3001
# Or just open public/analyze.html directly (uses local backend via relative URLs)
```

---

## Environment Variables Reference

### Backend (Render)
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_DIR` | Yes | `/data` | SQLite database directory |
| `NODE_ENV` | No | `production` | Environment mode |

### Frontend (Cloudflare Pages)
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_API_BASE_URL` | Yes* | `` | Backend API base URL (e.g. `https://api.example.com`) |

*Required for cross-origin deployment. Empty string works for same-origin.

---

## Troubleshooting

### Backend spins down on free tier
- First request after inactivity takes ~30s to wake up
- Consider Render Starter plan ($7/mo) for always-on

### SQLite data lost on deploy/restart
- Free tier has no persistent disk
- Use Render PostgreSQL add-on or upgrade plan

### CORS errors
- Ensure `VITE_API_BASE_URL` is set correctly in Cloudflare Pages
- Backend allows all origins by default

### "API calls not showing in Network tab"
- Check you're on `/analyze` page, not `/`
- Open DevTools → Network → Filter: "Fetch/XHR"
- Verify `VITE_API_BASE_URL` is set (check Console for `window.__API_BASE_URL__`)