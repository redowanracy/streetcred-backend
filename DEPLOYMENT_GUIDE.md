# Street Cred Backend: Cloud Deployment & Client Access Guide

This guide provides instructions for deploying the **Street Cred** backend API to the cloud so that the client (**Philiciah**), their development team, and mobile test builds can connect securely from anywhere in the world.

---

## Architecture Summary
* **Runtime:** Node.js 20+ (TypeScript / Express 5)
* **Database:** PostgreSQL 16 + **PostGIS** spatial extension (for geospatial mission queries)
* **API Documentation:** Interactive Swagger / OpenAPI UI at `/api/v1/docs`
* **Postman Collection:** Ready-to-import 58-request collection at `docs/streetcred.postman_collection.json`

---

## Step 1: Push Backend to a Private GitHub Repository & Grant Client Access

To give Philiciah full visibility of the backend code:

1. **Initialize Git and commit the backend code:**
   ```bash
   cd c:/Users/Racy/Trapcity/Handoff-backend
   git init
   git add .
   git commit -m "feat: complete Street Cred server-authoritative backend with PostGIS spatial engine"
   ```

2. **Create a new repository on GitHub:**
   * Go to [github.com/new](https://github.com/new)
   * Repository name: `streetcred-backend` (or `Trapcity-Backend`)
   * Visibility: **Private**
   * Do **not** initialize with README (repository already has one).

3. **Push to GitHub:**
   ```bash
   git branch -M main
   git remote add origin https://github.com/YOUR_GITHUB_USERNAME/streetcred-backend.git
   git push -u origin main
   ```

4. **Invite Philiciah:**
   * Go to **Settings > Collaborators > Add People**.
   * Enter Philiciah's GitHub username or email address and send the invitation.

---

## Step 2: Deploy to the Cloud

Choose whichever cloud platform you or your client prefers:

### Option A: Railway (Recommended — Fastest & Easiest)
*Railway offers built-in PostgreSQL with PostGIS, automatic HTTPS, and zero-config Docker deployment.*

1. Create a free account at [railway.app](https://railway.app).
2. Click **New Project** > **Provision PostgreSQL**.
3. In your PostgreSQL service > **Connect** / **Variables**, verify or run in Query:
   ```sql
   CREATE EXTENSION IF NOT EXISTS postgis;
   ```
4. Click **New Service** > **GitHub Repo** > select `streetcred-backend`.
5. Railway will automatically detect `railway.toml` and `Dockerfile`.
6. Go to your API Service > **Variables** and add:
   * `NODE_ENV`: `production`
   * `HOST`: `0.0.0.0`
   * `PORT`: `3000`
   * `DATABASE_URL`: `${{Postgres.DATABASE_URL}}` *(Railway automatically links this)*
   * `JWT_SECRET`: *(generate a 32+ character random string, e.g. `openssl rand -hex 32`)*
   * `TRUST_PROXY`: `1`
7. Under **Settings** > **Networking**, click **Generate Domain**.
   * You will receive a public HTTPS URL, e.g.: `https://streetcred-backend-production.up.railway.app`.
8. **Seed Database:**
   * In Railway CLI or the service's Web Shell tab, run:
     ```bash
     npm run seed:streetcred
     ```
   * This populates London missions, vehicle catalog, and starter inventory.

---

### Option B: Render (1-Click Blueprint)
*Render supports automatic deployment using the included `render.yaml`.*

1. Create an account at [render.com](https://render.com).
2. Connect your GitHub account.
3. Click **New +** > **Blueprint**.
4. Select your `streetcred-backend` repository.
5. Render will read `render.yaml` and provision:
   * A managed PostgreSQL database (`streetcred-db`)
   * A containerized Web Service (`streetcred-api`)
6. Once deployed, open the database Shell in Render and execute:
   ```sql
   CREATE EXTENSION IF NOT EXISTS postgis;
   ```
7. In the Web Service shell, run:
   ```bash
   npm run seed:streetcred
   ```
8. Your public URL will be: `https://streetcred-api.onrender.com`.

---

### Option C: Self-Hosted Docker VPS (DigitalOcean, AWS EC2, Ubuntu)
*Use the included `docker-compose.prod.yml` to run the database and API together on any Linux server.*

1. SSH into your server with Docker installed.
2. Clone the repository and navigate into it:
   ```bash
   git clone https://github.com/YOUR_GITHUB_USERNAME/streetcred-backend.git
   cd streetcred-backend
   ```
3. Set your environment variables in a `.env` file:
   ```env
   NODE_ENV=production
   PORT=3000
   HOST=0.0.0.0
   DB_PASSWORD=YourStrongDatabasePassword123!
   JWT_SECRET=YourStrongRandom32ByteJwtSecretKey2026!
   ```
4. Start the services:
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```
5. Seed the database inside the running container:
   ```bash
   docker compose -f docker-compose.prod.yml exec api npm run seed:streetcred
   ```
6. The API is now live at `http://YOUR_SERVER_IP:3000/api/v1/docs`.

---

### Option D: Instant 60-Second Public Demo (Cloudflare Tunnel)
*If you need to give Philiciah a live HTTPS link RIGHT NOW while the server runs on your PC:*

1. Open PowerShell and run:
   ```powershell
   npx cloudflared tunnel --url http://127.0.0.1:3000
   ```
2. Cloudflare will output an instant public HTTPS URL, for example:
   ```text
   https://random-subdomain.trycloudflare.com
   ```
3. Philiciah can open:
   `https://random-subdomain.trycloudflare.com/api/v1/docs` in her browser right now and test the live API and Swagger UI!

---

## Step 3: Connect Unity Game to the Cloud Backend

Once your cloud URL is live:

1. In Unity, select:  
   `Assets/Resources/StreetCredSettings.asset`
2. Update the fields in the Inspector:
   * **Enable Online:** `[Checked]`
   * **Base Url:** `https://your-cloud-domain.com` *(no trailing slash)*
   * **Allow Development Http:** `[Unchecked for HTTPS]`
3. Build the game or press Play. The game will now authenticate with your cloud server, load server-owned profiles, and stream live missions!
