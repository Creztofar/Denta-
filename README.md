# SmileCare Dental Clinic

A modular dental clinic website and working portal foundation for patients, dentists, reception and clinic administrators. The project uses fake clinic and patient data only.

## Run locally

Requirements: Node.js 24 or newer. There are no third-party runtime packages to install.

```powershell
Copy-Item .env.example .env
npm start
```

Open [http://localhost:3000](http://localhost:3000). The first development start creates a local SQLite database at `data/smilecare.sqlite` and seeds demo records. To start fresh, stop the server and remove that local database file.

On Windows, double-click `start-smilecare.bat` to start the server and open the browser. Do not open `public/index.html` directly because the app needs the Node.js API server.

All seeded development users use this password:

```text
SmileCareDemo!24
```

| Role | Demo sign-in |
|---|---|
| Super admin | `admin@smilecare.demo` |
| Receptionist | `reception@smilecare.demo` |
| Doctor | `doctor1@smilecare.demo`, `doctor2@smilecare.demo`, `doctor3@smilecare.demo` |
| Patient | `patient1@smilecare.demo` through `patient4@smilecare.demo` |

Reset links are returned by the local development API so the reset flow can be exercised without email. That response is disabled in production. Public registration creates patient accounts only.

## Project layout

```text
server/
  index.mjs             HTTP server, security headers and static file routing
  api.mjs               API routes, validation, access checks and workflows
  db.mjs                SQLite schema, initialization, demo data and password hashing
  security.mjs          Sessions, CSRF checks, role checks and safe responses
  validation.mjs        Shared request validation helpers
  appointments.mjs      Availability calculation, status transitions and booking transaction
public/
  index.html            Accessible app shell, metadata and structured data
  styles.css            Responsive design system and portal/site styles
  js/
    api.js              Same-origin JSON client and CSRF token handling
    components.js       Shared navigation, portal shell, forms and small UI components
    public-pages.js     Public clinic pages and patient-facing booking
    portal-pages.js     Patient, doctor and admin/reception views
    main.js             Client navigation, form handling and page actions
  robots.txt
  sitemap.xml
tests/
  platform.test.mjs     HTTP integration checks using Node's built-in test runner
```

## Technology choices

- **Server:** Node.js 24 native HTTP server and ES modules. API validation, session enforcement and role checks run on the server.
- **Browser:** semantic HTML, CSS and native ES modules. This keeps the project runnable without a framework build pipeline or downloaded packages while keeping pages, API access, portal views and shared UI in separate modules.
- **TypeScript/React:** this build uses JavaScript modules rather than React/Next.js or TypeScript. That is a deliberate no-build, no-downloaded-dependency choice for the empty environment, but it gives up compile-time type checking and should be treated as a portfolio foundation rather than evidence of a fully production-hardened stack.
- **Database:** SQLite through Node's built-in `node:sqlite` module, with foreign keys, unique/check constraints, indexes, and write-ahead logging. SQLite is relational and convenient for a self-contained portfolio deployment. It is configured for a single application instance; migrate the data layer to PostgreSQL before running multiple instances or handling substantial clinic workloads.
- **Passwords:** salted `scrypt` hashes. Password hashes are never returned by an API.
- **Authentication:** opaque random session IDs stored as SHA-256 hashes in the database, `HttpOnly`, `SameSite=Strict` cookies, production `Secure` cookies, expiry, and per-session CSRF tokens required on authenticated writes.

## Database model

`users` stores login identity, password hash, role and account state. It has one-to-one `patients` or `doctors` profiles. Services connect to doctors through `doctor_services`; `doctor_availability` defines weekly hours and breaks and `doctor_unavailability` stores date exceptions. `appointments` references one patient, dentist and service and enforces a valid time range and status vocabulary. `enquiries`, `testimonials`, `gallery_items`, and `faqs` support the public site and content manager. `sessions` and `password_reset_tokens` support authentication. `audit_logs` records actor, action, resource and time without copying patient details. `domain_events` is a durable outbox for future integrations.

All timestamps are stored in UTC ISO format. Scheduling dates and display use `CLINIC_TIMEZONE` (default `Asia/Kolkata`). Doctor availability uses local clinic time. A booking transaction checks the doctor's assigned service, active status, working hours, break, date exceptions, future date, slot alignment and overlap with existing pending, confirmed or rescheduled visits. The write runs under `BEGIN IMMEDIATE`; this serializes competing slot requests within the SQLite database.

## Authentication and permissions

| Role | Server-enforced scope |
|---|---|
| Patient | Own profile and own appointments; request/cancel/reschedule visits |
| Doctor | Appointments assigned to that doctor, basic information for patients linked to those appointments, and permitted appointment status updates |
| Receptionist | Scheduling, patient creation/search and enquiry follow-up |
| Admin | Clinic operations, patients, doctors, availability, services, content and audit view |
| Super admin | Admin functions plus staff account management |

Client route hiding is only a usability detail. Each private API route checks the session and role on the server, and patient and doctor reads constrain SQL queries to the current user's permitted records. Mutations validate same-origin requests and require the session CSRF token. Login and reset endpoints have in-memory per-IP rate limits; deployment behind a proxy must preserve correct client IP handling or replace this limiter with a shared store.

The appointment lifecycle supports `PENDING`, `CONFIRMED`, `RESCHEDULED`, `CANCELLED`, `COMPLETED`, and `NO_SHOW`, with server-side transition checks. Public patient requests start as pending; reception or an administrator confirms them. Every status change produces an audit record and an outbox event.

## API map

- **Auth:** `POST /api/auth/register`, `/login`, `/logout`, `/forgot-password`, `/reset-password`, `/change-password`; `GET /api/auth/session`.
- **Public:** `GET /api/public/services`, `/doctors`, `/faqs`, `/gallery`, `/testimonials`; `GET /api/availability`; `POST /api/public/enquiries`.
- **Patient:** `GET/PATCH /api/patient/profile`, `GET /api/patient/appointments`, `POST /api/patient/appointments`, `POST /api/patient/appointments/:id/cancel|reschedule`.
- **Doctor:** `GET /api/doctor/appointments`, `/availability`, `/patients/:id`; `PATCH /api/doctor/appointments/:id`.
- **Clinic admin/reception:** `GET /api/admin/metrics`, `/appointments`, `/patients`, `/doctors`, `/services`, `/enquiries`; create/manage routes are listed in `server/api.mjs` and use role checks.
- **Admin only:** doctor/service/content editing, account activation, and audit access. **Super admin only:** `/api/admin/staff`.
- **Health:** `GET /api/health`.

Error responses use a stable `{ error: { code, message } }` shape; raw stack traces and database errors are not sent to the browser.

## Automation-ready events

Appointment and enquiry changes append records to `domain_events`, which acts as a transactional outbox boundary between clinic workflows and future delivery services. Planned event names include `appointment.created`, `appointment.confirmed`, `appointment.cancelled`, `appointment.rescheduled`, `appointment.completed`, `appointment.no_show`, and `enquiry.created`. No event worker, n8n connection, webhook delivery, email, WhatsApp, SMS, calendar sync or payment gateway is implemented. A future worker can claim unpublished outbox rows, sign webhook requests, retry failures and mark `published_at` without putting integration credentials in the browser or coupling scheduling to an automation provider.

## Configuration

Copy `.env.example` to `.env` for local use.

| Variable | Purpose |
|---|---|
| `NODE_ENV` | Use `production` for secure-cookie and no-demo-data behavior. |
| `PORT` | HTTP listener port; defaults to `3000`. |
| `APP_ORIGIN` | Exact browser origin for mutation checks, such as `https://clinic.example`. Set this in production. |
| `DATABASE_PATH` | SQLite database path; defaults to `./data/smilecare.sqlite`. |
| `SESSION_TTL_HOURS` | Session lifetime; defaults to 12 hours. |
| `RESET_TOKEN_TTL_MINUTES` | Development reset token lifetime; defaults to 30 minutes. |
| `CLINIC_TIMEZONE` | Clinic schedule/display time zone; defaults to `Asia/Kolkata`. |
| `SEED_DEMO_DATA` | Development demo seed switch. Production never seeds demo data. |
| `INITIAL_SUPER_ADMIN_EMAIL` / `INITIAL_SUPER_ADMIN_PASSWORD` | Create the first production super-admin account. The password must be at least 12 characters. |

## Deployment and privacy requirements

Run behind a TLS-terminating HTTPS reverse proxy, set `NODE_ENV=production`, `APP_ORIGIN`, a persistent writable database volume and the initial super-admin credentials. Set `SEED_DEMO_DATA=false`; production startup refuses to run without an active super-admin account. Back up the database and test restores. The app serves static files and API from the same origin; no permissive CORS policy is enabled.

Before real clinic use, the clinic owner must review applicable privacy, medical-record retention, consent, breach response, and jurisdictional requirements; obtain legal/security review; arrange a production email channel for password resets; remove demo contact and testimonial content; configure monitored backups and restore drills; and assess whether PostgreSQL, centralized rate limiting, MFA, staff provisioning controls, and a dedicated audit retention policy are required. This starter stores basic patient contact data and appointment service/time only. It intentionally does not store diagnoses, treatment notes, images, insurance or payment records.

## Known limits

- SQLite is single-instance and file-backed; it is not a multi-region or multi-replica database setup.
- The production password-reset email sender is not configured; production reset requests return a clear unavailable response instead of pretending an email was sent. Local development returns a working reset link.
- Audit and automation outbox records are persisted, but there is no delivery worker, notification center or outbound integration.
- Admin content management covers basic FAQs, testimonials and gallery records; full clinic-settings editing, CMS image upload, bulk import/export and advanced reports are not implemented.
- The app uses standard browser modules rather than React/Next.js and external font/photo URLs for demo imagery. Replace these with approved clinic assets and self-host fonts/images for controlled production performance and licensing.
- Admin tables page the loaded results in the browser; list APIs cap several collections at 300 records. Add server-side pagination and filtering before using this with a large clinic dataset.
- The included UI/API integration tests cover core authentication, role boundaries, appointment conflicts and status rules. They do not replace a full accessibility audit, penetration test, legal/privacy review or multi-device manual review.
