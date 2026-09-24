import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = path.dirname(fileURLToPath(import.meta.url));
const repository = process.argv[2];
assert.ok(repository);
const driver = path.join(base, 'live-command-capture-fail-closed-r1.mjs');
const outputDirectory = path.join(base, 'pr332-capture-regression-r1');
await mkdir(outputDirectory);
const git = (...args) => execFileSync('git', ['-C', repository, ...args], {
  encoding: 'utf8', windowsHide: true,
}).trim();
const tree = git('write-tree');
assert.equal(git('diff', '--name-only'), '');
const sha = data => createHash('sha256').update(data).digest('hex');
const report = {
  pr: 332, tested_staged_tree: tree,
  corrected_helper_sha256: sha(await readFile(driver)),
  started_at: new Date().toISOString(), cases: [], status: 'running',
};
try {
  for (const item of [
    {name: 'missing-executable', program: path.join(outputDirectory, 'absent-native-program.exe'),
      args: [], expected: 1, expectedText: 'absent-native-program.exe'},
    {name: 'native-failure', program: process.execPath,
      args: ['-e', "console.error('native failure control'); process.exit(7)"],
      expected: 7, expectedText: 'native failure control'},
    {name: 'native-success', program: process.execPath,
      args: ['-e', "console.log('native success control'); process.exit(0)"],
      expected: 0, expectedText: 'native success control'},
  ]) {
    const log = path.join(outputDirectory, item.name + '.log');
    const configPath = path.join(outputDirectory, item.name + '.configuration.json');
    await writeFile(configPath, JSON.stringify({
      repository, name: item.name, program: item.program,
      arguments: item.args, log, outputDirectory, stagedTree: tree,
    }, null, 2) + '\n', {flag: 'wx'});
    const result = spawnSync(process.execPath, [driver, configPath], {
      cwd: repository, env: process.env, encoding: 'utf8',
      windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024,
    });
    await writeFile(path.join(outputDirectory, item.name + '.driver.log'),
      result.stdout + result.stderr, {flag: 'wx'});
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, item.expected, result.stderr);
    const receipt = JSON.parse(await readFile(path.join(outputDirectory, item.name + '.execution.json'), 'utf8'));
    const rawLog = await readFile(log);
    assert.equal(receipt.exit_code, item.expected);
    assert.equal(receipt.signal, null);
    assert.equal(receipt.source_unchanged, true);
    assert.equal(receipt.tested_staged_tree, tree);
    assert.equal(receipt.log_sha256, sha(rawLog));
    assert.ok(rawLog.toString('utf8').includes(item.expectedText));
    assert.ok(receipt.captures.some(c => c.file === item.name + '.completed.png'));
    for (const capture of receipt.captures) {
      assert.equal(capture.sha256, sha(await readFile(path.join(outputDirectory, capture.file))));
    }
    report.cases.push({
      name: item.name, expected_exit: item.expected, observed_exit: result.status,
      receipt: item.name + '.execution.json', log_sha256: sha(rawLog),
      assertions_passed: true,
    });
    console.log(item.name + ': expected=' + item.expected + ', observed=' + result.status);
  }
  assert.equal(git('write-tree'), tree);
  assert.equal(git('diff', '--name-only'), '');
  report.source_unchanged = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error);
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  await writeFile(path.join(outputDirectory, 'receipt.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
}
console.log(JSON.stringify(report));
