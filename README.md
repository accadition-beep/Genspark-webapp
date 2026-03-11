# ADITION ELECTRIC SOLUTION — PWA v6

**Mobile-first PWA** for electric appliance repair shop management.  
Admin & Staff roles · Job tracking C-001 to C-999 · R2 image storage · D1 SQLite DB

---

## 🔗 URLs
| Environment | URL |
|---|---|
| **Sandbox (Dev)** | https://3000-ivun77vx8q4y3hmbo2tha-583b4d74.sandbox.novita.ai |
| **GitHub** | https://github.com/bilalkhan1108-lgtm/Genspark-webapp |
| **Production** | Deploy via `npm run deploy` (see Deployment section) |

---

## ✅ Completed Features (v6)

### Authentication & RBAC
- Email/password login with JWT (30-day expiry)
- **Admin** (bilalkhan1108@gmail.com / `0010`) — full CRUD, backup/restore, view delivered jobs
- **Staff** — view-only, no prices/charges/mobiles/export, sees Balance Due only

### Dashboard (Virtual List)
- **Virtual list rendering** — only renders visible job cards, handles 500+ jobs lag-free
- Persistent URL filter (`?status=under_repair` default)
- Live search with 350ms debounce
- 4-colour status badges: 🟠 Under Repair · 🟢 Repaired · 🔵 Returned · ✅ Delivered

### Job Management
- Sequential job IDs: C-001 → C-999 (resets only on full cleanup)
- Customer upsert by mobile number (auto-update on re-registration)
- **Received Amount** input on create/edit forms (admin only)
- **Financial Panel**: Total Charges · Received Amount · Balance Due
- Staff sees Balance Due only (no breakdown)
- Multi-machine per job with per-machine: product name, complaint, charges, quantity, status, images

### Machine & Image Management
- **Client-side canvas image compression** — max 1280px, 0.82 JPEG quality before R2 upload (prevents app hang on high-res photos)
- Up to 3 images per machine displayed on job card
- Per-machine status updates auto-propagate to job status

### 9:16 Job Card (1080×1920 HD JPG)
- `html2canvas` with `scale:2` for HD output
- Includes: Job ID, Customer info, Machine list with complaints, Financial summary
- **Conditional footer block**:
  - `status ≠ delivered` → ⚠️ 25-day collection notice
  - `status = delivered` → 📦 Delivery Info (Receiver Name/Mobile/Method/Courier/Tracking)
- Web Share API → allows WhatsApp Business selection
- Download fallback if share not supported

### Registration Messages (WhatsApp)
- **Undelivered**: Registration confirmation + 25-day liability notice
- **Delivered**: "Successful Delivery" message with financial summary

### Database Integrity
- `PRAGMA foreign_keys = ON`
- `ON DELETE CASCADE` on all foreign key relations
- Admin seeded in migration (hard-coded, never lost on reset)

### Excel Reports (Admin Only)
- Full backup export (.xlsx) — image URLs only, no blobs
- Full backup import — transactional, rolls back on error
- Staff work report (per staff, machines handled)
- Job summary report

### Cleanup (Admin Only)
- Date-range delete — removes old jobs/machines/images
- Full reset — deletes all data, resets sequence to C-001

### PWA
- Service worker v6: cache-first for UI, stale-while-revalidate for CDN, network-first for API
- Background sync support
- Offline UI (serves from cache)
- Installable on Android/iOS home screen

### Mobile UX
- All touch targets **minimum 44px** (WCAG AA mobile standard)
- Safe area insets (notch/home-bar aware)
- Viewport locked (no user-scale)

---

## 📐 Data Architecture

### D1 Tables
| Table | Key Fields |
|---|---|
| `users` | id, name, email, password_hash, role, active |
| `customers` | id, name, mobile (UNIQUE), mobile2, address |
| `job_counter` | id=1, last_seq (auto-incremented) |
| `jobs` | id (C-001…), customer_id, snap_*, note, status, received_amount, delivery_* |
| `machines` | id, job_id FK→CASCADE, product_name, product_complaint, charges, quantity, assigned_staff_id, status |
| `machine_images` | id, machine_id FK→CASCADE, r2_object_key, url |

### R2 Bucket
- **PRODUCT_IMAGES** — stores compressed JPEG images (key: `images/{jobId}/{machineId}/{timestamp}.jpg`)

### Status Flow
```
under_repair → repaired → returned → delivered
```
Job status auto-updates based on machine statuses.

---

## 🚀 Deployment to Cloudflare Pages

```bash
# 1. Create D1 database
npx wrangler d1 create adition-production
# → Copy database_id to wrangler.jsonc

# 2. Run migrations
npx wrangler d1 migrations apply adition-production

# 3. Create R2 bucket
npx wrangler r2 bucket create adition-images

# 4. Create Pages project
npx wrangler pages project create adition-electric --production-branch main

# 5. Set JWT secret
npx wrangler pages secret put JWT_SECRET --project-name adition-electric
# → Enter a strong random secret

# 6. Deploy
npm run build
npx wrangler pages deploy dist --project-name adition-electric
```

### Cloudflare Bindings Required
| Binding | Type | Name |
|---|---|---|
| `DB` | D1 Database | adition-production |
| `PRODUCT_IMAGES` | R2 Bucket | adition-images |
| `JWT_SECRET` | Secret variable | (strong random string) |

---

## 🛠️ Local Development

```bash
# Install dependencies
npm install

# Apply migrations locally
npx wrangler d1 migrations apply adition-production --local

# Build and start dev server
npm run build
pm2 start ecosystem.config.cjs

# Test
curl http://localhost:3000/api/auth/login \
  -d '{"email":"bilalkhan1108@gmail.com","password":"0010"}' \
  -H "Content-Type: application/json"
```

---

## 📱 User Guide

### Login
- Open the app → enter email & password
- Admin: `bilalkhan1108@gmail.com` / `0010`

### Create a Job
1. Dashboard → **New Job**
2. Enter customer name + mobile (required)
3. Add optional address, note, received amount (admin)
4. Enter first machine details: product name, complaint, charges (admin), quantity
5. Tap **Create Job** → job card opens

### Add More Machines / Images
- On Job Detail → tap **+ Add Machine**
- On each machine card → tap the 📷 icon to upload image (auto-compressed)

### Mark Delivered
- Job Detail → tap **Mark Delivered** (admin only)
- Fill receiver name, mobile, delivery method
- Status changes to Delivered; job card shows delivery block

### Share Job Card
- Job Detail → tap **Share**
- App generates 1080×1920 JPG + WhatsApp message
- Select WhatsApp Business from share sheet

### Export Reports (Admin)
- Dashboard menu → **Reports**
- Choose: Full Backup, Staff Report, or Job Summary

---

## Tech Stack
- **Backend**: Hono 4 · Cloudflare Workers · D1 (SQLite) · R2
- **Auth**: jose JWT (HS256) · bcryptjs
- **Frontend**: Vanilla JS SPA · Tailwind CSS CDN · html2canvas · Axios · FontAwesome
- **Build**: Vite 6 · @hono/vite-cloudflare-pages · TypeScript
- **PWA**: Service Worker v6 · Web Share API · Web App Manifest

---

*adition™ since 1984 · Gheekanta, Ahmedabad 380001 · Subjected to Ahmedabad Jurisdiction only*
