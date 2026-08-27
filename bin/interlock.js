#!/usr/bin/env node
'use strict';

const { runEntrypoint } = require('../src/entrypoint.js');

runEntrypoint().then(code => { process.exitCode = code; });
