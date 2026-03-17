# BerlingerHaus Backoffice CAP

Backend base para un backoffice profesional de una distribuidora de menaje de cocina, construido con SAP Cloud Application Programming Model (CAP) sobre Node.js.

## Incluye

- Modelo CDS para `Products`, `Campaigns` y la relación many-to-many `ProductCampaigns`
- Servicio OData `AdminService` en la ruta `/admin`
- Datos iniciales para productos y campañas en `db/data`
- Persistencia local con SQLite

## Scripts

- `npm run watch`: arranca CAP en modo desarrollo
- `npm start`: arranca el servicio
- `npm run build`: genera artefactos CAP
- `npm run compile`: compila el servicio CDS

## Entidades principales

- `Products`: catálogo de productos de cocina
- `Campaigns`: campañas comerciales
- `ProductCampaigns`: asignación de productos a campañas

## Siguiente fase sugerida

Sobre esta base se pueden añadir KPIs de backoffice como best-sellers, stock bajo, campañas activas y paneles administrativos.

## Piloto en VPS

El repositorio ya incluye una base para desplegar un piloto rápido de 1 mes en un VPS Ubuntu:

- [ecosystem.config.js](ecosystem.config.js): arranque persistente con PM2
- [deploy/nginx/berlingerhaus.conf](deploy/nginx/berlingerhaus.conf): reverse proxy con Nginx
- [scripts/backup-pilot.sh](scripts/backup-pilot.sh): backup diario de SQLite e imágenes
- [docs/pilot-vps-ubuntu.md](docs/pilot-vps-ubuntu.md): guía paso a paso de despliegue

Para este piloto se recomienda mantener respaldados:

- `db.sqlite`
- `app/assets/products`

## Piloto en Render

Si se quiere la opción más rápida tipo PaaS, el repositorio ya incluye soporte base para Render:

- [render.yaml](render.yaml): blueprint del servicio y PostgreSQL
- [scripts/render-start.js](scripts/render-start.js): arranque con `cds deploy` + `cds serve`
- [docs/pilot-render.md](docs/pilot-render.md): guía del piloto rápido en Render

En este proyecto no hace falta desplegar frontend y backend por separado porque la UI ya se sirve desde la propia aplicación Node/CAP.

## Login del backoffice

El acceso al sistema ya está protegido con login y sesión por cookie.

Puedes definir usuarios de dos formas:

- Variable `BACKOFFICE_USERS_JSON` con varios usuarios
- Variables `BACKOFFICE_ADMIN_USER` y `BACKOFFICE_ADMIN_PASSWORD` para un único administrador

Ejemplo recomendado para Render:

```json
[
	{
		"username": "daniel",
		"password": "TuClaveSegura123!",
		"displayName": "Daniel",
		"role": "admin"
	},
	{
		"username": "maria",
		"password": "OtraClaveSegura123!",
		"displayName": "Maria Comercial",
		"role": "commercial"
	},
	{
		"username": "direccion",
		"password": "LecturaSegura123!",
		"displayName": "Dirección",
		"role": "readonly"
	}
]
```

Roles disponibles:

- `admin`
- `commercial`
- `readonly`

Si no configuras usuarios, la aplicación arranca con credenciales demo temporales. En producción conviene reemplazarlas inmediatamente con variables reales de Render.
