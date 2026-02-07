module.exports = {
  apps: [
    {
      name: 'wa-hub-dashboard',
      script: 'node_modules/.bin/next',
      args: 'start',
      cwd: '/home/michaelnasser321/wa-hub/wa-hub-dashboard',
      env: {
        PORT: 3001,
        HOSTNAME: '0.0.0.0',
        NODE_ENV: 'production',
      },
    },
  ],
};
