#!/usr/bin/env node

const path = require('node:path');

const role = process.argv[2] ?? 'api';
const roleArguments = process.argv.slice(3);
const supportedRoles = new Set(['api', 'worker', 'scheduler']);

if (role === '--help' || role === '-h') {
  process.stdout.write(
    [
      'Usage: aiflow-engine <api|worker|scheduler> [options]',
      '',
      'Examples:',
      '  aiflow-engine api',
      '  aiflow-engine worker --queues=extract,map',
      '  aiflow-engine scheduler',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

if (!supportedRoles.has(role)) {
  process.stderr.write(`Unsupported runtime role: ${role}\n`);
  process.exit(1);
}

const entrypoint = path.join(__dirname, '..', 'apps', role, 'dist', 'main.js');

process.argv = [process.argv[0], entrypoint, ...roleArguments];
require(entrypoint);
