'use strict';

const EXIT_RUNTIME = 1;

function safeErrorCode(error) {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return null;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(error, 'code'); }
  catch (_) { return null; }
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
    typeof descriptor.value === 'string' ? descriptor.value : null;
}

function fatalCategory(error) {
  const code = safeErrorCode(error);
  if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return 'installation-modules';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'local-file-access';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'required-local-file';
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'local-storage';
  if (code === 'EMFILE' || code === 'ENFILE') return 'runtime-file-limit';
  if (code === 'ENOMEM') return 'runtime-memory';
  return 'internal';
}

function fatalMessage(error) {
  const category = fatalCategory(error);
  if (category === 'installation-modules') {
    return 'interlock: required installed modules could not be loaded (category: installation-modules).\n' +
      'Reinstall from the same trusted Interlock source in this operating-system and Node environment; do not share node_modules between WSL and native Windows.';
  }
  if (category === 'local-file-access') {
    return 'interlock: required local files could not be accessed (category: local-file-access).\n' +
      'Check ownership and permissions for the Interlock installation and its printed data directory; do not use administrator privileges merely to bypass the error.';
  }
  if (category === 'required-local-file') {
    return 'interlock: a required local file is missing or not a file (category: required-local-file).\n' +
      'Verify that this command uses the intended Interlock installation. Do not recreate or overwrite data files by hand.';
  }
  if (category === 'local-storage') {
    return 'interlock: local storage is full or unavailable (category: local-storage).\n' +
      'Free space or quota in the Interlock installation and data locations, then run the command again.';
  }
  if (category === 'runtime-file-limit') {
    return 'interlock: the Node runtime reached its open-file limit (category: runtime-file-limit).\n' +
      'Close unused processes or raise the user file limit, then run the command again.';
  }
  if (category === 'runtime-memory') {
    return 'interlock: the Node runtime could not allocate memory (category: runtime-memory).\n' +
      'Close memory-heavy processes, then run the command again.';
  }
  return 'interlock: an unexpected runtime failure stopped the command (category: internal).\n' +
    'Do not assume the command completed. Report the command name, operating system, Node version, and this category; never include passwords, passkeys, tokens, or data files.';
}

async function runEntrypoint(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const io = options.io || { stdout: process.stdout, stderr: process.stderr };
  const loadCli = options.loadCli || (() => require('./cli.js'));
  try {
    const { run, runRecover, runStart } = loadCli();
    if (argv[0] === 'start') return await runStart(argv.slice(1), io);
    if (argv[0] === 'recover') return await runRecover(argv.slice(1), io);
    return await run(argv, io);
  } catch (error) {
    io.stderr.write(fatalMessage(error) + '\n');
    return EXIT_RUNTIME;
  }
}

module.exports = Object.freeze({ EXIT_RUNTIME, fatalCategory, fatalMessage, runEntrypoint });
