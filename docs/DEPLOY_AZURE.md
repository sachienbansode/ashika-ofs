# Deploying the OFS desk on an Azure VM (Ubuntu 22.04 / 24.04)

The app runs on Azure; both databases stay on the AWS box `13.233.106.37`. That
cross-cloud hop is the one thing most likely to bite, so it is step 1.

Target state: Node bound to `127.0.0.1:4011`, PM2 keeping it alive across reboots,
nginx terminating TLS on `ofs.ashikagroup.com`, certificates auto-renewing.

---

## 0. Before you touch the VM

| Need | Why |
|---|---|
| **Static public IP** on the VM | The AWS security group and your DNS record both pin to it. A dynamic IP breaks both on reboot. |
| **DNS A record** → that IP | Let's Encrypt validates over HTTP; without DNS resolving first, certbot fails. |
| **AWS security group** allows the VM's IP on **5432** | Azure → AWS Postgres is public-internet traffic. Without this the app starts and every query times out. |
| Platform's **JWT_SECRET** and **API_KEY_SECRET** | Staff tokens are issued by the existing portal, and the SMTP password is sealed with the API key secret. Both must match byte for byte. |

> Confirm the DB hop before anything else — from the VM:
> ```bash
> sudo apt install -y postgresql-client
> nc -vz 13.233.106.37 5432          # must say "succeeded"
> ```
> If it hangs, it is the AWS security group, not the VM.

---

## 1. Base packages

Check what the VM already has before installing — it may host other apps:

```bash
node -v; npm -v; which pm2 nginx
```

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx ufw

# Node 22 LTS from NodeSource (Ubuntu's own node is too old)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v

sudo npm install -g pm2
```

## 2. Firewall — two layers, both required

Azure's **Network Security Group** and the VM's **ufw** are independent; traffic
must pass both. In the Azure portal add inbound rules for 80 and 443 (and 22 from
your admin range only). Then on the VM:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # 80 + 443
sudo ufw enable
sudo ufw status
```

Port 4011 is **not** opened anywhere — Node listens on localhost and only nginx
reaches it.

## 3. Clone

```bash
sudo mkdir -p /var/apps/ashika-ofs-app
sudo chown -R $USER:$USER /var/apps/ashika-ofs-app
git clone https://github.com/sachienbansode/ashika-ofs.git /var/apps/ashika-ofs-app
cd /var/apps/ashika-ofs-app
npm ci --omit=dev
```

Private repo over HTTPS will prompt for credentials. Either use a GitHub personal
access token as the password, or add a **deploy key** for this repo (read-only is
enough — the VM never pushes) and clone over SSH.

## 4. `.env`

```bash
cp .env.example .env
chmod 600 .env          # secrets: owner-readable only
nano .env
```

Fill these — everything else has a working default:

| Key | Value |
|---|---|
| `OFS_DATABASE_URL` | `postgresql://root_admin@13.233.106.37:5432/ofs_bids` |
| `OFS_PG_PASSWORD` | the `root_admin` password |
| `ANANTA_DATABASE_URL` | `postgresql://root_admin@13.233.106.37:5432/uat_ananta_staging` |
| `ANANTA_PG_PASSWORD` | same password |
| `JWT_SECRET` | **exactly** the platform's value, or every login is rejected |
| `API_KEY_SECRET` | **exactly** the platform's value, or the SMTP password will not decrypt |
| `CORS_ORIGINS` | `https://ofs.ashikagroup.com` |
| `APP_URL` | `https://ofs.ashikagroup.com` |

Keep passwords in `*_PG_PASSWORD`, not inside the URL — the app applies them after
parsing, so the URL stays safe to paste into a ticket or a log.

Then, in order — each step gates the next:

```bash
npm run check-env      # missing/placeholder values, before anything connects
npm run smoke          # both databases answer; LD columns are what we expect
npm run migrate        # creates the ofs schema in ofs_bids
```

`npm run smoke` is the first real contact with the databases. Fix whatever it
reports before migrating.

## 5. PM2

```bash
pm2 start ecosystem.config.js
pm2 logs ashika-ofs-app --lines 30      # expect both db targets logged, then "listening on 127.0.0.1:4011"
curl -s localhost:4011/healthz          # {"ok":true,...}
curl -s localhost:4011/readyz           # both databases must report ok:true

pm2 save
pm2 startup systemd                     # prints a sudo command — run it, then pm2 save again
```

`ecosystem.config.js` has `cwd: /var/apps/ashika-ofs-app`. If you cloned somewhere
else, change it there rather than passing flags.

## 6. nginx + TLS

```bash
sudo cp deploy/nginx/ofs.conf /etc/nginx/sites-available/ofs.conf
sudo nano /etc/nginx/sites-available/ofs.conf     # replace ofs.ashikagroup.com
sudo ln -s /etc/nginx/sites-available/ofs.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default       # stops the welcome page shadowing the app
sudo nginx -t && sudo systemctl reload nginx
```

Confirm `http://ofs.ashikagroup.com/healthz` answers, then issue the certificate:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ofs.ashikagroup.com
sudo systemctl status certbot.timer     # renewal is automatic; verify the timer is active
sudo certbot renew --dry-run
```

Certbot rewrites the server block for TLS and adds the HTTP→HTTPS redirect. Once
HTTPS is confirmed, uncomment the HSTS line in the config and reload.

## 7. Grant the desk its page

The app self-registers `ofs-desk` and `ofs-masters` into the platform's
`page_registry` on first boot. A staff user still needs the grant on their role in
the Admin console before the dashboard loads — until then the UI shows
"ofs-desk grant required". Full access is `'*'` only; add `ofs-desk:pii` for the
handful of users allowed to unmask client PII.

## 8. Routine deploys — two blocks, always

Local (Windows PowerShell):

```powershell
cd "D:\sachin b\projects\OFS"
git add -A
git commit -m "ofs: <change>"
git push origin main
```

Azure VM — **`git fetch` before `reset`**, the stale cached-ref bug has bitten
repeatedly:

```bash
cd /var/apps/ashika-ofs-app
git fetch origin
git reset --hard origin/main
npm ci --omit=dev          # only when package.json changed
npm run migrate            # only when db/migrations/ changed
pm2 restart ashika-ofs-app
pm2 logs ashika-ofs-app --lines 20
```

`git reset --hard` does not touch `.env` — it is gitignored.

---

## When it does not work

| Symptom | Cause |
|---|---|
| `/readyz` 503, `ETIMEDOUT` | AWS security group is not allowing the VM's public IP on 5432. |
| `/readyz` 503, `no pg_hba.conf entry` | The DB reached you but rejects the host/user/SSL combination — check `pg_hba.conf` and that `*_PG_SSL=true`. |
| 502 from nginx | Node is down or on another port: `pm2 logs`, then `curl localhost:4011/healthz`. |
| Every login 401 | `JWT_SECRET` does not match the platform's. |
| Dashboard says "ofs-desk grant required" | Token is valid; the role lacks the page grant (step 7). |
| Bids rejected `unknown_client` | The Ananta connection works but `dwh.tbl_user_info` has no such UCC — run `npm run smoke`. |
| `/api/allotment/mail/status` → `password_undecryptable` | `API_KEY_SECRET` does not match the platform's. |
| certbot fails validation | DNS is not pointing at the VM yet, or NSG/ufw is blocking port 80. |
| Works, then dies after reboot | `pm2 startup systemd` was never run, or `pm2 save` was not re-run after it. |
| `npm ci` → `EUSAGE ... existing package-lock.json` | The lockfile is missing from the checkout. `git pull` (it is committed), or fall back to `npm install --omit=dev`. |
| `git pull` → "untracked working tree files would be overwritten" | An earlier `npm install` left its own `package-lock.json`. Deploy with `git fetch origin && git reset --hard origin/main` instead — it never merges, so this cannot happen. |
| `password authentication failed for user ...` | The credential is wrong for that database. Compare the two `_PG_PASSWORD` values (`md5sum` them rather than printing), and quote any password containing `#` — dotenv treats an unquoted `#` as a comment and truncates the value. |
