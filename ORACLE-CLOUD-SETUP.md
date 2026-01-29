# Déployer Bylis sur Oracle Cloud Free Tier (100% Gratuit)

## Pourquoi Oracle Cloud?

- **4 CPU ARM + 24GB RAM** gratuits à vie
- **200GB stockage** gratuit
- **10TB/mois** trafic sortant gratuit
- IPs Oracle moins flaggées que Render/Heroku

## Étape 1: Créer un Compte Oracle Cloud

1. Aller sur https://signup.oraclecloud.com/
2. Remplir les informations
3. Vérifier avec carte bancaire (charge temporaire ~$1, remboursé)
4. Attendre validation (quelques minutes)

## Étape 2: Créer une Instance ARM

1. Dashboard → **Compute** → **Instances** → **Create Instance**
2. Configuration:
   - **Name**: `bylis`
   - **Image**: Ubuntu 22.04 (ou Oracle Linux)
   - **Shape**: **Ampere** → VM.Standard.A1.Flex
   - **OCPUs**: 4 (gratuit)
   - **Memory**: 24 GB (gratuit)
3. **Networking**: Créer nouveau VCN
4. **SSH Keys**: Générer ou uploader votre clé SSH
5. **Create**

## Étape 3: Configurer le Firewall

```bash
# Dans Oracle Console:
# Networking → Virtual Cloud Networks → [votre VCN] → Security Lists
# Ajouter Ingress Rule:
# - Source: 0.0.0.0/0
# - Protocol: TCP
# - Port: 3000
```

## Étape 4: Se Connecter en SSH

```bash
ssh -i your-key.pem ubuntu@<IP_PUBLIQUE>
```

## Étape 5: Installer Node.js 20

```bash
# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Oracle Linux
sudo dnf module enable nodejs:20 -y
sudo dnf install nodejs git -y
```

## Étape 6: Déployer Bylis

```bash
# Cloner le repo
git clone https://github.com/MatrixHolding/bylis.git
cd bylis

# Créer fichier .env
cat > .env << 'EOF'
PORT=3000
NODE_ENV=production
SUPABASE_URL=https://votre-projet.supabase.co
SUPABASE_SERVICE_ROLE_KEY=votre-clé-service
BAILEYS_AUTH_DIR=./data/baileys
EOF

# Installer et build
npm install
npm run build

# Tester
npm start
```

## Étape 7: Run 24/7 avec PM2

```bash
# Installer PM2
sudo npm install -g pm2

# Lancer Bylis
pm2 start dist/index.js --name bylis

# Auto-start au reboot
pm2 save
pm2 startup
# Copier et exécuter la commande affichée
```

## Étape 8: Configurer le Firewall OS

```bash
# Ubuntu
sudo ufw allow 3000
sudo ufw enable

# Oracle Linux
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

## Étape 9: Tester

```bash
curl http://<IP_PUBLIQUE>:3000/

# Créer une session
curl -X POST http://<IP_PUBLIQUE>:3000/api/baileys/session \
  -H "Content-Type: application/json" \
  -d '{"store_id": "test-uuid-here", "force_new_qr": true}'
```

## Étape 10: Configurer WakhaFlow

Dans WakhaFlow, changer l'URL Bylis:
```
BYLIS_URL=http://<IP_PUBLIQUE>:3000
```

---

## Troubleshooting

### "Out of capacity" lors de création d'instance
- Essayer une autre région (Frankfurt, London, Tokyo)
- Réessayer plus tard (les quotas sont limités)

### Instance supprimée après quelques mois
- Convertir en compte "Pay As You Go" (toujours gratuit si sous les limites)
- Se connecter régulièrement pour montrer l'activité

### WhatsApp bloque toujours (405)
- Oracle Cloud est datacenter aussi, mais moins flaggé
- Si bloqué: ajouter un proxy résidentiel (voir HOSTING-OPTIONS.md)

---

## Ressources

- [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/)
- [Guide Complet](https://orendra.com/blog/how-to-get-free-lifetime-servers-4-core-arm-24gb-ram-more/)
- [FAQ Oracle Free Tier](https://www.oracle.com/cloud/free/faq/)
