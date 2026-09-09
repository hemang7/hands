/**
 * Redaction. Three layers:
 *   1. secrets never enter the model context or any artifact: steps hold {kind:'secret', ref:ENV}
 *      and the surface fills them from the environment
 *   2. every string that reaches a log, evidence file or screenshot filename passes through
 *      Redactor.scrub(), which masks known secret values, pii-marked input values and anything that
 *      pattern-matches regulated identifiers (SSN, card PAN)
 *   3. outputs marked pii are masked in logs but returned to the caller in full: the caller asked
 *      for them and is the system of record for handling them
 */
export class Redactor {
  private secrets: string[] = [];
  private pii: string[] = [];

  addSecret(v: string | undefined) {
    if (v && v.length >= 3) this.secrets.push(v);
  }
  addPii(v: string | undefined) {
    if (v && v.length >= 3) this.pii.push(v);
  }

  /** Mask a pii value keeping only the tail (last 2 chars) so runs remain correlatable. */
  static maskPii(v: string): string {
    if (v.length <= 2) return '••';
    return '•'.repeat(Math.max(2, v.length - 2)) + v.slice(-2);
  }

  scrub(s: string): string {
    let out = s;
    // longest first so a secret that contains another secret is masked whole
    for (const v of [...this.secrets].sort((a, b) => b.length - a.length)) out = out.split(v).join('[secret]');
    for (const v of [...this.pii].sort((a, b) => b.length - a.length)) out = out.split(v).join(Redactor.maskPii(v));
    out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]');
    out = out.replace(/\b(?:\d[ -]?){13,16}\b/g, '[pan]');
    return out;
  }

  scrubDeep<T>(v: T): T {
    if (typeof v === 'string') return this.scrub(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.scrubDeep(x)) as T;
    if (v && typeof v === 'object') {
      const o: any = {};
      for (const [k, x] of Object.entries(v)) o[k] = this.scrubDeep(x);
      return o;
    }
    return v;
  }
}
