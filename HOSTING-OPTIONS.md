# Bylis Hosting Options - Contourner le blocage WhatsApp 405

## Le Problème

WhatsApp bloque les connexions venant d'IPs de datacenters (Render, Heroku, AWS, etc.) avec l'erreur 405.

---

## Option 1: Proxy Résidentiel Payant (Recommandé pour Production)

### Configuration sur Render

Ajoutez la variable d'environnement:
```
PROXY_URL=socks5://user:password@proxy.example.com:1080
```

### Fournisseurs recommandés

| Fournisseur | Prix | Caractéristiques |
|-------------|------|------------------|
| [Bright Data](https://brightdata.com) | ~$15/GB | Leader mondial, fiable |
| [IPRoyal](https://iproyal.com) | ~$7/GB | Bon rapport qualité/prix |
| [Decodo](https://decodo.com) | ~$8/GB | Anciennement Smartproxy |
| [OkeyProxy](https://okeyproxy.com) | ~$3/GB | Le moins cher |

---

## Option 2: VPS avec IP Résidentielle

### Fournisseurs avec IPs résidentielles

| Fournisseur | Prix | RAM | Particularité |
|-------------|------|-----|---------------|
| [Kamatera](https://kamatera.com) | $4/mois | 1GB+ | IPs variées |
| [InterServer](https://interserver.net) | $6/mois | 2GB | IPs propres |
| [HostArmada](https://hostarmada.com) | $5/mois | 2GB | Support 24/7 |
| [Ultahost](https://ultahost.com) | $5/mois | 1GB | DDoS protection |

### Déploiement sur VPS

```bash
# 1. Cloner Bylis
git clone https://github.com/MatrixHolding/bylis.git
cd bylis

# 2. Installer Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. Configurer environnement
cp .env.example .env
# Éditer .env avec vos variables Supabase

# 4. Installer et lancer
npm install
npm run build
npm start

# 5. Pour run 24/7 avec PM2
npm install -g pm2
pm2 start dist/index.js --name bylis
pm2 save
pm2 startup
```

---

## Option 3: Solutions 100% Gratuites

### A. Oracle Cloud Free Tier (Forever Free)

**Ressources gratuites:**
- 4 ARM cores + 24GB RAM (ou 4 petites VMs)
- 200GB stockage
- 10TB/mois sortant

**Étapes:**
1. Créer compte: https://signup.oraclecloud.com/
2. Créer une instance ARM (Ampere A1)
3. Déployer Bylis (voir section VPS ci-dessus)

**Note:** Nécessite carte bancaire pour vérification (charge temporaire remboursée).

### B. Proxy Résidentiel Gratuit (Essai)

| Fournisseur | Gratuit | Durée | Carte requise |
|-------------|---------|-------|---------------|
| [Decodo](https://decodo.com) | 100MB | 3 jours | Non |
| [OkeyProxy](https://okeyproxy.com) | 1GB | Illimité | Non |
| [ProxyElite](https://proxyelite.info) | 50 IPs | 1 heure | Non |

**Comment utiliser:**
1. Créer compte gratuit
2. Obtenir credentials SOCKS5
3. Configurer sur Render: `PROXY_URL=socks5://user:pass@host:port`

### C. Self-Host à Domicile

**Matériel:**
- Raspberry Pi 4 (~$50) ou vieux PC
- Connexion internet résidentielle

**Avantages:**
- IP résidentielle automatique
- 100% gratuit (après achat hardware)
- Contrôle total

**Setup:**
```bash
# Sur Raspberry Pi
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
git clone https://github.com/MatrixHolding/bylis.git
cd bylis && npm install && npm run build
pm2 start dist/index.js --name bylis
```

---

## Option 4: WhatsApp Official Proxy (Docker)

Meta propose un proxy officiel open-source:
https://github.com/WhatsApp/proxy

```bash
# Déployer avec Docker
docker pull facebook/whatsapp_proxy:latest
docker run -d -p 443:443 -p 5222:5222 facebook/whatsapp_proxy:latest
```

**Note:** Conçu pour l'app WhatsApp officielle, compatibilité avec Baileys non garantie.

---

## Recommandations par Cas d'Usage

| Cas d'usage | Solution recommandée |
|-------------|---------------------|
| Production (clients payants) | Proxy résidentiel payant |
| Startup/Budget limité | Oracle Cloud Free + Proxy gratuit |
| Développement/Test | Local ou Raspberry Pi |
| Enterprise | WhatsApp Cloud API (officiel) |

---

## Configuration Bylis avec Proxy

Bylis supporte maintenant les proxies via la variable `PROXY_URL`:

```bash
# SOCKS5
PROXY_URL=socks5://username:password@proxy.example.com:1080

# HTTPS
PROXY_URL=https://username:password@proxy.example.com:8080

# Sans auth
PROXY_URL=socks5://proxy.example.com:1080
```

Le proxy est utilisé pour:
- `agent`: Connexion WebSocket à WhatsApp
- `fetchAgent`: Upload/download de médias
