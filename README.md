# ADITION ELECTRIC SOLUTION — Service Management PWA

## Overview
Mobile-only PWA for ADITION ELECTRIC SOLUTION for managing electronic repair jobs. Built with Hono on Cloudflare Workers + D1 SQLite + R2 image storage.

## Live (Sandbox)
🌐 https://3000-ivun77vx8q4y3hmbo2tha-583b4d74.sandbox.novita.ai

## Credentials
| Role  | Email                        | Password |
|-------|------------------------------|----------|
| Admin | bilalkhan1108@gmail.com      | 0010     |
| Staff | (add via Staff Panel)        | —        |

## Features

### ✅ Implemented
- **Auth**: JWT login, 30-day token, role-based (admin / staff)
- **RBAC**: Admin — full CRUD, delete, backup, Delivered view; Staff — view-only, no prices/mobiles
- **Jobs**: Sequential IDs C-001 … C-999; customer auto-lookup by mobile
- **Machines**: Multi-machine per job; status (Under Repair / Repaired / Returned); per-machine image upload to R2
- **Job Card**: 9:16 HD JPG via html2canvas; Web Share API to share to WhatsApp Business
- **WhatsApp Messages**: Registration & Delivery templates (no wa.me link)
- **Delivery Flow**: Modal with In-Person / Courier options + tracking fields
- **Excel Backup**: Full export + transactional import via XLSX
- **Staff Reports**: By date range and staff member
- **Job Summary Report**: Admin-only Excel export
- **Data Cleanup**: Delete by date range or full reset (C-001 restart)
- **PWA**: Add-to-Home, Service Worker caching, manifest
- **Status Colours**: Under Repair=Red, Repaired=Green, Returned=Dark Yellow, Delivered=Blue

## API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/login | Login |
| GET | /api/jobs | List jobs (filter ?status=) |
| POST | /api/jobs | Create job |
| GET | /api/jobs/:id | Job details + machines |
| PUT | /api/jobs/:id | Update job/status |
| DELETE | /api/jobs/:id | Delete job (admin) |
| POST | /api/jobs/:id/machines | Add machine |
| PUT | /api/machines/:id | Update machine |
| DELETE | /api/machines/:id | Delete machine (admin) |
| POST | /api/machines/:id/images | Upload image to R2 |
| GET | /api/images/* | Serve image from R2 |
| GET | /api/staff | List staff (admin) |
| POST | /api/staff | Add staff (admin) |
| PUT | /api/staff/:id | Edit staff (admin) |
| GET | /api/backup/export | Excel backup download |
| POST | /api/backup/import | Restore from Excel |
| GET | /api/reports/jobs | Job summary XLSX |
| GET | /api/reports/staff | Staff work report XLSX |
| DELETE | /api/cleanup | Delete by date / full reset |

## Cloudflare Deployment

### 1. Prerequisites
```bash
npm install -g wrangler
wrangler login
```

### 2. Create D1 Database
```bash
npx wrangler d1 create adition-production
# Copy database_id to wrangler.jsonc
npx wrangler d1 migrations apply adition-production
```

### 3. Create R2 Bucket
```bash
npx wrangler r2 bucket create adition-images
```

### 4. Set Secrets
```bash
npx wrangler pages secret put JWT_SECRET --project-name adition-electric
# Enter a strong random secret
```

### 5. Deploy
```bash
npm run build
npx wrangler pages project create adition-electric --production-branch main
npx wrangler pages deploy dist --project-name adition-electric
```

## Data Architecture
- **D1 SQLite**: users, customers, jobs, machines, machine_images, job_counter
- **R2**: Machine images (stored as `machines/{machineId}/{timestamp}-{filename}`)
- **JWT**: HS256, 30-day expiry, stores id/role/email/name

## Footer
Opposite Metropolitan Court Gate 2, Gheekanta, Ahmedabad 380001  
Subjected to Ahmedabad Jurisdiction only
