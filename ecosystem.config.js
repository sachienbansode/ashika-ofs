module.exports = {
  apps: [
    {
      name: 'ashika-ofs-app',
      script: 'server.js',
      cwd: '/var/apps/ashika-ofs-app',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '400M',
      // NODE_ENV deliberately NOT set here: .env is the single place configuration
      // lives, and a value hardcoded in this file silently overrides it (PM2 env
      // beats dotenv, which does not overwrite what is already set). Set
      // NODE_ENV=production in .env for a live desk; anything else (uat, staging)
      // permits OFS_OTP_TEST_MODE.
      error_file: '/var/log/pm2/ashika-ofs-app.err.log',
      out_file: '/var/log/pm2/ashika-ofs-app.out.log',
      time: true
    }
  ]
};
