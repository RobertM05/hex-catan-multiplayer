# 🎲 Hex Catan Multiplayer

> **Bilingual Real-Time Multiplayer Hexagonal Strategy Game**  
> *Inspired by Settlers of Catan, built with pure Node.js, Express, Socket.IO, SVG & Web Audio.*

[![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-v4.8+-black.svg)](https://socket.io/)
[![CI](https://github.com/RobertM05/hex-catan-multiplayer/actions/workflows/ci.yml/badge.svg)](https://github.com/RobertM05/hex-catan-multiplayer/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-25%20Passing-brightgreen.svg)](tests/)
[![Languages](https://img.shields.io/badge/Languages-RO%20%7C%20EN-orange.svg)](#-bilingual-support--localizare)

---

## 🌟 Overview / Prezentare Generală

**Hex Catan Multiplayer** is a tournament-accurate, browser-based implementation of the classic hexagonal strategy board game. It features real-time multiplayer via WebSockets (Socket.IO), autonomous heuristic bot AI for solo play or filling lobby seats, a procedural SVG board generator complying with official Catan rules, and a completely client-side procedural sound engine via the Web Audio API.

The entire frontend runs on modern vanilla JavaScript (ES Modules) without heavy framework bloat or build steps, making it lightweight, fast, and fully responsive across mobile phones, tablets, and desktop computers.

---

## ✨ Features / Funcționalități

### 🗺️ Procedural & Official Board Generation
- **Standard Map (19 Hexes, 3–4 Players)**:
  - 4 Wood (Pădure), 3 Brick (Dealuri de Lut), 4 Wool (Pășuni), 4 Wheat (Câmpuri de Grâu), 3 Ore (Munți de Minereu), 1 Desert (Deșert).
  - Number tokens: 2 (1×), 12 (1×), and two of each from 3 to 11.
- **Extended Map (30 Hexes, 5–6 Players)**:
  - Official symmetrical 7-row layout (`3, 4, 5, 6, 5, 4, 3 = 30 hexes`).
  - 2 Deserts and 28 resource hexes.
- **Strict Red Number Rule (No Adjacent 6 & 8)**:
  - Automatically verifies and swaps high-yield red tokens (6 and 8) so they never touch an adjacent edge.
- **Outward Harbor Docks**:
  - 9 harbors on Standard map (4 generic 3:1 + 5 special 2:1).
  - 11 harbors on Extended map (5 generic 3:1 + 6 special 2:1).
  - Stylized pier lines project harbor badges into the water to avoid overlapping coastal roads and settlements.

### ⚔️ Game Mechanics & Rules (Tournament Accurate)
- **Snake Draft Setup**: Two rounds of initial placement (`Settlement` + `Road`). The second settlement automatically awards starting bootstrap resources.
- **Resource Production**: Dice rolls (2–12) distribute resources to all players with adjacent settlements (1 card) or cities (2 cards).
- **Robber & 7-Roll Discard**:
  - Any player with 8 or more resource cards must discard half (`Math.floor(total / 2)`).
  - The rolling player relocates the Robber to any non-desert hex and steals 1 random resource from an opponent on that hex.
  - Robber blocks production on its hex until moved.
- **Building System**:
  - **Road** (`1 Wood, 1 Brick`): Connected to existing network.
  - **Settlement** (`1 Wood, 1 Brick, 1 Wool, 1 Wheat`): Enforces the official distance rule (no settlements on adjacent vertices).
  - **City** (`2 Wheat, 3 Ore`): Upgrades an existing settlement.
  - **Development Card** (`1 Wool, 1 Wheat, 1 Ore`): Knights, Progress Cards (Road Building, Year of Plenty, Monopoly), and Victory Point cards.
- **Special Awards**:
  - **Longest Road** (2 VP): Awarded to the first player with 5 or more continuous road segments. Ties do not steal the award.
  - **Largest Army** (2 VP): Awarded to the first player who activates 3 or more Knight cards. Ties do not steal the award.
- **Trading Engine**:
  - **Bank & Port Trading**: Dynamic 4:1 base trade ratio, reduced to 3:1 with a generic port or 2:1 with a specialized port. Interactive cards with affordability feedback.
  - **Domestic Player Trading**: Send offers with specific give/receive resources; opponents can accept, reject, or negotiate.

### 🤖 Autonomous Heuristic Bot AI
- Intelligent bot players can be added to any lobby to play solo or fill empty spots.
- Bots calculate resource deficits, plan road paths toward high-probability vertices, utilize port trade ratios, play Knight cards strategically, and place setup buildings optimally.

### 🌐 Real-Time Multiplayer & Rooms
- **Room Hosting**: Create custom rooms with configurable Turn Duration (30s–120s), Target Victory Points (8–14 VP), and Map Size.
- **Shareable Room Codes**: Join instantly with a 4–6 character code (e.g. `CTN-8421`).
- **Disconnect & Reconnect Safety**: If a player disconnects, their slot is preserved and turns do not freeze.
- **Live In-Game Chat & Event Log**: Filterable activity log detailing production, trades, and moves.

### 🔊 Procedural Audio & UI
- **Zero Audio Assets**: Realistic sound effects synthesized on-the-fly via Web Audio API oscillators (dice shakes, building placements, button clicks, victory fanfare).
- **Glassmorphism UI**: Modern dark theme with CSS backdrops, animations, and high accessibility contrast.
- **Bilingual (RO / EN)**: Live language toggle switching all texts, cards, logs, and rules.

---

## 🚀 Quick Start / Instalare și Pornire

### Cerințe de sistem
- **Node.js**: v18.0.0 sau mai nou
- **npm**: v8.0.0 sau mai nou

### 1. Clonare și instalare
```bash
git clone https://github.com/your-username/hex-catan-multiplayer.git
cd hex-catan-multiplayer
npm install
```

### 2. Pornire server
```bash
npm start
```
Serverul va porni la: **`http://localhost:3000`**

Pentru dezvoltare cu auto-reload la modificări de cod:
```bash
npm run dev
```

### Admin dashboard (SEC-03)
`GET /admin`, `/admin/traffic`, `/admin.html`, and all `/api/admin/*` routes are **disabled** unless a strong shared secret is configured:

```bash
export ADMIN_SECRET="$(openssl rand -hex 32)"   # Linux / macOS
npm start
```

On Windows (PowerShell): `$env:ADMIN_SECRET = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })`

Sign in with any of:
- Browser prompt / login form at `/admin` (HTTP Basic or `POST /admin/session`)
- `Authorization: Bearer <ADMIN_SECRET>`
- `Authorization: Basic` with password = `ADMIN_SECRET`
- `X-Admin-Secret: <ADMIN_SECRET>`

If `ADMIN_SECRET` is unset, admin routes return **403** and never include traffic, IPs, or player hands.

### Docker (production image)

Requires Docker. The image runs Node 22 Alpine as the non-root `node` user and exposes `GET /health` for liveness checks.

```bash
docker compose up --build
```

The app is at **`http://localhost:3000`**. Probe: `curl http://localhost:3000/health`.

```bash
docker build -t hex-catan-multiplayer .
docker run --rm -p 3000:3000 hex-catan-multiplayer
```

### 3. Rulare teste automate
Proiectul include o suită completă de 25 de teste unitare și de integrare QA:
```bash
npm test
```

---

## 👥 How to Test with Friends / Cum joci cu prietenii

### 🔹 Opțiunea 1: Pe aceeași rețea Wi-Fi (Rețea Locală)
Dacă ești în aceeași casă sau birou cu prietenii:
1. Află IP-ul tău local (pe Mac: `ipconfig getifaddr en0`, pe Windows: `ipconfig`).
2. Prietenii tăi deschid pe telefon sau laptop:
   ```text
   http://<IP-UL-TAU-LOCAL>:3000
   ```
3. Unul creează camera și le dă codul de cameră (ex: `CTN-8421`).

---

### 🔹 Opțiunea 2: Peste Internet prin Cloudflare Tunnel (Recomandat, 100% Gratuit)
Dacă prietenii tăi sunt la ei acasă, poți expune serverul printr-un tunel securizat HTTPS fără port forwarding:

```bash
./cloudflared tunnel --url http://localhost:3000
```
Comanda îți va genera un link securizat (ex: `https://publications-developer-bishop-dimensions.trycloudflare.com`). Trimite link-ul prietenilor și pot juca instant din orice browser.

`cloudflared` connects to Node from loopback (`127.0.0.1` / `::1`). The server therefore treats that peer as a verified edge and honors `CF-Connecting-IP` / `X-Forwarded-For` for client IP telemetry (see below).

---

### 🔹 Opțiunea 3: Pe același calculator (Simulare Multiplayer)
1. Deschide [http://localhost:3000](http://localhost:3000) într-un tab normal.
2. Deschide un alt tab în mod **Incognito** (sau în alt browser, ex: Safari).
3. Creează camera din primul tab și alătură-te din cel de-al doilea cu un alt nume pentru a testa interacțiunile multiplayer.

---

## 🔐 Deployment topology & client IPs (SEC-08)

The server records client IPs for admin telemetry and (future) rate limits. Forwarded headers are **not** globally trusted.

| Topology | How traffic reaches Node | `TRUST_PROXY` | Client IP source |
| :--- | :--- | :--- | :--- |
| **Bare Node** (LAN or a public bind with no reverse proxy) | Browser connects from a non-loopback address | `false`, or default `loopback` | TCP peer (`socket.remoteAddress`). `CF-Connecting-IP`, `X-Real-IP`, and `X-Forwarded-For` are ignored because the peer is not a verified edge. |
| **Cloudflare Tunnel** (`cloudflared tunnel --url http://localhost:3000`) | `cloudflared` dials loopback | default `loopback` | Headers from the tunnel hop: `CF-Connecting-IP`, then hop-stripped `X-Forwarded-For`. |
| **Reverse proxy / PaaS** (nginx, Render, Railway, Fly.io) | One trusted hop in front of Node | `1` (only if Node is **not** reachable except via that proxy) or the proxy IP/CIDR | Hop count or listed proxy address. |

```bash
# Bare Node — never honor client-supplied forwarded headers
TRUST_PROXY=false npm start

# Cloudflare tunnel (default) — trust headers only from loopback
TRUST_PROXY=loopback npm start

# Single reverse proxy that is the only way to reach Node
TRUST_PROXY=1 npm start

# Trust a specific proxy address or CIDR
TRUST_PROXY=10.0.0.1 npm start
TRUST_PROXY=10.0.0.0/8 npm start
```

`TRUST_PROXY=true` is rejected: Express would trust every hop, which is how client IPs were spoofable. It is coerced to `loopback` with a startup warning.

Startup logs the active policy, for example: `Client IP trust proxy: loopback`.

---

## 📂 Project Structure / Structura Proiectului

```text
Catan/
├── server/                       # Backend Node.js
│   ├── server.js                 # Entry-point Express & Socket.IO
│   └── game/
│       ├── GameEngine.js         # Motorul de joc cu toate regulile oficiale
│       ├── HexGrid.js            # Generatorul de grilă hexagonală & porturi
│       ├── BotAI.js              # Inteligența artificială a boților
│       └── RoomManager.js        # Gestionarea camerelor, lobby-urilor și socket-urilor
├── public/                       # Frontend Vanilla Web
│   ├── index.html                # Markup-ul principal și modalele
│   ├── css/
│   │   ├── main.css              # Reset, variabile CSS, layout de bază
│   │   ├── board.css             # Stilurile tablei de joc și animații SVG
│   │   └── ui.css                # Interfața panourilor, cărți, trade modal
│   └── js/
│       ├── app.js                # Controller-ul principal al clientului
│       ├── renderer.js           # Randare procedurală a tablei prin SVG
│       ├── network.js            # Client Socket.IO și gestionare evenimente
│       ├── audio.js              # Sintetizator audio procedural (Web Audio)
│       └── i18n.js               # Dicționar bilingv Română / Engleză
├── tests/                        # Suite de teste QA
│   ├── gameEngine.test.js        # Teste pentru reguli de bază și mecanică
│   └── qaAuditAndRules.test.js   # Teste de securitate, numere roșii, porturi, boți
└── package.json                  # Dependențe și scripturi npm
```

---

## 🧪 Test Suites / Teste Automate

Suita de teste rulează direct cu motorul nativ `node:test` din Node.js (fără dependințe grele precum Jest sau Mocha):

| Test Suite | Verificări Cheie |
| :--- | :--- |
| **HexGrid generation** | Conectivitate graf, alocare resurse, plasare hoț pe deșert |
| **Red Number Adjacency** | 50 de iterații verificând că niciun 6 și 8 nu sunt vecine |
| **Harbor Distribution** | 9 porturi pe standard, 11 pe extended, zero coliziuni |
| **GameEngine Lifecycle** | Snake draft, regulă de distanță, deducere resurse, upgrade orașe |
| **Robber Discarding** | Pragul de 8 cărți, calcul exact `floor(total / 2)`, furt din inventar |
| **Dev Cards & Knights** | Blocare cărți în faza de setup/zaruri, tranziție de tură |
| **Port Trading Validation**| Rata 4:1 standard, 3:1 port generic, 2:1 port specializat |
| **Domestic Trade Security**| Respingere valori negative, numere non-întregi, schimb cu sine |
| **Longest Road & Army** | Blocare furt titlu la egalitate, retragere titlu la scădere sub 5 segmente |
| **Victory Conditions** | Declanșare instantanee GAME_OVER la atingerea numărului de VP țintă |
| **BotAI Autonomy** | Plasare automată inițială, decizii de construire, schimb la bancă |

---

## 🔄 CI/CD Pipelines (GitHub Actions)

Proiectul folosește un sistem modular de CI/CD automatizat prin GitHub Actions, inspirat din standardele profesionale de producție:

1. **Continuous Integration (`ci.yml`)**:
   - **Syntax Check**: Validare statică a codului (`node --check`) pentru toate fișierele backend, frontend și teste.
   - **ESM Import Validation**: Verifică rezoluția importurilor modulelor ES6 (`GameEngine`, `HexGrid`, `BotAI`, `RoomManager`).
   - **Multi-Version Matrix Test**: Execută suita completă de teste automate pe **Node.js 20.x și 22.x** (Node 18.x este EOL și nu mai face parte din CI).
   - **Security Audit**: Scanare automată de securitate a dependințelor (`npm audit --audit-level=high`).
   - **Asset Integrity Check**: Asigură prezența și integritatea fișierelor statice din `public/`.

2. **Continuous Deployment (`deploy.yml`)**:
   - Poartă automată de pre-validare (rulează testele înainte de deploy).
   - Suport pentru webhook-uri de auto-deploy (Render, Railway, Fly.io sau VPS).
   - Verificare post-deploy: interoghează `HEALTH_CHECK_URL` (HTTP 200, 12 încercări × 10s) și declanșează `ROLLBACK_HOOK_URL` la eșec. `timeout-minutes: 10` pe job-ul de deploy previne rulări blocate.

3. **Disaster Recovery / Rollback (`rollback.yml`)**:
   - Trigger manual securizat prin `workflow_dispatch`.
   - Permite revenirea instantanee la un commit hash specific sau la ultimul tag stabil în caz de incident de producție.

---

## 📜 Licență

Acest proiect este distribuit sub licența **MIT**.
