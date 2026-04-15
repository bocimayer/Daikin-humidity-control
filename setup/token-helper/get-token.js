#!/usr/bin/env node
'use strict';

const DaikinCloud = require('daikin-controller-cloud');

const [,, email, password] = process.argv;

if (!email || !password) {
  console.error('Usage: node get-token.js <daikin-email> <daikin-password>');
  process.exit(1);
}

const d = new DaikinCloud(null, {});

console.log(`Logging in as ${email}...`);

d.login(email, password)
  .then((tokenSet) => {
    const data = tokenSet.toJSON ? tokenSet.toJSON() : tokenSet;
    console.log('\n==========================================');
    console.log('DAIKIN_REFRESH_TOKEN (store this in Secret Manager):');
    console.log('');
    console.log(data.refresh_token);
    console.log('\n==========================================');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nLogin failed:', err.message);
    process.exit(1);
  });
