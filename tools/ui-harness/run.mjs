#!/usr/bin/env node
// Drives the real UI (built dist/) against the real sidecar in headless Chromium.
//
//   node tools/ui-harness/run.mjs smoke --project <disposable repo> [--shots docs/screenshots]
//   node tools/ui-harness/run.mjs e2e   --project <disposable repo> --model <id> [--budget 0.5] [--shots …]
//
// `smoke` needs no API key and sends no API requests (key verification is not attempted).
// `e2e` uses the API key stored for VOID Workshop and runs ONE small task in the disposable repo,
// approving the agent's actions from the UI exactly as a user would. It spends real (estimated
// < budget) API credit, so only run it deliberately.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startHarness, SHIM } from './harness.mjs';

const args = process.argv.slice(2);
const scenario = args[0];
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const project = opt('project');
const shots = opt('shots');
if (!['smoke', 'e2e'].includes(scenario) || !project) {
  console.error('usage: run.mjs smoke|e2e --project <dir> [--model id] [--budget usd] [--shots dir]');
  process.exit(2);
}
if (shots) fs.mkdirSync(shots, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) throw new Error(`check failed: ${name}`);
};

// smoke: force 'no key configured' regardless of what is stored for the real app
const harness = await startHarness(
  scenario === 'smoke' ? { pickDir: path.resolve(project), keyBackend: 'file', keyFile: '/nonexistent/void-workshop-smoke-key' } : { pickDir: path.resolve(project) },
);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
const page = await browser.newPage({ viewport: { width: 1480, height: 920 }, deviceScaleFactor: 1 });
await page.addInitScript(SHIM);
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));
/** Waits (up to 10 s) for the locator to become visible. */
const visible = (loc) => loc.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
const shot = async (name) => shots && (await page.screenshot({ path: path.join(shots, `${name}.png`) }));

try {
  await page.goto(harness.url);
  await page.locator('.statusbar').waitFor({ timeout: 30000 });

  if (scenario === 'smoke') await smoke();
  else await e2e();

  check('no uncaught errors in the page', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
} catch (err) {
  console.error(String(err));
  if (shots) await page.screenshot({ path: path.join(shots, `failure-${scenario}.png`) }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await harness.stop();
}

async function openProject() {
  await page.getByRole('button', { name: /Open project/ }).first().click();
  const openFolder = page.getByRole('button', { name: 'Open folder…' });
  if (await openFolder.isVisible().catch(() => false)) await openFolder.click();
  await page.getByText('Sessions', { exact: true }).waitFor();
}

async function smoke() {
  check('welcome screen renders', await visible(page.getByText('A local, approval-first coding agent')));
  check('status bar shows estimate disclaimer', await visible(page.getByText('Estimates only: Console billing not connected')));
  check('status bar shows no usable account', await visible(page.locator('.statusbar').getByText('No usable account')));

  // Settings: key status never shows a key, model list requires verification
  await page.getByRole('button', { name: 'Settings' }).click();
  check('settings: no key configured', await visible(page.getByText('No key configured')));
  check('settings: Claude plan sign-in offered', await visible(page.getByRole('button', { name: 'Sign in with Claude' })));
  check('settings: account choice defaults to the API key', await page.locator('label', { hasText: 'API key (Console credit' }).locator('input').isChecked());
  check('settings: key input is a password field', (await page.locator('input[type=password]').getAttribute('type')) === 'password');
  await page.getByRole('button', { name: 'Model' }).click();
  check('settings: models come from the API', (await page.locator('.settings select option').first().textContent()) === 'Verify your key to load models');
  await page.getByRole('button', { name: 'Speed & tokens' }).click();
  check('settings: context cap defaults to 200k', (await page.getByLabel('Compact the conversation at').inputValue()) === '200000');
  await page.getByRole('button', { name: 'VOID Portal (phone)' }).click();
  check('settings: VOID Portal page offers pairing', await visible(page.getByRole('button', { name: 'Pair a phone' })));
  check('settings: VOID Portal has no built-in relay', (await page.locator('.settings input.mono').inputValue()) === '');
  check('settings: pairing waits for a relay', await page.getByRole('button', { name: 'Pair a phone' }).isDisabled());
  await page.getByRole('button', { name: 'Spending limits' }).click();
  check('settings: default per-task budget is $1', (await page.locator('input[type=number]').first().inputValue()) === '1');
  await page.getByRole('button', { name: 'Billing & usage' }).click();
  check('settings: billing explains estimates', await visible(page.getByText('Console billing data is not available to this app')));

  // Appearance: live theme switching and editor
  await page.getByRole('button', { name: 'Appearance' }).click();
  await page.getByRole('button', { name: 'Nebula' }).click();
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  check('theme switch applies CSS variables', accent === '#ff5fd2', accent);
  await page.getByRole('button', { name: 'Void (default)' }).click();
  await page.waitForTimeout(200);
  await shot('themes');
  await page.keyboard.press('Escape');

  // Project: file tree, sensitive file gating
  await openProject();
  check('file tree lists src', await visible(page.locator('.tree-row', { hasText: 'src' }).first()));
  await page.locator('.tree-row', { hasText: '.env' }).first().click();
  check('sensitive file contents hidden by default', await visible(page.getByText('Open a sensitive file?')));
  await page.keyboard.press('Escape');

  // Task start blocked without key
  check('start task blocked without key', await visible(page.getByText('No API key configured.')));
  await page.locator('textarea').fill('Add a multiply function');
  check('send button disabled without key', await page.getByTitle('Send (Enter)').isDisabled());

  // Mode and model pickers under the prompt box
  await page.locator('.mode-pill').click();
  await page.locator('.dropdown-menu button', { hasText: 'Auto' }).filter({ hasNotText: 'Edit' }).click();
  check('mode menu switches to Auto', (await page.locator('.mode-pill').innerText()).includes('Auto'));
  await page.locator('textarea').focus();
  await page.keyboard.press('Shift+Tab');
  check('Shift+Tab cycles to Plan mode', (await page.locator('.mode-pill').innerText()).includes('Plan mode'));
  await page.keyboard.press('Shift+Tab');
  check('Shift+Tab wraps to Ask before edits', (await page.locator('.mode-pill').innerText()).includes('Ask before edits'));
  await page.getByTitle('Model', { exact: true }).click();
  check('model menu opens above the prompt box', await visible(page.locator('.dropdown-menu button.manage')));
  await page.keyboard.press('Escape');
  await page.getByTitle('Effort: how much the model thinks (applies immediately)').click();
  await page.locator('.dropdown-menu button .label', { hasText: /^Low$/ }).click();
  check('effort pill saves the choice', await visible(page.getByTitle('Effort: how much the model thinks (applies immediately)').filter({ hasText: 'Low' })));
  check('fast mode is off by default', (await page.locator('.pill', { hasText: 'Fast' }).innerText()).trim() === 'Fast');
  await page.getByTitle('Pay with your Claude plan or your API key').click();
  check('account menu offers the Claude plan', await visible(page.locator('.dropdown-menu').getByText('Not signed in to a Claude plan.')));
  await page.locator('.dropdown-menu button', { hasText: 'Claude plan' }).click();
  check('account switch saves the choice', await visible(page.locator('.composer').getByText('Not signed in to a Claude plan.')));
  await shot('account-switch');
  await page.getByTitle('Pay with your Claude plan or your API key').click();
  await page.locator('.dropdown-menu button', { hasText: 'API key' }).first().click();
  check('account switch goes back to the API key', await visible(page.getByText('No API key configured.')));

  // Runner: approval dialog, run, blocked command
  await page.locator('.runner-input input').fill('git status --short');
  await page.getByRole('button', { name: 'Review & run' }).click();
  await page.getByText('Run this command?').waitFor();
  check('runner shows exact command', await visible(page.locator('.cmd-box').getByText('git status --short')));
  check('runner labels read-only command', await visible(page.locator('.modal').getByText('Reads only')));
  await page.getByRole('button', { name: 'Run once' }).click();
  await page.locator('.run .chip', { hasText: 'succeeded' }).first().waitFor({ timeout: 15000 });
  check('approved command ran and succeeded', true);

  await page.locator('.runner-input input').fill('sudo ls');
  await page.getByRole('button', { name: 'Review & run' }).click();
  await page.getByText('Command blocked').waitFor();
  check('privilege escalation blocked in runner', await page.getByRole('button', { name: 'Run once' }).isDisabled());
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.locator('.runner-input input').fill('ls | sh');
  await page.getByRole('button', { name: 'Review & run' }).click();
  await page.locator('.toast', { hasText: 'not supported' }).waitFor();
  check('shell operators refused by runner', true);

  await page.getByRole('button', { name: /^Git/ }).click();
  check('git tab shows branch', await visible(page.locator('.right').getByText('main').first()));
  await page.locator('textarea').fill('');
  await shot('project');
}

async function e2e() {
  const model = opt('model');
  const budget = Number(opt('budget', '0.5'));
  if (!model) throw new Error('--model is required for e2e');

  // Verify key (free Models API) and configure model + conservative limits through the UI's backend.
  const verify = await harness.callSidecar('auth.verify', {});
  check('API key verified via Models API', verify.ok === true, verify.ok ? `${verify.models.length} models` : verify.message);
  check('selected model is offered to this key', verify.models.some((m) => m.id === model), model);
  await harness.callSidecar('settings.update', { model, perTaskBudgetUsd: budget, dailyBudgetUsd: Math.max(budget, 1), maxTurns: 12, maxOutputTokens: 8000, effort: 'low', confirmTaskBudgetAboveUsd: null });
  await page.reload();
  await page.locator('.statusbar').waitFor({ timeout: 30000 });

  await openProject();
  const prompt = 'Add an exported multiply(a, b) function to src/math.js and a test for it in test/math.test.js, then run the tests with npm test. Keep the change minimal.';
  await page.locator('.mode-pill').click();
  await page.locator('.dropdown-menu button', { hasText: 'Plan mode' }).click();
  await page.locator('textarea').fill(prompt);
  await page.getByTitle('Send (Enter)').click();

  // Planning phase → plan card + approval bar
  const approveAsk = page.locator('.plan-actions').getByRole('button', { name: 'Ask before edits' });
  await approveAsk.waitFor({ timeout: 240_000 });
  check('agent produced a plan before any change', await visible(page.locator('.plan-card').first()));
  const mathBefore = fs.readFileSync(path.join(project, 'src/math.js'), 'utf8');
  check('no file changed during planning', !mathBefore.includes('multiply'));
  await shot('plan');
  await approveAsk.click();

  // Approve each action as it comes, until the turn ends.
  let approvals = 0;
  let sawDiff = false;
  let sawCommand = false;
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    const dialog = page.locator('.modal.approval');
    if (await dialog.isVisible().catch(() => false)) {
      const title = await dialog.locator('h3').innerText();
      if (/change a file|create a file/.test(title)) {
        sawDiff = sawDiff || (await dialog.locator('.diff .add').count()) > 0;
        if (approvals === 0) await shot('approval');
        await dialog.getByRole('button', { name: 'Apply change' }).click();
      } else if (/run a command/.test(title)) {
        const cmd = await dialog.locator('.cmd-box').innerText();
        sawCommand = true;
        if (/^(npm test|npm run test|node --test[^|;&]*)$/.test(cmd.trim())) await dialog.getByRole('button', { name: 'Run once' }).click();
        else {
          await dialog.locator('input').fill('Please only run npm test.');
          await dialog.getByRole('button', { name: 'Deny' }).click();
        }
      } else {
        await dialog.getByRole('button', { name: 'Deny' }).click();
      }
      approvals++;
      await page.waitForTimeout(300);
      continue;
    }
    const state = await page.locator('.task-header .chip').first().innerText().catch(() => '');
    if (['Waiting for you', 'Failed', 'Limit reached', 'Billing stop', 'Cancelled'].includes(state)) break;
    await page.waitForTimeout(500);
  }
  const finalState = await page.locator('.task-header .chip').first().innerText();
  check('task finished its turn', finalState === 'Waiting for you', finalState);
  check('edits were shown as diffs before applying', sawDiff);
  check('test command was proposed and approved', sawCommand);
  const mathAfter = fs.readFileSync(path.join(project, 'src/math.js'), 'utf8');
  check('multiply() was added', /export function multiply/.test(mathAfter));

  await page.getByRole('button', { name: /^Changes/ }).click();
  await page.locator('.change').first().waitFor();
  const badges = await page.locator('.change .chip').allInnerTexts();
  check('changes are listed with states', badges.some((b) => /Applied|Tested/.test(b)), badges.join(','));
  await page.locator('.change-head').first().click();
  await shot('workspace');

  const task = (await harness.callSidecar('task.list', { root: path.resolve(project) }))[0];
  check('cost estimate recorded', task.cost_usd > 0 && task.cost_usd <= budget * 1.2, `$${task.cost_usd.toFixed(4)}`);
  const events = (await harness.callSidecar('task.get', { taskId: task.id })).events;
  const auth = events.find((e) => e.kind === 'auth');
  check('authenticated via Console key helper, first-party API', auth?.payload?.apiKeySource === 'apiKeyHelper' && auth?.payload?.apiProvider === 'firstParty');
  console.log(`\nTask ${task.id}: ${task.turns} turns, ${task.input_tokens} in / ${task.output_tokens} out / ${task.cache_read_tokens} cache-read tokens, est. $${task.cost_usd.toFixed(4)} (${task.cost_basis} prices)`);
}
