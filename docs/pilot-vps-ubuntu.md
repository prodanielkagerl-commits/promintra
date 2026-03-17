# Piloto rápido en VPS Ubuntu

Esta guía deja el proyecto listo para un piloto de 1 mes en un VPS Ubuntu con HTTPS, proceso persistente y backup diario.

## Requisitos recomendados

- Ubuntu 22.04 o 24.04
- 2 vCPU
- 4 GB RAM
- 60 GB SSD
- Un subdominio, por ejemplo `piloto.tudominio.com`

## 1. Preparar el servidor

```bash
sudo apt update
sudo apt install -y nginx git unzip
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Comprobar versiones:

```bash
node -v
npm -v
pm2 -v
```

## 2. Subir el proyecto

```bash
sudo mkdir -p /opt/berlingerhaus
sudo chown -R $USER:$USER /opt/berlingerhaus
cd /opt/berlingerhaus
git clone <URL_DEL_REPO> .
```

Si no se usa Git, subir el proyecto comprimido y descomprimirlo en `/opt/berlingerhaus`.

## 3. Instalar dependencias

```bash
cd /opt/berlingerhaus
npm install
npm run compile
```

## 4. Arrancar con PM2

El repo ya incluye [ecosystem.config.js](../ecosystem.config.js).

```bash
cd /opt/berlingerhaus
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Validar:

```bash
pm2 status
curl http://127.0.0.1:4004/backoffice/session
```

## 5. Configurar Nginx

El repo ya incluye [deploy/nginx/berlingerhaus.conf](../deploy/nginx/berlingerhaus.conf).

Copiarlo a Nginx y cambiar `piloto.tudominio.com` por el dominio real:

```bash
sudo cp /opt/berlingerhaus/deploy/nginx/berlingerhaus.conf /etc/nginx/sites-available/berlingerhaus
sudo nano /etc/nginx/sites-available/berlingerhaus
sudo ln -s /etc/nginx/sites-available/berlingerhaus /etc/nginx/sites-enabled/berlingerhaus
sudo nginx -t
sudo systemctl reload nginx
```

## 6. Activar HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d piloto.tudominio.com
```

## 7. Backup diario

El repo ya incluye [scripts/backup-pilot.sh](../scripts/backup-pilot.sh).

Dar permisos:

```bash
chmod +x /opt/berlingerhaus/scripts/backup-pilot.sh
```

Probar manualmente:

```bash
/opt/berlingerhaus/scripts/backup-pilot.sh
```

Programar con `cron` a las 02:30:

```bash
crontab -e
```

Añadir:

```cron
30 2 * * * /opt/berlingerhaus/scripts/backup-pilot.sh >> /var/log/berlingerhaus-backup.log 2>&1
```

## 8. Datos que hay que proteger

En este piloto hay dos elementos críticos:

- `db.sqlite`: base de datos del piloto
- `app/assets/products`: imágenes reales subidas por el cliente

## 9. Operaciones habituales

Reiniciar la app:

```bash
cd /opt/berlingerhaus
pm2 restart berlingerhaus-backoffice
```

Ver logs:

```bash
pm2 logs berlingerhaus-backoffice
```

Actualizar código:

```bash
cd /opt/berlingerhaus
git pull
npm install
npm run compile
pm2 restart berlingerhaus-backoffice
```

## 10. Recomendaciones para el piloto de 1 mes

- Mantener un único entorno piloto estable
- No mezclar desarrollo local con la base real del cliente
- Hacer backup diario automático
- Validar subida de imágenes y exportaciones PDF/Excel antes de abrir el piloto
- Definir al menos un usuario administrador y uno comercial
