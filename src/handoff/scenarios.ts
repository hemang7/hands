/**
 * Scripted "humans" for headless evidence runs and tests. Each one does what an operator would do
 * in the browser window, using nothing but ordinary Playwright calls on the same live page.
 */
import type { ScriptedHuman } from './operators.js';

export const SCENARIOS: Record<string, ScriptedHuman> = {
  /**
   * An operator who knows tenant beta: reads the intervention request, does the step the automation
   * could not (a relabeled button, a renamed menu item) in the live browser, and hands back.
   */
  'tenant-beta-operator': async (req, page) => {
    if (/sign-on|Sign On/i.test(req.goal)) {
      await page.getByRole('button', { name: /Log In|Sign On/ }).click();
      await page.waitForTimeout(500);
      return { action: 'skip_step', note: 'The sign-on button is labelled "Log In" on this tenant; I pressed it. Continue from the next step.' };
    }
    const menu = page.frames().find((f) => /\/frame\/menu$/.test(f.url()));
    if (!menu) return { action: 'abort', note: 'could not find the menu frame' };
    await menu.getByRole('link', { name: /Customer Lookup|Member Inquiry/ }).click();
    await page.waitForTimeout(500);
    return { action: 'skip_step', note: 'Opened "Customer Lookup" from the menu (this tenant renamed Member Inquiry). Automation can continue from the next step.' };
  },

  /** Generic: the operator looks, decides nothing can be done, aborts. */
  abort: async () => ({ action: 'abort', note: 'Operator reviewed the screen and aborted the run.' }),

  /** Operator performs the irreversible commit themselves after reviewing the screen. */
  'confirm-commit': async (_req, page, surface) => {
    const main = page.frames().find((f) => /\/subaccount\/review$/.test(f.url()) || /content|main/.test(f.name()));
    if (!main) return { action: 'abort', note: 'review screen not found' };
    surface.answerNextDialog('accept');
    await main.getByRole('button', { name: 'Confirm' }).click();
    await page.waitForTimeout(600);
    return { action: 'skip_step', note: 'Reviewed values and pressed Confirm myself; the posting is done.' };
  },
};
