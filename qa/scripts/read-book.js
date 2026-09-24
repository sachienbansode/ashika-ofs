'use strict';
/* Read the plan workbook and print it as JSON. Run by lib/bookSync in a child
   process so playwright.config.js can have the environment before it defines
   anything. Errors go to stderr and exit 1, so the parent can show them plainly. */
require('../lib/book').load()
  .then((b) => {
    process.stdout.write(JSON.stringify({
      file: b.file, envName: b.envName, env: b.env, users: b.users, data: b.data
    }));
  })
  .catch((e) => { process.stderr.write(String(e.message || e)); process.exit(1); });
