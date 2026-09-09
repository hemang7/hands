/**
 * File-backed capability store. One JSON file per (id, version) under capabilities/.
 * Deliberately simple: the artifact is the unit of review, so it lives in git-friendly files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AppProfileZ, validateCapability, type AppProfile, type Capability } from './schema.js';

export class CapabilityStore {
  constructor(readonly dir = path.resolve('capabilities'), readonly appsDir = path.resolve('apps')) {
    fs.mkdirSync(dir, { recursive: true });
  }

  filePath(id: string, version: number): string {
    return path.join(this.dir, `${id}.v${version}.json`);
  }

  save(cap: Capability): string {
    validateCapability(cap);
    const p = this.filePath(cap.id, cap.version);
    fs.writeFileSync(p, JSON.stringify(cap, null, 2) + '\n');
    return p;
  }

  load(idOrPath: string, version?: number): Capability {
    let p = idOrPath;
    if (!fs.existsSync(p)) {
      if (version === undefined) version = this.latestVersion(idOrPath);
      p = this.filePath(idOrPath, version);
    }
    return validateCapability(JSON.parse(fs.readFileSync(p, 'utf8')));
  }

  latestVersion(id: string): number {
    const versions = this.list()
      .filter((c) => c.id === id)
      .map((c) => c.version);
    if (!versions.length) throw new Error(`no capability "${id}" in ${this.dir}`);
    return Math.max(...versions);
  }

  list(): Capability[] {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return validateCapability(JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')));
        } catch {
          return null;
        }
      })
      .filter((c): c is Capability => !!c)
      .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
  }

  loadProfile(id: string): AppProfile {
    const p = path.join(this.appsDir, `${id}.json`);
    return AppProfileZ.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
  }
}
