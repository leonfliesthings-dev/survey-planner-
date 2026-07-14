import { Component, signal, computed, effect, ElementRef, ViewChild, AfterViewInit, ChangeDetectionStrategy, HostListener } from '@angular/core';
import * as L from 'leaflet';
import '@geoman-io/leaflet-geoman-free';

import catalog from './survey-engine/payloads.json';
import { captureTypes, CameraSpec, LensSpec } from './survey-engine/photogrammetry';
import { planFlight, PlanningResult, PlanMode } from './survey-engine/planning';
import { plan, TransectPlan, ElevationFn } from './survey-engine/transect-engine';
import { buildOrbit, buildCorridor, buildPerimeter } from './survey-engine/builders';
import { LatLng } from './survey-engine/waypoint';
import { emitAutoflyMission, AutoflyMission, AutoflyRoutePoint } from './survey-engine/autofly-mission';
import { loadTerrainGrid, browserTerrariumFetcher, TerrainGrid } from './survey-engine/terrain';
import { bufferPolygonMeters, parseKmlPolygon, parseKmlLine, parseKmlPoint } from './survey-engine/geo';
import { analyseViewshed, ViewshedResult } from './survey-engine/viewshed';
import { UnleashApi } from './survey-engine/unleash-api';

type MissionType = 'transect' | 'crossgrid' | 'perimeter' | 'orbit' | 'corridor';
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
const RAMP: [number, number, number][] = [[44, 111, 214], [55, 178, 77], [255, 212, 59], [255, 59, 48], [176, 46, 224]];

function haversine(a: LatLng, b: LatLng): number {
  const R = 6371000, d = Math.PI / 180;
  const dLat = (b.lat - a.lat) * d, dLng = (b.lng - a.lng) * d;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function mergePlans(a: TransectPlan, b: TransectPlan): TransectPlan {
  return {
    transects: [...a.transects, ...b.transects],
    waypoints: [...a.waypoints, ...b.waypoints],
    lineCount: a.lineCount + b.lineCount,
    totalLengthM: a.totalLengthM + b.totalLengthM,
    estMinutes: a.estMinutes + b.estMinutes,
    warnings: [...a.warnings, ...b.warnings],
  };
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
            <div class="title">◈ Mission Planner</div>
            <div class="sub">
              @if (result(); as r) { {{ r.mission.waypointCount }} waypoints • {{ typeLabel() }} • {{ r.distanceKm.toFixed(2) }} km • {{ mmss(r.tp.estMinutes) }} }
              @else { {{ drawHint() }} }
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
          <button class="tb" (click)="kmlInput.click()">⤒ IMPORT KML</button>
          <input #kmlInput type="file" accept=".kml" hidden (change)="onKmlFile(kmlInput)" />
          <button class="tb" [class.on]="placingLz()" (click)="placingLz.set(!placingLz())">⌂ {{ placingLz() ? 'CLICK MAP FOR LZ' : 'SET LZ' }}</button>
          <button class="tb" [class.on]="viewshedOn()" (click)="toggleViewshed()" [disabled]="!ready() || !lz() || busy()">◉ VIEWSHED</button>
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

              <label>Mission type
                <select #mt (change)="setMissionType($any(mt.value))">
                  <option value="transect" [selected]="missionType() === 'transect'">Area survey (transect) — lawnmower</option>
                  <option value="crossgrid" [selected]="missionType() === 'crossgrid'">Area survey (cross grid) — N-S + E-W</option>
                  <option value="perimeter" [selected]="missionType() === 'perimeter'">Perimeter — boundary</option>
                  <option value="orbit" [selected]="missionType() === 'orbit'">Orbit — around a point</option>
                  <option value="corridor" [selected]="missionType() === 'corridor'">Corridor — along a line</option>
                </select>
              </label>

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
                @if (missionType() !== 'orbit') {
                  <label>Gimbal (°)<input type="number" step="5" min="-90" max="30" [value]="gimbalDeg()" (input)="gimbalDeg.set(+$any($event.target).value)" /></label>
                  <label>Front lap (%)<input type="number" step="5" min="30" max="95" [value]="frontOverlap()" (input)="frontOverlap.set(+$any($event.target).value)" /></label>
                  <label>Side lap (%)<input type="number" step="5" min="30" max="95" [value]="sideOverlap()" (input)="sideOverlap.set(+$any($event.target).value)" /></label>
                }
              </div>

              <!-- Per-type parameters -->
              @if (missionType() === 'transect' || missionType() === 'crossgrid') {
                <div class="grid2">
                  <label>Buffer (m)<input type="number" step="5" min="0" [value]="bufferM()" (input)="bufferM.set(+$any($event.target).value)" /></label>
                </div>
              }
              @if (missionType() === 'perimeter') {
                <div class="grid2">
                  <label>Standoff (m)<input type="number" step="5" min="0" [value]="standoffM()" (input)="standoffM.set(+$any($event.target).value)" /></label>
                  <label>Runs <span class="mut">— spaced by lap</span><input type="number" step="1" min="1" [value]="perimeterRuns()" (input)="perimeterRuns.set(+$any($event.target).value)" /></label>
                </div>
              }
              @if (missionType() === 'corridor') {
                <div class="grid2">
                  <label>Corridor width (m)<input type="number" step="5" min="0" [value]="corridorWidthM()" (input)="corridorWidthM.set(+$any($event.target).value)" /></label>
                  <label>Runs (0=auto)<input type="number" step="1" min="0" [value]="corridorRuns()" (input)="corridorRuns.set(+$any($event.target).value)" /></label>
                  <label>Turnaround (m)<input type="number" step="5" min="0" [value]="turnaroundM()" (input)="turnaroundM.set(+$any($event.target).value)" /></label>
                </div>
              }
              @if (missionType() === 'orbit') {
                <div class="grid2">
                  <label>Radius (m)<input type="number" step="5" min="5" [value]="orbitRadiusM()" (input)="orbitRadiusM.set(+$any($event.target).value)" /></label>
                  <label>Points / loop<input type="number" step="1" min="3" [value]="orbitPoints()" (input)="orbitPoints.set(+$any($event.target).value)" /></label>
                  <label>Loops<input type="number" step="1" min="1" [value]="orbitLoops()" (input)="orbitLoops.set(+$any($event.target).value)" /></label>
                  <label>POI height (m)<input type="number" step="1" min="0" [value]="orbitPoiAltM()" (input)="orbitPoiAltM.set(+$any($event.target).value)" /></label>
                </div>
                <div class="mut" style="margin-top:8px">Gimbal auto-aimed at POI: {{ orbitGimbalDeg() }}°</div>
                <label class="row" style="margin-top:12px"><input type="checkbox" [checked]="orbitClockwise()" (change)="orbitClockwise.set($any($event.target).checked)" /> Clockwise</label>
              }

              <div class="switchrow">
                <span>Terrain follow</span>
                <button class="switch" [class.on]="terrainFollow()" role="switch" [attr.aria-checked]="terrainFollow()" (click)="terrainFollow.set(!terrainFollow())"><span class="knob"></span></button>
              </div>

              @if (missionType() === 'transect' || missionType() === 'crossgrid') {
                <div class="compassWrap">
                  <div class="mut">{{ missionType() === 'crossgrid' ? 'Grid direction (first pass)' : 'Transect direction' }}</div>
                  <svg #compass class="compass" viewBox="0 0 80 80" (pointerdown)="startCompass($event)">
                    <circle cx="40" cy="40" r="36" class="cface" />
                    <text x="40" y="12" class="cn">N</text><text x="72" y="43" class="cn">E</text><text x="40" y="75" class="cn">S</text><text x="6" y="43" class="cn">W</text>
                    <g [attr.transform]="'rotate(' + directionDeg() + ' 40 40)'"><line x1="40" y1="40" x2="40" y2="10" class="needle" /><line x1="40" y1="40" x2="40" y2="62" class="needletail" /></g>
                    <circle cx="40" cy="40" r="3" class="chub" />
                  </svg>
                  <div class="cdeg">{{ directionDeg() }}°</div>
                </div>
              }
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
              <button [class.on]="drawShape() === 'Polygon'" (click)="drawPolygon()" title="Draw area (polygon) — for area survey / perimeter">
                <svg viewBox="0 0 24 24" width="18" height="18"><polygon points="12,3 21,9.5 17.5,20 6.5,20 3,9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
              </button>
              <button [class.on]="drawShape() === 'Line'" (click)="drawLine()" title="Draw line / string — for corridor centre-line">
                <svg viewBox="0 0 24 24" width="18" height="18"><polyline points="3,18 9,8 15,15 21,5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="3" cy="18" r="2" fill="currentColor"/><circle cx="15" cy="15" r="2" fill="currentColor"/><circle cx="21" cy="5" r="2" fill="currentColor"/></svg>
              </button>
              <button [class.on]="drawShape() === 'Marker'" (click)="drawPoint()" title="Set point — for orbit centre / POI">
                <svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/></svg>
              </button>
              <button [class.on]="tool() === 'edit'" (click)="editArea()" title="Edit (drag points, add midpoints)">
                <svg viewBox="0 0 24 24" width="18" height="18"><path d="M14.5 5.5l4 4L8 20H4v-4L14.5 5.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13 7l4 4" fill="none" stroke="currentColor" stroke-width="2"/></svg>
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
    .nameinput { background:transparent; border:0; color:#fff; font-size:13px; font-weight:600; width:150px; padding:3px 2px; margin:0; }
    .nameinput::placeholder { color:rgba(255,255,255,.6); font-weight:400; }
    .nameinput:focus { outline:none; }
    .tok { width:170px; padding:5px 8px; border-radius:6px; border:0; font-size:12px; }
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

  readonly missionType = signal<MissionType>('transect');
  readonly drawShape = signal<'' | 'Polygon' | 'Line' | 'Marker'>('');
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
  readonly standoffM = signal(30);
  readonly perimeterRuns = signal(1);
  readonly corridorWidthM = signal(60);
  readonly corridorRuns = signal(3);
  readonly turnaroundM = signal(15);
  readonly orbitRadiusM = signal(60);
  readonly orbitPoints = signal(24);
  readonly orbitLoops = signal(1);
  readonly orbitPoiAltM = signal(0);
  readonly orbitClockwise = signal(true);
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
  readonly line = signal<LatLng[]>([]);
  readonly center = signal<LatLng | null>(null);
  readonly lz = signal<LatLng | null>(null);
  readonly result = signal<GenResult | null>(null);

  readonly payloadOpts = computed<PayloadOpt[]>(() => this.payloadsFor(this.droneId()));
  readonly ready = computed<boolean>(() => {
    const t = this.missionType();
    if (t === 'corridor') return this.line().length >= 2;
    if (t === 'orbit') return this.center() != null;
    return this.polygon().length >= 3;
  });
  readonly typeLabel = computed(() => (({
    transect: 'Area survey (transect)', crossgrid: 'Area survey (cross grid)',
    perimeter: 'Perimeter', orbit: 'Orbit', corridor: 'Corridor',
  } as Record<string, string>)[this.missionType()]));
  readonly orbitGimbalDeg = computed(() => {
    const h = this.result()?.planning.fp.heightM ?? this.targetHeightM();
    const p = -(Math.atan2(h - this.orbitPoiAltM(), Math.max(1, this.orbitRadiusM())) * 180) / Math.PI;
    return Math.round(Math.max(-90, Math.min(30, p)));
  });
  readonly drawLabel = computed(() => (this.missionType() === 'corridor' ? 'DRAW LINE' : this.missionType() === 'orbit' ? 'SET POINT' : 'DRAW AREA'));
  readonly drawHint = computed(() => (this.missionType() === 'corridor' ? 'Draw the corridor centre-line, or search a location' : this.missionType() === 'orbit' ? 'Drop a centre point, or search a location' : 'Draw an area, or search a location'));
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
  private lineLayer: L.Polyline | null = null;
  private centerMarker: L.Marker | null = null;
  private lzMarker: L.Marker | null = null;
  private compassDragging = false;
  private regenTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    effect(() => {
      // Auto-rebuild when any setting or geometry changes.
      this.missionType(); this.droneId(); this.payloadId(); this.mode(); this.targetGsdCm(); this.targetHeightM();
      this.speedStr(); this.bufferM(); this.gimbalDeg(); this.frontOverlap(); this.sideOverlap(); this.directionDeg(); this.terrainFollow();
      this.standoffM(); this.perimeterRuns(); this.corridorWidthM(); this.corridorRuns(); this.turnaroundM(); this.orbitRadiusM(); this.orbitPoints(); this.orbitLoops(); this.orbitPoiAltM(); this.orbitClockwise();
      this.polygon(); this.line(); this.center(); this.lz();
      this.scheduleRegen();
    });
    effect(() => {
      const t = this.token();
      try { localStorage.setItem('ul_pat', t); } catch { /* storage unavailable */ }
    });
  }

  private scheduleRegen(): void {
    clearTimeout(this.regenTimer);
    this.regenTimer = setTimeout(() => { if (this.tool() === 'none' && this.ready() && !this.busy()) this.generate(); }, 450);
  }

  ngAfterViewInit(): void {
    this.payloadId.set(this.payloadOpts()[0]?.id ?? '');
    this.map = L.map(this.mapEl.nativeElement, { center: [-37.611, 143.851], zoom: 15 });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery: Esri, Maxar' }).addTo(this.map);
    this.viewshedLayer.addTo(this.map);
    this.drawLayer.addTo(this.map);

    const pm = (this.map as any).pm;
    // markerStyle uses our divIcon so Marker draw doesn't hit Leaflet's broken default icon.
    pm.setGlobalOptions({
      allowSelfIntersection: false,
      pathOptions: { color: '#39d0d8', weight: 2, fillOpacity: 0.06 },
      markerStyle: { icon: L.divIcon({ className: '', html: '<div style="background:#39d0d8;color:#000;font-weight:700;font-size:10px;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border:2px solid #fff">◎</div>', iconSize: [22, 22], iconAnchor: [11, 11] }) },
    });
    this.map.on('pm:create', (e: any) => this.onDrawCreate(e));

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      if (this.placingLz()) { this.setLz({ lat: e.latlng.lat, lng: e.latlng.lng }); this.placingLz.set(false); }
    });
  }

  private onDrawCreate(e: any): void {
    const shape: string = e.shape;
    this.drawShape.set('');
    if (shape === 'Marker') {
      this.missionType.set('orbit');
      if (this.centerMarker) this.map.removeLayer(this.centerMarker);
      const m = e.layer as L.Marker;
      m.setIcon(L.divIcon({ className: '', html: '<div style="background:#39d0d8;color:#000;font-weight:700;font-size:10px;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border:2px solid #fff">◎</div>', iconSize: [22, 22], iconAnchor: [11, 11] }));
      this.centerMarker = m;
      const sync = () => { const ll = m.getLatLng(); this.center.set({ lat: ll.lat, lng: ll.lng }); };
      m.on('pm:edit', sync);
      (m as any).on('pm:dragend', sync);
      sync();
      (this.map as any).pm.disableDraw();
      this.hideTransects();
      (m as any).pm.enable();
      this.tool.set('none'); // point is light — build the orbit now, stays draggable
      this.scheduleRegen();
      return;
    }
    if (shape === 'Line') {
      this.missionType.set('corridor');
      if (this.lineLayer) this.map.removeLayer(this.lineLayer);
      const pl = e.layer as L.Polyline;
      this.lineLayer = pl;
      const sync = () => this.syncLine(pl);
      pl.on('pm:edit', sync); pl.on('pm:update', sync);
      (pl as any).on('pm:markerdragend', sync); (pl as any).on('pm:vertexadded', sync); (pl as any).on('pm:vertexremoved', sync);
      sync();
      (this.map as any).pm.disableDraw();
      this.hideTransects();
      (pl as any).pm.enable();
      this.tool.set('none'); // corridor is light — build now, line stays editable
      this.scheduleRegen();
      return;
    }
    // Polygon / Rectangle — keep a polygon mission type; default to transect.
    if (this.missionType() === 'orbit' || this.missionType() === 'corridor') this.missionType.set('transect');
    if (this.surveyLayer) this.map.removeLayer(this.surveyLayer);
    const layer = e.layer as L.Polygon;
    this.surveyLayer = layer;
    const resync = () => this.syncPolygon(layer);
    layer.on('pm:edit', resync); layer.on('pm:update', resync);
    (layer as any).on('pm:markerdragend', resync); (layer as any).on('pm:vertexadded', resync); (layer as any).on('pm:vertexremoved', resync);
    resync();
    (this.map as any).pm.disableDraw();
    this.hideTransects();
    (layer as any).pm.enable({ allowSelfIntersection: false });
    this.tool.set('edit');
  }

  setMissionType(t: MissionType): void { this.missionType.set(t); }

  // --- Geometry draw/edit tools ---
  private pm(): any { return (this.map as any).pm; }
  private activeLayer(): any { const t = this.missionType(); return t === 'corridor' ? this.lineLayer : t === 'orbit' ? this.centerMarker : this.surveyLayer; }
  private hideTransects(): void { this.drawLayer.clearLayers(); this.viewshedLayer.clearLayers(); }
  private resetModes(): void {
    const pm = this.pm();
    pm.disableDraw?.(); pm.disableGlobalEditMode?.(); pm.disableGlobalDragMode?.(); pm.disableGlobalRemovalMode?.();
    (this.surveyLayer as any)?.pm?.disable?.(); (this.lineLayer as any)?.pm?.disable?.(); (this.centerMarker as any)?.pm?.disable?.();
    this.tool.set('none'); this.drawShape.set('');
  }
  // Dedicated geometry draw tools. The shape you draw picks a sensible mission
  // type (point→orbit, line→corridor, polygon→area/perimeter) in onDrawCreate.
  private startDraw(shape: 'Polygon' | 'Line' | 'Marker'): void {
    this.resetModes(); this.hideTransects();
    this.pm().enableDraw(shape);
    this.tool.set('draw'); this.drawShape.set(shape);
  }
  drawPolygon(): void { this.startDraw('Polygon'); }
  drawLine(): void { this.startDraw('Line'); }
  drawPoint(): void { this.startDraw('Marker'); }
  editArea(): void {
    if (this.tool() === 'edit') return this.doneTools();
    const layer = this.activeLayer();
    if (!layer) { this.error.set(`Add geometry first (✎ ${this.drawLabel()}).`); return; }
    this.resetModes(); this.hideTransects();
    layer.pm.enable({ allowSelfIntersection: false });
    this.tool.set('edit');
  }
  deleteMode(): void {
    if (this.tool() === 'delete') return this.doneTools();
    this.resetModes(); this.hideTransects();
    this.pm().enableGlobalRemovalMode();
    this.tool.set('delete');
  }
  doneTools(): void { this.resetModes(); this.scheduleRegen(); }

  // --- Viewshed ---
  async toggleViewshed(): Promise<void> {
    if (this.viewshedOn()) { this.viewshedOn.set(false); this.viewshedLayer.clearLayers(); this.viewshedResult.set(null); return; }
    if (!this.lz()) { this.error.set('Set the LZ first (⌂ SET LZ), then ◉ VIEWSHED.'); return; }
    this.viewshedOn.set(true); this.busy.set(true); this.error.set('');
    try { await this.computeViewshed(); }
    catch (e: unknown) { this.viewshedOn.set(false); this.error.set(e instanceof Error ? e.message : String(e)); }
    finally { this.busy.set(false); }
  }

  private geomPoints(): LatLng[] {
    const t = this.missionType();
    if (t === 'corridor') return this.line();
    if (t === 'orbit') { const c = this.center(); return c ? [c] : []; }
    return this.polygon();
  }

  private viewshedRange(lz: LatLng): number {
    const pts = this.geomPoints();
    if (this.missionType() === 'orbit' && this.center()) return Math.max(100, (haversine(lz, this.center()!) + this.orbitRadiusM()) * 1.1);
    if (pts.length === 0) return 300;
    return Math.max(100, Math.max(...pts.map((p) => haversine(lz, p))) * 1.1);
  }

  private dsmBounds(): { minLat: number; maxLat: number; minLng: number; maxLng: number } | null {
    const pts = this.geomPoints();
    if (pts.length === 0) return null;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of pts) { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng); }
    if (this.missionType() === 'orbit') { const c = this.center()!; const dLat = this.orbitRadiusM() / 110540, dLng = this.orbitRadiusM() / (111320 * Math.cos(c.lat * Math.PI / 180)); minLat = c.lat - dLat; maxLat = c.lat + dLat; minLng = c.lng - dLng; maxLng = c.lng + dLng; }
    return { minLat, maxLat, minLng, maxLng };
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

  private syncPolygon(layer: L.Polygon): void { this.polygon.set((layer.getLatLngs()[0] as L.LatLng[]).map((p) => ({ lat: p.lat, lng: p.lng }))); }
  private syncLine(layer: L.Polyline): void { this.line.set((layer.getLatLngs() as L.LatLng[]).map((p) => ({ lat: p.lat, lng: p.lng }))); }

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
    this.polygon.set([]); this.line.set([]); this.center.set(null); this.result.set(null); this.error.set(''); this.pushMsg.set('');
    for (const l of [this.surveyLayer, this.lineLayer, this.centerMarker]) if (l) this.map.removeLayer(l);
    this.surveyLayer = null; this.lineLayer = null; this.centerMarker = null;
    this.drawLayer.clearLayers(); this.viewshedLayer.clearLayers();
  }

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

  // KML import — auto-detects Point (orbit) / LineString (corridor) / Polygon (grid).
  async onKmlFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0]; if (!file) return;
    try {
      const text = await file.text();
      const pt = parseKmlPoint(text);
      const ln = parseKmlLine(text);
      const poly = parseKmlPolygon(text);
      if (poly.length >= 3) { if (this.missionType() !== 'perimeter' && this.missionType() !== 'crossgrid') this.missionType.set('transect'); this.importPolygon(poly); }
      else if (ln.length >= 2) { this.missionType.set('corridor'); this.importLine(ln); }
      else if (pt) { this.missionType.set('orbit'); this.importPoint(pt); }
      else throw new Error('No point, line, or polygon found in the KML.');
    } catch (e: unknown) { this.error.set('KML import failed: ' + (e instanceof Error ? e.message : String(e))); }
    finally { input.value = ''; }
  }

  private importPolygon(ring: LatLng[]): void {
    this.resetModes();
    if (this.surveyLayer) this.map.removeLayer(this.surveyLayer);
    const layer = L.polygon(ring.map((p) => [p.lat, p.lng] as [number, number]), { color: '#39d0d8', weight: 2, fillOpacity: 0.06 }).addTo(this.map);
    this.surveyLayer = layer;
    const resync = () => this.syncPolygon(layer);
    layer.on('pm:edit', resync); layer.on('pm:update', resync);
    this.syncPolygon(layer);
    this.map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  }
  private importLine(pts: LatLng[]): void {
    this.resetModes();
    if (this.lineLayer) this.map.removeLayer(this.lineLayer);
    const layer = L.polyline(pts.map((p) => [p.lat, p.lng] as [number, number]), { color: '#39d0d8', weight: 3 }).addTo(this.map);
    this.lineLayer = layer;
    const resync = () => this.syncLine(layer);
    layer.on('pm:edit', resync); layer.on('pm:update', resync);
    this.syncLine(layer);
    this.map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  }
  private importPoint(p: LatLng): void {
    this.resetModes();
    if (this.centerMarker) this.map.removeLayer(this.centerMarker);
    const m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: '<div style="background:#39d0d8;color:#000;font-weight:700;font-size:10px;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border:2px solid #fff">◎</div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(this.map);
    this.centerMarker = m;
    (m as any).on('pm:edit', () => { const ll = m.getLatLng(); this.center.set({ lat: ll.lat, lng: ll.lng }); });
    this.center.set(p);
    this.map.setView([p.lat, p.lng], 16);
  }

  startCompass(e: PointerEvent): void { this.compassDragging = true; this.updateCompass(e); }
  @HostListener('window:pointermove', ['$event']) onMove(e: PointerEvent): void { if (this.compassDragging) this.updateCompass(e); }
  @HostListener('window:pointerup') onUp(): void { this.compassDragging = false; }
  private updateCompass(e: PointerEvent): void {
    const r = this.compassEl.nativeElement.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    this.directionDeg.set(Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360));
  }

  private captureConfig() {
    return { ...captureTypes.find((c) => c.type === 'ortho2d')!, frontOverlapPct: this.frontOverlap(), sideOverlapPct: this.sideOverlap() };
  }

  async generate(): Promise<void> {
    this.error.set(''); this.pushMsg.set(''); this.busy.set(true);
    try {
      const type = this.missionType();
      const opt = this.payloadOpts().find((p) => p.id === this.payloadId()) ?? this.payloadOpts()[0];
      const aircraft = this.drones.find((d) => d.id === this.droneId())!;
      const speedOverride = this.speedStr().trim() ? +this.speedStr() : null;

      const planning = planFlight({
        camera: opt.camera, lens: opt.lens, captureType: this.captureConfig(),
        mode: this.mode(), targetGsdCm: this.targetGsdCm(), targetHeightM: this.targetHeightM(),
        mappingSpeedMs: aircraft.mappingSpeedMs, speedOverrideMs: speedOverride, aircraftFlightTimeMinutes: aircraft.maxFlightTimeMinutes,
      });
      const { fp } = planning;
      const speed = planning.effectiveSpeedMs;

      // DSM over the active geometry (best-effort).
      const bounds = this.dsmBounds();
      let grid: TerrainGrid | null = null;
      if (bounds) {
        try { const g = await loadTerrainGrid(bounds, 13, browserTerrariumFetcher()); if (g.tileCount > 0) grid = g; } catch { /* handled */ }
      }

      const lz = this.lz() ?? this.geomPoints()[0];
      const takeoffMsl = grid?.elevationAt(lz) ?? 0;
      const genElev: ElevationFn = this.terrainFollow() && grid ? grid.elevationAt : () => takeoffMsl;
      // Terrain-follow spec for the orbit/corridor builders (densify + re-bake).
      const terrainOpt = this.terrainFollow() && grid ? { elevationAt: grid.elevationAt, lzElevMsl: takeoffMsl, aglM: fp.heightM } : undefined;

      // Build per mission type. Grid bakes terrain; the others fly a constant AGL
      // (terrain-follow is applied at push-time via aboveGroundLevel).
      let tp: TransectPlan;
      let flightPoly: LatLng[] | null = null;
      if (type === 'transect' || type === 'crossgrid') {
        flightPoly = bufferPolygonMeters(this.polygon(), this.bufferM());
        const pA = plan({ polygon: flightPoly, directionDeg: this.directionDeg(), spacingM: fp.lineSpacingM, aglM: fp.heightM, speedMs: speed, lz, elevationAt: genElev });
        tp = type === 'crossgrid'
          ? mergePlans(pA, plan({ polygon: flightPoly, directionDeg: this.directionDeg() + 90, spacingM: fp.lineSpacingM, aglM: fp.heightM, speedMs: speed, lz, elevationAt: genElev }))
          : pA;
      } else if (type === 'perimeter') {
        tp = buildPerimeter({ polygon: this.polygon(), standoffM: this.standoffM(), aglM: fp.heightM, speedMs: speed, spacingAlongM: fp.triggerDistanceM, runs: this.perimeterRuns(), runSpacingM: fp.lineSpacingM, terrain: terrainOpt });
      } else if (type === 'corridor') {
        tp = buildCorridor({ line: this.line(), widthM: this.corridorWidthM(), laneSpacingM: fp.lineSpacingM, aglM: fp.heightM, speedMs: speed, turnaroundM: this.turnaroundM(), lanes: this.corridorRuns(), terrain: terrainOpt });
      } else {
        tp = buildOrbit({ center: this.center()!, radiusM: this.orbitRadiusM(), pointCount: this.orbitPoints(), aglM: fp.heightM, speedMs: speed, clockwise: this.orbitClockwise(), loops: this.orbitLoops(), poiAltM: this.orbitPoiAltM(), terrain: terrainOpt });
      }

      const mission = emitAutoflyMission({
        name: this.missionName().trim() || `${this.typeLabel()} — ${opt.name} ${planning.gsdCm.toFixed(1)}cm`,
        description: `${this.typeLabel()} · GSD ${fp.resultingGsdCmPx.toFixed(1)} cm/px, ${fp.frontOverlapPct}/${fp.sideOverlapPct} overlap`,
        waypoints: tp.waypoints, photoSpacingM: fp.triggerDistanceM, takeoffElevationMslM: takeoffMsl, heightMode: 'relativeToStartPoint', nadirPitchDeg: this.gimbalDeg(),
        captureMode: type === 'orbit' ? 'perWaypoint' : 'interval',
      });

      // Terrain profile + collision check along the actual flown path.
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
        const flightMsl = follow ? terrainMsl + aglTarget : takeoffMsl + aglTarget;
        minClear = Math.min(minClear, flightMsl - terrainMsl);
        profile.push({ d, terrain: terrainMsl, flight: flightMsl });
      };
      if (wps.length) sample(wps[0].pos, 0);
      for (let i = 1; i < wps.length; i++) {
        const prev = wps[i - 1], cur = wps[i];
        const segLen = haversine(prev.pos, cur.pos);
        const n = Math.max(1, Math.ceil(segLen / PROFILE_STEP_M));
        for (let k = 1; k <= n; k++) { const t = k / n; dist += segLen / n; sample({ lat: prev.pos.lat + (cur.pos.lat - prev.pos.lat) * t, lng: prev.pos.lng + (cur.pos.lng - prev.pos.lng) * t }, dist); }
      }

      let viewshed: ViewshedResult | null = null;
      const warnings = [...planning.warnings, ...tp.warnings];
      if (this.viewshedOn()) {
        if (grid) viewshed = analyseViewshed({ lz, flightHeightAGL: fp.heightM, maxRangeM: this.viewshedRange(lz), elevationAt: grid.elevationAt, observerElevMsl: takeoffMsl });
        else warnings.push('Viewshed needs terrain tiles (DSM) — none loaded (CORS/offline).');
      }
      this.viewshedResult.set(viewshed);

      if (!haveDsm && follow) warnings.push('Terrain tiles unavailable (CORS/offline) — used flat elevation.');
      if (haveDsm && !follow && minClear < SAFETY_CLEARANCE_M) warnings.push(`Terrain collision risk: min clearance ${minClear.toFixed(0)} m (below ${SAFETY_CLEARANCE_M} m). Enable terrain follow or raise height.`);
      if (speedOverride && speedOverride > aircraft.maxSpeedMs) warnings.push(`Speed ${speedOverride} m/s exceeds the ${aircraft.name} max (${aircraft.maxSpeedMs} m/s).`);

      this.result.set({ planning, tp, mission, distanceKm: tp.totalLengthM / 1000, profile, minClearanceM: haveDsm ? minClear : null, viewshed, terrainFollow: follow, warnings });
      this.drawSurvey(mission.route, flightPoly ? { kind: 'poly', ring: flightPoly } : type === 'orbit' ? { kind: 'circle', center: this.center()!, radiusM: this.orbitRadiusM() } : null);
      this.drawViewshed(viewshed, lz);
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.set(false);
    }
  }

  private drawSurvey(route: AutoflyRoutePoint[], overlay: { kind: 'poly'; ring: LatLng[] } | { kind: 'circle'; center: LatLng; radiusM: number } | null): void {
    this.drawLayer.clearLayers();
    if (overlay?.kind === 'poly') L.polygon(overlay.ring.map((p) => [p.lat, p.lng] as [number, number]), { color: '#f59f00', weight: 1, dashArray: '5,5', fill: false }).addTo(this.drawLayer);
    if (overlay?.kind === 'circle') L.circle([overlay.center.lat, overlay.center.lng], { radius: overlay.radiusM, color: '#f59f00', weight: 1, dashArray: '5,5', fill: false }).addTo(this.drawLayer);

    const alts = route.map((p) => p.altitudeEGM ?? p.altitude);
    const lo = Math.min(...alts), hi = Math.max(...alts), span = hi - lo || 1;
    for (let i = 0; i + 1 < route.length; i++) {
      const t = (((alts[i] + alts[i + 1]) / 2) - lo) / span;
      L.polyline([[route[i].lat, route[i].lng], [route[i + 1].lat, route[i + 1].lng]], { color: rampColor(t), weight: 3 }).addTo(this.drawLayer);
    }
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
    const halfDeg = 180 / vs.totalRadials;
    const step = vs.stepM;
    const edge = (bearingDeg: number, dist: number): [number, number] => {
      const br = (bearingDeg * Math.PI) / 180;
      return [lz.lat + (dist * Math.cos(br)) / 111320, lz.lng + (dist * Math.sin(br)) / mLng];
    };
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

  private missionForCloud(r: GenResult): AutoflyMission {
    const name = this.missionName().trim() || r.mission.name;
    if (!r.terrainFollow) return { ...r.mission, name };
    const agl = Math.round(r.planning.fp.heightM * 100) / 100;
    return {
      ...r.mission, name, heightMode: 'aboveGroundLevel',
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
