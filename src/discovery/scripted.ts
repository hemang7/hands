/**
 * Offline decider for tests and for running the demo without an API key.
 * It reads the same rendered observation the real model sees and picks refs by role/name, so the
 * whole discovery pipeline (policy, recorder, evidence) runs unchanged. It is NOT the product; it
 * exists so reviewers can run `npm run demo:offline` without an OpenAI key.
 */
import { ScriptedLLM, type ToolCall } from './llm.js';

interface Line {
  ref: number;
  role: string;
  name: string;
  rest: string;
}

function parse(observation: string): Line[] {
  const out: Line[] = [];
  for (const raw of observation.split('\n')) {
    const m = raw.match(/^\s+\[(\d+)\] (\w+) "((?:[^"\\]|\\.)*)"(.*)$/);
    if (m) out.push({ ref: Number(m[1]), role: m[2], name: m[3], rest: m[4] });
  }
  return out;
}
const find = (els: Line[], role: string, name: RegExp) => els.find((e) => e.role === role && name.test(e.name));

/** Scripted policy for "look up a member and read the savings balance". */
export function memberLookupScript(memberId: string): ScriptedLLM {
  let extracted = false;
  let pwdTyped = false;
  return new ScriptedLLM(({ observation }): ToolCall => {
    const els = parse(observation);
    const text = observation;
    if (/SYSTEM NOTICE/.test(text)) {
      const b = find(els, 'button', /^Acknowledge$/);
      if (b) return { name: 'click', args: { ref: b.ref, reason: 'Acknowledge the system notice interstitial to reach the console' } };
    }
    const uid = find(els, 'textbox', /User ID|Operator ID/);
    const pwd = find(els, 'password', /.*/);
    const signOn = find(els, 'button', /^(Sign On|Log In)$/);
    if (uid && pwd && signOn) {
      if (!/value="teller/.test(uid.rest)) return { name: 'type', args: { ref: uid.ref, secretRef: 'username', reason: 'Sign-on form: fill the operator id from the configured secret' } };
      if (!pwdTyped) {
        pwdTyped = true;
        return { name: 'type', args: { ref: pwd.ref, secretRef: 'password', reason: 'Fill the password from the configured secret; never as literal text' } };
      }
      pwdTyped = false;
      return { name: 'click', args: { ref: signOn.ref, reason: 'Submit the sign-on form' } };
    }
    if (/No record found/i.test(text)) {
      return { name: 'declare_outcome', args: { code: 'RECORD_NOT_FOUND', textPresent: 'No record found for member', description: 'The member number does not exist' } };
    }
    if (/MEMBER DETAIL/.test(text)) {
      if (!extracted) {
        const cell = els.find((e) => e.role === 'cell' && /column="(Current|Ledger) Balance"/.test(e.rest) && /Share Savings/.test(e.rest));
        if (cell) {
          extracted = true;
          return { name: 'extract', args: { ref: cell.ref, name: 'savings_balance', type: 'money', reason: 'The Current Balance column of the Share Savings row holds the savings balance' } };
        }
      }
      return { name: 'done', args: { summary: `Looked up member ${memberId} and read the share savings balance from the member detail screen.`, evidenceText: 'MEMBER DETAIL' } };
    }
    const memberBox = find(els, 'textbox', /Member Number|Member No\./);
    if (memberBox) {
      if (!memberBox.rest.includes(`value="${memberId}"`)) return { name: 'type', args: { ref: memberBox.ref, text: memberId, reason: 'Enter the member number from the goal into the inquiry field' } };
      const go = find(els, 'button', /^(Inquire|Search)$/);
      if (go) return { name: 'click', args: { ref: go.ref, reason: 'Run the member inquiry' } };
    }
    const menu = find(els, 'link', /Member Inquiry|Customer Lookup/);
    if (menu) return { name: 'click', args: { ref: menu.ref, reason: 'Open the member inquiry function from the menu frame' } };
    return { name: 'stuck', args: { reason: 'scripted decider found no matching rule', needed: 'navigate to the member inquiry screen' } };
  });
}

/** Scripted policy for "open a sub-account, review, confirm the posting" (exercises select, review, irreversible commit + dialog). */
export function openSubAccountScript(inputs: Record<string, string>): ScriptedLLM {
  let pwdTyped = false;
  let confirmClicks = 0;
  let extracted = false;
  return new ScriptedLLM(({ observation }): ToolCall => {
    const els = parse(observation);
    const text = observation;
    const uid = find(els, 'textbox', /User ID|Operator ID/);
    const pwd = find(els, 'password', /.*/);
    const signOn = find(els, 'button', /^(Sign On|Log In)$/);
    if (uid && pwd && signOn) {
      if (!/value="teller/.test(uid.rest)) return { name: 'type', args: { ref: uid.ref, secretRef: 'username', reason: 'Sign-on form: operator id from the configured secret' } };
      if (!pwdTyped) {
        pwdTyped = true;
        return { name: 'type', args: { ref: pwd.ref, secretRef: 'password', reason: 'Password from the configured secret' } };
      }
      pwdTyped = false;
      return { name: 'click', args: { ref: signOn.ref, reason: 'Submit the sign-on form' } };
    }
    if (/TRANSACTION POSTED/.test(text)) {
      if (!extracted) {
        const conf = els.find((e) => e.role === 'text' && /^HC\d+$/.test(e.name));
        if (conf) {
          extracted = true;
          return { name: 'extract', args: { ref: conf.ref, name: 'host_confirmation_number', type: 'string', reason: 'The host confirmation number proves the posting' } };
        }
      }
      return { name: 'done', args: { summary: 'Opened the sub-account, confirmed the posting and captured the host confirmation number.', evidenceText: 'TRANSACTION POSTED' } };
    }
    if (/REVIEW NEW SUB-ACCOUNT/.test(text)) {
      const confirm = find(els, 'button', /^Confirm$/);
      if (confirm) {
        confirmClicks++;
        const accept = /dialog ".*" dismissed/.test(text);
        return { name: 'click', args: { ref: confirm.ref, reason: 'Review screen shows the intended values; post the sub-account to the host', confirmIrreversible: true, acceptDialog: accept } };
      }
    }
    if (/NEW SUB-ACCOUNT - MEMBER/.test(text)) {
      const type = find(els, 'combobox', /Account Type/);
      const nick = find(els, 'textbox', /Nickname/);
      const dep = find(els, 'textbox', /Initial Deposit/);
      const cont = find(els, 'button', /^Continue$/);
      if (type && !type.rest.includes(`value="${inputs.accountType}"`) && !/selected/.test(type.rest)) {
        if (!(globalThis as any).__typeSel) {
          (globalThis as any).__typeSel = true;
          return { name: 'select', args: { ref: type.ref, option: inputs.accountType, reason: 'Choose the requested account type' } };
        }
      }
      if (nick && !nick.rest.includes(`value="${inputs.nickname}"`)) return { name: 'type', args: { ref: nick.ref, text: inputs.nickname, reason: 'Enter the requested nickname' } };
      if (dep && !dep.rest.includes(`value="${inputs.deposit}"`)) return { name: 'type', args: { ref: dep.ref, text: inputs.deposit, reason: 'Enter the initial deposit' } };
      if (cont) return { name: 'click', args: { ref: cont.ref, reason: 'Continue to the review screen' } };
    }
    if (/MEMBER DETAIL/.test(text)) {
      const open = find(els, 'button', /Open Sub-Account|Add Sub-Account/);
      if (open) return { name: 'click', args: { ref: open.ref, reason: 'Start the new sub-account flow for this member' } };
    }
    const memberBox = find(els, 'textbox', /Member Number|Member No\./);
    if (memberBox) {
      if (!memberBox.rest.includes(`value="${inputs.memberId}"`)) return { name: 'type', args: { ref: memberBox.ref, text: inputs.memberId, reason: 'Enter the member number from the goal' } };
      const go = find(els, 'button', /^(Inquire|Search)$/);
      if (go) return { name: 'click', args: { ref: go.ref, reason: 'Run the member inquiry' } };
    }
    const menu = find(els, 'link', /Member Inquiry|Customer Lookup/);
    if (menu) return { name: 'click', args: { ref: menu.ref, reason: 'Open the member inquiry function from the menu frame' } };
    return { name: 'stuck', args: { reason: 'scripted decider found no matching rule', needed: 'navigate to the member inquiry screen' } };
  });
}
