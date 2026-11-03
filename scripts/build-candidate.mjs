import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditPackage } from './audit-package.mjs';
import { verifyPackageSource } from './verify-package-source.mjs';
import { buildWindowsInstaller } from './build-windows-installer.mjs';
import { smokePackagedStartup } from './smoke-packaged-startup.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const forgePackage = require.resolve('@electron-forge/cli/package.json');
const forge = path.join(path.dirname(forgePackage), 'dist/electron-forge.js');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [forge, 'package', '--arch=x64'], { cwd: root,
    env: { ...process.env, EDUCODER_EDGE_ONLY_INTERNAL: '1', EDUCODER_CANDIDATE_BUILD: '1' }, windowsHide: true, stdio: 'inherit' });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve() : reject(new Error(`FORGE_BUILD_FAILED (${code})`)));
});
const packageDir = path.join(root, 'out', `edge-candidate-${pkg.version}`, `${pkg.name}-win32-x64`);
const privacy = await auditPackage(packageDir, true);
const source = await verifyPackageSource(packageDir);
if (privacy.findings.length || source.findings.length) throw new Error(`CANDIDATE_AUDIT_FAILED: ${[...privacy.findings, ...source.findings].join('; ')}`);
const startupSmoke = await smokePackagedStartup(packageDir);
console.log(`Candidate audit PASS: ${privacy.entries} ASAR entries; ${source.runtimeFiles} source files match`);
const version = `${pkg.version}-candidate`;
const outputFile = path.join(root, 'out', 'installers', `educoder-study-assistant-${version}-win-x64-setup.exe`);
const installer = await buildWindowsInstaller({ packageDir, outputFile, version });
const result = { version, installer: path.basename(outputFile), installerSha256: installer.installerSha256,
  payloadSha256: installer.payloadSha256, browser: 'system Microsoft Edge',
  playbackEnabled: false,
  manualWorkspace: { singleAssistantWindow: true, embeddedPlayControls: true, directMapClickStartsSingle: true,
    persistentSelectionModes: false, transientOrderedBatchSelection: true, completionReleasesSession: true,
    primaryStartRequiresUserAction: true, resumeRequiresUserAction: true },
  playbackRecovery: { recoverableNoProgressRetries: true, retryAttemptLimit: null, retryDelayCapMs: 30000,
    transientNetworkAndMediaReadinessRetries: true, verifiedSameOriginPageResetRecovery: true,
    freshOfficialControlsRequired: true, unavailableSavedRestoreUsesActualOfficialPosition: true,
    explicitBeginningNeverFallsBack: true, intermediateOfficialSessionPreserved: true,
    completedSaveRetryNeverReplays: true, finalRecordConflictCheck: true,
    officialControlsOnly: true, userCancellationStopsRetries: true, websitePauseRespected: true,
    authenticationAndExplicitErrorsRequireUser: true, simulatedValidationOnly: true },
  localManualViewing: { available: true, scope: 'one user-selected scanned video', requiresUserAction: true,
    autoplayEnabled: false, perClassroomVideoPositions: true, legacyPositionReadOnlyMigration: true },
  personalTemporaryQueue: { available: true, enabledByDefault: false, userSelectedScannedVideos: true, startRequiresUserAction: true, realEndedAndOfficial100Required: true, autoResume: false },
  privacy, source, startupSmoke, installedFiles: installer.files };
await writeFile(`${outputFile}.json`, JSON.stringify(result, null, 2) + '\n');
console.log(`Installer ready: ${path.basename(outputFile)}; SHA256 ${installer.installerSha256}`);
