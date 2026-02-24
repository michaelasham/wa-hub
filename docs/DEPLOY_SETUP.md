# Push-to-Deploy Setup Guide

This guide explains how to set up automated deployment from GitHub to a GCP Compute Engine VM using GitHub Actions.

## Overview

When code is pushed to the `main` branch, GitHub Actions will:
1. SSH into the VM
2. Pull the latest code
3. Install dependencies (`npm ci`)
4. Build if needed (`npm run build`)
5. Restart the `wa-hub` systemd service

## Prerequisites

- GCP Compute Engine VM running Ubuntu/Debian
- Node.js and npm installed on the VM
- Git installed on the VM
- SSH access to the VM

## VM Setup Steps

### 1. Create Deploy User

Create a dedicated user for deployments (do not use root):

```bash
sudo useradd -m -s /bin/bash wa-hub
sudo usermod -aG sudo wa-hub
```

### 2. Set Up Deployment Directory

```bash
# Create deployment directory
sudo mkdir -p /opt/wa-hub
sudo chown wa-hub:wa-hub /opt/wa-hub

# Clone the repository (as wa-hub user)
sudo -u wa-hub git clone https://github.com/michaelasham/wa-hub.git /opt/wa-hub
```

### 3. Install Systemd Service

```bash
# Copy systemd unit file
sudo cp /opt/wa-hub/scripts/wa-hub.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable wa-hub
```

### 4. Configure Sudoers (Allow Service Restart Only)

Create a sudoers rule that allows the `wa-hub` user to restart only the `wa-hub` service without a password:

```bash
sudo visudo -f /etc/sudoers.d/wa-hub-deploy
```

Add this line:

```
wa-hub ALL=(ALL) NOPASSWD: /bin/systemctl restart wa-hub, /bin/systemctl status wa-hub, /bin/systemctl is-active wa-hub
```

**Note:** `is-active` is a read-only command that only checks service status, so it's safe to include.

**Security Note:** This only allows restarting and checking status of the `wa-hub` service, nothing else.

### 5. Set Up SSH Key for GitHub Actions

Generate an SSH key pair for GitHub Actions:

```bash
# On your local machine or CI/CD system
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/wa-hub-deploy-key -N ""
```

Add the **public key** to the VM:

```bash
# On the VM, as wa-hub user
sudo -u wa-hub mkdir -p ~wa-hub/.ssh
sudo -u wa-hub chmod 700 ~wa-hub/.ssh

# Copy the public key content and add it to authorized_keys
sudo -u wa-hub bash -c 'echo "YOUR_PUBLIC_KEY_HERE" >> ~wa-hub/.ssh/authorized_keys'
sudo -u wa-hub chmod 600 ~wa-hub/.ssh/authorized_keys
```

**Important:** The private key will be added to GitHub Secrets in the next step.

### 6. Configure Environment File

Create the `.env` file on the VM:

```bash
sudo -u wa-hub nano /opt/wa-hub/.env
```

Add required environment variables:

```env
PORT=3000
API_KEY=your_api_key_here
WEBHOOK_SECRET=your_webhook_secret
CHROME_PATH=/usr/bin/chromium-browser
SESSION_DATA_PATH=./.wwebjs_auth
LOG_LEVEL=info
```

Make sure the file is readable by the wa-hub user:

```bash
sudo chown wa-hub:wa-hub /opt/wa-hub/.env
sudo chmod 600 /opt/wa-hub/.env
```

### 7. Install Dependencies and Test

```bash
cd /opt/wa-hub
sudo -u wa-hub npm ci --production
```

Test the service manually:

```bash
sudo systemctl start wa-hub
sudo systemctl status wa-hub
```

## GitHub Secrets Configuration

Add the following secrets to your GitHub repository:

1. Go to: **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret** for each:

### Required Secrets

| Secret Name | Description | Example |
|------------|-------------|---------|
| `DEPLOY_HOST` | IP address or hostname of your GCP VM | `35.225.63.31` |
| `DEPLOY_USER` | SSH username (the deploy user) | `wa-hub` |
| `DEPLOY_SSH_KEY` | Private SSH key content (the entire key including `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----`) | Full private key content |

### How to Get the Private Key

If you generated the key pair in step 5:

```bash
cat ~/.ssh/wa-hub-deploy-key
```

Copy the entire output, including the header and footer lines.

## Workflow File

The deployment workflow is located at `.github/workflows/deploy.yml`. It will:

- Trigger on push to `main` branch
- SSH into the VM using the configured secrets
- Run the deployment commands:
  - `git fetch --all`
  - `git reset --hard origin/main`
  - `npm ci --production`
  - `npm run build` (if build script exists)
  - `sudo systemctl restart wa-hub`
  - Check service status

## Testing the Deployment

1. Make a small change to the codebase
2. Commit and push to `main`:
   ```bash
   git add .
   git commit -m "Test deployment"
   git push origin main
   ```
3. Check GitHub Actions tab to see the deployment run
4. Verify on the VM:
   ```bash
   sudo systemctl status wa-hub
   sudo journalctl -u wa-hub -f
   ```

## Troubleshooting

### SSH Connection Fails

- Verify `DEPLOY_HOST` is correct (use external IP for GCP VM)
- Check that the VM firewall allows SSH (port 22)
- Verify the SSH key is correctly added to `authorized_keys`
- Test SSH manually: `ssh -i ~/.ssh/wa-hub-deploy-key wa-hub@YOUR_VM_IP`

### Service Fails to Start

- Check service logs: `sudo journalctl -u wa-hub -n 50`
- Verify `.env` file exists and has correct values
- Check file permissions: `ls -la /opt/wa-hub`
- Verify Node.js path: `which node` (should be `/usr/bin/node`)

### Permission Denied on Service Restart

- Verify sudoers rule: `sudo cat /etc/sudoers.d/wa-hub-deploy`
- Test manually: `sudo -u wa-hub sudo systemctl restart wa-hub`
- Check sudoers syntax: `sudo visudo -c`

### Git Reset Fails

- Ensure the deploy user owns `/opt/wa-hub`: `sudo chown -R wa-hub:wa-hub /opt/wa-hub`
- Check git remote: `cd /opt/wa-hub && git remote -v`

### npm ci Fails

- Ensure Node.js and npm are installed: `node --version && npm --version`
- Check disk space: `df -h`
- Verify package-lock.json exists in the repository

## Security Best Practices

1. **Never commit secrets**: The `.env` file should be in `.gitignore`
2. **Use dedicated deploy user**: Never use root for deployments
3. **Limit sudo access**: Only allow restarting the specific service
4. **Rotate SSH keys**: Periodically regenerate and update SSH keys
5. **Monitor deployments**: Review GitHub Actions logs regularly
6. **Use firewall rules**: Restrict SSH access to known IPs if possible

## Manual Deployment (Fallback)

If GitHub Actions is unavailable, you can deploy manually:

```bash
# SSH into the VM
ssh wa-hub@YOUR_VM_IP

# Run the deploy script
cd /opt/wa-hub
/opt/wa-hub/scripts/deploy.sh
```

Or manually:

```bash
cd /opt/wa-hub
git fetch --all
git reset --hard origin/main
npm ci --production
sudo systemctl restart wa-hub
sudo systemctl status wa-hub
```
