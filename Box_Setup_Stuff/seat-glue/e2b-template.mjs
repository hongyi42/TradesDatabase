// Build the E2B template a manager's sandbox starts from (step 2b, plan
// 2026-09-28-step-2b-manager-files-sandbox-skills). Run from a laptop, once, and
// again whenever the library list changes:
//
//   npm i --no-save e2b@2.51.0
//   node Box_Setup_Stuff/seat-glue/e2b-template.mjs            # builds "trades-manager"
//   node Box_Setup_Stuff/seat-glue/e2b-template.mjs other-name # or E2B_TEMPLATE on the box
//
// WHY A TEMPLATE (operator 2026-09-28, 2A): the sandbox has NO internet, so it
// cannot pip-install at run time. Everything a manager's files need is baked in
// here. The key comes from the main checkout's .env (E2B_API_KEY), never printed.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Template, defaultBuildLogger } from 'e2b';

const name = process.argv[2] || 'trades-manager';
const common = execSync('git rev-parse --path-format=absolute --git-common-dir').toString().trim();
const line = readFileSync(join(dirname(common), '.env'), 'utf8').split('\n').find((l) => l.startsWith('E2B_API_KEY='));
if (!line) throw new Error('E2B_API_KEY missing from .env');
const apiKey = line.slice('E2B_API_KEY='.length).trim().replace(/^["']|["']$/g, '');

// openpyxl + xlsxwriter: spreadsheets; reportlab: PDFs (2c's invoices);
// pandas: the CSV that export_query writes.
const template = Template()
  .fromPythonImage('3.12')
  .pipInstall(['openpyxl', 'xlsxwriter', 'reportlab', 'pandas']);

const info = await Template.build(template, name, { apiKey, cpuCount: 2, memoryMB: 2048, onBuildLogs: defaultBuildLogger() });
console.log(`built template ${name}:`, JSON.stringify({ templateId: info.templateId, buildId: info.buildId }));
