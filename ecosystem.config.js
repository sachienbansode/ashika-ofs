module.exports = {
  apps: [
    {
      name: 'ashika-ofs-app',
      script: 'server.js',
      cwd: '/var/apps/ashika-ofs-app',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      error_file: '/var/log/pm2/ashika-ofs-app.err.log',
      out_file: '/var/log/pm2/ashika-ofs-app.out.log',
      time: true
    }
  ]
};
