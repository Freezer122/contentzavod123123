import {
  BrowserDiagnostics,
  DIAGNOSTIC_SCENARIOS,
  type DiagnosticScenario,
} from '../src/browser/diagnostics.js';
const scenario = process.argv[2] ?? 'OK',
  profileId = process.argv[3] ?? 'Threads 02';
if (!DIAGNOSTIC_SCENARIOS.includes(scenario as DiagnosticScenario))
  throw new Error(`Сценарий: ${DIAGNOSTIC_SCENARIOS.join(', ')}`);
console.log(
  JSON.stringify(
    await new BrowserDiagnostics().run(scenario as DiagnosticScenario, profileId),
    null,
    2,
  ),
);
