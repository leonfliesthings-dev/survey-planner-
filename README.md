# Autofly Area‑Survey Planner

A web tool that plans **terrain‑following area‑survey (lawnmower) missions** for DJI/Autofly drones and pushes them straight into the [Unleash Live](https://developer.unleashlive.com) Mission API — filling a gap the cloud's mission editor doesn't cover.

**▶ Live:** https://leonfliesthings.com/survey-planner/
*(bring your own Unleash Live Personal Access Token — see below)*

![The planner](https://leonfliesthings.com/survey-planner/shots/planner.png)

## What it does

Draw or import a survey area, pick the drone + payload and capture settings, drop a landing zone, and it generates a full survey mission — then pushes it to your Unleash Live account in one click.

- **Draw or import** the capture area (GCS‑style polygon editing, or import a `.kml`)
- **Location search** — place, address, or `lat, lng`
- **Drone → payload** cascade (DJI camera/sensor catalogue) with **GSD ⇄ height**, **front/side overlap**, **speed** (+ camera‑overwhelm check), and a **compass‑rose** transect direction
- **Terrain following** — samples a DSM (Terrarium) and flies a constant AGL; a **boundary buffer** extends flight lines past the edges so the outer photos resolve
- **Terrain profile** with collision checking, and an **elevation colour‑ramped** flight path
- **Viewshed** — line‑of‑sight rose from the LZ (per‑cell green/red over the DSM)
- **Push** to `POST /v1/mission` (relative‑to‑takeoff, or cloud surface‑follow for terrain), or **export** the mission JSON

Verified end‑to‑end — a 565‑waypoint survey pushed to the cloud and previewed in 3D:

![In the Unleash cloud](https://leonfliesthings.com/survey-planner/shots/cloud.png)

![3D preview — following terrain at 75 m AGL](https://leonfliesthings.com/survey-planner/shots/preview-3d.png)

## Unleash Live APIs used

| Purpose | Endpoint |
|---|---|
| Auth check | `GET /v1/analytics/version` |
| Create / read mission | `POST` · `GET /v1/mission` |
| Base URL | `https://api.unleashlive.com` (Bearer PAT) |

Camera capture uses distance‑interval shooting (`START_DISTANCE_INTERVAL_SHOT` / `STOP_INTERVAL_SHOT`) with per‑waypoint gimbal/heading actions; terrain following uses `heightMode: aboveGroundLevel`.

## Architecture

Framework‑agnostic **TypeScript engine** (pure, unit‑tested) under `src/app/survey-engine/`:

- `photogrammetry.ts` — GSD / footprint / overlap / spacing / speed + DJI payload catalogue
- `transect-engine.ts` — lawnmower geometry + terrain‑follow densification
- `planning.ts` — GSD⇄height, speed override, > 120 m AGL & camera‑overwhelm warnings
- `terrain.ts` — Terrarium DSM sampling · `geo.ts` — polygon buffer + KML parse · `viewshed.ts` — LOS
- `autofly-mission.ts` — mission JSON emitter · `unleash-api.ts` — API client

**Angular** UI (`survey-planner.ts`) with Leaflet + Geoman. Engine logic is covered by Vitest tests.

## Run it

Requires **Node 18+** (developed on Node 24 LTS).

```bash
npm install
ng serve          # http://localhost:4200
npm test          # Vitest
ng build --base-href /survey-planner/   # static build for hosting
```

## Security / token

The tool never stores or embeds any credentials. To push to the cloud you paste **your own** Unleash Live Personal Access Token, which stays only in your browser's local storage. This is deliberate — no shared keys.
