/**
 * Minimal Unleash Live API client for missions. Framework-agnostic (uses global
 * fetch — works in the browser and Node 18+). Auth is a Personal Access Token
 * sent as `Authorization: Bearer <ul_pat_...>`.
 *
 * Docs: https://developer.unleashlive.com  Base: https://api.unleashlive.com
 */
import { AutoflyMission } from './autofly-mission';

export interface UnleashApiOptions {
  token: string;
  baseUrl?: string;
}

export interface CreatedMission {
  id: string;
  name: string;
  type: string;
  [k: string]: unknown;
}

export class UnleashApi {
  private readonly base: string;
  constructor(private readonly opts: UnleashApiOptions) {
    if (!opts.token) throw new Error('UnleashApi: token required');
    this.base = opts.baseUrl ?? 'https://api.unleashlive.com';
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Create a mission. Returns the stored mission (with server-assigned id). */
  createMission(mission: AutoflyMission): Promise<CreatedMission> {
    return this.req('POST', '/v1/mission', mission);
  }

  /** Fetch a mission by id. */
  getMission(id: string): Promise<CreatedMission> {
    return this.req('GET', `/v1/mission/${id}`);
  }

  /** List missions (optionally limited). */
  async listMissions(limit = 25): Promise<CreatedMission[]> {
    const d = await this.req('GET', `/v1/mission?limit=${limit}`);
    return (d?.items ?? d ?? []) as CreatedMission[];
  }

  /** Delete a mission by id. */
  deleteMission(id: string): Promise<unknown> {
    return this.req('DELETE', `/v1/mission/${id}`);
  }
}
