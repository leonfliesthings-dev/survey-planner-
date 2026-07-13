import { Component, signal, computed, effect, ElementRef, ViewChild, AfterViewInit, ChangeDetectionStrategy, HostListener } from '@angular/core';
import * as L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';

import catalog from './survey-engine/payloads.json';
import { captureTypes, CameraSpec, LensSpec } from './survey-engine/photogrammetry';
import { planFlight, PlanningResult, PlanMode } from './survey-engine/planning';
import { plan, TransectPlan, ElevationFn } from './survey-engine/transect-engine';
import { LatLng } from './survey-engine/waypoint';
import { emitAutoflyMission, AutoflyMission, AutoflyRoutePoint } from './survey-engine/autofly-mission';
import { loadTerrainGrid, browserTerrariumFetcher, TerrainGrid } from './survey-engine/terrain';
import { bufferPolygonMeters, parseKmlPolygon } from './survey-engine/geo';
import { analyseViewshed, ViewshedResult } from './survey-engine/viewshed';
import { UnleashApi } from './survey-engine/unleash-api';

interface PayloadOpt { id: string; name: string; camera: CameraSpec; lens: LensSpec; }
interface ProfilePt { d: number; terrain: number; flight: number; }
interface GenResult {
  planning: PlanningResult;
  tp: TransectPlan;
  mission: AutoflyMission;
  distanceKm: number;
  profile: ProfilePt[];
  minClearanceM: number | null;
  viewshed: ViewshedResult | null;
  terrainFollow: boolean;
  warnings: string[];
}

const SAFETY_CLEARANCE_M = 10;
// Elevation colour ramp: blue → green → yellow → red → purple.
const RAMP: [number, number, number][] = [[44, 111, 214], [55, 178, 77], [255, 212, 59], [255, 59, 48], [176, 46, 224]];

function haversine(a: LatLng, b: LatLng): number {
  const R = 6371000, d = Math.PI / 180;
  const dLat = (b.lat - a.lat) * d, dLng = (b.lng - a.lng) * d;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function rampColor(t: number): string {
  const x = Math.min(0.999, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = RAMP[i], b = RAMP[i + 1] ?? RAMP[i];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

@Component({
  selector: 'app-survey-planner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="app">
      <div class="main">
        <header class="head">
          <div class="hleft">
            <div class="title">◈ Area-Survey Planner</div>
            <div class="sub">
              @if (result(); as r) { {{ r.mission.waypointCount }} waypoints • Waypoint Mission • {{ r.distanceKm.toFixed(2) }} km • {{ mmss(r.tp.estMinutes) }} }
              @else { Draw an area, or search a location to fly to }
            </div>
          </div>
          <form class="search" (submit)="search(q.value); $event.preventDefault()">
            <input #q type="text" placeholder="Search place, address, or  -37.611, 143.851" />
            <button type="submit">Go</button>
          </form>
        </header>

        <div class="toolbar">
          <label class="planname" title="Name this flight plan">
            <span class="pen">✎</span>
            <input class="nameinput" [value]="missionName()" (input)="missionName.set($any($event.target).value)" placeholder="Flight plan name" />
          </label>
          <button class="tb" [class.on]="tool() === 'draw'" (click)="drawArea()">✎ DRAW AREA</button>
          <button class="tb" (click)="kmlInput.click()">⤒ OR IMPORT KML</button>
          <input #kmlInput type="file" accept=".kml" hidden (change)="onKmlFile(kmlInput)" />
          <button class="tb" [class.on]="placingLz()" (click)="placingLz.set(!placingLz())">⌂ {{ placingLz() ? 'CLICK MAP FOR LZ' : 'SET LZ' }}</button>
          <button class="tb" [class.on]="viewshedOn()" (click)="toggleViewshed()" [disabled]="polygon().length < 3 || !lz() || busy()">◉ VIEWSHED</button>
          <button class="tb" (click)="exportJson()" [disabled]="!result()">⤓ EXPORT</button>
          <button class="tb" (click)="clearAll()">🗑 CLEAR</button>
          <span class="spacer"></span>
          <input class="tok" type="password" placeholder="ul_pat_… token" [value]="token()" (input)="token.set($any($event.target).value)" />
          <button (click)="push()" [disabled]="!result() || !token() || busy()">⇪ PUSH</button>
        </div>

        <div class="body">
          <aside class="panel">
            <div class="grp">
              <div class="grid2">
                <label>Drone
                  <select #dr (change)="onDrone(dr.value)">
                    @for (d of drones; track d.id) { <option [value]="d.id" [selected]="d.id === droneId()">{{ d.name }}</option> }
                  </select>
                </label>
                <label>Payload
                  <select #pl (change)="payloadId.set(pl.value)">
                    @for (p of payloadOpts(); track p.id) { <option [value]="p.id" [selected]="p.id === payloadId()">{{ p.name }}</option> }
                  </select>
                </label>
              </div>

              <div class="modeRow">
                <button class="seg" [class.on]="mode() === 'gsd'" (click)="mode.set('gsd')">Set GSD</button>
                <button class="seg" [class.on]="mode() === 'height'" (click)="mode.set('height')">Set height</button>
              </div>
              <div class="grid2">
                @if (mode() === 'gsd') {
                  <label>GSD (cm/px)<input type="number" step="0.5" min="0.5" [value]="targetGsdCm()" (input)="targetGsdCm.set(+$any($event.target).value)" /></label>
                } @else {
                  <label>Height (m AGL)<input type="number" step="5" min="5" [value]="targetHeightM()" (input)="targetHeightM.set(+$any($event.target).value)" /></label>
                }
                <label>Speed (m/s)<input type="number" step="0.5" min="1" placeholder="auto" [value]="speedStr()" (input)="speedStr.set($any($event.target).value)" /></label>
                <label>Buffer (m)<input type="number" step="5" min="0" [value]="bufferM()" (input)="bufferM.set(+$any($event.target).value)" /></label>
                <label>Gimbal (°)<input type="number" step="5" min="-90" max="30" [value]="gimbalDeg()" (input)="gimbalDeg.set(+$any($event.target).value)" /></label>
                <label>Front lap (%)<input type="number" step="5" min="30" max="95" [value]="frontOverlap()" (input)="frontOverlap.set(+$any($event.target).value)" /></label>
                <label>Side lap (%)<input type="number" step="5" min="30" max="95" [value]="sideOverlap()" (input)="sideOverlap.set(+$any($event.target).value)" /></label>
              </div>

              <div class="switchrow">
                <span>Terrain follow</span>
                <button class="switch" [class.on]="terrainFollow()" role="switch" [attr.aria-checked]="terrainFollow()" (click)="terrainFollow.set(!terrainFollow())"><span class="knob"></span></button>
              </div>

              <div class="compassWrap">
                <div class="mut">Transect direction</div>
                <svg #compass class="compass" viewBox="0 0 80 80" (pointerdown)="startCompass($event)">
                  <circle cx="40" cy="40" r="36" class="cface" />
                  <text x="40" y="12" class="cn">N</text><text x="72" y="43" class="cn">E</text><text x="40" y="75" class="cn">S</text><text x="6" y="43" class="cn">W</text>
                  <g [attr.transform]="'rotate(' + directionDeg() + ' 40 40)'"><line x1="40" y1="40" x2="40" y2="10" class="needle" /><line x1="40" y1="40" x2="40" y2="62" class="needletail" /></g>
                  <circle cx="40" cy="40" r="3" class="chub" />
                </svg>
                <div class="cdeg">{{ directionDeg() }}°</div>
              </div>

            </div>

            @if (error()) { <p class="err">{{ error() }}</p> }
            @if (viewshedResult(); as vs) { <p class="info">◉ Viewshed from LZ: {{ vs.clearPercent.toFixed(0) }}% clear ({{ vs.clearRadials }}/{{ vs.totalRadials }} radials)</p> }
            @if (result(); as r) {
              @for (w of r.warnings; track w) { <p class="warn">⚠ {{ w }}</p> }
              @if (pushMsg()) { <p class="ok">{{ pushMsg() }}</p> }

              <div class="wphead">Waypoints ({{ r.mission.waypointCount }}) <span class="mut">· {{ keyWaypoints().length }} shown</span></div>
              <div class="rampcap"><span class="rbar"></span> path colour = flight elevation</div>
              <div class="wplist">
                @for (k of keyWaypoints(); track k.i) {
                  <div class="wp">
                    <span class="badge" [class.s]="k.label === 'S'" [class.e]="k.label === 'E'">{{ k.label }}</span>
                    <span class="wptxt">{{ k.label === 'S' ? 'Start' : (k.label === 'E' ? 'End' : 'Waypoint ' + (k.i + 1)) }}
                      <small>▾ {{ k.p.altitude.toFixed(0) }}m &nbsp; ✥ {{ k.p.heading }}° &nbsp; ◷ {{ k.p.speed.toFixed(0) }}m/s</small>
                    </span>
                  </div>
                }
              </div>
            }
          </aside>

          <div class="rightcol">
            <div class="maptools">
              <button [class.on]="tool() === 'draw'" (click)="drawArea()" title="Draw survey area">
                <svg viewBox="0 0 24 24" width="18" height="18"><polygon points="12,3 21,9.5 17.5,20 6.5,20 3,9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
              </button>
              <button [class.on]="tool() === 'edit'" (click)="editArea()" title="Edit vertices (drag points, add midpoints)">
                <svg viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="6" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="6" cy="6" r="2.6" fill="currentColor"/><circle cx="18" cy="6" r="2.6" fill="currentColor"/><circle cx="6" cy="18" r="2.6" fill="currentColor"/><circle cx="18" cy="18" r="2.6" fill="currentColor"/></svg>
              </button>
              <button [class.on]="tool() === 'delete'" (click)="deleteMode()" title="Delete a point or the shape">
                <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 7h12M9.5 7V5h5v2M8 7l1 12h6l1-12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <button (click)="doneTools()" title="Done editing">
                <svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 13l4 4 10-11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>
            <div #mapEl class="map"></div>
            <div class="profile">
              <div class="phead">Terrain profile
                @if (result(); as r) {
                  @if (r.minClearanceM !== null) { <span [class.bad]="r.minClearanceM < clearance">min clearance {{ r.minClearanceM.toFixed(0) }} m</span> }
                  @else { <span class="mut">no DSM — enable terrain / check CORS</span> }
                }
              </div>
              <svg class="pchart" viewBox="0 0 900 150" preserveAspectRatio="none">
                @if (result()) {
                  <path [attr.d]="terrainPath()" class="terrain" />
                  <polyline [attr.points]="flightLine()" class="flight" />
                  @for (c of collisions(); track $index) { <circle [attr.cx]="c[0]" [attr.cy]="c[1]" r="3" class="hit" /> }
                }
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; height:100vh; color:#e6edf3; font:14px -apple-system,Segoe UI,Roboto,sans-serif; }
    .app { display:flex; height:100%; }
    .main { flex:1; display:flex; flex-direction:column; min-width:0; }
    .head { background:#2b3644; padding:10px 18px; display:flex; align-items:center; gap:18px; }
    .hleft { flex:0 0 auto; }
    .title { font-size:17px; font-weight:600; }
    .sub { color:#8b98a5; font-size:12px; margin-top:2px; }
    .search { flex:1; max-width:560px; margin:0 auto; display:flex; gap:8px; }
    .search input { flex:1; margin:0; padding:8px 12px; background:#1c2430; border:1px solid #3a4756; border-radius:8px; color:#e6edf3; font-size:13px; }
    .search button { padding:8px 16px; background:#2f6fd6; color:#fff; border:0; border-radius:8px; font-weight:600; cursor:pointer; }
    .toolbar { background:#2f6fd6; display:flex; align-items:center; gap:8px; padding:8px 14px; }
    .toolbar button { background:transparent; color:#fff; border:0; font-weight:700; font-size:12px; cursor:pointer; padding:6px 8px; border-radius:6px; }
    .toolbar button:hover:not(:disabled) { background:rgba(255,255,255,.15); }
    .toolbar button.on { background:rgba(255,255,255,.28); }
    .toolbar button:disabled { opacity:.45; cursor:not-allowed; }
    .toolbar .spacer { flex:1; }
    .planname { display:flex; align-items:center; gap:6px; background:rgba(255,255,255,.16); border-radius:6px; padding:3px 10px; margin-right:4px; }
    .planname .pen { color:#fff; font-size:12px; opacity:.85; }
    .nameinput { background:transparent; border:0; color:#fff; font-size:13px; font-weight:600; width:160px; padding:3px 2px; margin:0; }
    .nameinput::placeholder { color:rgba(255,255,255,.6); font-weight:400; }
    .nameinput:focus { outline:none; }
    .tok { width:180px; padding:5px 8px; border-radius:6px; border:0; font-size:12px; }
    .body { flex:1; display:flex; min-height:0; }
    .panel { width:300px; flex:0 0 300px; overflow-y:auto; padding:14px 16px; background:#0f151c; }
    .grp label { display:block; font-size:11px; color:#8b98a5; margin:11px 0 0; }
    .grp label.row { display:flex; gap:8px; align-items:center; color:#e6edf3; font-size:13px; }
    input, select { width:100%; margin-top:4px; padding:7px 9px; background:#131a22; border:1px solid #202b36; border-radius:8px; color:#e6edf3; font-size:13px; }
    label.row input { width:auto; margin:0; }
    .mut { color:#5b6774; }
    .modeRow, .compassWrap { margin-top:12px; }
    .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:11px; }
    .grid2 label { margin-top:0; min-width:0; }
    .grid2 select { text-overflow:ellipsis; }
    .seg { width:50%; padding:7px; background:#131a22; border:1px solid #202b36; color:#8b98a5; cursor:pointer; }
    .seg:first-child { border-radius:8px 0 0 8px; } .seg:last-child { border-radius:0 8px 8px 0; border-left:0; }
    .seg.on { background:#2f6fd6; color:#fff; border-color:#2f6fd6; }
    .switchrow { display:flex; align-items:center; justify-content:space-between; margin-top:14px; font-size:13px; color:#e6edf3; }
    .switch { width:42px; height:22px; border-radius:11px; background:#2b3644; border:0; position:relative; cursor:pointer; padding:0; transition:background .15s; }
    .switch.on { background:#2f6fd6; }
    .switch .knob { position:absolute; top:2px; left:2px; width:18px; height:18px; border-radius:50%; background:#fff; transition:left .15s; }
    .switch.on .knob { left:22px; }
    .compassWrap { display:flex; flex-direction:column; align-items:center; }
    .compass { width:96px; height:96px; touch-action:none; cursor:grab; }
    .cface { fill:#131a22; stroke:#202b36; stroke-width:2; }
    .cn { fill:#8b98a5; font-size:9px; text-anchor:middle; }
    .needle { stroke:#ff7b72; stroke-width:3; stroke-linecap:round; }
    .needletail { stroke:#39d0d8; stroke-width:3; stroke-linecap:round; }
    .chub { fill:#e6edf3; }
    .cdeg { color:#39d0d8; font-variant-numeric:tabular-nums; margin-top:2px; }
    .err { color:#ff7b72; font-size:12px; } .warn { color:#e3b341; font-size:12px; } .ok { color:#3fb950; font-size:12px; } .info { color:#74c0fc; font-size:12px; }
    .wphead { margin-top:16px; font-weight:600; color:#c9d4de; }
    .rampcap { font-size:11px; color:#8b98a5; margin-top:4px; display:flex; align-items:center; gap:6px; }
    .rbar { width:60px; height:8px; border-radius:4px; background:linear-gradient(90deg,#2c6fd6,#37b24d,#ffd43b,#ff3b30,#b02ee0); }
    .wplist { margin-top:8px; }
    .wp { display:flex; gap:10px; align-items:center; padding:5px 0; }
    .badge { width:24px; height:24px; flex:0 0 24px; border-radius:50%; background:#37b24d; color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; }
    .badge.s { background:#2f9e44; } .badge.e { background:#1971c2; }
    .wptxt { font-size:13px; } .wptxt small { display:block; color:#8b98a5; font-size:11px; margin-top:1px; }
    .rightcol { flex:1; display:flex; flex-direction:column; min-width:0; position:relative; }
    .map { flex:1; min-height:0; background:#0b0f14; }
    .maptools { position:absolute; top:12px; right:12px; z-index:1000; display:flex; flex-direction:column; gap:6px; }
    .maptools button { width:38px; height:38px; background:#fff; border:0; border-radius:8px; box-shadow:0 1px 5px rgba(0,0,0,.45); color:#2b3644; display:flex; align-items:center; justify-content:center; cursor:pointer; }
    .maptools button:hover { background:#eef2f6; }
    .maptools button.on { background:#2f6fd6; color:#fff; }
    .profile { height:170px; flex:0 0 170px; background:#0d1218; border-top:1px solid #202b36; padding:8px 12px; }
    .phead { font-size:12px; color:#8b98a5; display:flex; gap:12px; }
    .phead .bad { color:#ff7b72; font-weight:700; }
    .pchart { width:100%; height:130px; }
    .terrain { fill:#3b3226; stroke:#c9a15b; stroke-width:1.5; }
    .flight { fill:none; stroke:#39d0d8; stroke-width:2; }
    .hit { fill:#ff3b30; }
  `],
})
export class SurveyPlanner implements AfterViewInit {
  @ViewChild('mapEl') mapEl!: ElementRef<HTMLDivElement>;
  @ViewChild('compass') compassEl!: ElementRef<SVGSVGElement>;

  readonly clearance = SAFETY_CLEARANCE_M;
  readonly drones = catalog.aircraft;
  private readonly allPayloads = catalog.payloads;

  readonly droneId = signal('m4d');
  readonly payloadId = signal('');
  readonly mode = signal<PlanMode>('gsd');
  readonly targetGsdCm = signal(2);
  readonly targetHeightM = signal(80);
  readonly speedStr = signal('');
  readonly bufferM = signal(40);
  readonly directionDeg = signal(90);
  readonly gimbalDeg = signal(-90);
  readonly frontOverlap = signal(70);
  readonly sideOverlap = signal(70);
  readonly terrainFollow = signal(false);
  readonly viewshedOn = signal(false);
  readonly viewshedResult = signal<ViewshedResult | null>(null);
  readonly token = signal((typeof localStorage !== 'undefined' && localStorage.getItem('ul_pat')) || '');
  readonly missionName = signal('');
  readonly placingLz = signal(false);
  readonly tool = signal<'none' | 'draw' | 'edit' | 'delete'>('none');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly pushMsg = signal('');
  readonly polygon = signal<LatLng[]>([]);
  readonly lz = signal<LatLng | null>(null);
  readonly result = signal<GenResult | null>(null);

  readonly payloadOpts = computed<PayloadOpt[]>(() => this.payloadsFor(this.droneId()));
  readonly keyWaypoints = computed<{ i: number; label: string; p: AutoflyRoutePoint }[]>(() => {
    const route = this.result()?.mission.route ?? [];
    const n = route.length;
    return route
      .map((p, i) => ({ i, p, key: i === 0 || i === n - 1 || p.actions.length > 0 }))
      .filter((x) => x.key)
      .map((x) => ({ i: x.i, label: x.i === 0 ? 'S' : x.i === n - 1 ? 'E' : String(x.i + 1), p: x.p }));
  });

  private map!: L.Map;
  private drawLayer = L.layerGroup();
  private viewshedLayer = L.layerGroup();
  private surveyLayer: L.Polygon | null = null;
  private lzMarker: L.Marker | null = null;
  private compassDragging = false;
  private regenTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // Auto-rebuild the plan whenever any left-panel setting or the drawn area changes.
    effect(() => {
      this.droneId(); this.payloadId(); this.mode(); this.targetGsdCm(); this.targetHeightM();
      this.speedStr(); this.bufferM(); this.gimbalDeg(); this.frontOverlap(); this.sideOverlap(); this.directionDeg(); this.terrainFollow(); this.polygon(); this.lz();
      this.scheduleRegen();
    });
    // Remember the token across reloads (browser localStorage).
    effect(() => {
      const t = this.token();
      try { localStorage.setItem('ul_pat', t); } catch { /* storage unavailable */ }
    });
  }

  private scheduleRegen(): void {
    clearTimeout(this.regenTimer);
    // Don't rebuild while the map draw/edit/delete tools are active — only when idle.
    this.regenTimer = setTimeout(() => { if (this.tool() === 'none' && this.polygon().length >= 3 && !this.busy()) this.generate(); }, 450);
  }

  ngAfterViewInit(): void {
    this.payloadId.set(this.payloadOpts()[0]?.id ?? '');
    this.map = L.map(this.mapEl.nativeElement, { center: [-37.611, 143.851], zoom: 15 });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery: Esri, Maxar' }).addTo(this.map);
    this.viewshedLayer.addTo(this.map);
    this.drawLayer.addTo(this.map);

    // Geoman for GCS-style editing, but driven from our own icon buttons (its
    // default toolbar icons don't survive Angular's asset pipeline).
    const pm = (this.map as any).pm;
    pm.setGlobalOptions({ allowSelfIntersection: false, pathOptions: { color: '#39d0d8', weight: 2, fillOpacity: 0.06 } });
    this.map.on('pm:create', (e: any) => this.onDrawCreate(e.layer as L.Polygon));

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      if (this.placingLz()) { this.setLz({ lat: e.latlng.lat, lng: e.latlng.lng }); this.placingLz.set(false); }
    });
  }

  private onDrawCreate(layer: L.Polygon): void {
    // Keep a single survey polygon — replace any previous one.
    if (this.surveyLayer) this.map.removeLayer(this.surveyLayer);
    this.surveyLayer = layer;
    this.syncPolygon(layer);
    const resync = () => this.syncPolygon(layer);
    layer.on('pm:edit', resync);
    layer.on('pm:update', resync);
    (layer as any).on('pm:markerdragend', resync);
    (layer as any).on('pm:vertexadded', resync);
    (layer as any).on('pm:vertexremoved', resync);
    // Drop into edit mode on the area only; hide transects until accepted.
    (this.map as any).pm.disableDraw();
    this.hideTransects();
    (layer as any).pm.enable({ allowSelfIntersection: false });
    this.tool.set('edit');
  }

  // --- GCS-style draw/edit tools (drive Geoman from our own buttons) ---
  private pm(): any { return (this.map as any).pm; }
  // While editing the AREA, hide the transects entirely — only the polygon is editable.
  private hideTransects(): void { this.drawLayer.clearLayers(); this.viewshedLayer.clearLayers(); }
  private resetModes(): void {
    const pm = this.pm();
    pm.disableDraw?.(); pm.disableGlobalEditMode?.(); pm.disableGlobalDragMode?.(); pm.disableGlobalRemovalMode?.();
    (this.surveyLayer as any)?.pm?.disable?.();
    this.tool.set('none');
  }
  drawArea(): void { this.resetModes(); this.hideTransects(); this.pm().enableDraw('Polygon'); this.tool.set('draw'); }
  editArea(): void {
    if (this.tool() === 'edit') return this.doneTools();
    if (!this.surveyLayer) { this.error.set('Draw an area first (✎ DRAW AREA).'); return; }
    this.resetModes(); this.hideTransects();
    (this.surveyLayer as any).pm.enable({ allowSelfIntersection: false });
    this.tool.set('edit');
  }
  deleteMode(): void {
    if (this.tool() === 'delete') return this.doneTools();
    this.resetModes(); this.hideTransects();
    this.pm().enableGlobalRemovalMode();
    this.tool.set('delete');
  }
  // The ✓ button: accept the area edit and (re)build the transects.
  doneTools(): void { this.resetModes(); this.scheduleRegen(); }

  // --- Viewshed on demand from the LZ + current settings ---
  async toggleViewshed(): Promise<void> {
    if (this.viewshedOn()) { this.viewshedOn.set(false); this.viewshedLayer.clearLayers(); this.viewshedResult.set(null); return; }
    if (!this.lz()) { this.error.set('Set the LZ first (⌂ SET LZ), then ◉ VIEWSHED.'); return; }
    this.viewshedOn.set(true); this.busy.set(true); this.error.set('');
    try { await this.computeViewshed(); }
    catch (e: unknown) { this.viewshedOn.set(false); this.error.set(e instanceof Error ? e.message : String(e)); }
    finally { this.busy.set(false); }
  }

  // Viewshed reaches the capture area: LZ → farthest polygon vertex, +10%.
  private viewshedRange(lz: LatLng): number {
    const poly = this.polygon();
    if (poly.length === 0) return 300;
    return Math.max(100, Math.max(...poly.map((p) => haversine(lz, p))) * 1.1);
  }

  private async computeViewshed(): Promise<void> {
    const lz = this.lz(); if (!lz) return;
    const opt = this.payloadOpts().find((p) => p.id === this.payloadId()) ?? this.payloadOpts()[0];
    const aircraft = this.drones.find((d) => d.id === this.droneId())!;
    const planning = planFlight({ camera: opt.camera, lens: opt.lens, captureType: this.captureConfig(), mode: this.mode(), targetGsdCm: this.targetGsdCm(), targetHeightM: this.targetHeightM(), mappingSpeedMs: aircraft.mappingSpeedMs, aircraftFlightTimeMinutes: aircraft.maxFlightTimeMinutes });
    const range = this.viewshedRange(lz);
    const dLat = range / 110540, dLng = range / (111320 * Math.cos((lz.lat * Math.PI) / 180));
    const grid = await loadTerrainGrid({ minLat: lz.lat - dLat, maxLat: lz.lat + dLat, minLng: lz.lng - dLng, maxLng: lz.lng + dLng }, 13, browserTerrariumFetcher());
    if (grid.tileCount === 0) throw new Error('Viewshed: terrain tiles unavailable (CORS/offline).');
    const takeoffMsl = grid.elevationAt(lz) ?? 0;
    const vs = analyseViewshed({ lz, flightHeightAGL: planning.fp.heightM, maxRangeM: range, elevationAt: grid.elevationAt, observerElevMsl: takeoffMsl });
    this.viewshedResult.set(vs);
    this.drawViewshed(vs, lz);
  }

  private syncPolygon(layer: L.Polygon): void {
    const ring = layer.getLatLngs()[0] as L.LatLng[];
    this.polygon.set(ring.map((p) => ({ lat: p.lat, lng: p.lng })));
  }

  private payloadsFor(droneId: string): PayloadOpt[] {
    const a = this.drones.find((d) => d.id === droneId);
    if (!a) return [];
    const ids = a.hasSwappablePayload ? a.compatiblePayloadIds : a.builtInCameraIds;
    return ids
      .map((id) => this.allPayloads.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p && p.sensorWidthMm != null && p.lenses.length > 0)
      .map((p) => ({
        id: p.id, name: p.name,
        camera: { name: p.name, sensorWidthMm: p.sensorWidthMm as number, sensorHeightMm: p.sensorHeightMm as number, imageWidthPx: p.imageWidthPx as number, imageHeightPx: p.imageHeightPx as number },
        lens: { name: p.lenses[0].name, focalLengthMm: p.lenses[0].focalLengthMm },
      }));
  }

  onDrone(id: string): void { this.droneId.set(id); this.payloadId.set(this.payloadsFor(id)[0]?.id ?? ''); }
  mmss(min: number): string { const s = Math.round(min * 60); return `${Math.floor(s / 60)}m ${s % 60}s`; }

  private setLz(p: LatLng): void {
    this.lz.set(p);
    if (this.lzMarker) this.lzMarker.setLatLng([p.lat, p.lng]);
    else {
      this.lzMarker = L.marker([p.lat, p.lng], { draggable: true, icon: L.divIcon({ className: '', html: '<div style="background:#f59f00;color:#000;font-weight:700;font-size:10px;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border:2px solid #fff">LZ</div>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(this.map);
      this.lzMarker.on('dragend', () => { const ll = this.lzMarker!.getLatLng(); this.lz.set({ lat: ll.lat, lng: ll.lng }); });
    }
  }

  clearAll(): void {
    this.polygon.set([]); this.result.set(null); this.error.set(''); this.pushMsg.set('');
    if (this.surveyLayer) { this.map.removeLayer(this.surveyLayer); this.surveyLayer = null; }
    this.drawLayer.clearLayers(); this.viewshedLayer.clearLayers();
  }

  // Location search: lat,lng jumps directly; otherwise geocode via Nominatim (OSM).
  async search(qRaw: string): Promise<void> {
    const q = qRaw.trim(); if (!q) return;
    const coord = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(q);
    if (coord) { this.map.setView([+coord[1], +coord[2]], 16); return; }
    this.error.set('');
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      const arr = (await res.json()) as any[];
      if (!arr.length) { this.error.set(`No location match for "${q}".`); return; }
      const r = arr[0];
      if (r.boundingbox) { const [s, n, w, e] = (r.boundingbox as string[]).map(Number); this.map.fitBounds([[s, w], [n, e]]); }
      else this.map.setView([+r.lat, +r.lon], 16);
    } catch (e: unknown) { this.error.set('Search failed: ' + (e instanceof Error ? e.message : String(e))); }
  }

  // KML import: pull the capture-area polygon out of a .kml and drop it on the map.
  async onKmlFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]; if (!file) return;
    try {
      const ring = parseKmlPolygon(await file.text());
      if (ring.length < 3) throw new Error('No polygon found in the KML.');
      this.importArea(ring);
    } catch (e: unknown) { this.error.set('KML import failed: ' + (e instanceof Error ? e.message : String(e))); }
    finally { input.value = ''; }
  }

  private importArea(ring: LatLng[]): void {
    this.resetModes();
    if (this.surveyLayer) this.map.removeLayer(this.surveyLayer);
    const layer = L.polygon(ring.map((p) => [p.lat, p.lng] as [number, number]), { color: '#39d0d8', weight: 2, fillOpacity: 0.06 }).addTo(this.map);
    this.surveyLayer = layer;
    const resync = () => this.syncPolygon(layer);
    layer.on('pm:edit', resync);
    layer.on('pm:update', resync);
    this.syncPolygon(layer); // sets polygon() → auto-build
    this.map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  }

  startCompass(e: PointerEvent): void { this.compassDragging = true; this.updateCompass(e); }
  @HostListener('window:pointermove', ['$event']) onMove(e: PointerEvent): void { if (this.compassDragging) this.updateCompass(e); }
  @HostListener('window:pointerup') onUp(): void { this.compassDragging = false; }
  private updateCompass(e: PointerEvent): void {
    const r = this.compassEl.nativeElement.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    this.directionDeg.set(Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360));
  }

  // Nadir ortho capture type with the user's front/side overlap folded in.
  private captureConfig() {
    return { ...captureTypes.find((c) => c.type === 'ortho2d')!, frontOverlapPct: this.frontOverlap(), sideOverlapPct: this.sideOverlap() };
  }

  async generate(): Promise<void> {
    this.error.set(''); this.pushMsg.set(''); this.busy.set(true);
    try {
      const target = this.polygon();
      const opt = this.payloadOpts().find((p) => p.id === this.payloadId()) ?? this.payloadOpts()[0];
      const aircraft = this.drones.find((d) => d.id === this.droneId())!;
      const speedOverride = this.speedStr().trim() ? +this.speedStr() : null;

      const planning = planFlight({
        camera: opt.camera, lens: opt.lens, captureType: this.captureConfig(),
        mode: this.mode(), targetGsdCm: this.targetGsdCm(), targetHeightM: this.targetHeightM(),
        mappingSpeedMs: aircraft.mappingSpeedMs, speedOverrideMs: speedOverride, aircraftFlightTimeMinutes: aircraft.maxFlightTimeMinutes,
      });
      const { fp } = planning;

      let grid: TerrainGrid | null = null;
      if (target.length >= 3) {
        const lats = target.map((p) => p.lat), lngs = target.map((p) => p.lng);
        try {
          const g = await loadTerrainGrid({ minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs) }, 13, browserTerrariumFetcher());
          if (g.tileCount > 0) grid = g;
        } catch { /* handled below */ }
      }

      const lz = this.lz() ?? target[0];
      const takeoffMsl = grid?.elevationAt(lz) ?? 0;
      const genElev: ElevationFn = this.terrainFollow() && grid ? grid.elevationAt : () => takeoffMsl;

      const flightPoly = bufferPolygonMeters(target, this.bufferM());
      const tp = plan({ polygon: flightPoly, directionDeg: this.directionDeg(), spacingM: fp.lineSpacingM, aglM: fp.heightM, speedMs: planning.effectiveSpeedMs, lz, elevationAt: genElev });

      const mission = emitAutoflyMission({
        name: this.missionName().trim() || `Area Survey — ${opt.name} ${planning.gsdCm.toFixed(1)}cm`,
        description: `GSD ${fp.resultingGsdCmPx.toFixed(1)} cm/px, ${fp.frontOverlapPct}/${fp.sideOverlapPct} overlap, buffer ${this.bufferM()} m`,
        waypoints: tp.waypoints, photoSpacingM: fp.triggerDistanceM, takeoffElevationMslM: takeoffMsl, heightMode: 'relativeToStartPoint', nadirPitchDeg: this.gimbalDeg(),
      });

      // Terrain profile + collision check — sample densely ALONG the flight path
      // (every ~15 m), interpolating flight altitude between waypoints, so the
      // terrain trace is high-fidelity rather than one coarse point per waypoint.
      const PROFILE_STEP_M = 10;
      const aglTarget = fp.heightM;
      const follow = this.terrainFollow();
      const wps = tp.waypoints;
      const profile: ProfilePt[] = [];
      let dist = 0, minClear = Infinity, haveDsm = false;
      const sample = (pos: LatLng, d: number) => {
        const terr = grid ? grid.elevationAt(pos) : null;
        if (terr != null) haveDsm = true;
        const terrainMsl = terr ?? takeoffMsl;
        // What actually flies: surface-follow holds AGL above the local ground;
        // fixed-height flies flat above the take-off point (real collision risk).
        const flightMsl = follow ? terrainMsl + aglTarget : takeoffMsl + aglTarget;
        minClear = Math.min(minClear, flightMsl - terrainMsl);
        profile.push({ d, terrain: terrainMsl, flight: flightMsl });
      };
      if (wps.length) sample(wps[0].pos, 0);
      for (let i = 1; i < wps.length; i++) {
        const prev = wps[i - 1], cur = wps[i];
        const segLen = haversine(prev.pos, cur.pos);
        const n = Math.max(1, Math.ceil(segLen / PROFILE_STEP_M));
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          dist += segLen / n;
          sample({ lat: prev.pos.lat + (cur.pos.lat - prev.pos.lat) * t, lng: prev.pos.lng + (cur.pos.lng - prev.pos.lng) * t }, dist);
        }
      }

      // Viewshed rose from the LZ (needs a DSM).
      let viewshed: ViewshedResult | null = null;
      const warnings = [...planning.warnings, ...tp.warnings];
      if (this.viewshedOn()) {
        if (grid) viewshed = analyseViewshed({ lz, flightHeightAGL: fp.heightM, maxRangeM: this.viewshedRange(lz), elevationAt: grid.elevationAt, observerElevMsl: takeoffMsl });
        else warnings.push('Viewshed needs terrain tiles (DSM) — none loaded (CORS/offline).');
      }
      this.viewshedResult.set(viewshed);

      if (!haveDsm && this.terrainFollow()) warnings.push('Terrain tiles unavailable (CORS/offline) — used flat elevation.');
      if (haveDsm && minClear < SAFETY_CLEARANCE_M) warnings.push(`Terrain collision risk: min clearance ${minClear.toFixed(0)} m (below ${SAFETY_CLEARANCE_M} m). Enable terrain follow or raise height.`);
      if (speedOverride && speedOverride > aircraft.maxSpeedMs) warnings.push(`Speed ${speedOverride} m/s exceeds the ${aircraft.name} max (${aircraft.maxSpeedMs} m/s).`);

      this.result.set({ planning, tp, mission, distanceKm: tp.totalLengthM / 1000, profile, minClearanceM: haveDsm ? minClear : null, viewshed, terrainFollow: this.terrainFollow(), warnings });
      this.drawSurvey(mission.route, target, flightPoly);
      this.drawViewshed(viewshed, lz);
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  private drawSurvey(route: AutoflyRoutePoint[], _target: LatLng[], flightPoly: LatLng[]): void {
    this.drawLayer.clearLayers();
    // Target polygon is the editable Geoman layer; here we add the buffered flight boundary.
    L.polygon(flightPoly.map((p) => [p.lat, p.lng] as [number, number]), { color: '#f59f00', weight: 1, dashArray: '5,5', fill: false }).addTo(this.drawLayer);

    // Elevation-ramped path, coloured from each waypoint's own altitude (aligned to route).
    const alts = route.map((p) => p.altitudeEGM ?? p.altitude);
    const lo = Math.min(...alts), hi = Math.max(...alts), span = hi - lo || 1;
    for (let i = 0; i + 1 < route.length; i++) {
      const t = (((alts[i] + alts[i + 1]) / 2) - lo) / span;
      L.polyline([[route[i].lat, route[i].lng], [route[i + 1].lat, route[i + 1].lng]], { color: rampColor(t), weight: 3 }).addTo(this.drawLayer);
    }

    // Markers only at turn/endpoint waypoints (internal terrain-follow points hidden).
    const n = route.length;
    route.forEach((p, i) => {
      if (!(i === 0 || i === n - 1 || p.actions.length > 0)) return;
      const label = i === 0 ? 'S' : i === n - 1 ? 'E' : String(i + 1);
      const bg = i === 0 ? '#2f9e44' : i === n - 1 ? '#1971c2' : '#37b24d';
      L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: `<div style="background:${bg};color:#fff;font-weight:700;font-size:10px;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border:2px solid #fff">${label}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(this.drawLayer);
    });
  }

  private drawViewshed(vs: ViewshedResult | null, lz: LatLng): void {
    this.viewshedLayer.clearLayers();
    if (!vs) return;
    const mLng = 111320 * Math.cos((lz.lat * Math.PI) / 180);
    const halfDeg = 180 / vs.totalRadials; // half wedge width
    const step = vs.stepM;
    const edge = (bearingDeg: number, dist: number): [number, number] => {
      const br = (bearingDeg * Math.PI) / 180;
      return [lz.lat + (dist * Math.cos(br)) / 111320, lz.lng + (dist * Math.sin(br)) / mLng];
    };
    // Per-step ring cells: green where the LOS cell is clear, red only where blocked.
    for (const r of vs.radials) {
      const b0 = r.bearingDeg - halfDeg, b1 = r.bearingDeg + halfDeg;
      for (let s = 0; s < r.stepsClear.length; s++) {
        const inner = s * step, outer = (s + 1) * step;
        const cell: [number, number][] = [edge(b0, inner), edge(b1, inner), edge(b1, outer), edge(b0, outer)];
        L.polygon(cell, { stroke: false, fillColor: r.stepsClear[s] ? '#37b24d' : '#ff3b30', fillOpacity: 0.35 }).addTo(this.viewshedLayer);
      }
    }
  }

  private profileBounds(): { dMax: number; loMsl: number; hiMsl: number } {
    const p = this.result()?.profile ?? [];
    const dMax = Math.max(1, ...p.map((x) => x.d));
    const loMsl = Math.min(Infinity, ...p.map((x) => Math.min(x.terrain, x.flight)));
    const hiMsl = Math.max(-Infinity, ...p.map((x) => Math.max(x.terrain, x.flight)));
    return { dMax, loMsl: loMsl === Infinity ? 0 : loMsl, hiMsl: hiMsl === -Infinity ? 1 : hiMsl };
  }
  private px(d: number, dMax: number): number { return (d / dMax) * 900; }
  private py(msl: number, lo: number, hi: number): number { const pad = (hi - lo) * 0.15 + 1; return 145 - ((msl - lo + pad / 2) / (hi - lo + pad)) * 140; }

  readonly terrainPath = computed(() => {
    const p = this.result()?.profile ?? []; if (!p.length) return '';
    const { dMax, loMsl, hiMsl } = this.profileBounds();
    return `M0,150 L${p.map((x) => `${this.px(x.d, dMax).toFixed(1)},${this.py(x.terrain, loMsl, hiMsl).toFixed(1)}`).join(' L')} L900,150 Z`;
  });
  readonly flightLine = computed(() => {
    const p = this.result()?.profile ?? []; if (!p.length) return '';
    const { dMax, loMsl, hiMsl } = this.profileBounds();
    return p.map((x) => `${this.px(x.d, dMax).toFixed(1)},${this.py(x.flight, loMsl, hiMsl).toFixed(1)}`).join(' ');
  });
  readonly collisions = computed<[number, number][]>(() => {
    const p = this.result()?.profile ?? []; if (!p.length) return [];
    const { dMax, loMsl, hiMsl } = this.profileBounds();
    return p.filter((x) => x.flight - x.terrain < SAFETY_CLEARANCE_M).map((x) => [this.px(x.d, dMax), this.py(x.flight, loMsl, hiMsl)] as [number, number]);
  });

  // The mission we hand the cloud. When terrain-follow is on we DON'T ship our
  // baked relative altitudes (those stay in-app for the profile + colour ramp);
  // instead every waypoint is flattened to the constant target AGL and the mode
  // is set to aboveGroundLevel, so the cloud follows the surface itself.
  private missionForCloud(r: GenResult): AutoflyMission {
    const name = this.missionName().trim() || r.mission.name;
    if (!r.terrainFollow) return { ...r.mission, name };
    const agl = Math.round(r.planning.fp.heightM * 100) / 100;
    return {
      ...r.mission,
      name,
      heightMode: 'aboveGroundLevel',
      route: r.mission.route.map((p) => ({ lat: p.lat, lng: p.lng, altitude: agl, heading: p.heading, pitch: p.pitch, gimbal: p.gimbal, speed: p.speed, actions: p.actions })),
    };
  }

  exportJson(): void {
    const r = this.result(); if (!r) return;
    const mission = this.missionForCloud(r);
    const blob = new Blob([JSON.stringify(mission, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${mission.name.replace(/[^\w]+/g, '_')}.json`; a.click();
    URL.revokeObjectURL(a.href);
  }

  async push(): Promise<void> {
    const r = this.result(); if (!r) return;
    this.busy.set(true); this.pushMsg.set(''); this.error.set('');
    try {
      const mission = this.missionForCloud(r);
      const created = await new UnleashApi({ token: this.token() }).createMission(mission);
      const agl = Math.round(r.planning.fp.heightM);
      this.pushMsg.set(`✓ Created "${mission.name}"${r.terrainFollow ? ` — surface-follow @ ${agl} m AGL` : ''} — id ${created.id}`);
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }
}
