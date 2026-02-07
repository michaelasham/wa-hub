const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

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
        WA_HUB_BASE_URL: process.env.WA_HUB_BASE_URL,
        WA_HUB_TOKEN: process.env.WA_HUB_TOKEN,
        DASHBOARD_WEBHOOK_PUBLIC_URL: process.env.DASHBOARD_WEBHOOK_PUBLIC_URL,
        DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD,
        DASHBOARD_SESSION_SECRET: process.env.DASHBOARD_SESSION_SECRET,
        WA_HUB_WEBHOOK_SIGNATURE_SECRET: process.env.WA_HUB_WEBHOOK_SIGNATURE_SECRET,
      },
    },
  ],
};
